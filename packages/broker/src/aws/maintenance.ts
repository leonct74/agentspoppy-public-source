// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The host-maintenance session: the broker's OWN housekeeping credentials.
 *
 * Until template v4, the operator IAM user carried account-wide monitoring and
 * cleanup powers directly (`MonitorAndTeardown` + `HostResidualCleanup`), so a
 * stolen operator key could delete stacks and buckets WITHOUT ever assuming the
 * broker role — outside every Deny guardrail. Template v4 strips the user to
 * assume-only, and the same two statements now travel as the SESSION POLICY of a
 * broker-role session instead: identical effective permissions for the host, but
 * every use passes the guarded door (docs/specs/operator-key-least-privilege.md).
 *
 * Works against template v3 unchanged (the role ceiling covers these actions and
 * no guardrail denies them), so the app can ship this before any account
 * re-applies v4. Deliberately sends NO SourceIdentity: stamping one requires
 * `sts:SetSourceIdentity` in the role's trust policy, which only v4 grants — an
 * unconditional stamp would AccessDeny every existing v3 account on day one.
 *
 * Two consumers deliberately do NOT use this module and stay on the raw operator
 * key, because they ARE the operator's retained v4 powers: the vend's own hop-1
 * (sts.ts) and the GetCallerIdentity probe (identity.ts).
 */
import { HOST_SESSION_PREFIX } from "@agentspoppy/core";
import { operatorCredentials } from "./credentials";
import {
  isPackedPolicyError,
  policyDocumentsMatch,
  retryOnPolicyPropagation,
  splitPolicyDocument,
} from "./sts";

/** Recognised by core's classifyActor as AgentsPoppy itself, never a poppy. */
export const MAINTENANCE_SESSION_NAME = `${HOST_SESSION_PREFIX}maintenance`;

/**
 * The host's housekeeping permissions — the two statements template v4 REMOVES
 * from the operator user. This module is their canonical home now: they exist
 * only as a session bound (a session policy can narrow a role, never widen it).
 *
 * MonitorAndTeardown: read stacks/tags/CloudTrail + delete poppy stacks.
 * HostResidualCleanup: the residual deletion engine — after (or instead of) a
 * poppy's own cleanup, the HOST deletes what the tag sweep still attributes to
 * it. Unconditioned by design: several of these actions don't (reliably) support
 * aws:ResourceTag conditions, and a condition that silently fails to authorize
 * means orphaned, billable resources. The real safety control is in code: the
 * engine only targets resources the tag sweep attributed to a poppy, and re-reads
 * the live tag immediately before every deletion.
 */
export const MAINTENANCE_POLICY_STATEMENTS = [
  {
    Sid: "MonitorAndTeardown",
    Effect: "Allow",
    Action: [
      "cloudformation:ListStacks",
      "cloudformation:DescribeStacks",
      "cloudformation:DescribeStackResources",
      "cloudformation:ListStackResources",
      "cloudformation:GetTemplate",
      "cloudformation:DeleteStack",
      "tag:GetResources",
      "cloudtrail:LookupEvents",
    ],
    Resource: "*",
  },
  {
    Sid: "HostResidualCleanup",
    Effect: "Allow",
    Action: [
      "s3:GetBucketTagging",
      "s3:ListBucketVersions",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "s3:DeleteBucket",
      "dynamodb:ListTagsOfResource",
      "dynamodb:UpdateTable",
      "dynamodb:DeleteTable",
      "cognito-idp:ListTagsForResource",
      "cognito-idp:DescribeUserPool",
      "cognito-idp:DeleteUserPoolDomain",
      "cognito-idp:DeleteUserPool",
      "lambda:ListTags",
      "lambda:DeleteFunction",
      "logs:ListTagsForResource",
      "logs:DeleteLogGroup",
      "ses:DeleteIdentity",
      "ses:DescribeActiveReceiptRuleSet",
      "ses:SetActiveReceiptRuleSet",
      "ses:DeleteReceiptRuleSet",
      "events:ListTagsForResource",
      "events:DescribeRule",
      "events:ListTargetsByRule",
      "events:RemoveTargets",
      "events:DeleteRule",
    ],
    Resource: "*",
  },
] as const;

/** The session-policy document, serialised the way STS receives it. */
export function maintenancePolicyJson(): string {
  return JSON.stringify({ Version: "2012-10-17", Statement: MAINTENANCE_POLICY_STATEMENTS });
}

/** Why a maintenance AssumeRole failed — drives which remedy the UI offers. */
export type AssumeFailureKind = "dead-key" | "denied" | "transient";

export class MaintenanceSessionError extends Error {
  constructor(
    message: string,
    readonly kind: AssumeFailureKind,
  ) {
    super(message);
    this.name = "MaintenanceSessionError";
  }
}

/**
 * Classify an AssumeRole failure. NOTE: AWS deliberately answers "role does not
 * exist" and "you may not assume it" with the SAME AccessDenied wording, so the
 * two cannot be told apart here — callers that know the caller's identity split
 * `denied` further (an operator being denied means the setup is broken; anyone
 * else being denied means this machine should switch to the operator key).
 */
export function classifyAssumeFailure(err: unknown): AssumeFailureKind {
  const msg = (err as Error)?.message ?? "";
  if (/InvalidClientTokenId|security token.*invalid|expired/i.test(msg)) return "dead-key";
  if (/not authorized|access.?denied|explicit deny/i.test(msg)) return "denied";
  return "transient";
}

interface SessionCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

interface MaintenanceConfig {
  roleArn: string;
  region: string;
}

let config: MaintenanceConfig | null = null;
let cached: { creds: SessionCreds; expiresAtMs: number } | null = null;
let inFlight: Promise<SessionCreds> | null = null;

/** Refresh when less than this remains — housekeeping calls never race expiry. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const SESSION_DURATION_SECONDS = 3600;

/**
 * Point the maintenance session at the connected account's broker role. Called by
 * the service layer whenever it knows the account (connect, deploy, startup). A
 * changed role or region invalidates the cache.
 */
export function configureMaintenanceSession(cfg: MaintenanceConfig): void {
  if (config?.roleArn !== cfg.roleArn || config?.region !== cfg.region) {
    cached = null;
    inFlight = null;
  }
  config = cfg;
}

/** Forget everything — disconnect, tests. */
export function resetMaintenanceSession(): void {
  config = null;
  cached = null;
  inFlight = null;
}

/**
 * Credentials for the broker's housekeeping AWS clients.
 *
 * Configured → a cached broker-role session bounded to the maintenance policy.
 * Not configured (no account connected yet — e.g. first-run flows) → the raw
 * operator chain, exactly what every consumer used before this module existed.
 */
export async function maintenanceCredentials(): Promise<
  SessionCreds | Awaited<ReturnType<typeof operatorCredentials>>
> {
  if (!config) return operatorCredentials();
  if (cached && cached.expiresAtMs - Date.now() > REFRESH_MARGIN_MS) return cached.creds;
  if (!inFlight) {
    inFlight = mintMaintenanceSession(config).finally(() => {
      inFlight = null;
    });
  }
  const creds = await inFlight;
  return creds;
}

/** The two-hop mint, mirroring the vend's shape (sts.ts) but tag-free. */
async function mintMaintenanceSession(cfg: MaintenanceConfig): Promise<SessionCreds> {
  const { STSClient, AssumeRoleCommand } = await import("@aws-sdk/client-sts");
  const operator = await operatorCredentials();
  const operatorSts = new STSClient({ region: cfg.region, credentials: operator });

  // Hop 1 — plain boot session, signed by the operator's long-term key (template
  // v4's HopOne trust statement: PrincipalArn = the operator user, TokenIssueTime
  // null). Short-lived; only used to mint the bounded session below.
  let boot;
  try {
    boot = await operatorSts.send(
      new AssumeRoleCommand({
        RoleArn: cfg.roleArn,
        RoleSessionName: `${HOST_SESSION_PREFIX}maint-boot`,
        DurationSeconds: 900,
      }),
    );
  } catch (err) {
    throw new MaintenanceSessionError((err as Error).message, classifyAssumeFailure(err));
  }
  const bc = boot.Credentials;
  if (!bc?.AccessKeyId || !bc.SecretAccessKey || !bc.SessionToken) {
    throw new MaintenanceSessionError("AssumeRole returned incomplete credentials", "transient");
  }
  const bootCreds: SessionCreds = {
    accessKeyId: bc.AccessKeyId,
    secretAccessKey: bc.SecretAccessKey,
    sessionToken: bc.SessionToken,
  };
  const brokerSts = new STSClient({ region: cfg.region, credentials: bootCreds });

  // Hop 2 — re-assume self (role chaining; v4's HopTwo: PrincipalArn = the role),
  // bounded to the maintenance policy. Inline when the PACKED budget allows —
  // the plaintext fits easily, but STS's compressed budget is the one that bites
  // (sts.ts::isPackedPolicyError; CrewPoppy hit it at 1,690 chars) — else fall
  // back to content-addressed managed session policies, scope preserved exactly.
  const policy = maintenancePolicyJson();
  const base = {
    RoleArn: cfg.roleArn,
    RoleSessionName: MAINTENANCE_SESSION_NAME,
    DurationSeconds: SESSION_DURATION_SECONDS,
  };
  try {
    const out = await brokerSts.send(new AssumeRoleCommand({ ...base, Policy: policy }));
    return rememberSession(out.Credentials);
  } catch (err) {
    if (!isPackedPolicyError(err)) {
      throw new MaintenanceSessionError((err as Error).message, classifyAssumeFailure(err));
    }
  }

  const arns: { arn: string }[] = [];
  for (const doc of splitPolicyDocument(policy)) {
    arns.push({ arn: await ensureMaintenanceScopePolicy(bootCreds, cfg, doc) });
  }
  return retryOnPolicyPropagation(async () => {
    const out = await brokerSts.send(new AssumeRoleCommand({ ...base, PolicyArns: arns }));
    return rememberSession(out.Credentials);
  });
}

function rememberSession(credentials?: {
  AccessKeyId?: string;
  SecretAccessKey?: string;
  SessionToken?: string;
  Expiration?: Date;
}): SessionCreds {
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
    throw new MaintenanceSessionError("AssumeRole returned incomplete credentials", "transient");
  }
  const creds: SessionCreds = {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
  };
  cached = {
    creds,
    expiresAtMs: credentials.Expiration?.getTime() ?? Date.now() + SESSION_DURATION_SECONDS * 1000,
  };
  return creds;
}

/**
 * Ensure a managed policy holding one chunk of the maintenance scope, returning
 * its ARN. Content-addressed like the vend's scope policies, and read back with
 * the same paranoia (sts.ts::ensureScopePolicyDoc): the name is predictable, so
 * an existing document is verified to be OURS before any session is bound to it —
 * unverifiable is treated exactly like hostile.
 */
async function ensureMaintenanceScopePolicy(
  bootCreds: SessionCreds,
  cfg: MaintenanceConfig,
  doc: string,
): Promise<string> {
  const { createHash } = await import("node:crypto");
  const accountId = cfg.roleArn.split(":")[4] ?? "";
  const sig = createHash("sha256").update(doc).digest("hex").slice(0, 12);
  const name = `AgentsPoppyScope-host-${sig}`.slice(0, 128);
  const arn = `arn:aws:iam::${accountId}:policy/${name}`;

  const { IAMClient, CreatePolicyCommand, GetPolicyCommand, GetPolicyVersionCommand } =
    await import("@aws-sdk/client-iam");
  const iam = new IAMClient({ region: cfg.region, credentials: bootCreds });
  try {
    await iam.send(
      new CreatePolicyCommand({
        PolicyName: name,
        PolicyDocument: doc,
        Description:
          "AgentsPoppy host-maintenance session scope — used only as an AssumeRole session bound (restricts, never grants).",
      }),
    );
    return arn;
  } catch (err) {
    if (!/EntityAlreadyExists/i.test((err as { name?: string }).name ?? "")) throw err;
  }

  let existing: string | undefined;
  try {
    const meta = await iam.send(new GetPolicyCommand({ PolicyArn: arn }));
    const versionId = meta.Policy?.DefaultVersionId;
    if (!versionId) throw new Error("policy has no default version");
    const version = await iam.send(new GetPolicyVersionCommand({ PolicyArn: arn, VersionId: versionId }));
    existing = version.PolicyVersion?.Document;
  } catch (readErr) {
    throw new Error(
      `refusing to use the IAM policy ${name}: could not read it back to confirm AgentsPoppy wrote it ` +
        `(${(readErr as Error).message}).`,
    );
  }
  if (!existing || !policyDocumentsMatch(existing, doc)) {
    throw new Error(
      `refusing to use the IAM policy ${name}: it already exists but does not contain the maintenance scope ` +
        `AgentsPoppy compiled. Inspect ${arn} and remove it if it is not yours.`,
    );
  }
  return arn;
}

