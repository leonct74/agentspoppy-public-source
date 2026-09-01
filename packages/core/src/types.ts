// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * AgentsPoppy core domain types — the agnostic broker model.
 *
 * No app-specific (e.g. mail) logic ever lives here. The hierarchy is:
 *
 *   ConnectedAccount  →  Connection (a connected app)  →  Inventory + audit
 */

/** A linked AWS identity. Credentials are held by the broker out-of-band, never in this record. */
export interface ConnectedAccount {
  /** Local id within AgentsPoppy. */
  id: string;
  /** AWS account id (12 digits). */
  accountId: string;
  /** Friendly name the user gave it. */
  alias?: string;
  /** Regions this account is used in. */
  regions: string[];
  /**
   * ARN of the IAM role AgentsPoppy assumes (via STS) to vend a connection its
   * scoped, short-lived credentials. The user creates this role once in their
   * account; per-connection scoping is layered on at AssumeRole time via a
   * session policy + session tags. Absent until the user wires it up — only
   * credential *vending* needs it; monitoring/teardown use operator credentials.
   */
  roleArn?: string;
  /** ISO 8601. */
  createdAt: string;
}

/** The app/agent on the other end of a connection. */
export interface AppIdentity {
  /** Stable app id, e.g. "com.mailpoppy.desktop". */
  id: string;
  /** Display name, e.g. "MailPoppy". */
  name: string;
  iconUrl?: string;
}

export type ConnectionStatus = "pending" | "active" | "paused" | "revoked";

/** A resource scope limited to resources tagged as belonging to this connection. */
export const TAGGED_AS_SELF = "tagged-as-self";

/** One service-level grant inside a permission set. */
export interface PermissionGrant {
  /** AWS service, e.g. "cloudformation", "ses", "s3". */
  service: string;
  /** Human-facing action labels or AWS action names. */
  actions: string[];
  /** An ARN pattern, "*", or the {@link TAGGED_AS_SELF} sentinel. */
  resourceScope: string;
  /**
   * Optional: why this grant needs the scope it has, in the developer's own words.
   *
   * AGENTS.md has asked for this since the Cognito child-create recipe was written, and two
   * poppies wrote genuinely good ones — but the field did not exist, so the host parsed the
   * manifest, dropped it, and no user ever saw a word of it.
   *
   * **Its standing is a CLAIM, not a fact, and any UI showing it must say so.** It is authored
   * by the extension developer and nothing verifies it; a hostile manifest can write "this is
   * completely safe" beside a wildcard. It sits in the "what it is for" register, never in the
   * "what it can do" one — the boundary line is computed from the grant and is the only thing
   * on the screen entitled to assert reach. See docs/specs/permission-presentation.md.
   *
   * Plain text, rendered as text. Capped by the manifest validator.
   */
  reason?: string;
}

/** Optional dynamic limits. v1 is always null (roadmap: caps, approvals, time windows). */
export interface PermissionLimits {
  maxSpendPerDayUsd?: number;
  requireApprovalFor?: string[];
}

/** What an app is allowed to do — declared by the app, approved by the user. */
export interface PermissionSet {
  id: string;
  name: string;
  description: string;
  grants: PermissionGrant[];
  /** Tag keys every brokered resource must carry (enables attribution + teardown). */
  requiredTags: string[];
  limits: PermissionLimits | null;
}

/** A connected app under a ConnectedAccount. */
export interface Connection {
  id: string;
  /** FK → {@link ConnectedAccount.id}. */
  accountId: string;
  app: AppIdentity;
  status: ConnectionStatus;
  permissionSet: PermissionSet;
  /**
   * Supervised mode: when true, the broker will not vend credentials for a
   * mutating operation until the user explicitly approves it (see
   * {@link ApprovalRequest}). Reads stay un-gated. Absent/false = vend on demand
   * within scope (the default). The user toggles this per connection.
   */
  supervised?: boolean;
  /**
   * ISO 8601 expiry of the most recently vended credentials, if any. The broker
   * stamps this on every vend so the UI can show a live countdown to when this
   * app's current short-lived session lapses (and it must re-mint / re-approve).
   */
  credentialsExpireAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A single operation a poppy declares before acting, so a supervised connection
 * can show the user *exactly* what is about to happen (e.g. "Delete user pool
 * 'acme-users'") and narrow the vended credentials to just this.
 */
export interface OperationIntent {
  /** Plain-language summary the user sees and approves. */
  summary: string;
  /**
   * The exact grants this one operation needs. MUST be a subset of the
   * connection's permission set — the broker rejects anything broader, and vends
   * credentials scoped to only these grants on approval.
   */
  grants: PermissionGrant[];
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "consumed" | "expired";

/**
 * A request awaiting the user's call before a supervised connection may act.
 * `operation` is null for a session-level approval (a poppy that didn't declare
 * a specific operation) — approving it vends the connection's normal credentials.
 */
export interface ApprovalRequest {
  id: string;
  /** FK → {@link Connection.id}. */
  connectionId: string;
  /** ISO 8601 when the poppy asked. */
  requestedAt: string;
  /** The specific operation, or null for a session-level request. */
  operation: OperationIntent | null;
  status: ApprovalStatus;
  /** ISO 8601 when the user approved/denied. */
  decidedAt?: string;
  /** ISO 8601 after which a still-pending request is considered stale (auto-expired). */
  expiresAt: string;
}

/** A CloudFormation-managed resource (source of truth for the stack footprint). */
export interface ResourceEntry {
  logicalId: string;
  physicalId: string;
  /** CloudFormation type, e.g. "AWS::Lambda::Function". */
  type: string;
  status: string;
}

/** One CloudFormation stack belonging to a connection. */
export interface StackInventory {
  stackName: string;
  region: string;
  stackExists: boolean;
  resources: ResourceEntry[];
}

export type LedgerAction = "created" | "deleted" | "updated";

/** An out-of-stack mutation, attributed to a connection. Append-only. */
export interface LedgerEntry {
  /** ISO 8601. */
  ts: string;
  /** Attribution → {@link Connection.id}. */
  connectionId: string;
  action: LedgerAction;
  /** "Route53" | "SES" | "S3" | ... */
  service: string;
  resourceType: string;
  /** Resource name / DNS name / ARN. */
  name: string;
  region: string;
  detail?: string;
}

/** Everything a single connection created in the cloud (the per-app footprint). */
export interface Inventory {
  connectionId: string;
  stacks: StackInventory[];
  ledger: LedgerEntry[];
}

/**
 * A live AWS resource still carrying a connection's app-attribution tag
 * (`agentspoppy:app`), found by the generic tag sweep — independent of any
 * CloudFormation stack. After a teardown this set MUST be empty; anything here is
 * the "mess" a poppy left behind (out-of-stack resources, or a partial stack delete).
 */
export interface ResidualResource {
  /** Full ARN of the leftover resource. */
  arn: string;
  /** Best-effort "service:type" derived from the ARN, e.g. "s3", "lambda:function". */
  resourceType: string;
  region: string;
  /** Best-effort AWS-console deep link — the manual escape hatch for anything the host
   *  couldn't remove itself. Attached by the broker when it reports leftovers. */
  consoleUrl?: string;
}

/**
 * What a leaves-no-trace certificate is bound to — the exact build it vouches for.
 * The `manifestHash` pins the manifest (declared scope, capabilities, entrypoints,
 * teardown hook) so a certificate can never be replayed onto a different build: change
 * any of those and the hash — and thus the subject — changes.
 */
export interface CertificationSubject {
  /** The extension/app id (manifest.id), e.g. "com.mailpoppy.desktop". */
  appId: string;
  /** The extension version certified (manifest.version). */
  version: string;
  /** SHA-256 (hex) of the canonical manifest. */
  manifestHash: string;
}

/**
 * The outcome of one certification run: deploy → use → tear down → assert the
 * `agentspoppy:app` tag sweep is empty. `passed` is true iff `residualsAfter` is empty.
 * `warnings` never fail the run (e.g. "nothing was found before teardown"); `problems`
 * are the reasons it failed.
 */
export interface CertificationReport {
  subject: CertificationSubject;
  /** The AWS account the lifecycle ran in. */
  accountId: string;
  /** The regions swept for residuals. */
  regions: string[];
  /** The tagged footprint observed BEFORE teardown — evidence there was something to remove. */
  footprintBefore: ResidualResource[];
  /** CloudFormation stacks deleted during teardown. */
  deletedStacks: string[];
  /** Resources STILL tagged after teardown — MUST be empty to pass. */
  residualsAfter: ResidualResource[];
  /** Whether the poppy's declared teardown hook was invoked. */
  teardownHookRun: boolean;
  /** True iff `residualsAfter` is empty — the leaves-no-trace property held. */
  passed: boolean;
  /** Why it failed (empty when passed). */
  problems: string[];
  /** Non-fatal advisories (e.g. an empty footprint means the run exercised little). */
  warnings: string[];
  /** When the run completed (ISO 8601). */
  ranAt: string;
}

/**
 * An issued leaves-no-trace certificate. A developer self-runs the harness locally
 * (`issuer: "self"`, no signature) while iterating; the platform re-runs the SAME
 * harness at submission and issues a signed one (`issuer: "agentspoppy"`), which is
 * what the curated directory verifies before listing. Only a passed report can be issued.
 */
export interface LeaveNoTraceCertificate {
  /** Certificate schema id + version. */
  schema: "agentspoppy.leaves-no-trace/1";
  subject: CertificationSubject;
  /** "self" = local dev self-run (unsigned); "agentspoppy" = platform-issued + signed. */
  issuer: "self" | "agentspoppy";
  /** When issued (ISO 8601). */
  issuedAt: string;
  /** The report the issuance was based on (its `passed` is always true). */
  report: CertificationReport;
  /** Platform signature over the canonical subject; absent for a local self-run. */
  signature?: string;
}

/**
 * Whether a resource in the infra graph actually exists right now. The point of the
 * distinction is honesty about the tag index: the Resource Groups Tagging API is
 * eventually consistent and can list a resource for a while AFTER it's deleted, so a raw
 * tag hit is a *candidate*, not a fact.
 * - `present`    — confirmed to exist (a live resource, or — after teardown — a real leftover).
 * - `removed`    — confirmed gone (e.g. a successful delete is on record).
 * - `unverified` — tagged but we couldn't confirm either way (skip-failed / no signal); shown
 *   as "verifying", never as a hard leftover, so a lagging tag index can't cry wolf.
 */
export type InfraNodeStatus = "present" | "removed" | "unverified";

/** One resource in a poppy's cloud footprint — a node in the infrastructure graph. */
export interface InfraNode {
  /** Stable id: the CloudFormation logical id for in-stack resources, else the ARN. */
  id: string;
  /** AWS service, e.g. "s3", "lambda", "cognito-idp". */
  service: string;
  /** CloudFormation type ("AWS::S3::Bucket") when known, else the ARN-derived "service:type". */
  resourceType: string;
  /** Human label — the physical id / resource name. */
  name: string;
  region: string;
  status: InfraNodeStatus;
  /** Whether it lives inside the poppy's CloudFormation stack (vs an out-of-stack resource). */
  inStack: boolean;
  arn?: string;
  /** Deep link to this resource in the AWS console, when one can be derived. */
  consoleUrl?: string;
}

/** A directed dependency between two {@link InfraNode}s (from references in the stack template). */
export interface InfraEdge {
  from: string;
  to: string;
}

/**
 * A poppy's cloud footprint as a graph: services as nodes, their stack-template
 * references as edges. Built from the live stack (resources + template) plus the generic
 * tag sweep, so it doubles as a live infrastructure map AND — after teardown — a report of
 * exactly what was removed vs. what's still present.
 */
export interface InfraGraph {
  connectionId: string;
  appId: string;
  nodes: InfraNode[];
  edges: InfraEdge[];
  /** ISO 8601. */
  generatedAt: string;
}

/** Per-connection audit trail entry. */
export interface AuditEntry {
  /** ISO 8601. */
  ts: string;
  /** e.g. "granted" | "paused" | "credentials-issued" | "teardown". */
  type: string;
  detail?: string;
}
