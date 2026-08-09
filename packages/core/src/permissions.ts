// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The consent model: turn a permission set into plain-language "blast radius"
 * the user can actually approve, and derive the attribution tags that make
 * per-app tracking + teardown possible. All pure and unit-tested.
 */
import { TAGGED_AS_SELF } from "./types";
import type { ConnectedAccount, Connection, PermissionGrant, PermissionSet } from "./types";

/** The tag keys AgentsPoppy stamps on every brokered resource (for attribution). */
export const ATTRIBUTION_TAG_KEYS = [
  "agentspoppy:account",
  "agentspoppy:app",
  "agentspoppy:connection",
] as const;

const MUTATING = /(create|update|delete|put|write|modify|attach|detach|remove|set|change)/i;
// Verbs that change or remove something that ALREADY exists — "mutating" minus
// "create". A pure create is additive: it can't harm a pre-existing resource.
// "change" is here so e.g. route53:ChangeResourceRecordSets / cognito:ChangePassword
// are recognised as edits to existing resources, not reads.
const DESTRUCTIVE = /(update|delete|put|write|modify|attach|detach|remove|set|change)/i;
// Services where even a pure "create" is a privilege change (creating an IAM role,
// user or policy is escalation), so create-on-"*" stays high, not merely additive.
const CONTROL_PLANE = new Set(["iam", "organizations", "account"]);

/**
 * True if a grant can change or destroy things (not merely read). A wildcard
 * action — `"*"` or a service wildcard like `"iam:*"` — includes every mutating
 * call, so it always counts as mutating; otherwise we look for a mutating verb.
 * (Without the wildcard check a full-access grant like `iam: ["*"]` would slip
 * through as "read-only" — the most dangerous grant, mis-rated as the safest.)
 */
export function grantCanMutate(grant: PermissionGrant): boolean {
  return grant.actions.some((a) => a === "*" || a.endsWith(":*") || MUTATING.test(a));
}

/**
 * True if the grant can change or DELETE resources that already exist (not merely
 * create new ones). A wildcard action implies it. This is what separates "can harm
 * the rest of your account" (destructive) from "can only add new resources" (create).
 */
export function grantCanDestroy(grant: PermissionGrant): boolean {
  return grant.actions.some((a) => a === "*" || a.endsWith(":*") || DESTRUCTIVE.test(a));
}

/** True if the grant is limited to resources tagged as this connection's own. */
export function grantIsTagScoped(grant: PermissionGrant): boolean {
  return grant.resourceScope === TAGGED_AS_SELF;
}

/** One plain-language line describing a grant's blast radius. */
export function describeGrant(grant: PermissionGrant): string {
  const verb = grantCanMutate(grant) ? "create, change and delete" : "read";
  const where = grantIsTagScoped(grant)
    ? "only resources tagged as its own"
    : grant.resourceScope === "*"
      ? "any resource"
      : `resources matching ${grant.resourceScope}`;
  return `Can ${verb} ${grant.service.toUpperCase()} — ${where}.`;
}

/** Plain-language summary of an entire permission set, for the consent UI. */
export function describePermissionSet(ps: PermissionSet): string[] {
  return ps.grants.map(describeGrant);
}

/** The exact tag key→value pairs every brokered resource for this connection must carry. */
export function connectionTags(account: ConnectedAccount, connection: Connection): Record<string, string> {
  return {
    "agentspoppy:account": account.accountId,
    "agentspoppy:app": connection.app.id,
    "agentspoppy:connection": connection.id,
  };
}

/** Does the permission set declare every tag needed for attribution + teardown? */
export function hasAttributionTags(ps: PermissionSet): boolean {
  return ATTRIBUTION_TAG_KEYS.every((t) => ps.requiredTags.includes(t));
}

/**
 * True if every mutating grant is constrained (tag-scoped or a concrete ARN pattern,
 * never "*"). This is the property that makes "show / wipe what an app made" a
 * guarantee rather than a convention.
 */
export function isFullyAttributable(ps: PermissionSet): boolean {
  if (!hasAttributionTags(ps)) return false;
  return ps.grants
    .filter(grantCanMutate)
    .every((g) => grantIsTagScoped(g) || (g.resourceScope !== "*" && g.resourceScope.length > 0));
}

// --- policy risk: flag grants that reach beyond the app's own resources ---

export type RiskLevel = "low" | "medium" | "high";

/** A grant's risk, with a plain-language reason the user can act on. */
export interface GrantRisk {
  level: RiskLevel;
  /** True when confined to the app's own resources — by tag or by name pattern (cannot reach others). */
  scoped: boolean;
  reason: string;
}

/** A whole permission set's risk: the per-grant findings + set-level warnings. */
export interface PolicyRisk {
  /** The worst level across grants + set-level warnings. */
  level: RiskLevel;
  grants: { grant: PermissionGrant; risk: GrantRisk }[];
  /** Issues that aren't tied to a single grant (e.g. missing teardown tags). */
  warnings: string[];
  /** True if any grant is NOT limited to the app's own (tagged) resources. */
  hasUnscopedGrants: boolean;
}

const LEVEL_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/** The higher (worse) of two risk levels. */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b;
}

/**
 * Assess a single grant's blast radius. The cardinal sin is an *unscoped*
 * mutating grant — one that can change resources beyond the app's own — because
 * it can compromise unrelated services in the account. Tag-scoped grants are
 * safe; read-only is softer than mutating; a concrete ARN pattern sits between.
 */
export function assessGrant(grant: PermissionGrant): GrantRisk {
  const svc = grant.service.toUpperCase();
  const mutates = grantCanMutate(grant);
  const tag = grantIsTagScoped(grant);
  const wildcard = grant.resourceScope === "*" || grant.resourceScope.length === 0;

  // Resource "*". Three sub-cases, because "create" is not "change/delete":
  //  - can change/delete existing (or an IAM identity = escalation) → red, the
  //    cardinal sin: a bug or rogue app could touch unrelated resources;
  //  - can only CREATE new resources → amber: additive, can't harm what exists
  //    (e.g. CreateUserPool has no ARN to scope to, but creating one is harmless);
  //  - read-only → amber.
  if (wildcard) {
    const canHarmExisting = grantCanDestroy(grant) || CONTROL_PLANE.has(grant.service.toLowerCase());
    if (mutates && canHarmExisting) {
      return {
        level: "high",
        scoped: false,
        reason: `Can create, change and delete ANY ${svc} resource in your account — not just its own.`,
      };
    }
    if (mutates) {
      return {
        level: "medium",
        scoped: false,
        reason: `Can create new ${svc} resources in your account, but cannot change or delete anything that already exists.`,
      };
    }
    return { level: "medium", scoped: false, reason: `Can read ANY ${svc} resource in your account — not just its own.` };
  }

  // Confined to the app's OWN resources — by tag (it created them) or by a concrete
  // name pattern. It can never touch a resource with a different name/tag, so the
  // blast radius is its own footprint. Read-only is reassuring (green); being able
  // to create/change/delete its own is moderate (amber) — worth the user's eye, not
  // alarming.
  const where = tag ? "tagged as its own" : `named ${grant.resourceScope}`;
  const otherwise = tag ? "a different tag" : "a different name";
  return mutates
    ? {
        level: "medium",
        scoped: true,
        reason: `Can create, change and delete only ${svc} resources ${where} — it cannot touch any ${svc} resource with ${otherwise}.`,
      }
    : { level: "low", scoped: true, reason: `Can read only ${svc} resources ${where}.` };
}

/**
 * Assess an entire permission set so the UI can warn the user (and nudge poppy
 * developers toward tightly-scoped, tagged policies). The overall {@link PolicyRisk.level}
 * is the worst of the per-grant levels and any set-level warning.
 */
export function assessPermissionSet(ps: PermissionSet): PolicyRisk {
  const grants = ps.grants.map((grant) => ({ grant, risk: assessGrant(grant) }));
  let level: RiskLevel = grants.reduce<RiskLevel>((acc, g) => maxRisk(acc, g.risk.level), "low");

  const warnings: string[] = [];
  if (!hasAttributionTags(ps)) {
    warnings.push(
      "Missing attribution tags — AgentsPoppy can't reliably track or tear down what this app creates.",
    );
    level = maxRisk(level, "medium");
  }

  return { level, grants, warnings, hasUnscopedGrants: grants.some((g) => !g.risk.scoped) };
}
