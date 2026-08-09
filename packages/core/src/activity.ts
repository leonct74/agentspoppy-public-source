// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Account-activity attribution — the model behind "did anything happen in my
 * cloud *around* AgentsPoppy?".
 *
 * AgentsPoppy is a credential broker, not a network gateway, so it can't *block*
 * an app that reaches AWS some other way. But every call AWS records in
 * CloudTrail carries a principal, and AgentsPoppy issues credentials under a
 * known shape (an AssumeRole session of the broker role, session-named
 * `agentspoppy-<connectionId>`). That lets us bucket recent management events
 * into: through a connected poppy, by AgentsPoppy itself (the operator), or
 * **external** — activity that did NOT go through AgentsPoppy. Pure + tested.
 */

export type ActorKind = "poppy" | "agentspoppy" | "external";

/** Just the bits of a CloudTrail `userIdentity` we attribute on (provider-normalised). */
export interface RawPrincipal {
  /** CloudTrail userIdentity.type, e.g. "AssumedRole" | "IAMUser" | "Root". */
  type?: string;
  arn?: string;
  /** For an AssumedRole: the role session name (last ARN segment). */
  sessionName?: string;
  /** For an AssumedRole: the role the session was issued from. */
  roleName?: string;
  /** For an IAMUser: the user name. */
  userName?: string;
}

export interface AttributionContext {
  /** The broker role AgentsPoppy assumes (DEFAULT_ROLE_NAME). */
  brokerRoleName: string;
  /** The operator IAM user AgentsPoppy runs as — the LIVE connected identity's name. */
  operatorName: string;
  /** The operator's exact caller ARN — the live identity beats the canonical name,
   * since real users connect with an IAM user of their own naming. */
  operatorArn?: string;
  /** The canonical bootstrap-created operator (DEFAULT_OPERATOR_NAME) — always
   * recognised as AgentsPoppy even when the live session runs as someone else, so
   * e.g. a bootstrap-then-reconnect within the lookback window doesn't false-alarm. */
  canonicalOperatorName?: string;
  /** Session-name prefix AgentsPoppy stamps on vended sessions. */
  sessionPrefix?: string;
}

export interface ActivityActor {
  kind: ActorKind;
  /** Short, human label, e.g. "IAM user deploy-bot" / "MailPoppy" / "AgentsPoppy". */
  label: string;
  arn?: string;
  /** Present when kind === "poppy": the connection the brokered session belongs to. */
  connectionId?: string;
}

/** One attributed management event (CloudTrail), as the UI consumes it. */
export interface ActivityEvent {
  /** CloudTrail EventId. */
  id: string;
  /** ISO 8601. */
  time: string;
  /** Short service name, e.g. "s3", "iam". */
  service: string;
  /** API action, e.g. "CreateBucket". */
  action: string;
  region?: string;
  actor: ActivityActor;
}

export interface ActivitySummary {
  total: number;
  /** The headline: events that did NOT go through AgentsPoppy. */
  external: number;
  throughPoppies: number;
  byAgentsPoppy: number;
}

const DEFAULT_SESSION_PREFIX = "agentspoppy-";

/**
 * Bucket a principal. A brokered session is an AssumeRole of the broker role
 * whose session name carries our prefix — from it we recover the connection id.
 * The operator is AgentsPoppy acting on the user's behalf. Everything else is
 * activity that reached the account outside AgentsPoppy.
 */
export function classifyActor(
  p: RawPrincipal,
  ctx: AttributionContext,
): { kind: ActorKind; connectionId?: string } {
  const prefix = ctx.sessionPrefix ?? DEFAULT_SESSION_PREFIX;
  if (p.sessionName?.startsWith(prefix) && (!p.roleName || p.roleName === ctx.brokerRoleName)) {
    return { kind: "poppy", connectionId: p.sessionName.slice(prefix.length) };
  }
  const operatorNames = [ctx.operatorName, ctx.canonicalOperatorName].filter((n): n is string => !!n);
  const isOperator =
    operatorNames.some((n) => p.userName === n || isUserArnFor(p.arn, n)) ||
    (!!ctx.operatorArn && p.arn === ctx.operatorArn);
  if (isOperator) return { kind: "agentspoppy" };
  return { kind: "external" };
}

/**
 * True when `arn` is an IAM user ARN whose (possibly pathed) user name is EXACTLY
 * `name`. A substring test is not safe here: with a user-chosen operator name like
 * "acmepoppy-3", `includes(":user/acmepoppy-3")` would also swallow the genuinely
 * external users "acmepoppy-30" or "acmepoppy-3-ci" — misattributing outside
 * changes to AgentsPoppy itself, the exact signal this feed exists to surface.
 */
function isUserArnFor(arn: string | undefined, name: string): boolean {
  return !!arn && arn.match(/:user\/(?:.*\/)?([^/]+)$/)?.[1] === name;
}

/** A short label for an external principal — the case the user actually scans. */
export function describePrincipal(p: RawPrincipal): string {
  if (p.userName) return `IAM user ${p.userName}`;
  if (p.type === "Root") return "Account root";
  if (p.type === "AssumedRole" && p.roleName) return `Role ${p.roleName}`;
  if (p.type === "AWSService" && p.arn) return p.arn;
  return p.arn ?? p.type ?? "Unknown principal";
}

/** Short service name from a CloudTrail eventSource like "s3.amazonaws.com". */
export function shortService(eventSource: string): string {
  return eventSource.replace(/\.amazonaws\.com$/, "");
}

export function summarizeActivity(events: ActivityEvent[]): ActivitySummary {
  const summary: ActivitySummary = { total: events.length, external: 0, throughPoppies: 0, byAgentsPoppy: 0 };
  for (const e of events) {
    if (e.actor.kind === "external") summary.external += 1;
    else if (e.actor.kind === "poppy") summary.throughPoppies += 1;
    else summary.byAgentsPoppy += 1;
  }
  return summary;
}
