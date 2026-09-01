// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The broker service: connection lifecycle + consent + the per-app footprint,
 * orchestrating the Store and the injected AWS providers. Pure of any
 * app-specific knowledge — MailPoppy is just one connecting app.
 */
import { randomUUID } from "node:crypto";
import { assessPermissionSet, grantsSubsetOf, isFullyAttributable, operationIsMutating, summarizeActivity } from "@agentspoppy/core";
import { ledgerForConnection, readLedger } from "@agentspoppy/core/ledger";
import type {
  ActivityEvent,
  ActivitySummary,
  AppIdentity,
  ApprovalRequest,
  AuditEntry,
  ConnectedAccount,
  Connection,
  ConnectionStatus,
  InfraGraph,
  Inventory,
  OperationIntent,
  PermissionSet,
  ResidualResource,
} from "@agentspoppy/core";
import type { Store } from "./store";
import type { ActivityProvider, CloudProvider, CredentialVendor, ScopedCredentials } from "./providers";
import {
  AccountUnreadableError,
  DEFAULT_OPERATOR_NAME,
  DEFAULT_ROLE_NAME,
  EvictionRequiredError,
  RevokeKeyError,
  TEMPLATE_VERSION,
  configureMaintenanceSession,
  consoleUrlForArn,
  roleTemplateJson,
  type SetupVersionStatus,
} from "./aws";
import type { AwsBootstrap, AwsKeyInput, CallerIdentity, OperatorKeyInfo, RoleProbeResult } from "./aws";

/** Recent account activity, attributed, with the headline counts. */
export interface ActivityReport {
  events: ActivityEvent[];
  summary: ActivitySummary;
}

/**
 * The result of a credential request: either the scoped credentials, or — for a
 * supervised connection performing a mutating (or undeclared) operation — an
 * approval the user must grant first. The poppy re-requests, echoing `approval.id`,
 * until it's approved (→ credentials) or denied (→ error).
 */
export type CredentialResponse =
  | { kind: "credentials"; credentials: ScopedCredentials }
  | { kind: "approval-required"; approval: ApprovalRequest };

/** How long a pending approval stays meaningful before the UI marks it stale. */
const APPROVAL_TTL_MS = 15 * 60 * 1000;

/** What a poppy may send when requesting credentials. */
export interface CredentialRequest {
  /** The specific operation about to run — narrows the creds and drives supervised approval. */
  operation?: OperationIntent;
  /** Echoed back by the poppy while polling a pending approval it was handed. */
  approvalId?: string;
}

function roleNameFromArn(arn?: string): string | undefined {
  return arn?.match(/:role\/(.+)$/)?.[1];
}

export type BrokerErrorCode =
  | "not_found"
  | "invalid_state"
  | "bad_request"
  | "account_unreadable"
  /** Making room for a new operator key would delete another machine's — confirm first. */
  | "eviction_required"
  /** The action needs the machine to be standing on the operator key (step 0 first). */
  | "not_operator"
  /** The deployed setup template predates this capability — re-apply setup first. */
  | "setup_outdated";

export class BrokerError extends Error {
  constructor(public readonly code: BrokerErrorCode, message: string) {
    super(message);
    this.name = "BrokerError";
  }
}

export interface BrokerDeps {
  store: Store;
  credentials: CredentialVendor;
  cloud: CloudProvider;
  /** Bootstrap-time AWS checks (operator identity + role verification). */
  aws: AwsBootstrap;
  /** Recent account activity (CloudTrail), for the "around AgentsPoppy" feed. */
  activity: ActivityProvider;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
}

export interface LinkAccountInput {
  accountId: string;
  alias?: string;
  regions: string[];
  /** ARN of the IAM role AgentsPoppy assumes to vend scoped credentials (optional). */
  roleArn?: string;
}

export interface RequestConnectionInput {
  accountId: string;
  app: AppIdentity;
  permissionSet: PermissionSet;
}

function regionFor(account: ConnectedAccount): string {
  return account.regions[0] ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
}

export class BrokerService {
  private readonly store: Store;
  private readonly credentials: CredentialVendor;
  private readonly cloud: CloudProvider;
  private readonly aws: AwsBootstrap;
  private readonly activity: ActivityProvider;
  private readonly now: () => string;
  /**
   * Connections currently being torn down. While a connection is in here, its credential
   * requests skip the supervised-approval gate: the user already consented to "tear down
   * everything", and the creds can't exceed the connection's already-approved (and, for
   * deletes, self-scoped) grants — so re-prompting per delete would only block the cleanup
   * the user asked for. Without this, a supervised poppy's teardown hook can't run headlessly
   * (e.g. under certification), so its out-of-stack resources would orphan.
   */
  private readonly tearingDown = new Set<string>();

  constructor(deps: BrokerDeps) {
    this.store = deps.store;
    this.credentials = deps.credentials;
    this.cloud = deps.cloud;
    this.aws = deps.aws;
    this.activity = deps.activity;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  // --- aws bootstrap ---

  /**
   * Point the shared maintenance session at this account's broker role, so every
   * housekeeping AWS client (activity feed, tag sweep, teardown, residual cleanup,
   * the staleness read) goes through the guarded door instead of the raw key
   * (docs/specs/operator-key-least-privilege.md). Cheap and idempotent.
   */
  private maintainFor(account: ConnectedAccount | undefined): void {
    if (account?.roleArn) {
      configureMaintenanceSession({ roleArn: account.roleArn, region: regionFor(account) });
    }
  }

  /** The operator's AWS identity — also a "are my credentials working?" probe. */
  getAwsIdentity(): Promise<CallerIdentity> {
    return this.aws.getCallerIdentity();
  }

  /** This machine's operator-key id + mint time (never secrets) — the key-age nudge. */
  async getOperatorKeyInfo(): Promise<OperatorKeyInfo> {
    if (!this.aws.operatorKeyInfo) return { profileKeyId: null, mintedAt: null };
    return this.aws.operatorKeyInfo();
  }

  /**
   * The kill switch: revoke THIS machine's operator key (delete in AWS first, then
   * forget locally). Errors are routed, not just displayed — see RevokeKeyError.
   */
  async revokeOperatorKey(): Promise<{ deletedKeyId: string; alreadyGone: boolean }> {
    if (!this.aws.revokeOperatorKey) {
      throw new BrokerError("invalid_state", "this build cannot revoke keys");
    }
    const account = (await this.store.listAccounts())[0];
    try {
      return await this.aws.revokeOperatorKey(account ? regionFor(account) : undefined);
    } catch (err) {
      if (err instanceof RevokeKeyError) {
        const code =
          err.reason === "not-operator" ? "not_operator" : err.reason === "setup-outdated" ? "setup_outdated" : "invalid_state";
        throw new BrokerError(code, err.message);
      }
      throw err;
    }
  }

  /**
   * Save pasted operator keys to the dedicated `agentspoppy` profile, then return
   * the now-resolvable identity. The in-app alternative to `aws configure`.
   */
  async setAwsCredentials(input: AwsKeyInput): Promise<CallerIdentity> {
    if (!input.accessKeyId?.trim() || !input.secretAccessKey?.trim()) {
      throw new BrokerError("bad_request", "Both an Access Key ID and a Secret Access Key are required.");
    }
    await this.aws.writeOperatorCredentials(input);
    this.operatorIdCache = null; // new keys = (possibly) a new operator identity
    return this.aws.getCallerIdentity();
  }

  /**
   * Is the broker role deployed in the user's account the one this host expects?
   *
   * The guardrails that protect an account are written into the user's OWN AWS by the
   * bootstrap stack, so shipping a tightened guardrail changes nothing until that user
   * re-applies setup. Nothing else tells them to (docs/specs/broker-role-v2.md).
   *
   * Read-only, and deliberately never throws: a staleness check that fails must not break
   * the screen it sits on. An unreadable answer surfaces as `unknown`, which prompts the
   * same as out-of-date but SAYS "couldn't check" — crying wolf is how a security banner
   * gets trained out of a user.
   */
  async getSetupStatus(): Promise<SetupVersionStatus> {
    const account = (await this.store.listAccounts())[0];
    // No AWS linked → there is nothing deployed to be stale, and asking anyway would send a
    // brand-new user's first launch on a scan of every AWS region to learn what we already know.
    if (!account) return { state: "absent", deployed: null, expected: TEMPLATE_VERSION };
    this.maintainFor(account);
    try {
      return await this.aws.readSetupVersion(regionFor(account));
    } catch (err) {
      return {
        state: "unknown",
        deployed: null,
        expected: TEMPLATE_VERSION,
        reason: (err as Error).message?.trim() || "the setup stack could not be read",
      };
    }
  }

  /** The CloudFormation template for the broker role + minimal operator for this account. */
  async roleTemplate(accountId: string): Promise<{ operator: CallerIdentity; templateJson: string }> {
    const account = (await this.store.listAccounts()).find((a) => a.id === accountId);
    if (!account) throw new BrokerError("not_found", `account ${accountId} not found`);
    const operator = await this.aws.getCallerIdentity();
    return { operator, templateJson: roleTemplateJson({ operatorAccountId: operator.accountId }) };
  }

  /**
   * AUTOMATED setup: deploy the broker role + non-admin operator for this account
   * using elevated setup credentials (used in memory only, never persisted), then
   * record the resulting Broker Role ARN. Idempotent / resumable — re-running after
   * any interruption reconciles against AWS and finishes the job. The only thing
   * left on disk is the non-admin operator key.
   */
  async deployBootstrap(
    accountId: string | null,
    setup?: AwsKeyInput,
    /** Fresh-machine only: where the setup should live (the wizard's region choice).
     *  Ignored when an account is already linked — you can't move a setup by re-running it. */
    regionOverride?: string,
    /** Re-apply: touch the stack only — never rotate the operator key or the local profile. */
    updateOnly?: boolean,
    /** Step 0 / eviction consent — see BootstrapInput (docs/specs/operator-key-least-privilege.md). */
    extra?: { keysFirst?: boolean; allowEviction?: boolean },
  ): Promise<{
    brokerRoleArn: string;
    account: ConnectedAccount;
    /** Set when this machine reused a setup living in another region (nothing was created). */
    joinedExistingSetupIn?: string;
    /** Set when the run connected this machine but could NOT re-apply the template. */
    setupNotUpdated?: boolean;
    /** When `setupNotUpdated` came from a thrown failure (keys-first mode): the reason. */
    setupUpdateError?: string;
    /** Set when the oldest operator key was retired to stay within IAM's 2-key limit. */
    evictedAccessKeyId?: string;
  }> {
    // Only validate when keys were actually supplied; omitting them means "reuse
    // the AWS credentials already connected" (no second paste).
    if (setup && (!setup.accessKeyId?.trim() || !setup.secretAccessKey?.trim())) {
      throw new BrokerError("bad_request", "Both an Access Key ID and a Secret Access Key are required.");
    }
    const accounts = await this.store.listAccounts();
    const existing = accountId ? accounts.find((a) => a.id === accountId) : null;
    if (accountId && !existing) throw new BrokerError("not_found", `account ${accountId} not found`);

    // No linked account yet (fresh machine) → derive everything from the setup
    // creds, so the user never has to persist admin keys first. The wizard passes the
    // user's region choice here; without it we'd silently plant every setup in
    // us-east-1 no matter where the user lives.
    if (regionOverride && !/^[a-z]{2}(-[a-z]+)+-\d$/.test(regionOverride.trim())) {
      throw new BrokerError("bad_request", `"${regionOverride}" is not an AWS region name`);
    }
    const region = existing
      ? regionFor(existing)
      : regionOverride?.trim() || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
    let result;
    try {
      result = await this.aws.deployBootstrap({
        setup,
        region,
        expectedAccountId: existing?.accountId,
        ...(updateOnly ? { updateOnly: true } : {}),
        ...(extra?.keysFirst ? { keysFirst: true } : {}),
        ...(extra?.allowEviction ? { allowEviction: true } : {}),
      });
    } catch (err) {
      if (err instanceof EvictionRequiredError) throw new BrokerError("eviction_required", err.message);
      throw err;
    }
    // An update-only run never touches credentials, so the cached identity stays valid.
    if (!updateOnly) this.operatorIdCache = null;

    // Upsert: the linked account, else one already matching this AWS account, else a fresh row.
    const target = existing ?? accounts.find((a) => a.accountId === result.accountId) ?? null;
    const extras = {
      ...(result.joinedExistingSetupIn ? { joinedExistingSetupIn: result.joinedExistingSetupIn } : {}),
      ...(result.setupNotUpdated ? { setupNotUpdated: true } : {}),
      ...(result.setupUpdateError ? { setupUpdateError: result.setupUpdateError } : {}),
      ...(result.evictedAccessKeyId ? { evictedAccessKeyId: result.evictedAccessKeyId } : {}),
    };
    if (target) {
      const updated: ConnectedAccount = { ...target, roleArn: result.brokerRoleArn };
      await this.store.updateAccount(updated);
      this.maintainFor(updated);
      return { brokerRoleArn: result.brokerRoleArn, account: updated, ...extras };
    }
    const created: ConnectedAccount = {
      id: randomUUID(),
      accountId: result.accountId,
      regions: [region],
      roleArn: result.brokerRoleArn,
      createdAt: this.now(),
    };
    await this.store.addAccount(created);
    this.maintainFor(created);
    return { brokerRoleArn: result.brokerRoleArn, account: created, ...extras };
  }

  /** Set (or replace) the role AgentsPoppy assumes for an account. */
  async setAccountRoleArn(accountId: string, roleArn: string): Promise<ConnectedAccount> {
    if (!roleArn) throw new BrokerError("bad_request", "roleArn is required");
    const account = (await this.store.listAccounts()).find((a) => a.id === accountId);
    if (!account) throw new BrokerError("not_found", `account ${accountId} not found`);
    const updated: ConnectedAccount = { ...account, roleArn };
    await this.store.updateAccount(updated);
    return updated;
  }

  /**
   * Re-point an account to a single AWS region — where this account's poppies actually live.
   * The region drives where every connected poppy's backend operates, so callers MUST restart
   * those backends afterwards (see {@link ExtensionRegistry.restartForAccount}) for them to pick
   * the new region up; the HTTP layer wires that in.
   */
  async setAccountRegion(accountId: string, region: string): Promise<ConnectedAccount> {
    if (!region.trim()) throw new BrokerError("bad_request", "region is required");
    const account = (await this.store.listAccounts()).find((a) => a.id === accountId);
    if (!account) throw new BrokerError("not_found", `account ${accountId} not found`);
    const updated: ConnectedAccount = { ...account, regions: [region.trim()] };
    await this.store.updateAccount(updated);
    return updated;
  }

  /** Confirm the account's role exists and is assumable, before any poppy uses it. */
  async verifyAccount(accountId: string): Promise<RoleProbeResult> {
    const account = (await this.store.listAccounts()).find((a) => a.id === accountId);
    if (!account) throw new BrokerError("not_found", `account ${accountId} not found`);
    if (!account.roleArn) throw new BrokerError("bad_request", "account has no roleArn to verify");
    this.maintainFor(account);
    return this.aws.verifyRole(account.roleArn, regionFor(account));
  }

  // --- accounts ---

  listAccounts(): Promise<ConnectedAccount[]> {
    return this.store.listAccounts();
  }

  async linkAccount(input: LinkAccountInput): Promise<ConnectedAccount> {
    if (!input.accountId) throw new BrokerError("bad_request", "accountId is required");
    const account: ConnectedAccount = {
      id: randomUUID(),
      accountId: input.accountId,
      alias: input.alias,
      regions: input.regions ?? [],
      roleArn: input.roleArn,
      createdAt: this.now(),
    };
    await this.store.addAccount(account);
    return account;
  }

  /**
   * Forget a linked account locally (e.g. the user linked the wrong one), removing
   * its connections too. This does NOT tear down any cloud resources — those are
   * handled per-connection via teardown; an account mislinked during onboarding has
   * none yet.
   */
  async unlinkAccount(accountId: string): Promise<{ ok: true }> {
    const account = (await this.store.listAccounts()).find((a) => a.id === accountId);
    if (!account) throw new BrokerError("not_found", `account ${accountId} not found`);
    await this.store.removeAccount(accountId);
    return { ok: true };
  }

  // --- extension blocklist (rung-1 local ban) ---

  listBlockedExtensions(): Promise<string[]> {
    return this.store.listBlockedExtensions();
  }

  blockExtension(id: string): Promise<void> {
    return this.store.blockExtension(id);
  }

  unblockExtension(id: string): Promise<void> {
    return this.store.unblockExtension(id);
  }

  // --- connections ---

  listConnections(): Promise<Connection[]> {
    return this.store.listConnections();
  }

  async getConnection(id: string): Promise<Connection> {
    const c = await this.store.getConnection(id);
    if (!c) throw new BrokerError("not_found", `connection ${id} not found`);
    return c;
  }

  async requestConnection(input: RequestConnectionInput): Promise<Connection> {
    if (!input.app?.id) throw new BrokerError("bad_request", "app.id is required");
    const account = (await this.store.listAccounts()).find((a) => a.id === input.accountId);
    if (!account) throw new BrokerError("not_found", `account ${input.accountId} not found`);

    const ts = this.now();
    // Risk-tiered default: a connection that can reach BEYOND its own resources
    // starts supervised — the user must approve each change, so the riskiest grants
    // are gated from first use. Fully self-scoped connections start unsupervised;
    // their scope is already enforced inside every credential we vend, and gating
    // them would block routine own-resource work for no extra safety.
    const supervised = assessPermissionSet(input.permissionSet).hasUnscopedGrants;
    const connection: Connection = {
      id: randomUUID(),
      accountId: input.accountId,
      app: input.app,
      status: "pending",
      supervised,
      permissionSet: input.permissionSet,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.store.putConnection(connection);
    await this.audit(
      connection.id,
      "requested",
      isFullyAttributable(input.permissionSet) ? undefined : "permission set is not fully attributable",
    );
    if (supervised) {
      await this.audit(connection.id, "supervised-on", "default — requests access beyond its own resources");
    }
    return connection;
  }

  approve(id: string): Promise<Connection> {
    return this.transition(id, ["pending"], "active", "approved", "approve");
  }

  deny(id: string): Promise<Connection> {
    return this.transition(id, ["pending"], "revoked", "denied", "deny");
  }

  pause(id: string): Promise<Connection> {
    return this.transition(id, ["active"], "paused", "paused", "pause");
  }

  resume(id: string): Promise<Connection> {
    return this.transition(id, ["paused"], "active", "resumed", "resume");
  }

  revoke(id: string): Promise<Connection> {
    return this.transition(id, ["pending", "active", "paused"], "revoked", "revoked", "revoke");
  }

  /**
   * Forget a connection record (and its audit/approvals) so it stops cluttering
   * the list. Only a *revoked* connection can be forgotten — a live one must be
   * revoked first, so this can never silently drop something still active. This
   * removes nothing in the cloud; any footprint should be torn down beforehand.
   */
  async forgetConnection(id: string): Promise<{ ok: true }> {
    const c = await this.getConnection(id);
    if (c.status !== "revoked") {
      throw new BrokerError("invalid_state", `cannot forget a ${c.status} connection — revoke it first`);
    }
    await this.store.removeConnection(id);
    return { ok: true };
  }

  /** Turn supervised mode on/off for a connection (the user's per-poppy control). */
  async setSupervised(id: string, supervised: boolean): Promise<Connection> {
    const c = await this.getConnection(id);
    const updated: Connection = { ...c, supervised, updatedAt: this.now() };
    await this.store.putConnection(updated);
    await this.audit(id, supervised ? "supervised-on" : "supervised-off");
    return updated;
  }

  /** Pending approvals awaiting the user's decision (across all connections). */
  async listPendingApprovals(): Promise<ApprovalRequest[]> {
    return (await this.store.listApprovals()).filter((a) => a.status === "pending");
  }

  /** Approve a pending operation → the poppy's next credential poll will vend. */
  approveApproval(approvalId: string): Promise<ApprovalRequest> {
    return this.decideApproval(approvalId, "approved", "operation-approved");
  }

  /** Deny a pending operation → the poppy's next credential poll fails. */
  denyApproval(approvalId: string): Promise<ApprovalRequest> {
    return this.decideApproval(approvalId, "denied", "operation-denied");
  }

  /**
   * Vend credentials for a connection — the supervised-mode gate. Behaviour:
   *  - not supervised → vend immediately (scoped to the operation if one is declared,
   *    else the whole permission set) — the original behaviour;
   *  - supervised + a read-only operation → vend immediately (reads stay un-gated);
   *  - supervised + a mutating operation (or none declared) → create/return an
   *    approval the user must grant; once approved, a re-request (echoing the
   *    approval id) vends credentials narrowed to exactly that operation.
   */
  async requestCredentials(id: string, input: CredentialRequest = {}): Promise<CredentialResponse> {
    const c = await this.getConnection(id);
    if (c.status !== "active") {
      throw new BrokerError("invalid_state", `cannot issue credentials for a ${c.status} connection`);
    }
    const account = await this.accountFor(c);

    // Poll path: the poppy is checking on an approval it was handed.
    if (input.approvalId) {
      const appr = await this.store.getApproval(input.approvalId);
      if (!appr || appr.connectionId !== id) throw new BrokerError("not_found", "approval not found");
      switch (appr.status) {
        case "pending":
          return { kind: "approval-required", approval: appr };
        case "denied":
          throw new BrokerError("invalid_state", "this operation was denied by the user");
        case "consumed":
          throw new BrokerError("invalid_state", "this approval has already been used — request again");
        case "expired":
          throw new BrokerError("invalid_state", "this approval expired — request again");
        case "approved": {
          const grants = appr.operation ? appr.operation.grants : c.permissionSet.grants;
          const creds = await this.vendScoped(c, account, grants);
          await this.store.updateApproval({ ...appr, status: "consumed" });
          return { kind: "credentials", credentials: creds };
        }
      }
    }

    const operation = input.operation ?? null;
    // An operation may never ask for more than the connection already grants.
    if (operation && !grantsSubsetOf(operation.grants, c.permissionSet.grants)) {
      throw new BrokerError("bad_request", "the operation requests access beyond this connection's permission set");
    }

    // A teardown in progress is itself the user's consent to remove everything, so its
    // (self-scoped) cleanup creds vend without a further per-operation approval.
    const needsApproval =
      (c.supervised ?? false) && !this.tearingDown.has(id) && (operation ? operationIsMutating(operation) : true);
    if (!needsApproval) {
      const grants = operation ? operation.grants : c.permissionSet.grants;
      const creds = await this.vendScoped(c, account, grants);
      return { kind: "credentials", credentials: creds };
    }

    // Converge on an existing decision for the SAME operation rather than stacking
    // duplicate approvals. A poppy whose mint was abandoned mid-wait (its deploy
    // call gave up while the user walked over to approve) re-requests with no
    // approvalId — without this, the just-approved request is orphaned and never
    // collected, so it asks forever and the approval is granted but never vends.
    const ts = this.now();
    const sameOp = (a: ApprovalRequest): boolean =>
      a.connectionId === id &&
      (!a.operation && !operation
        ? true
        : !!a.operation && !!operation && a.operation.summary === operation.summary);
    const mine = (await this.store.listApprovals()).filter(sameOp);
    // Only decisions still within their TTL count. A stale approval — e.g. one
    // approved in an earlier session whose vend then threw (so it was left
    // "approved", never consumed) — must NOT silently authorise a fresh request
    // hours later. Past its expiry it is treated as gone, so the user is prompted
    // again instead of the deploy proceeding on an old, unrelated approval.
    const fresh = (a: ApprovalRequest): boolean => Date.parse(a.expiresAt) > Date.parse(ts);

    // Already approved, unused, AND unexpired → honour it now, so a re-request right
    // after the user approves actually vends instead of parking a fresh request.
    const approved = mine.find((a) => a.status === "approved" && fresh(a));
    if (approved) {
      const grants = approved.operation ? approved.operation.grants : c.permissionSet.grants;
      const creds = await this.vendScoped(c, account, grants);
      await this.store.updateApproval({ ...approved, status: "consumed" });
      return { kind: "credentials", credentials: creds };
    }
    // Still pending and unexpired → hand back the SAME one; otherwise park a fresh
    // request. Find-or-create is ATOMIC (one store lock): a poppy that fires two
    // credential requests at once must converge on ONE approval — done as separate
    // check-then-add steps, both requests passed the check before either added, and
    // the user was shown two authorization prompts for a single open.
    const candidate: ApprovalRequest = {
      id: randomUUID(),
      connectionId: id,
      requestedAt: ts,
      operation,
      status: "pending",
      expiresAt: new Date(Date.parse(ts) + APPROVAL_TTL_MS).toISOString(),
    };
    const { approval, created } = await this.store.findOrAddApproval(
      candidate,
      (a) => sameOp(a) && a.status === "pending" && fresh(a),
    );
    if (created) await this.audit(id, "approval-requested", operation?.summary ?? "use its connection");
    return { kind: "approval-required", approval };
  }

  /**
   * Legacy/simple path: vend credentials, throwing if the connection is supervised
   * and the request would need approval. Kept for callers that don't speak the
   * approval protocol; new code should use {@link requestCredentials}.
   */
  async issueCredentials(id: string): Promise<ScopedCredentials> {
    const r = await this.requestCredentials(id, {});
    if (r.kind !== "credentials") {
      throw new BrokerError("invalid_state", "this connection is supervised — credentials require approval");
    }
    return r.credentials;
  }

  /** Vend credentials scoped to a specific set of grants (a clone keeps the real id/tags). */
  private async vendScoped(
    c: Connection,
    account: ConnectedAccount,
    grants: Connection["permissionSet"]["grants"],
  ): Promise<ScopedCredentials> {
    const scoped: Connection = { ...c, permissionSet: { ...c.permissionSet, grants } };
    const creds = await this.credentials.vend(scoped, account);
    // Record the session expiry so the UI can count down to the next re-mint.
    await this.store.putConnection({ ...c, credentialsExpireAt: creds.expiration });
    await this.audit(c.id, "credentials-issued", `expires ${creds.expiration}`);
    return creds;
  }

  private async decideApproval(
    approvalId: string,
    next: "approved" | "denied",
    auditType: string,
  ): Promise<ApprovalRequest> {
    const appr = await this.store.getApproval(approvalId);
    if (!appr) throw new BrokerError("not_found", `approval ${approvalId} not found`);
    // Same verdict twice (double-click, stale card) is a harmless no-op, not an error.
    if (appr.status === next) return appr;
    if (appr.status !== "pending") {
      throw new BrokerError(
        "invalid_state",
        appr.status === "expired"
          ? "this request expired before it was decided — if the app still needs access it will ask again"
          : `this request was already ${appr.status} — there's nothing left to decide`,
      );
    }
    const updated: ApprovalRequest = { ...appr, status: next, decidedAt: this.now() };
    await this.store.updateApproval(updated);
    await this.audit(appr.connectionId, auditType, appr.operation?.summary);
    return updated;
  }

  /** The per-app cloud footprint: CloudFormation stacks + this connection's ledger. */
  async getInventory(id: string): Promise<Inventory> {
    const c = await this.getConnection(id);
    const account = await this.accountFor(c);
    const [stacks, ledger] = await Promise.all([this.cloud.listStacks(c, account), readLedger()]);
    return { connectionId: id, stacks, ledger: ledgerForConnection(ledger, id) };
  }

  /**
   * Destroy what this app built: run its declared teardown hook (out-of-stack cleanup),
   * delete each of its stacks, let the HOST delete whatever the tag sweep still attributes
   * to the app, then verify nothing's left. The whole window runs with the
   * supervised-approval gate lifted for this connection (see {@link tearingDown}) so a hook
   * can mint its own self-scoped cleanup creds without prompting — the user already consented
   * by tearing down. `runHook` is the host's best-effort hook runner (the service stays pure of
   * extension/IO concerns); failures are swallowed so the generic stack delete + sweep — the
   * backstop — always run.
   *
   * The host-cleanup pass (`hostCleanup`, default ON) is what makes teardown COMPLETE in
   * every poppy state: a revoked/blocked/uninstalled poppy can't run its own hook, but its
   * tagged leftovers (RETAIN-marked buckets, tables, user pools) are still removed — by the
   * host, on operator credentials, with a live tag re-check before every deletion. Pass
   * `hostCleanup: false` to measure the poppy's OWN cleanliness instead (certification does
   * — the host backstop must not paper over a non-compliant poppy).
   */
  async teardown(
    id: string,
    opts: { runHook?: (connectionId: string) => Promise<void>; hostCleanup?: boolean } = {},
  ): Promise<{
    deletedStacks: string[];
    /** What the host-cleanup pass removed beyond the stacks. */
    removedResiduals: ResidualResource[];
    /** What's genuinely left after everything — with console links, never silent. */
    residuals: ResidualResource[];
    /** True when host cleanup hit AccessDenied, OR the tag sweep itself couldn't be read
     *  (so "no residuals" is unverified). Either way the fix is updating the operator's
     *  access policy, not retrying — and the UI must not claim the account is clean. */
    cleanupAuthProblem: boolean;
  }> {
    const c = await this.getConnection(id);
    const account = await this.accountFor(c);
    this.maintainFor(account);
    // Drifted-credential guard: the operator chain (env vars / default profile / SSO) can
    // silently point at a DIFFERENT AWS account than the one this connection was made
    // against — and the same app deployed there would carry the same tags, so the sweep
    // + tag re-check would happily destroy the OTHER account's deployment. STS
    // GetCallerIdentity needs no permissions, so it only fails when the credentials are
    // invalid — in which case every delete below fails the same way (nothing wrong is
    // deletable) and teardown proceeds to report those failures honestly.
    const who = await this.aws.getCallerIdentity(regionFor(account)).catch(() => null);
    if (who && who.accountId !== account.accountId) {
      throw new BrokerError(
        "invalid_state",
        `refusing to tear down: your AWS credentials belong to account ${who.accountId}, but ` +
          `${c.app.name} is connected to account ${account.accountId}. Fix the credentials ` +
          `(Connect your AWS → change credentials), then tear down again.`,
      );
    }
    this.tearingDown.add(id);
    const deletedStacks: string[] = [];
    let removedResiduals: ResidualResource[] = [];
    let cleanupAuthProblem = false;
    let residuals: ResidualResource[];
    try {
      if (opts.runHook) await opts.runHook(id).catch(() => {});
      const stacks = await this.cloud.listStacks(c, account);
      for (const s of stacks) {
        await this.cloud.deleteStack(c, account, s.stackName);
        deletedStacks.push(s.stackName);
      }
      // The generic tag sweep catches anything the stack delete didn't cover
      // (out-of-stack resources, partial-delete leftovers). A DENIED sweep must never
      // read as "clean": findResiduals throws AccountUnreadableError when no region
      // could be read — flag it so the UI never shows a green all-clear it can't prove.
      residuals = await this.cloud.findResiduals(c, account).catch(() => {
        cleanupAuthProblem = true;
        return [];
      });
      if ((opts.hostCleanup ?? true) && residuals.length > 0) {
        // Host cleanup: delete the leftovers ourselves — the poppy's cooperation is no
        // longer required for its footprint to actually go away.
        const report = await this.cloud
          .deleteResiduals(c, account, residuals)
          .catch(() => null); // engine unavailable → the raw sweep below stays the report
        if (report) {
          removedResiduals = report.removed;
          cleanupAuthProblem = cleanupAuthProblem || report.failed.some((f) => f.authError);
          // Verify re-sweep — but never let its (eventually-consistent) result override
          // first-hand knowledge: anything the engine FAILED to delete definitely still
          // exists, so the engine's honest remainder is UNIONED in, not just a fallback
          // for when the re-sweep throws. What the engine just removed is filtered out
          // (the lagging index would re-report it).
          const engineRemainder = [...report.failed.map((f) => f.residual), ...report.unsupported];
          const resweep = await this.cloud.findResiduals(c, account).catch(() => {
            cleanupAuthProblem = true;
            return [] as ResidualResource[];
          });
          const removedArns = new Set(removedResiduals.map((r) => r.arn));
          const seen = new Set<string>();
          residuals = [...resweep, ...engineRemainder]
            .filter((r) => !removedArns.has(r.arn))
            .filter((r) => (seen.has(r.arn) ? false : (seen.add(r.arn), true)));
        }
      }
      // Console deep links: the manual escape hatch for whatever the host couldn't remove.
      residuals = residuals.map((r) => ({ ...r, consoleUrl: r.consoleUrl ?? consoleUrlForArn(r.arn, r.region) }));
    } finally {
      this.tearingDown.delete(id);
    }
    await this.audit(
      id,
      "teardown",
      `deleted ${deletedStacks.length} stack(s)` +
        (removedResiduals.length ? `; host removed ${removedResiduals.length} leftover(s)` : "") +
        (residuals.length ? `; ${residuals.length} resource(s) still tagged` : ""),
    );
    return { deletedStacks, removedResiduals, residuals, cleanupAuthProblem };
  }

  /** The generic tag sweep on its own — every live resource still attributed to this app. */
  async getResiduals(id: string): Promise<ResidualResource[]> {
    const c = await this.getConnection(id);
    const account = await this.accountFor(c);
    return this.cloud.findResiduals(c, account);
  }

  /** The poppy's footprint as a verified graph (services + their wiring) — the infra map. */
  async getInfraGraph(id: string): Promise<InfraGraph> {
    const c = await this.getConnection(id);
    const account = await this.accountFor(c);
    try {
      return await this.cloud.buildInfraGraph(c, account);
    } catch (err) {
      // A blanket credentials/permission failure isn't an empty footprint — surface it as a
      // distinct code so the UI can prompt a reconnect instead of rendering a blank map.
      if (err instanceof AccountUnreadableError) throw new BrokerError("account_unreadable", err.message);
      throw err;
    }
  }

  async getAudit(id: string): Promise<AuditEntry[]> {
    await this.getConnection(id); // 404 if missing
    return this.store.getAudit(id);
  }

  /**
   * Recent account activity, attributed to a poppy / AgentsPoppy / external.
   * The point of interest is the `external` bucket: things that touched the
   * cloud *without* going through AgentsPoppy. Poppy events are enriched with
   * the app's name so the feed reads in plain language.
   */
  async getActivity(opts: { sinceMinutes?: number; limit?: number } = {}): Promise<ActivityReport> {
    const sinceMinutes = opts.sinceMinutes ?? 24 * 60;
    const limit = opts.limit ?? 100;

    const accounts = await this.store.listAccounts();
    this.maintainFor(accounts[0]);
    const brokerRoleName =
      accounts.map((a) => roleNameFromArn(a.roleArn)).find((n): n is string => !!n) ?? DEFAULT_ROLE_NAME;
    // Per-region; us-east-1 also collects global-service events (IAM, STS).
    const regions = [...new Set([...accounts.flatMap((a) => a.regions), "us-east-1"])];

    // Attribute the operator by its LIVE identity: users connect with their own IAM
    // user (rarely the canonical name), and misattributing the broker's own calls as
    // "external" poisons the feed's headline number.
    const operator = await this.operatorIdentity();
    const raw = await this.activity.recentActivity({
      brokerRoleName,
      operatorName: operator?.userName ?? DEFAULT_OPERATOR_NAME,
      operatorArn: operator?.arn,
      regions,
      sinceMinutes,
      limit,
    });

    const byId = new Map((await this.store.listConnections()).map((c) => [c.id, c]));
    const events = raw.map((e) => {
      if (e.actor.kind === "poppy" && e.actor.connectionId) {
        const name = byId.get(e.actor.connectionId)?.app.name;
        if (name) return { ...e, actor: { ...e.actor, label: name } };
      }
      return e;
    });

    return { events, summary: summarizeActivity(events) };
  }

  /**
   * What one poppy has actually done, from CloudTrail: the events attributed to the
   * connection's APP — keyed to the app rather than the connection id on purpose, since a
   * connection is superseded on scope drift (registry.reconcile) while the poppy and its
   * history continue. Without that, every re-approval would wipe the observed record at
   * exactly the moment the user is re-deciding.
   *
   * The default window is 7 days (the account feed's 24 h is about "what just happened";
   * this register is about "what does this poppy DO"). Raw events out — the pure
   * summariser lives in core (summarizeObserved) so every surface counts identically.
   *
   * Honest limit, stated where it is rendered rather than solved here: the CloudTrail
   * provider swallows per-region failures, so an empty result cannot distinguish a quiet
   * poppy from an unreadable trail.
   */
  async getConnectionActivity(
    id: string,
    opts: { sinceMinutes?: number; limit?: number } = {},
  ): Promise<{ events: ActivityEvent[]; sinceMinutes: number }> {
    const target = await this.getConnection(id);
    const sinceMinutes = opts.sinceMinutes ?? 7 * 24 * 60;
    const report = await this.getActivity({ sinceMinutes, limit: opts.limit ?? 250 });
    const appOf = new Map((await this.store.listConnections()).map((c) => [c.id, c.app.id]));
    const events = report.events.filter(
      (e) => e.actor.kind === "poppy" && e.actor.connectionId && appOf.get(e.actor.connectionId) === target.app.id,
    );
    return { events, sinceMinutes };
  }

  // --- internals ---

  /**
   * The operator's live caller identity for activity attribution, cached briefly —
   * the app polls the feed, and the identity only changes when the user re-submits
   * credentials (which invalidates the cache). A null (credentials unresolvable) is
   * cached for the same window: the feed's own CloudTrail read fails on the same
   * broken credentials, so hammering STS every poll buys nothing.
   */
  private operatorIdCache: { at: number; value: { userName?: string; arn: string } | null } | null = null;

  private async operatorIdentity(): Promise<{ userName?: string; arn: string } | null> {
    const TTL_MS = 5 * 60_000;
    if (this.operatorIdCache && Date.now() - this.operatorIdCache.at < TTL_MS) {
      return this.operatorIdCache.value;
    }
    const id = await this.aws.getCallerIdentity().catch(() => null);
    // IAM user ARNs can carry a path (arn:...:user/some/path/name) — CloudTrail's
    // userName field is always the bare final segment.
    const userName = id?.arn.match(/:user\/(?:.*\/)?([^/]+)$/)?.[1];
    const value = id ? { userName, arn: id.arn } : null;
    this.operatorIdCache = { at: Date.now(), value };
    return value;
  }

  /** The ConnectedAccount a connection belongs to (providers need its region + role). */
  private async accountFor(c: Connection): Promise<ConnectedAccount> {
    const accounts = await this.store.listAccounts();
    const account = accounts.find((a) => a.id === c.accountId);
    if (!account) throw new BrokerError("not_found", `account ${c.accountId} for connection ${c.id} not found`);
    return this.ensureRoleArn(account, accounts);
  }

  /**
   * Self-heal an account that reached the vend path with no broker role ARN — e.g. one
   * linked manually, re-pointed by the region switcher, or whose bootstrap recorded the
   * ARN only on a different region's row. The broker role's name is fixed
   * ({@link DEFAULT_ROLE_NAME}) and IAM is account-global, so the ARN is fully derivable
   * from the account id; deriving + persisting it once beats dead-ending every AWS call
   * with an opaque "account has no roleArn". (If that role doesn't actually exist or
   * isn't assumable, the AssumeRole itself then fails with a clear STS error instead.)
   * Prefers a role name already proven on a sibling account, else the default.
   */
  private async ensureRoleArn(account: ConnectedAccount, accounts: ConnectedAccount[]): Promise<ConnectedAccount> {
    if (account.roleArn) return account;
    const roleName =
      accounts.map((a) => roleNameFromArn(a.roleArn)).find((n): n is string => !!n) ?? DEFAULT_ROLE_NAME;
    const healed: ConnectedAccount = { ...account, roleArn: `arn:aws:iam::${account.accountId}:role/${roleName}` };
    await this.store.updateAccount(healed);
    return healed;
  }

  private async transition(
    id: string,
    allowed: ConnectionStatus[],
    next: ConnectionStatus,
    auditType: string,
    action: string,
  ): Promise<Connection> {
    const c = await this.getConnection(id);
    if (!allowed.includes(c.status)) {
      throw new BrokerError("invalid_state", `cannot ${action} a ${c.status} connection`);
    }
    const updated: Connection = { ...c, status: next, updatedAt: this.now() };
    await this.store.putConnection(updated);
    await this.audit(id, auditType);
    return updated;
  }

  private async audit(connectionId: string, type: string, detail?: string): Promise<void> {
    const entry: AuditEntry = { ts: this.now(), type, detail };
    await this.store.appendAudit(connectionId, entry);
  }
}
