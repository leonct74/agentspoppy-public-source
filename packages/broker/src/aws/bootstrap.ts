// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * AUTOMATED one-time setup: deploy the broker role + non-admin operator on the
 * user's behalf, using elevated *setup* credentials they paste once.
 *
 * Two properties matter above all else (the user's words): it must WORK, and it
 * must be RESUMABLE if interrupted for any reason. So the orchestrator keeps NO
 * local progress state — AWS is the single source of truth. Every Deploy/Resume
 * click reconciles reality:
 *
 *   1. the `AgentsPoppy` stack is created if missing, waited on if in-progress,
 *      and deleted+recreated if a previous attempt rolled back;
 *   2. the operator's access key is reconciled — stale/orphan keys deleted, one
 *      fresh key minted (the secret is returned exactly once by AWS, so we mint
 *      rather than try to recover a lost secret).
 *
 * The elevated setup credentials are used *in memory only* — they are passed in,
 * handed to the AWS clients for the duration of the run, and never persisted. The
 * ONLY credential written to disk is the resulting non-admin operator key
 * ({@link writeAgentsPoppyProfile}). An interrupted run therefore leaves no
 * elevated credential behind; resuming simply re-asks the user to paste it again.
 *
 * The raw AWS calls sit behind {@link BootstrapGateway} so the reconcile logic is
 * unit-tested as a pure state machine, with no AWS and no secrets on disk.
 */
import {
  operatorCredentials,
  readAgentsPoppyProfileKeyId,
  writeAgentsPoppyProfile,
  type AwsKeyInput,
} from "./credentials";
import { DEFAULT_OPERATOR_NAME, DEFAULT_ROLE_NAME, roleTemplateJson } from "./role-template";
import { STANDARD_REGIONS } from "./regions";
import type { CallerIdentity } from "./identity";
// Type-only — erased at compile time, so the SDK still loads lazily.
import type { CloudFormationClient } from "@aws-sdk/client-cloudformation";

/** The bootstrap stack's name. MUST stay `AgentsPoppy` so it matches the scoped
 *  access policy's `stack/AgentsPoppy/*` resource (infra/policies). */
export const BOOTSTRAP_STACK_NAME = "AgentsPoppy";

export interface BootstrapInput {
  /**
   * Elevated setup credentials — in-memory only, never persisted. Omit to reuse
   * the credentials the user already connected (their configured profile/chain),
   * so they aren't asked to paste keys a second time.
   */
  setup?: AwsKeyInput;
  /** Region the bootstrap stack lives in (IAM is global; CFN is regional). */
  region: string;
  /** If set, the run aborts unless the setup creds belong to this AWS account. */
  expectedAccountId?: string;
}

export interface BootstrapResult {
  /** The account the setup credentials belong to. */
  accountId: string;
  brokerRoleArn: string;
  operatorUserName: string;
  /** The freshly minted operator key id (the secret is written to the profile, not returned). */
  operatorAccessKeyId: string;
  /**
   * Set when this machine reused (joined) a setup that lives in another region —
   * nothing was created; this machine just received its own operator key.
   */
  joinedExistingSetupIn?: string;
  /**
   * Set when the operator user was at IAM's 2-access-key limit and the OLDEST key
   * had to be deleted to make room — the machine still holding it (if any) will
   * need to run setup again.
   */
  evictedAccessKeyId?: string;
}

export interface DescribedStack {
  status: string;
  outputs: Record<string, string>;
}

/** An operator access key as IAM reports it (creation time drives oldest-first eviction). */
export interface OperatorAccessKey {
  accessKeyId: string;
  createDate?: Date;
}

/** The AWS operations the bootstrap needs, all under the *setup* credentials. */
export interface BootstrapGateway {
  /** GetCallerIdentity — who do the setup credentials belong to? */
  whoAmI(): Promise<CallerIdentity>;
  /** Describe the bootstrap stack, or null if it does not exist. */
  describeStack(): Promise<DescribedStack | null>;
  createStack(templateBody: string): Promise<void>;
  /** Re-apply the template to an existing stack. A no-op (no diff) is NOT an error. */
  updateStack(templateBody: string): Promise<void>;
  deleteStack(): Promise<void>;
  /** The operator's existing access keys — ids + creation times (for oldest-first eviction). */
  listAccessKeys(userName: string): Promise<OperatorAccessKey[]>;
  deleteAccessKey(userName: string, accessKeyId: string): Promise<void>;
  createAccessKey(userName: string): Promise<{ accessKeyId: string; secretAccessKey: string }>;
  /**
   * Whether the named, account-GLOBAL IAM resources the setup stack would create already
   * exist. Used to give a clear message when a setup in another region already made them
   * (IAM names are unique per account, so a second region can't recreate them). Optional:
   * a gateway that can't check (no IAM read perm) simply omits it and we fall through.
   */
  findExistingBrokerResources?(): Promise<{ role: boolean; user: boolean }>;
  /**
   * Which region the existing setup stack lives in (best-effort, for the "already set up"
   * message — so we can tell the user exactly where to go back to). Null if not found.
   */
  findSetupStackRegion?(): Promise<string | null>;
  /**
   * Describe the bootstrap stack in ANOTHER region — used to JOIN a setup that already
   * lives elsewhere (second computer) instead of failing. Optional: without it the
   * cross-region case falls back to the guidance error.
   */
  describeStackInRegion?(region: string): Promise<DescribedStack | null>;
}

const IN_PROGRESS = /_IN_PROGRESS$/;
const COMPLETE = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"]);
// States a previous attempt can be stuck in that are unusable and must be cleared
// before we can recreate the stack.
const UNUSABLE = new Set([
  "ROLLBACK_COMPLETE",
  "ROLLBACK_FAILED",
  "CREATE_FAILED",
  "DELETE_FAILED",
]);

export interface BootstrapOptions {
  /** Injected for tests; defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; defaults to the real ~/.aws writer. */
  writeProfile?: (key: AwsKeyInput) => void;
  /**
   * Injected for tests; defaults to reading the `[agentspoppy]` profile. Which
   * operator key id THIS machine currently holds (null if none) — so re-setup
   * replaces only its own key and never bricks another computer's.
   */
  readLocalKeyId?: () => string | null;
  /** Poll cadence + ceiling for CloudFormation waits. */
  pollMs?: number;
  maxPolls?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run (or resume) the bootstrap to completion. Idempotent: safe to call again
 * after any interruption. Returns once the broker role exists and a fresh operator
 * key has been written to the `agentspoppy` profile.
 */
export async function runBootstrap(
  gw: BootstrapGateway,
  input: BootstrapInput,
  opts: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const writeProfile = opts.writeProfile ?? writeAgentsPoppyProfile;
  const readLocalKeyId = opts.readLocalKeyId ?? readAgentsPoppyProfileKeyId;
  const pollMs = opts.pollMs ?? 3000;
  const maxPolls = opts.maxPolls ?? 120; // 6 min ceiling at 3s — IAM stacks are fast

  // 0) Sanity: never deploy into the wrong account.
  const who = await gw.whoAmI();
  if (!who.accountId) throw new Error("Could not determine the AWS account for these credentials.");
  if (input.expectedAccountId && who.accountId !== input.expectedAccountId) {
    throw new Error(
      `These credentials are for account ${who.accountId}, but you're connecting account ${input.expectedAccountId}.`,
    );
  }

  // 1) Ensure the stack exists and is complete (resumable). If the setup already
  //    lives in ANOTHER region, this JOINS it (second computer) instead of failing.
  const { stack, joinedRegion } = await ensureStack(gw, who.accountId, who.arn, input.region, sleep, pollMs, maxPolls);
  const brokerRoleArn = stack.outputs.BrokerRoleArn;
  const operatorUserName = stack.outputs.OperatorUserName ?? DEFAULT_OPERATOR_NAME;
  if (!brokerRoleArn) {
    throw new Error("The setup stack completed but did not return a Broker Role ARN.");
  }

  // 2) Reconcile the operator access key — MULTI-DEVICE SAFE. The secret is shown
  //    by AWS exactly once, so this machine always mints a fresh key; but other
  //    machines' keys must survive, so we delete only (a) the key THIS machine
  //    already holds (it's being replaced) and (b), if the user is still at IAM's
  //    2-key limit, the OLDEST remaining key (most likely a lost/retired machine).
  const keys = await gw.listAccessKeys(operatorUserName);
  const localKeyId = readLocalKeyId();
  for (const k of keys) {
    if (localKeyId && k.accessKeyId === localKeyId) await gw.deleteAccessKey(operatorUserName, k.accessKeyId);
  }
  const others = keys
    .filter((k) => !(localKeyId && k.accessKeyId === localKeyId))
    .sort((a, b) => (a.createDate?.getTime() ?? 0) - (b.createDate?.getTime() ?? 0));
  let evictedAccessKeyId: string | undefined;
  while (others.length >= 2) {
    const oldest = others.shift()!;
    await gw.deleteAccessKey(operatorUserName, oldest.accessKeyId);
    evictedAccessKeyId = oldest.accessKeyId;
  }
  const key = await gw.createAccessKey(operatorUserName);
  // 3) Persist ONLY the non-admin operator key. (Setup creds are never written.)
  writeProfile({ accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey });

  return {
    accountId: who.accountId,
    brokerRoleArn,
    operatorUserName,
    operatorAccessKeyId: key.accessKeyId,
    ...(joinedRegion ? { joinedExistingSetupIn: joinedRegion } : {}),
    ...(evictedAccessKeyId ? { evictedAccessKeyId } : {}),
  };
}

/**
 * Detect — as cheaply as the caller's permissions allow — that AgentsPoppy is already set up
 * (its account-global role/user exist). Authenticating AS the operator user or broker role is
 * itself proof (needs no IAM read at all); otherwise probe IAM, falling through (→ all false)
 * if the credentials can't read it.
 */
async function detectExistingBroker(
  gw: BootstrapGateway,
  callerArn: string,
): Promise<{ role: boolean; user: boolean }> {
  if (callerArn.includes(`:user/${DEFAULT_OPERATOR_NAME}`) || callerArn.includes(`:role/${DEFAULT_ROLE_NAME}`)) {
    // You can only be these if a setup already created them.
    return { role: true, user: true };
  }
  return (await gw.findExistingBrokerResources?.().catch(() => null)) ?? { role: false, user: false };
}

/** Best-effort: which region the existing setup stack is in (null if we can't tell). */
async function findOriginRegion(gw: BootstrapGateway): Promise<string | null> {
  return (await gw.findSetupStackRegion?.().catch(() => null)) ?? null;
}

/**
 * The "already set up" guidance, in plain language, replacing the raw AWS error. Only reached
 * when the automatic cross-region JOIN couldn't run (usually: these credentials can't read the
 * setup stack where it lives) — so the advice centres on retrying with the right credentials.
 */
function alreadySetUpError(originRegion: string | null, thisRegion: string): Error {
  // Setup already exists right here in this region — nothing cross-region to explain; the user just
  // doesn't need to run setup (and these creds, e.g. the operator key, can't modify it anyway).
  if (originRegion && originRegion === thisRegion) {
    return new Error(
      `AgentsPoppy is already set up and running in ${thisRegion} — there's nothing to set up. ` +
        `You don't need to run setup again; just use AgentsPoppy as normal.`,
    );
  }
  const where = originRegion ? `in ${originRegion}` : "in another region";
  return new Error(
    `AgentsPoppy is already set up in this account — the setup lives ${where} and is still there. ` +
      `Setup exists once per AWS account (its role and user are account-wide, not per-region), and every computer shares it — there is nothing to set up again. ` +
      `This computer just tried to reuse that setup automatically, but couldn't read it ${where} with the credentials provided here. ` +
      `Click Deploy again using the same admin (or access-policy) credentials you used for the original setup${originRegion ? `, or switch the region to ${originRegion} and retry` : ""}. ` +
      `If you'd rather move the setup to ${thisRegion}, first delete the "${BOOTSTRAP_STACK_NAME}" stack ${where} (that removes the role and user too), then set up again here.`,
  );
}

async function ensureStack(
  gw: BootstrapGateway,
  accountId: string,
  callerArn: string,
  thisRegion: string,
  sleep: (ms: number) => Promise<void>,
  pollMs: number,
  maxPolls: number,
): Promise<{ stack: DescribedStack; joinedRegion?: string }> {
  let s = await gw.describeStack();

  // Mid-flight from a previous attempt → wait for it to settle.
  if (s && IN_PROGRESS.test(s.status)) s = await waitSettled(gw, sleep, pollMs, maxPolls);

  // A rolled-back/failed shell can never be updated into shape → clear it.
  if (s && UNUSABLE.has(s.status)) {
    await gw.deleteStack();
    s = await waitGone(gw, sleep, pollMs, maxPolls);
  }

  // Not there (or just cleared) → create it. Already complete → re-apply the
  // template so changes (e.g. a tightened guardrail) land on the next Deploy/Resume;
  // CloudFormation treats an identical template as a no-op (swallowed in the gateway).
  if (!s) {
    // No setup stack in THIS region. But the role + operator user it creates are account-GLOBAL
    // (IAM has no regions). If they already exist, a setup in another region made them, and
    // CloudFormation can't recreate the same names — the create fails (collision or, if you're
    // signed in as the operator, a plain AccessDenied on CreateStack) and OnFailure:DELETE wipes
    // the new stack. So: JOIN the existing setup instead — find where it lives, read its outputs
    // there, and carry on (this machine just needs its own operator key, minted below). The setup
    // is account-wide; a second computer never needs a second setup. Only when the join can't run
    // (can't locate/read the stack) do we fall back to the guidance error.
    const existing = await detectExistingBroker(gw, callerArn);
    if (existing.role || existing.user) {
      const origin = await findOriginRegion(gw);
      if (origin && origin !== thisRegion && gw.describeStackInRegion) {
        const there = await gw.describeStackInRegion(origin).catch(() => null);
        if (there && COMPLETE.has(there.status)) return { stack: there, joinedRegion: origin };
      }
      throw alreadySetUpError(origin, thisRegion);
    }
    try {
      await gw.createStack(roleTemplateJson({ operatorAccountId: accountId }));
    } catch (err) {
      // Backstop: a create that itself reports the collision (e.g. creds that CAN create but the
      // names are taken) still gets the friendly guidance rather than the raw "already exists".
      if (/already exists/i.test((err as Error).message ?? "")) {
        throw alreadySetUpError(await findOriginRegion(gw), thisRegion);
      }
      throw err;
    }
    s = await waitSettled(gw, sleep, pollMs, maxPolls);
  } else if (COMPLETE.has(s.status)) {
    try {
      await gw.updateStack(roleTemplateJson({ operatorAccountId: accountId }));
    } catch (err) {
      // The stack is already here and complete. If these creds simply can't modify it — e.g. the
      // operator/runtime key, which has no setup permissions — setup is already done; say so plainly
      // instead of surfacing a raw "not authorized: cloudformation:UpdateStack".
      if (/not authorized|access denied/i.test((err as Error).message ?? "")) {
        throw alreadySetUpError(thisRegion, thisRegion);
      }
      throw err;
    }
    s = await waitSettled(gw, sleep, pollMs, maxPolls);
  }

  if (!s || !COMPLETE.has(s.status)) {
    throw new Error(`The setup stack did not reach a completed state (status: ${s?.status ?? "deleted"}).`);
  }
  return { stack: s };
}

/** Poll until the stack is no longer in an *_IN_PROGRESS state (or gone). */
async function waitSettled(
  gw: BootstrapGateway,
  sleep: (ms: number) => Promise<void>,
  pollMs: number,
  maxPolls: number,
): Promise<DescribedStack | null> {
  for (let i = 0; i < maxPolls; i++) {
    const s = await gw.describeStack();
    if (!s || !IN_PROGRESS.test(s.status)) return s;
    await sleep(pollMs);
  }
  throw new Error("Timed out waiting for the setup stack to finish.");
}

/** Poll until the stack no longer exists. */
async function waitGone(
  gw: BootstrapGateway,
  sleep: (ms: number) => Promise<void>,
  pollMs: number,
  maxPolls: number,
): Promise<null> {
  for (let i = 0; i < maxPolls; i++) {
    const s = await gw.describeStack();
    if (!s || s.status === "DELETE_COMPLETE") return null;
    await sleep(pollMs);
  }
  throw new Error("Timed out waiting for the old setup stack to be removed.");
}

/**
 * Real gateway backed by the AWS SDK. If `setup` keys are given they're used for
 * the lifetime of the run only (in-memory, never persisted); otherwise it reuses
 * the operator's already-configured credentials (profile/chain) — so a user who
 * has already connected their AWS isn't asked to paste keys again. SDK imported
 * lazily so tests/demo stay offline.
 */
/** Describe the bootstrap stack via the given CFN client; null if it doesn't exist. */
async function describeBootstrapStack(client: CloudFormationClient): Promise<DescribedStack | null> {
  const { DescribeStacksCommand } = await import("@aws-sdk/client-cloudformation");
  try {
    const res = await client.send(new DescribeStacksCommand({ StackName: BOOTSTRAP_STACK_NAME }));
    const stack = res.Stacks?.[0];
    if (!stack) return null;
    const outputs: Record<string, string> = {};
    for (const o of stack.Outputs ?? []) if (o.OutputKey) outputs[o.OutputKey] = o.OutputValue ?? "";
    return { status: stack.StackStatus ?? "", outputs };
  } catch (err) {
    // CloudFormation answers "does not exist" with a ValidationError, not 404.
    if ((err as Error).message?.includes("does not exist")) return null;
    throw err;
  }
}

export function sdkBootstrapGateway(region: string, setup?: AwsKeyInput): BootstrapGateway {
  const resolveCreds = async () =>
    setup
      ? {
          accessKeyId: setup.accessKeyId.trim(),
          secretAccessKey: setup.secretAccessKey.trim(),
          ...(setup.sessionToken?.trim() ? { sessionToken: setup.sessionToken.trim() } : {}),
        }
      : operatorCredentials();

  async function cfn() {
    const { CloudFormationClient } = await import("@aws-sdk/client-cloudformation");
    return new CloudFormationClient({ region, credentials: await resolveCreds() });
  }
  async function iam() {
    const { IAMClient } = await import("@aws-sdk/client-iam");
    return new IAMClient({ region, credentials: await resolveCreds() });
  }

  return {
    async whoAmI() {
      const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
      const sts = new STSClient({ region, credentials: await resolveCreds() });
      const out = await sts.send(new GetCallerIdentityCommand({}));
      return { accountId: out.Account ?? "", arn: out.Arn ?? "", userId: out.UserId ?? "" };
    },

    async describeStack() {
      return describeBootstrapStack(await cfn());
    },

    async describeStackInRegion(r) {
      const { CloudFormationClient } = await import("@aws-sdk/client-cloudformation");
      return describeBootstrapStack(new CloudFormationClient({ region: r, credentials: await resolveCreds() }));
    },

    async createStack(templateBody) {
      const { CreateStackCommand } = await import("@aws-sdk/client-cloudformation");
      const client = await cfn();
      await client.send(
        new CreateStackCommand({
          StackName: BOOTSTRAP_STACK_NAME,
          TemplateBody: templateBody,
          // Named IAM resources (RoleName/UserName) require this explicit ack.
          Capabilities: ["CAPABILITY_NAMED_IAM"],
          Tags: [{ Key: "agentspoppy:bootstrap", Value: "true" }],
          OnFailure: "DELETE", // leave no rolled-back shell to clean up next time
        }),
      );
    },

    async updateStack(templateBody) {
      const { UpdateStackCommand } = await import("@aws-sdk/client-cloudformation");
      const client = await cfn();
      try {
        await client.send(
          new UpdateStackCommand({
            StackName: BOOTSTRAP_STACK_NAME,
            TemplateBody: templateBody,
            Capabilities: ["CAPABILITY_NAMED_IAM"],
            // Re-state tags: UpdateStack with none can drop the stack's existing tags.
            Tags: [{ Key: "agentspoppy:bootstrap", Value: "true" }],
          }),
        );
      } catch (err) {
        // An identical template means there's nothing to change — not a failure.
        if ((err as Error).message?.includes("No updates are to be performed")) return;
        throw err;
      }
    },

    async deleteStack() {
      const { DeleteStackCommand } = await import("@aws-sdk/client-cloudformation");
      const client = await cfn();
      await client.send(new DeleteStackCommand({ StackName: BOOTSTRAP_STACK_NAME }));
    },

    async listAccessKeys(userName) {
      const { ListAccessKeysCommand } = await import("@aws-sdk/client-iam");
      const client = await iam();
      const res = await client.send(new ListAccessKeysCommand({ UserName: userName }));
      return (res.AccessKeyMetadata ?? [])
        .filter((k) => k.AccessKeyId)
        .map((k) => ({ accessKeyId: k.AccessKeyId!, createDate: k.CreateDate }));
    },

    async deleteAccessKey(userName, accessKeyId) {
      const { DeleteAccessKeyCommand } = await import("@aws-sdk/client-iam");
      const client = await iam();
      await client.send(new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: accessKeyId }));
    },

    async createAccessKey(userName) {
      const { CreateAccessKeyCommand } = await import("@aws-sdk/client-iam");
      const client = await iam();
      const res = await client.send(new CreateAccessKeyCommand({ UserName: userName }));
      const k = res.AccessKey;
      if (!k?.AccessKeyId || !k?.SecretAccessKey) throw new Error("AWS did not return a new access key.");
      return { accessKeyId: k.AccessKeyId, secretAccessKey: k.SecretAccessKey };
    },

    async findExistingBrokerResources() {
      const { GetRoleCommand, GetUserCommand } = await import("@aws-sdk/client-iam");
      const client = await iam();
      // NoSuchEntity = the name is free (good). Any other error (e.g. AccessDenied) is
      // propagated so the caller treats the probe as inconclusive and falls through to create.
      const exists = async (cmd: object): Promise<boolean> => {
        try {
          await client.send(cmd as never);
          return true;
        } catch (err) {
          if ((err as { name?: string }).name === "NoSuchEntity") return false;
          throw err;
        }
      };
      const [role, user] = await Promise.all([
        exists(new GetRoleCommand({ RoleName: DEFAULT_ROLE_NAME })),
        exists(new GetUserCommand({ UserName: DEFAULT_OPERATOR_NAME })),
      ]);
      return { role, user };
    },

    async findSetupStackRegion() {
      const { CloudFormationClient, DescribeStacksCommand } = await import("@aws-sdk/client-cloudformation");
      const creds = await resolveCreds();
      const inRegion = async (r: string): Promise<string | null> => {
        try {
          const client = new CloudFormationClient({ region: r, credentials: creds });
          const res = await client.send(new DescribeStacksCommand({ StackName: BOOTSTRAP_STACK_NAME }));
          const status = res.Stacks?.[0]?.StackStatus ?? "";
          // A deleted/deleting shell doesn't count as "where it lives".
          return status && !status.startsWith("DELETE_") ? r : null;
        } catch {
          return null; // not here / region disabled / no read perm in this region → skip
        }
      };
      const hits = await Promise.all(STANDARD_REGIONS.map(inRegion));
      return hits.find((r): r is string => r !== null) ?? null;
    },
  };
}
