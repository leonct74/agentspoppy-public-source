// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { Store } from "./store";
import { BrokerError, BrokerService } from "./service";
import {
  StubActivityProvider,
  StubCloudProvider,
  StubCredentialVendor,
  type ActivityProvider,
  type CredentialVendor,
  type ScopedCredentials,
} from "./providers";
import { StubAwsBootstrap } from "./aws";
import type { DeletionReport } from "./aws/deletion";
import { ATTRIBUTION_TAG_KEYS, TAGGED_AS_SELF } from "@agentspoppy/core";
import type { AppIdentity, ConnectedAccount, Connection, PermissionGrant, PermissionSet, ResidualResource } from "@agentspoppy/core";

const app: AppIdentity = { id: "com.mailpoppy.desktop", name: "MailPoppy" };
const permissionSet: PermissionSet = {
  id: "mailpoppy.default",
  name: "MailPoppy",
  description: "",
  grants: [{ service: "s3", actions: ["CreateBucket"], resourceScope: TAGGED_AS_SELF }],
  requiredTags: [...ATTRIBUTION_TAG_KEYS],
  limits: null,
};

function service(): BrokerService {
  return new BrokerService({
    store: new Store(),
    credentials: new StubCredentialVendor(),
    cloud: new StubCloudProvider(),
    aws: new StubAwsBootstrap(),
    activity: new StubActivityProvider(),
  });
}

describe("BrokerService", () => {
  let home: string;

  beforeEach(() => {
    home = join(tmpdir(), `agentspoppy-svc-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.AGENTSPOPPY_HOME = home;
    process.env.AGENTSPOPPY_LEDGER = join(home, "ledger.json");
  });
  afterEach(async () => {
    delete process.env.AGENTSPOPPY_HOME;
    delete process.env.AGENTSPOPPY_LEDGER;
    await fs.rm(home, { recursive: true, force: true });
  });

  // The staleness check sits on the home screen, so it must never throw and never
  // send a brand-new user's first launch on a scan of every AWS region.
  describe("getSetupStatus", () => {
    it("answers 'absent' without touching AWS when no account is linked", async () => {
      let asked = false;
      const aws = new StubAwsBootstrap();
      aws.readSetupVersion = async () => {
        asked = true;
        throw new Error("should not be reached");
      };
      const s = new BrokerService({
        store: new Store(),
        credentials: new StubCredentialVendor(),
        cloud: new StubCloudProvider(),
        aws,
        activity: new StubActivityProvider(),
      });
      expect((await s.getSetupStatus()).state).toBe("absent");
      expect(asked).toBe(false);
    });

    it("reports 'unknown' rather than throwing when the read blows up", async () => {
      const aws = new StubAwsBootstrap();
      aws.readSetupVersion = async () => {
        throw new Error("the broker role could not be read");
      };
      const s = new BrokerService({
        store: new Store(),
        credentials: new StubCredentialVendor(),
        cloud: new StubCloudProvider(),
        aws,
        activity: new StubActivityProvider(),
      });
      await s.linkAccount({ accountId: "123456789012", regions: ["eu-west-1"] });
      const status = await s.getSetupStatus();
      expect(status.state).toBe("unknown");
      expect(status.reason).toContain("could not be read");
    });

    it("reads the deployed version for a linked account", async () => {
      const s = service();
      await s.linkAccount({ accountId: "123456789012", regions: ["eu-west-1"] });
      expect((await s.getSetupStatus()).state).toBe("current");
    });
  });

  it("happy path: link → request → approve → credentials", async () => {
    const s = service();
    const account = await s.linkAccount({ accountId: "123456789012", regions: ["eu-west-1"] });
    const conn = await s.requestConnection({ accountId: account.id, app, permissionSet });
    expect(conn.status).toBe("pending");

    expect((await s.approve(conn.id)).status).toBe("active");

    const creds = await s.issueCredentials(conn.id);
    expect(creds.accessKeyId).toContain(conn.id);
    // The session expiry is recorded on the connection so the UI can count down.
    expect((await s.getConnection(conn.id)).credentialsExpireAt).toBe(creds.expiration);

    expect((await s.getAudit(conn.id)).map((a) => a.type)).toEqual(["requested", "approved", "credentials-issued"]);
  });

  it("enforces status guards", async () => {
    const s = service();
    const account = await s.linkAccount({ accountId: "1", regions: [] });
    const conn = await s.requestConnection({ accountId: account.id, app, permissionSet });

    await expect(s.issueCredentials(conn.id)).rejects.toMatchObject({ code: "invalid_state" });

    await s.approve(conn.id);
    await s.pause(conn.id);
    await expect(s.issueCredentials(conn.id)).rejects.toMatchObject({ code: "invalid_state" });

    await s.resume(conn.id);
    expect((await s.getConnection(conn.id)).status).toBe("active");

    await s.revoke(conn.id);
    await expect(s.approve(conn.id)).rejects.toBeInstanceOf(BrokerError);
  });

  it("denies a pending connection", async () => {
    const s = service();
    const account = await s.linkAccount({ accountId: "1", regions: [] });
    const conn = await s.requestConnection({ accountId: account.id, app, permissionSet });
    expect((await s.deny(conn.id)).status).toBe("revoked");
  });

  it("forgets a revoked connection but refuses a live one", async () => {
    const s = service();
    const account = await s.linkAccount({ accountId: "1", regions: [] });
    const conn = await s.requestConnection({ accountId: account.id, app, permissionSet });
    await s.approve(conn.id);

    // An active connection can't be forgotten — it must be revoked first.
    await expect(s.forgetConnection(conn.id)).rejects.toMatchObject({ code: "invalid_state" });

    await s.revoke(conn.id);
    expect(await s.forgetConnection(conn.id)).toEqual({ ok: true });

    // It's gone from the list, and asking for it now 404s.
    expect(await s.listConnections()).toHaveLength(0);
    await expect(s.getConnection(conn.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("risk-tiered default: a connection that reaches beyond its own resources starts supervised", async () => {
    const s = service();
    const account = await s.linkAccount({ accountId: "1", regions: [] });

    // Fully self-scoped (tagged) → unsupervised by default.
    const scoped = await s.requestConnection({ accountId: account.id, app, permissionSet });
    expect(scoped.supervised).toBeFalsy();

    // Reaches beyond its own (a wildcard grant) → supervised by default, with an audit trail.
    const broad: PermissionSet = {
      ...permissionSet,
      grants: [{ service: "s3", actions: ["DeleteObject"], resourceScope: "*" }],
    };
    const conn = await s.requestConnection({ accountId: account.id, app, permissionSet: broad });
    expect(conn.supervised).toBe(true);
    expect((await s.getAudit(conn.id)).map((a) => a.type)).toContain("supervised-on");
  });

  it("flags a non-attributable permission set in the audit on request", async () => {
    const s = service();
    const account = await s.linkAccount({ accountId: "1", regions: [] });
    const wildcard: PermissionSet = {
      ...permissionSet,
      grants: [{ service: "iam", actions: ["CreateRole"], resourceScope: "*" }],
    };
    const conn = await s.requestConnection({ accountId: account.id, app, permissionSet: wildcard });
    const requested = (await s.getAudit(conn.id)).find((a) => a.type === "requested");
    expect(requested?.detail).toMatch(/not fully attributable/);
  });

  it("404s for unknown account / connection", async () => {
    const s = service();
    await expect(s.getConnection("nope")).rejects.toMatchObject({ code: "not_found" });
    await expect(s.requestConnection({ accountId: "nope", app, permissionSet })).rejects.toMatchObject({ code: "not_found" });
  });

  it("returns a per-connection inventory shape", async () => {
    const s = service();
    const account = await s.linkAccount({ accountId: "1", regions: [] });
    const conn = await s.requestConnection({ accountId: account.id, app, permissionSet });
    expect(await s.getInventory(conn.id)).toEqual({ connectionId: conn.id, stacks: [], ledger: [] });
  });

  // --- bootstrap ---

  it("exposes the operator identity", async () => {
    const s = service();
    expect((await s.getAwsIdentity()).accountId).toBe("123456789012");
  });

  it("builds a bootstrap template: broker role (trusted by the operator account) + minimal operator", async () => {
    const s = service();
    const account = await s.linkAccount({ accountId: "123456789012", regions: ["eu-west-1"] });

    const { operator, templateJson } = await s.roleTemplate(account.id);
    expect(operator.accountId).toBe("123456789012");
    const tpl = JSON.parse(templateJson) as {
      Resources: {
        AgentsPoppyRole: { Properties: { AssumeRolePolicyDocument: { Statement: { Principal: { AWS: string } }[] } } };
        AgentsPoppyOperator: { Type: string };
      };
    };
    // trust principal = operator account; a dedicated non-admin operator is provisioned;
    // the role carries the lockout guardrail.
    expect(tpl.Resources.AgentsPoppyRole.Properties.AssumeRolePolicyDocument.Statement[0]?.Principal.AWS).toContain("123456789012");
    expect(tpl.Resources.AgentsPoppyOperator.Type).toBe("AWS::IAM::User");
    expect(templateJson).toContain("CannotManageIamUsersOrAccount");
  });

  it("sets a role on an existing account", async () => {
    const s = service();
    const account = await s.linkAccount({ accountId: "1", regions: [] });
    expect(account.roleArn).toBeUndefined();
    const updated = await s.setAccountRoleArn(account.id, "arn:aws:iam::1:role/AgentsPoppy");
    expect(updated.roleArn).toBe("arn:aws:iam::1:role/AgentsPoppy");
    expect((await s.listAccounts()).find((a) => a.id === account.id)?.roleArn).toBe("arn:aws:iam::1:role/AgentsPoppy");
    await expect(s.setAccountRoleArn("nope", "x")).rejects.toMatchObject({ code: "not_found" });
  });

  it("self-heals a missing roleArn at vend time (derives the account-global broker role)", async () => {
    const s = service();
    // An account linked / region-switched without a roleArn — the state that left
    // MailPoppy unable to get credentials ("account … has no roleArn").
    const account = await s.linkAccount({ accountId: "123456789012", regions: ["eu-west-1"] });
    expect(account.roleArn).toBeUndefined();
    const conn = await s.requestConnection({ accountId: account.id, app, permissionSet });
    await s.approve(conn.id);

    // Vending no longer dead-ends: the deterministic broker-role ARN is derived and
    // persisted, so this and every later vend (and the UI) sees it.
    await s.issueCredentials(conn.id);
    expect((await s.listAccounts()).find((a) => a.id === account.id)?.roleArn).toBe(
      "arn:aws:iam::123456789012:role/AgentsPoppyBroker",
    );
  });

  it("re-points an account to a new region", async () => {
    const s = service();
    const account = await s.linkAccount({ accountId: "1", regions: ["us-east-1"] });
    const updated = await s.setAccountRegion(account.id, "eu-west-1");
    expect(updated.regions).toEqual(["eu-west-1"]);
    expect((await s.listAccounts()).find((a) => a.id === account.id)?.regions).toEqual(["eu-west-1"]);
    await expect(s.setAccountRegion(account.id, "  ")).rejects.toMatchObject({ code: "bad_request" });
    await expect(s.setAccountRegion("nope", "eu-west-1")).rejects.toMatchObject({ code: "not_found" });
  });

  it("verifies an account only when it has a role to assume", async () => {
    const s = service();
    const account = await s.linkAccount({ accountId: "1", regions: [] });
    await expect(s.verifyAccount(account.id)).rejects.toMatchObject({ code: "bad_request" });

    const withRole = await s.linkAccount({ accountId: "2", regions: [], roleArn: "arn:aws:iam::2:role/AgentsPoppy" });
    expect(await s.verifyAccount(withRole.id)).toMatchObject({ ok: true });
  });

  it("getActivity summarises and enriches poppy events with the app name", async () => {
    let connId = "";
    const activity: ActivityProvider = {
      async recentActivity() {
        return [
          { id: "e1", time: "2026-01-02T00:00:00Z", service: "s3", action: "CreateBucket",
            actor: { kind: "external", label: "IAM user deploy-bot" } },
          { id: "e2", time: "2026-01-01T00:00:00Z", service: "cloudformation", action: "CreateStack",
            actor: { kind: "poppy", label: "Connected app", connectionId: connId } },
        ];
      },
    };
    const s = new BrokerService({
      store: new Store(),
      credentials: new StubCredentialVendor(),
      cloud: new StubCloudProvider(),
      aws: new StubAwsBootstrap(),
      activity,
    });
    const account = await s.linkAccount({ accountId: "123456789012", regions: ["eu-west-1"] });
    const conn = await s.requestConnection({ accountId: account.id, app, permissionSet });
    connId = conn.id;

    const report = await s.getActivity();
    expect(report.summary).toEqual({ total: 2, external: 1, throughPoppies: 1, byAgentsPoppy: 0 });
    expect(report.events.find((e) => e.id === "e2")?.actor.label).toBe("MailPoppy");
  });

  it("getConnectionActivity keys on the APP, so history survives a superseded connection", async () => {
    // A connection is revoked and recreated whenever the declared scope drifts
    // (registry.reconcile). The poppy and its history continue, so the observed register
    // must follow the app — otherwise every re-approval would wipe the record at exactly
    // the moment the user is re-deciding.
    let oldId = "", otherId = "";
    const activity: ActivityProvider = {
      async recentActivity() {
        return [
          { id: "e1", time: "2026-01-02T00:00:00Z", service: "route53", action: "ChangeResourceRecordSets",
            actor: { kind: "poppy", label: "Connected app", connectionId: oldId } },
          { id: "e2", time: "2026-01-01T00:00:00Z", service: "s3", action: "CreateBucket",
            actor: { kind: "poppy", label: "Connected app", connectionId: otherId } },
          { id: "e3", time: "2026-01-01T00:00:00Z", service: "iam", action: "DeleteUser",
            actor: { kind: "external", label: "IAM user deploy-bot" } },
        ];
      },
    };
    const s = new BrokerService({
      store: new Store(), credentials: new StubCredentialVendor(), cloud: new StubCloudProvider(),
      aws: new StubAwsBootstrap(), activity,
    });
    const account = await s.linkAccount({ accountId: "123456789012", regions: ["eu-west-1"] });
    const old = await s.requestConnection({ accountId: account.id, app, permissionSet });
    oldId = old.id;
    const other = await s.requestConnection({
      accountId: account.id, app: { id: "com.other.app", name: "OtherPoppy" }, permissionSet,
    });
    otherId = other.id;
    // supersede: revoke the old connection, request a fresh one for the SAME app
    await s.revoke(old.id);
    const fresh = await s.requestConnection({ accountId: account.id, app, permissionSet });

    const r = await s.getConnectionActivity(fresh.id);
    // e1 belongs to this app (via its superseded connection); e2 is another poppy; e3 external
    expect(r.events.map((e) => e.id)).toEqual(["e1"]);
    expect(r.sinceMinutes).toBe(7 * 24 * 60);
    await expect(s.getConnectionActivity("nope")).rejects.toMatchObject({ code: "not_found" });
  });

  it("getActivity attributes the operator by its LIVE identity, not the canonical name", async () => {
    // Real users connect with an IAM user of their own naming (e.g. acmepoppy-3);
    // attribution must follow the actual caller or the broker's own calls (deploys,
    // teardowns) show up as external activity.
    let seen: Parameters<ActivityProvider["recentActivity"]>[0] | undefined;
    const activity: ActivityProvider = {
      async recentActivity(q) {
        seen = q;
        return [];
      },
    };
    const s = new BrokerService({
      store: new Store(),
      credentials: new StubCredentialVendor(),
      cloud: new StubCloudProvider(),
      // A pathed user ARN — CloudTrail's userName field is the bare final segment.
      aws: new StubAwsBootstrap({ accountId: "1", arn: "arn:aws:iam::1:user/team/acmepoppy-3", userId: "X" }),
      activity,
    });
    await s.getActivity();
    expect(seen?.operatorName).toBe("acmepoppy-3");
    expect(seen?.operatorArn).toBe("arn:aws:iam::1:user/team/acmepoppy-3");
  });

  // --- supervised mode (per-action approval) ---

  /** Captures the grants the vendor was asked to scope creds to (to assert narrowing). */
  class CapturingVendor implements CredentialVendor {
    lastGrants: PermissionGrant[] | null = null;
    async vend(connection: Connection): Promise<ScopedCredentials> {
      this.lastGrants = connection.permissionSet.grants;
      return {
        accessKeyId: `STUB-${connection.id}`,
        secretAccessKey: "s",
        sessionToken: "t",
        expiration: new Date(Date.now() + 3_600_000).toISOString(),
      };
    }
  }

  const supSet: PermissionSet = {
    ...permissionSet,
    grants: [
      { service: "cognito-idp", actions: ["ListUsers"], resourceScope: TAGGED_AS_SELF },
      { service: "cognito-idp", actions: ["DeleteUserPool"], resourceScope: TAGGED_AS_SELF },
    ],
  };

  function serviceWith(vendor: CredentialVendor): BrokerService {
    return new BrokerService({
      store: new Store(),
      credentials: vendor,
      cloud: new StubCloudProvider(),
      aws: new StubAwsBootstrap(),
      activity: new StubActivityProvider(),
    });
  }

  async function activeConn(s: BrokerService, ps: PermissionSet = supSet): Promise<Connection> {
    const account = await s.linkAccount({ accountId: "123456789012", regions: ["eu-west-1"] });
    const conn = await s.requestConnection({ accountId: account.id, app, permissionSet: ps });
    await s.approve(conn.id);
    return conn;
  }

  it("not supervised: vends immediately, scoped to the whole permission set", async () => {
    const s = service();
    const conn = await activeConn(s);
    const r = await s.requestCredentials(conn.id, {});
    expect(r.kind).toBe("credentials");
  });

  it("supervised + no operation declared: requires a session-level approval, then vends", async () => {
    const s = service();
    const conn = await activeConn(s);
    await s.setSupervised(conn.id, true);

    const first = await s.requestCredentials(conn.id, {});
    expect(first.kind).toBe("approval-required");
    if (first.kind !== "approval-required") throw new Error("unreachable");
    expect(first.approval.operation).toBeNull();

    // Still pending → still gated.
    const polled = await s.requestCredentials(conn.id, { approvalId: first.approval.id });
    expect(polled.kind).toBe("approval-required");

    await s.approveApproval(first.approval.id);
    const vended = await s.requestCredentials(conn.id, { approvalId: first.approval.id });
    expect(vended.kind).toBe("credentials");

    // A consumed approval can't be reused.
    await expect(s.requestCredentials(conn.id, { approvalId: first.approval.id })).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  // Regression: a poppy that fires two credential requests at once (two AWS calls at
  // open) must produce ONE approval prompt, not two. Before find-or-create was atomic,
  // both requests passed the "any pending?" check before either parked its approval.
  it("supervised: concurrent requests converge on a single approval", async () => {
    const s = service();
    const conn = await activeConn(s);
    await s.setSupervised(conn.id, true);

    const [a, b] = await Promise.all([s.requestCredentials(conn.id, {}), s.requestCredentials(conn.id, {})]);
    if (a.kind !== "approval-required" || b.kind !== "approval-required") throw new Error("unreachable");
    expect(a.approval.id).toBe(b.approval.id);
    expect((await s.listPendingApprovals()).length).toBe(1);
  });

  it("converges after approval: a re-request (abandoned poller) vends the already-approved one", async () => {
    const s = service();
    const conn = await activeConn(s);
    await s.setSupervised(conn.id, true);

    const first = await s.requestCredentials(conn.id, {});
    if (first.kind !== "approval-required") throw new Error("unreachable");
    await s.approveApproval(first.approval.id);

    // The poppy's original poll was abandoned; it re-requests with NO approvalId.
    // The broker honours the approved request instead of parking a new one.
    const again = await s.requestCredentials(conn.id, {});
    expect(again.kind).toBe("credentials");
    expect((await s.getAudit(conn.id)).map((a) => a.type)).toContain("credentials-issued");
    expect(await s.listPendingApprovals()).toHaveLength(0);
  });

  it("does NOT reuse a stale approval: an old approved-but-unconsumed one re-prompts", async () => {
    // Build the service with our own store so we can age an approval past its TTL —
    // the scenario that silently authorised a 2-hour-old deploy in the field.
    const store = new Store();
    const s = new BrokerService({
      store,
      credentials: new StubCredentialVendor(),
      cloud: new StubCloudProvider(),
      aws: new StubAwsBootstrap(),
      activity: new StubActivityProvider(),
    });
    const conn = await activeConn(s);
    await s.setSupervised(conn.id, true);

    // Approve a request but never consume it (mimics an earlier session whose vend threw).
    const first = await s.requestCredentials(conn.id, {});
    if (first.kind !== "approval-required") throw new Error("unreachable");
    await s.approveApproval(first.approval.id);
    const stale = (await store.listApprovals()).find((a) => a.id === first.approval.id)!;
    await store.updateApproval({ ...stale, expiresAt: new Date(Date.now() - 60_000).toISOString() });

    // A fresh, no-approvalId request must NOT vend off the stale approval — it parks
    // a NEW one so the user is prompted (and notified) again.
    const again = await s.requestCredentials(conn.id, {});
    expect(again.kind).toBe("approval-required");
    if (again.kind !== "approval-required") throw new Error("unreachable");
    expect(again.approval.id).not.toBe(first.approval.id);
    expect(await s.listPendingApprovals()).toHaveLength(1);
  });

  it("dedupes pending approvals: re-requesting returns the same one, not a stack", async () => {
    const s = service();
    const conn = await activeConn(s);
    await s.setSupervised(conn.id, true);

    const a = await s.requestCredentials(conn.id, {});
    const b = await s.requestCredentials(conn.id, {});
    if (a.kind !== "approval-required" || b.kind !== "approval-required") throw new Error("unreachable");
    expect(b.approval.id).toBe(a.approval.id);
    expect(await s.listPendingApprovals()).toHaveLength(1);
  });

  it("supervised + read-only operation: vends immediately (reads stay un-gated)", async () => {
    const s = service();
    const conn = await activeConn(s);
    await s.setSupervised(conn.id, true);

    const r = await s.requestCredentials(conn.id, {
      operation: { summary: "List mailboxes", grants: [{ service: "cognito-idp", actions: ["ListUsers"], resourceScope: TAGGED_AS_SELF }] },
    });
    expect(r.kind).toBe("credentials");
    expect(await s.listPendingApprovals()).toHaveLength(0);
  });

  it("supervised + mutating operation: approval required, and the vended creds are narrowed to it", async () => {
    const vendor = new CapturingVendor();
    const s = serviceWith(vendor);
    const conn = await activeConn(s);
    await s.setSupervised(conn.id, true);

    const op = { summary: "Delete user pool 'acme-users'", grants: [{ service: "cognito-idp", actions: ["DeleteUserPool"], resourceScope: TAGGED_AS_SELF }] };
    const req = await s.requestCredentials(conn.id, { operation: op });
    expect(req.kind).toBe("approval-required");
    if (req.kind !== "approval-required") throw new Error("unreachable");
    expect(req.approval.operation?.summary).toContain("acme-users");
    expect(await s.listPendingApprovals()).toHaveLength(1);

    await s.approveApproval(req.approval.id);
    const vended = await s.requestCredentials(conn.id, { approvalId: req.approval.id });
    expect(vended.kind).toBe("credentials");
    // Narrowed: only the approved DeleteUserPool grant, not the connection's full set.
    expect(vendor.lastGrants).toEqual(op.grants);
  });

  it("supervised: a teardown hook's mutating creds vend WITHOUT approval, only during teardown", async () => {
    const s = service();
    const conn = await activeConn(s);
    await s.setSupervised(conn.id, true);
    const deleteOp = { summary: "Delete user pool", grants: [{ service: "cognito-idp", actions: ["DeleteUserPool"], resourceScope: TAGGED_AS_SELF }] };

    // Inside the teardown window, the hook can mint its self-scoped cleanup creds straight away.
    let insideKind: string | undefined;
    await s.teardown(conn.id, {
      runHook: async (id) => {
        insideKind = (await s.requestCredentials(id, { operation: deleteOp })).kind;
      },
    });
    expect(insideKind).toBe("credentials");
    expect(await s.listPendingApprovals()).toHaveLength(0);

    // Outside teardown, the same mutating op is gated again (the bypass is window-scoped).
    const after = await s.requestCredentials(conn.id, { operation: deleteOp });
    expect(after.kind).toBe("approval-required");
  });

  it("supervised + denied operation: the poppy's next poll fails", async () => {
    const s = service();
    const conn = await activeConn(s);
    await s.setSupervised(conn.id, true);

    const req = await s.requestCredentials(conn.id, {
      operation: { summary: "Delete pool", grants: [{ service: "cognito-idp", actions: ["DeleteUserPool"], resourceScope: TAGGED_AS_SELF }] },
    });
    if (req.kind !== "approval-required") throw new Error("unreachable");
    await s.denyApproval(req.approval.id);
    await expect(s.requestCredentials(conn.id, { approvalId: req.approval.id })).rejects.toMatchObject({
      code: "invalid_state",
    });
  });

  it("refuses an operation that asks for more than the connection grants", async () => {
    const s = service();
    const conn = await activeConn(s);
    await s.setSupervised(conn.id, true);
    await expect(
      s.requestCredentials(conn.id, {
        // broader scope ("*") than the connection's tag-scope → escalation
        operation: { summary: "Delete ANY pool", grants: [{ service: "cognito-idp", actions: ["DeleteUserPool"], resourceScope: "*" }] },
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("setSupervised toggles the flag and audits it", async () => {
    const s = service();
    const conn = await activeConn(s);
    expect((await s.setSupervised(conn.id, true)).supervised).toBe(true);
    expect((await s.setSupervised(conn.id, false)).supervised).toBe(false);
    const types = (await s.getAudit(conn.id)).map((a) => a.type);
    expect(types).toContain("supervised-on");
    expect(types).toContain("supervised-off");
  });

  describe("teardown host cleanup", () => {
    const leftover = (arn: string): ResidualResource => ({ arn, resourceType: "s3", region: "eu-west-1" });

    /** Sweep returns `first` until the engine runs, then `second`; the engine's report is canned. */
    class HostCleanupCloud extends StubCloudProvider {
      engineCalls: ResidualResource[][] = [];
      constructor(
        private readonly first: ResidualResource[],
        private readonly second: ResidualResource[],
        private readonly report: DeletionReport,
      ) {
        super();
      }
      override async findResiduals(): Promise<ResidualResource[]> {
        return this.engineCalls.length === 0 ? this.first : this.second;
      }
      override async deleteResiduals(_c: Connection, _a: ConnectedAccount, residuals: ResidualResource[]): Promise<DeletionReport> {
        this.engineCalls.push(residuals);
        return this.report;
      }
    }

    function serviceWith(cloud: StubCloudProvider): BrokerService {
      return new BrokerService({
        store: new Store(),
        credentials: new StubCredentialVendor(),
        cloud,
        aws: new StubAwsBootstrap(),
        activity: new StubActivityProvider(),
      });
    }

    it("runs the host engine on the sweep's residuals and reports what it removed", async () => {
      const bucket = leftover("arn:aws:s3:::mail-bucket");
      const cloud = new HostCleanupCloud([bucket], [bucket] /* index still lags */, {
        removed: [bucket],
        failed: [],
        unsupported: [],
      });
      const s = serviceWith(cloud);
      const conn = await activeConn(s);
      const out = await s.teardown(conn.id);
      expect(cloud.engineCalls).toEqual([[bucket]]); // engine got exactly the sweep's residuals
      expect(out.removedResiduals).toEqual([bucket]);
      // The lagging re-sweep still lists the bucket, but it was just removed — not a leftover.
      expect(out.residuals).toEqual([]);
      expect(out.cleanupAuthProblem).toBe(false);
      expect((await s.getAudit(conn.id)).map((a) => a.detail).join(" ")).toContain("host removed 1 leftover(s)");
    });

    it("reports genuine leftovers with console links, and flags a permissions problem", async () => {
      const pool: ResidualResource = {
        arn: "arn:aws:cognito-idp:eu-west-1:123:userpool/eu-west-1_AbC",
        resourceType: "cognito-idp:userpool",
        region: "eu-west-1",
      };
      const cloud = new HostCleanupCloud([pool], [pool], {
        removed: [],
        failed: [{ residual: pool, error: "AccessDenied", authError: true }],
        unsupported: [],
      });
      const s = serviceWith(cloud);
      const conn = await activeConn(s);
      const out = await s.teardown(conn.id);
      expect(out.removedResiduals).toEqual([]);
      expect(out.cleanupAuthProblem).toBe(true);
      expect(out.residuals).toHaveLength(1);
      // The manual escape hatch: every reported leftover carries a console deep link.
      expect(out.residuals[0].consoleUrl).toContain("console.aws.amazon.com");
    });

    it("hostCleanup:false skips the engine entirely (certification measures the poppy, not the host)", async () => {
      const bucket = leftover("arn:aws:s3:::mail-bucket");
      const cloud = new HostCleanupCloud([bucket], [], { removed: [bucket], failed: [], unsupported: [] });
      const s = serviceWith(cloud);
      const conn = await activeConn(s);
      const out = await s.teardown(conn.id, { hostCleanup: false });
      expect(cloud.engineCalls).toEqual([]); // never invoked
      expect(out.removedResiduals).toEqual([]);
      expect(out.residuals.map((r) => r.arn)).toEqual([bucket.arn]);
    });

    it("a failed deletion stays reported even when the lagging re-sweep omits it", async () => {
      // The engine KNOWS the delete failed (the resource exists); an eventually-consistent
      // re-sweep that returns [] must not turn that into a false "your account is clean".
      const bucket = leftover("arn:aws:s3:::stuck-bucket");
      const cloud = new HostCleanupCloud([bucket], [] /* re-sweep under-reports */, {
        removed: [],
        failed: [{ residual: bucket, error: "DeleteBucket conflict", authError: false }],
        unsupported: [],
      });
      const s = serviceWith(cloud);
      const conn = await activeConn(s);
      const out = await s.teardown(conn.id);
      expect(out.residuals.map((r) => r.arn)).toEqual([bucket.arn]); // unioned, not dropped
      expect(out.cleanupAuthProblem).toBe(false);
    });

    it("a denied tag sweep never reads as clean — it flags the auth problem instead", async () => {
      class DeniedSweepCloud extends StubCloudProvider {
        override async findResiduals(): Promise<ResidualResource[]> {
          throw new Error("couldn't read the tag index in any region");
        }
      }
      const s = serviceWith(new DeniedSweepCloud());
      const conn = await activeConn(s);
      const out = await s.teardown(conn.id);
      expect(out.residuals).toEqual([]);
      expect(out.cleanupAuthProblem).toBe(true); // "clean" is unverified → the UI must not claim it
    });

    it("refuses to tear down when the operator credentials belong to a DIFFERENT account", async () => {
      class RecordingCloud extends StubCloudProvider {
        stackDeletes = 0;
        override async listStacks(): Promise<never[]> {
          return [];
        }
        override async deleteStack(): Promise<void> {
          this.stackDeletes++;
        }
      }
      const cloud = new RecordingCloud();
      const s = new BrokerService({
        store: new Store(),
        credentials: new StubCredentialVendor(),
        cloud,
        // Drifted chain: creds resolve to another account than the one the connection targets.
        aws: new StubAwsBootstrap({ accountId: "999999999999", arn: "arn:aws:iam::999999999999:user/other", userId: "OTHER" }),
        activity: new StubActivityProvider(),
      });
      const conn = await activeConn(s);
      await expect(s.teardown(conn.id)).rejects.toMatchObject({ code: "invalid_state" });
      expect(cloud.stackDeletes).toBe(0); // nothing was touched in the wrong account
    });
  });
});
