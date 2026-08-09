// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Real credential vending via STS AssumeRole.
 *
 * The vend is a TWO-HOP role chain, so the operator stays minimal — its only STS
 * power is the plain `sts:AssumeRole` it was bootstrapped with:
 *
 *  1. The operator (creds resolved from the local AWS provider chain — env, shared
 *     config, SSO — and never stored) assumes the broker role *plain*: no tags, no
 *     session policy.
 *  2. From *within* that broker-role session (role chaining) we re-assume the broker
 *     role, now stamping the connection's transitive attribution tags and narrowing
 *     to exactly its grants (inline session policy, or a customer-managed policy by
 *     ARN when the scope is too big to inline).
 *
 * Tagging (`sts:TagSession`), scoping, and any scope-policy creation all happen on
 * hop 2 under the broker role's own broad ceiling — so the operator needs neither
 * `sts:TagSession` nor any `iam:*` of its own, and no bootstrap re-deploy.
 *
 * The actual SDK call is a single injectable seam ({@link AssumeRoleFn}) so the
 * vendor's logic (policy assembly, validation, error handling) is unit-tested
 * without touching AWS, and the SDK is only loaded when a real vend happens.
 */
import type { ConnectedAccount, Connection } from "@agentspoppy/core";
import type { CredentialVendor, ScopedCredentials } from "../providers";
import { operatorCredentials } from "./credentials";
import { sessionPolicyForConnection, sessionTags, type SessionTag } from "./policy";

const DEFAULT_DURATION_SECONDS = 3600;

export interface AssumeRoleParams {
  roleArn: string;
  sessionName: string;
  /** JSON-serialised session policy (the scope). Used inline when small enough, else
   * promoted to a customer-managed policy referenced by ARN (STS caps inline at 2048). */
  policy: string;
  tags: SessionTag[];
  transitiveTagKeys: string[];
  durationSeconds: number;
  region: string;
  /** The AWS account the role lives in — needed to build the scope policy's ARN. */
  accountId: string;
  /** The connection id — names the per-connection scope policy. */
  connectionId: string;
}

/** The one AWS call, isolated for testing. Returns the vended scoped credentials. */
export type AssumeRoleFn = (params: AssumeRoleParams) => Promise<ScopedCredentials>;

export class StsCredentialVendor implements CredentialVendor {
  constructor(
    private readonly assumeRole: AssumeRoleFn = sdkAssumeRole,
    private readonly durationSeconds: number = DEFAULT_DURATION_SECONDS,
  ) {}

  async vend(connection: Connection, account: ConnectedAccount): Promise<ScopedCredentials> {
    if (!account.roleArn) {
      throw new Error(
        `account ${account.accountId} has no roleArn — AgentsPoppy needs an IAM role to assume before it can vend scoped credentials`,
      );
    }
    const tags = sessionTags(account, connection);
    return this.assumeRole({
      roleArn: account.roleArn,
      sessionName: sessionName(connection),
      policy: JSON.stringify(sessionPolicyForConnection(connection)),
      tags,
      transitiveTagKeys: tags.map((t) => t.Key),
      durationSeconds: this.durationSeconds,
      region: regionFor(account),
      accountId: account.accountId,
      connectionId: connection.id,
    });
  }
}

/** RoleSessionName must be 2–64 chars of [\w+=,.@-]. */
function sessionName(connection: Connection): string {
  return `agentspoppy-${connection.id}`.replace(/[^\w+=,.@-]/g, "-").slice(0, 64);
}

function regionFor(account: ConnectedAccount): string {
  return account.regions[0] ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
}

/**
 * STS caps an INLINE AssumeRole session policy at 2048 chars. Apps with large
 * scopes (a full deploy touches a dozen services) exceed that, so anything bigger
 * is promoted to a customer-managed policy referenced by ARN — which scopes the
 * session identically (a session policy can only ever narrow the role, never widen
 * it), just without the size limit. Leave a little headroom under 2048.
 */
const INLINE_POLICY_LIMIT = 2000;

/** Build the credentials shape from an AssumeRole response, or throw if incomplete. */
function toScopedCredentials(credentials: {
  AccessKeyId?: string;
  SecretAccessKey?: string;
  SessionToken?: string;
  Expiration?: Date;
}): ScopedCredentials {
  if (!credentials.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken || !credentials.Expiration) {
    throw new Error("STS AssumeRole returned incomplete credentials");
  }
  return {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
    expiration: credentials.Expiration.toISOString(),
  };
}

/** Temporary AWS credentials (the shape STS returns and the SDK clients accept). */
interface SessionCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/** Role chaining caps the chained session at one hour, whatever the role allows. */
const ROLE_CHAIN_MAX_DURATION = 3600;

/**
 * A single managed IAM policy document caps at 6144 chars. A large permission set
 * (a full deploy touches a dozen services, each with many actions) can exceed that,
 * so we split it across several managed session policies. AssumeRole accepts up to
 * 10 `PolicyArns`, and the session's effective permission is the role ∩ the UNION
 * of the session policies — so splitting the statements across policies preserves
 * the scope exactly (each statement is still present in some policy). Leave headroom
 * under 6144 for the per-chunk JSON envelope.
 */
const MANAGED_POLICY_LIMIT = 6000;

/** AssumeRole accepts at most 10 managed session policies. */
const MAX_SESSION_POLICIES = 10;

/**
 * STS enforces a SECOND, invisible limit on inline session policies: the PACKED
 * (compressed binary) size, shared with the session tags. It does not track the
 * plaintext length — a wide-but-compact policy (many short actions across many
 * services, e.g. a Lambda-platform poppy's deploy set) can sit comfortably under
 * the 2048-char plaintext cap yet overflow the packed budget, which STS rejects
 * with "Packed policy consumes NNN% of allotted space". First hit by CrewPoppy:
 * 1690 plaintext chars / 42 actions → 157% packed. Exported for unit tests.
 */
export function isPackedPolicyError(err: unknown): boolean {
  return /packed policy/i.test((err as Error)?.message ?? "");
}

/**
 * IAM is eventually consistent: a managed policy created via `ensureScopePolicyDoc`
 * can lag a beat before STS's AssumeRole can resolve its ARN. STS surfaces that as one
 * of a few wordings — most commonly "At least one Policy ARN in the PolicyArns parameter
 * does not match an existing IAM Managed Policy ARN." We retry ONLY these (a genuinely
 * bad ARN keeps failing and is surfaced after the retry budget); everything else throws
 * at once. Exported for unit tests — the exact STS wording is the whole bug this guards.
 */
export function isPolicyNotYetVisibleError(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? "";
  return /does not exist|not exist|does not match an existing|cannot be found|no such (managed )?policy/i.test(msg);
}

/** Injectable sleep (overridden in tests) — real timers by default. */
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `attempt` and, if it fails purely because a just-created managed policy hasn't
 * propagated to STS yet (`isPolicyNotYetVisibleError`), retry with a linear backoff
 * (1s, 2s, …) up to `maxAttempts`. Any other error is surfaced immediately. Exported
 * with an injectable `sleep` so the retry is unit-tested without wall-clock waits.
 */
export async function retryOnPolicyPropagation<T>(
  attempt: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = realSleep,
  maxAttempts = 6,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (i >= maxAttempts - 1 || !isPolicyNotYetVisibleError(err)) throw err;
      await sleep(1000 * (i + 1));
    }
  }
}

/**
 * Split a session-policy document into chunks, each a valid policy document whose
 * serialised length stays under `budget`. Greedy: pack statements until the next
 * would overflow, then start a new chunk. Pure + exported for unit testing.
 */
export function splitPolicyDocument(policyJson: string, budget = MANAGED_POLICY_LIMIT): string[] {
  const doc = JSON.parse(policyJson) as { Version: string; Statement: unknown[] };
  const serialise = (s: unknown[]) => JSON.stringify({ Version: doc.Version, Statement: s });
  if (serialise(doc.Statement).length <= budget) return [serialise(doc.Statement)];

  const chunks: string[] = [];
  let cur: unknown[] = [];
  for (const st of doc.Statement) {
    if (cur.length > 0 && serialise([...cur, st]).length > budget) {
      chunks.push(serialise(cur));
      cur = [st];
    } else {
      cur.push(st);
    }
  }
  if (cur.length > 0) chunks.push(serialise(cur));
  return chunks;
}

/**
 * Ensure one managed scope policy exists for the given document, returning its ARN.
 * The policy name is *content-addressed* — it embeds a short hash of the document —
 * so we create-if-missing and reuse an identical doc, but any change to the document
 * (a scope change, or a different chunk) yields a NEW name and thus a fresh policy.
 * Without this, a doc change that doesn't alter the grants (so `reconcile` keeps the
 * same connection) would silently reuse a stale policy.
 *
 * It is created with the *broker-role session's* own creds (hop 1), under the broker
 * role's broad ceiling (`iam:CreatePolicy` on `AgentsPoppyScope-*` is not denied by
 * any guardrail) — so the operator needs no IAM permission of its own and no
 * bootstrap re-deploy. The policy is used ONLY as an AssumeRole session bound, never
 * attached to any identity, so it can only ever restrict, never grant.
 */
async function ensureScopePolicyDoc(brokerCreds: SessionCreds, p: AssumeRoleParams, doc: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const sig = createHash("sha256").update(doc).digest("hex").slice(0, 12);
  const name = `AgentsPoppyScope-${p.connectionId}-${sig}`.slice(0, 128);
  const arn = `arn:aws:iam::${p.accountId}:policy/${name}`;

  const { IAMClient, CreatePolicyCommand } = await import("@aws-sdk/client-iam");
  const iam = new IAMClient({ region: p.region, credentials: brokerCreds });
  try {
    await iam.send(
      new CreatePolicyCommand({
        PolicyName: name,
        PolicyDocument: doc,
        Description: "AgentsPoppy per-connection session scope — used only as an AssumeRole session bound (restricts, never grants).",
      }),
    );
  } catch (err) {
    // Identical document already created → reuse it (content-addressed name).
    if (!/EntityAlreadyExists/i.test((err as { name?: string }).name ?? "")) throw err;
  }
  return arn;
}

/** Default seam: the real STS AssumeRole (two-hop role chain). SDK loaded lazily.
 * Exported only for unit tests (the packed-policy fallback lives in here). */
export const sdkAssumeRole: AssumeRoleFn = async (p) => {
  const operator = await operatorCredentials();
  const { STSClient, AssumeRoleCommand } = await import("@aws-sdk/client-sts");

  // Hop 1 — the operator assumes the broker role PLAIN (no tags, no session policy).
  // This is the only STS power the operator has (sts:AssumeRole). Everything that
  // needs more (tagging, scoping, scope-policy creation) happens inside this session.
  const operatorSts = new STSClient({ region: p.region, credentials: operator });
  const boot = await operatorSts.send(
    new AssumeRoleCommand({
      RoleArn: p.roleArn,
      RoleSessionName: `${p.sessionName}-boot`.slice(0, 64),
      DurationSeconds: 900,
    }),
  );
  const bc = boot.Credentials;
  if (!bc?.AccessKeyId || !bc.SecretAccessKey || !bc.SessionToken) {
    throw new Error("STS AssumeRole (broker bootstrap) returned incomplete credentials");
  }
  const brokerCreds: SessionCreds = {
    accessKeyId: bc.AccessKeyId,
    secretAccessKey: bc.SecretAccessKey,
    sessionToken: bc.SessionToken,
  };
  const brokerSts = new STSClient({ region: p.region, credentials: brokerCreds });

  // Hop 2 — re-assume the broker role from WITHIN the role session (role chaining),
  // now stamping the connection's transitive tags and narrowing to its scope. The
  // broker role's ceiling grants sts:TagSession; its trust (account root) lets the
  // role assume itself. Chained sessions are capped at one hour.
  const base = {
    RoleArn: p.roleArn,
    RoleSessionName: p.sessionName,
    Tags: p.tags,
    TransitiveTagKeys: p.transitiveTagKeys,
    DurationSeconds: Math.min(p.durationSeconds, ROLE_CHAIN_MAX_DURATION),
  };

  if (p.policy.length <= INLINE_POLICY_LIMIT) {
    try {
      const out = await brokerSts.send(new AssumeRoleCommand({ ...base, Policy: p.policy }));
      return toScopedCredentials(out.Credentials ?? {});
    } catch (err) {
      // The plaintext length fit, but the PACKED budget didn't (see
      // isPackedPolicyError). Fall through to the managed-policy route below —
      // PolicyArns carry no packed budget, and the scope is preserved exactly.
      if (!isPackedPolicyError(err)) throw err;
    }
  }

  // Large (or packed-dense) scope → one or more per-connection managed policies referenced via
  // PolicyArns, created with the broker session's own creds (no operator IAM perm,
  // no re-deploy). A scope bigger than a single 6144-char policy is split across
  // several (the session permission is the union of them ∩ the role, so the scope
  // is preserved exactly).
  const docs = splitPolicyDocument(p.policy);
  if (docs.length > MAX_SESSION_POLICIES) {
    throw new Error(
      `session scope needs ${docs.length} managed policies but AssumeRole allows at most ${MAX_SESSION_POLICIES} — tighten the permission set`,
    );
  }
  const policyArns: { arn: string }[] = [];
  for (const doc of docs) policyArns.push({ arn: await ensureScopePolicyDoc(brokerCreds, p, doc) });
  // IAM is eventually consistent: the just-created managed policy can lag a beat before
  // STS's AssumeRole resolves its ARN (surfaced as "…does not match an existing IAM
  // Managed Policy ARN"). Retry those; any other error surfaces immediately.
  return retryOnPolicyPropagation(async () => {
    const out = await brokerSts.send(new AssumeRoleCommand({ ...base, PolicyArns: policyArns }));
    return toScopedCredentials(out.Credentials ?? {});
  });
};
