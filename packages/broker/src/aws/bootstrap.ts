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
import { BOUNDARY_POLICY_NAME, DEFAULT_OPERATOR_NAME, DEFAULT_ROLE_NAME, roleTemplateJson } from "./role-template";
import { setupVersionStatus, type SetupStackRead, type SetupVersionStatus } from "./setup-version";
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
  /**
   * Set when the run connected this machine but could NOT re-apply the template — the
   * credentials in hand weren't allowed to update the stack where it lives. The setup still
   * works; it is simply still the old version, and saying so is the whole point.
   */
  setupNotUpdated?: boolean;
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
  /**
   * The reason CloudFormation gives for the first failed resource — the difference between
   * "the update didn't work" and "the key you used is missing iam:CreatePolicy". Optional:
   * without it the guidance names the most likely cause rather than the actual one.
   */
  describeFailureReason?(region?: string): Promise<string | null>;
  /**
   * Re-apply the template to the stack in ANOTHER region. The bootstrap stack is regional but
   * the setup it creates is account-global, so a machine whose configured region differs from
   * the stack's must still be able to UPDATE it — otherwise "re-apply setup" is a no-op for
   * that user and there is no in-app path to their guardrails at all.
   */
  updateStackInRegion?(region: string, templateBody: string): Promise<void>;
}

const IN_PROGRESS = /_IN_PROGRESS$/;
const COMPLETE = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"]);
// States a previous attempt can be stuck in that are unusable and must be cleared
// before we can recreate the stack.
/** An update that ended here changed nothing: the previous template is still deployed. */
const ROLLED_BACK = new Set(["UPDATE_ROLLBACK_COMPLETE", "UPDATE_ROLLBACK_FAILED"]);

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
  const { stack, joinedRegion, notUpdated } = await ensureStack(
    gw,
    who.accountId,
    who.arn,
    input.region,
    sleep,
    pollMs,
    maxPolls,
  );
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
    ...(notUpdated ? { setupNotUpdated: true } : {}),
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

/**
 * The credentials in hand cannot modify an existing, complete setup stack. Whether that is
 * good news or bad news depends entirely on whether the deployed setup is CURRENT — so say
 * which, rather than reassuring everyone equally.
 */
function cannotUpdateStackError(status: SetupVersionStatus, region: string): Error {
  if (status.state === "current") {
    return new Error(
      `AgentsPoppy is already set up in ${region} and up to date (setup version ${status.deployed}) — ` +
        `there's nothing to set up. You don't need to run setup again; just use AgentsPoppy as normal.`,
    );
  }
  const which =
    status.state === "outdated"
      ? `Your setup is version ${status.deployed}; this version of AgentsPoppy expects ${status.expected}.`
      : `AgentsPoppy couldn't tell which setup version you have${status.reason ? ` (${status.reason})` : ""}.`;
  return new Error(
    `Your AgentsPoppy setup needs updating, but these credentials aren't allowed to change it. ${which} ` +
      `The credentials on this machine are the non-admin operator, which deliberately can't modify the setup — ` +
      `that's what stops a connected app rewriting its own guardrails. ` +
      `Click "Use different credentials for this step" and paste your admin keys, or a key carrying the ` +
      `AgentsPoppy access policy, then re-apply setup. Nothing else changes: it's an in-place update.`,
  );
}

/**
 * Read the deployed bootstrap stack's outputs, wherever it lives, for the staleness check.
 * Read-only and permission-cheap: the operator already holds `cloudformation:DescribeStacks`.
 *
 * Every failure mode is reported as itself. In particular a stack that cannot be READ is
 * never reported as absent or current — see setup-version.ts.
 */
export async function readSetupStack(gw: BootstrapGateway, thisRegion: string): Promise<SetupStackRead> {
  let here: DescribedStack | null;
  try {
    here = await gw.describeStack();
  } catch (err) {
    return { ok: false, kind: "unreadable", reason: readFailureReason(err) };
  }
  if (here && !here.status.startsWith("DELETE_")) {
    return IN_PROGRESS.test(here.status) ? { ok: false, kind: "pending" } : { ok: true, outputs: here.outputs };
  }

  // Setup is account-GLOBAL but its stack is regional, so "not in this region" does not mean
  // "not set up" — a second machine, or a user who changed region, has it elsewhere.
  const origin = (await gw.findSetupStackRegion?.().catch(() => null)) ?? null;
  if (origin && origin !== thisRegion && gw.describeStackInRegion) {
    try {
      const there = await gw.describeStackInRegion(origin);
      if (there && !there.status.startsWith("DELETE_")) {
        return IN_PROGRESS.test(there.status) ? { ok: false, kind: "pending" } : { ok: true, outputs: there.outputs };
      }
    } catch (err) {
      return { ok: false, kind: "unreadable", reason: readFailureReason(err) };
    }
  }
  return { ok: false, kind: "absent" };
}

/** A plain-language reason, because it is shown to the user verbatim. */
function readFailureReason(err: unknown): string {
  const msg = (err as Error)?.message ?? "";
  if (/not authorized|access denied|explicit deny/i.test(msg)) {
    return "these AWS credentials aren't allowed to read the setup stack";
  }
  if (/expired|invalid.*token|signature/i.test(msg)) return "these AWS credentials are expired or invalid";
  return msg.trim() || "the setup stack could not be read";
}

/**
 * Why the re-apply rolled back, in words the user can act on.
 *
 * The likeliest cause is worth naming even when the events can't be read: the setup policy
 * gained `iam:CreatePolicy` when the template gained a managed policy, and nothing updates a
 * policy already attached inside a user's IAM. So every user who followed the least-privilege
 * advice holds a policy one statement short of what their next re-apply needs — and since
 * `cloudformation:UpdateStack` itself IS permitted, the API call succeeds and CloudFormation
 * fails asynchronously. This is the only place they can be told.
 */
async function updateRolledBackMessage(gw: BootstrapGateway, region?: string): Promise<string> {
  const reason = (await gw.describeFailureReason?.(region).catch(() => null)) ?? null;
  const looksLikePermissions = reason === null || /not authorized|access denied|explicit deny/i.test(reason);
  return (
    "The setup update was rolled back by AWS, so nothing changed — your AgentsPoppy setup is " +
    "still the previous version." +
    (reason ? ` AWS said: ${reason}` : "") +
    (looksLikePermissions
      ? ` The usual cause is an older AgentsPoppy access policy on the key you used: this setup needs ` +
        `"iam:CreatePolicy" on arn:aws:iam::*:policy/${BOUNDARY_POLICY_NAME}, which earlier versions of ` +
        `the policy did not grant. That permission exists to create one new protection — the ` +
        `${BOUNDARY_POLICY_NAME} policy, a ceiling that caps any IAM role a connected app creates. ` +
        `Replace the AgentsPoppy policy on that IAM user with the current version (the app's ` +
        `"Copy the policy" button has it), then re-apply setup.`
      : "")
  );
}

/**
 * Re-apply the template to a stack that lives in another region, then wait for it there.
 *
 * Degrades rather than blocks: a second computer signing in with credentials that cannot
 * update the stack still needs its own operator key, so a refusal is reported (`notUpdated`)
 * instead of thrown. What must never happen is applying nothing and calling it success.
 */
async function reapplyInOriginRegion(
  gw: BootstrapGateway,
  origin: string,
  accountId: string,
  current: DescribedStack,
  sleep: (ms: number) => Promise<void>,
  pollMs: number,
  maxPolls: number,
): Promise<{ stack: DescribedStack; notUpdated?: boolean }> {
  if (!gw.updateStackInRegion || !gw.describeStackInRegion) return { stack: current, notUpdated: true };
  try {
    await gw.updateStackInRegion(origin, roleTemplateJson({ operatorAccountId: accountId }));
  } catch {
    // Denied / unreachable — the join still stands, but nothing was applied.
    return { stack: current, notUpdated: true };
  }
  let settled: DescribedStack | null = null;
  for (let i = 0; i < maxPolls && !settled; i++) {
    const s = await gw.describeStackInRegion(origin).catch(() => null);
    if (s && !IN_PROGRESS.test(s.status)) settled = s;
    else await sleep(pollMs);
  }
  // Never fall back to the PRE-update stack on a timeout: that would report the old template
  // as the outcome of an update we have no result for — success by default, which is the
  // failure mode this whole pass is closing.
  if (!settled) throw new Error(`Timed out waiting for the setup stack in ${origin} to finish updating.`);
  if (ROLLED_BACK.has(settled.status)) throw new Error(await updateRolledBackMessage(gw, origin));
  return { stack: settled };
}

async function ensureStack(
  gw: BootstrapGateway,
  accountId: string,
  callerArn: string,
  thisRegion: string,
  sleep: (ms: number) => Promise<void>,
  pollMs: number,
  maxPolls: number,
): Promise<{ stack: DescribedStack; joinedRegion?: string; notUpdated?: boolean }> {
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
        if (there && COMPLETE.has(there.status)) {
          // Joining is not the same as leaving it alone. The template is re-applied THERE, so
          // a user whose configured region differs from their stack's still gets their
          // guardrails updated — without this, "re-apply setup" silently changed nothing and
          // then reported success, and no path through the app could ever fix them.
          const applied = await reapplyInOriginRegion(gw, origin, accountId, there, sleep, pollMs, maxPolls);
          return { stack: applied.stack, joinedRegion: origin, ...(applied.notUpdated ? { notUpdated: true } : {}) };
        }
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
      // The stack is already here and complete, and these credentials can't modify it — almost
      // always the operator/runtime key, which deliberately has no setup permissions.
      //
      // This used to translate to a flat "there's nothing to set up", which is TRUE for someone
      // who re-ran setup out of caution and FALSE — dangerously so — for someone who came here
      // from the "your broker role is out of date" banner: they'd be reassured that everything
      // was fine while nothing had changed. We know the deployed version here, so answer the
      // question they actually have. (docs/specs/broker-role-v2.md)
      if (/not authorized|access denied/i.test((err as Error).message ?? "")) {
        throw cannotUpdateStackError(setupVersionStatus({ ok: true, outputs: s.outputs }), thisRegion);
      }
      throw err;
    }
    s = await waitSettled(gw, sleep, pollMs, maxPolls);
    // An update CloudFormation ROLLED BACK left the old template in place — the guardrails we
    // were re-applying are still not there. UPDATE_ROLLBACK_COMPLETE is a perfectly good state
    // to *find* a stack in, which is why it lives in COMPLETE; as the verdict on an update we
    // just started it means failure. Reporting it as success is how a user ends up in an
    // "update → done → still out of date" loop and is never told why.
    if (s && ROLLED_BACK.has(s.status)) throw new Error(await updateRolledBackMessage(gw));
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

    async updateStackInRegion(r, templateBody) {
      const { CloudFormationClient, UpdateStackCommand } = await import("@aws-sdk/client-cloudformation");
      const client = new CloudFormationClient({ region: r, credentials: await resolveCreds() });
      try {
        await client.send(
          new UpdateStackCommand({
            StackName: BOOTSTRAP_STACK_NAME,
            TemplateBody: templateBody,
            Capabilities: ["CAPABILITY_NAMED_IAM"],
            Tags: [{ Key: "agentspoppy:bootstrap", Value: "true" }],
          }),
        );
      } catch (err) {
        if ((err as Error).message?.includes("No updates are to be performed")) return;
        throw err;
      }
    },

    async describeFailureReason(r) {
      // Best-effort: the SETUP credentials run the update, and both the admin path and the
      // scoped access policy hold cloudformation:DescribeStackEvents on stack/AgentsPoppy/*.
      // A failure here just means the caller falls back to naming the likeliest cause.
      // The region matters: a cross-region re-apply's events are in the STACK's region.
      const { CloudFormationClient, DescribeStackEventsCommand } = await import("@aws-sdk/client-cloudformation");
      const client = r ? new CloudFormationClient({ region: r, credentials: await resolveCreds() }) : await cfn();
      const res = await client.send(new DescribeStackEventsCommand({ StackName: BOOTSTRAP_STACK_NAME }));
      // Events are newest-first, so the newest *_FAILED is the one that caused THIS rollback.
      // The stack-level event just says "resource(s) failed"; the resource-level one names it.
      const failed = (res.StackEvents ?? []).filter(
        (e) => e.ResourceStatus?.endsWith("_FAILED") && e.ResourceStatusReason,
      );
      const named = failed.find((e) => e.ResourceType !== "AWS::CloudFormation::Stack") ?? failed[0];
      if (!named?.ResourceStatusReason) return null;
      const where = named.LogicalResourceId ? `${named.LogicalResourceId}: ` : "";
      return `${where}${named.ResourceStatusReason}`;
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
