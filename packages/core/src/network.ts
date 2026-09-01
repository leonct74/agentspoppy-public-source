// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Network egress, phase 1 (docs/specs/network-egress.md): pure helpers for the
 * declaration and for deciding when the screen owes the user the standing fact
 * "its cloud code can reach the internet".
 *
 * IAM is a control plane for identity, not for the network: a Lambda deployed
 * outside a VPC has unrestricted outbound internet, whatever its policy says.
 * Phase 1 makes poppies SAY where their cloud code connects; enforcement (a
 * sealed VPC for "none") is phase 2 and lives elsewhere. Nothing here grants,
 * denies, or rates — display truth only.
 */
import type { EgressDeclaration, InfrastructureEgress, NetworkDeclaration, PermissionSet } from "./types";

/**
 * Actions that put RUNNABLE CODE into the user's cloud — the moment the poppy's
 * behaviour stops being confined to the user's machine and its network. Matched
 * by EXACT action name, case-insensitively, never by substring: the rating's
 * substring matching once turned GetConsoleOutput into a "Put" write, and this
 * list must not repeat that mistake.
 *
 * Additive by design: a service missing here means the fact is not shown, never
 * that something breaks. CloudFormation is included because a stack can contain
 * anything, functions included — deploying a template IS deploying compute.
 */
const COMPUTE_DEPLOY_ACTIONS: Record<string, ReadonlySet<string>> = {
  lambda: new Set(["createfunction", "updatefunctioncode", "updatefunctionconfiguration"]),
  cloudformation: new Set(["createstack", "updatestack", "createchangeset", "executechangeset"]),
  ec2: new Set(["runinstances"]),
  ecs: new Set(["runtask", "createservice", "updateservice"]),
};

function bareActionName(action: string): string {
  return (action.includes(":") ? action.slice(action.indexOf(":") + 1) : action).toLowerCase();
}

/**
 * True when any grant lets the poppy put code into the cloud that runs off the
 * user's machine — the precondition for the egress fact mattering at all. A
 * poppy with no cloud compute gets no network line: no fact, no copy.
 */
export function canDeployCloudCompute(ps: Pick<PermissionSet, "grants">): boolean {
  return ps.grants.some((g) => {
    const known = COMPUTE_DEPLOY_ACTIONS[g.service.toLowerCase()];
    return known !== undefined && g.actions.some((a) => known.has(bareActionName(a)));
  });
}

/** Longest domain list a manifest may declare — a poppy talking to more endpoints than this should explain itself in its design, not its manifest. */
export const EGRESS_DOMAIN_MAX = 20;

// A bare lowercase hostname: labels of [a-z0-9-], dot-separated, at least two labels,
// no scheme, no path, no port, no wildcard. Declaring "*.example.com" is declining to
// declare; the field exists to name endpoints, not patterns.
const EGRESS_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Structural validation for a manifest's `permissionSet.network`. Returns every
 * problem found (empty = valid). Pure and throw-free so the manifest validator
 * can show an author everything at once.
 */
const INFRASTRUCTURE_KINDS: ReadonlySet<string> = new Set(["none", "servers", "websites", "email"]);

/**
 * One egress value, checked against the shared vocabulary. Both doors that carry code
 * the poppy itself wrote — the cloud (`egress`) and this machine (`machine`) — use it,
 * so a developer learns one grammar and the two can never drift apart in what they
 * accept. `field` names the offending path in the message.
 */
function validateEgressValue(e: unknown, field: string): string[] {
  if (e === "none" || e === "aws-only" || e === "user-directed") return [];
  if (Array.isArray(e)) {
    const errors: string[] = [];
    if (e.length === 0) errors.push(`${field} domain list must not be empty — use "none" to declare no connections`);
    if (e.length > EGRESS_DOMAIN_MAX) errors.push(`${field} may name at most ${EGRESS_DOMAIN_MAX} domains`);
    for (const d of e) {
      if (typeof d !== "string" || !EGRESS_DOMAIN_RE.test(d)) {
        errors.push(`${field} entry ${JSON.stringify(d)} must be a bare lowercase hostname, e.g. "api.stripe.com" — no scheme, path, port or wildcard`);
      }
    }
    return errors;
  }
  return [`${field} must be "none", "aws-only", "user-directed", or an array of hostnames`];
}

export function validateNetworkDeclaration(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== "object") return ["network must be an object with an egress field"];
  const n = value as Partial<NetworkDeclaration>;
  if (n.infrastructure !== undefined && !INFRASTRUCTURE_KINDS.has(n.infrastructure as string)) {
    errors.push('network.infrastructure must be "none", "servers", "websites" or "email"');
  }
  // Door 3 is optional: a manifest written before the machine gate stays valid, and the
  // host observes instead of refusing. A PRESENT but malformed value is an error, never
  // a silent downgrade to observe — that would let a typo buy the quiet mode.
  if (n.machine !== undefined) errors.push(...validateEgressValue(n.machine, "network.machine"));
  errors.push(...validateEgressValue(n.egress as EgressDeclaration | undefined, "network.egress"));
  return errors;
}

/** How many domains the finding headline names before switching to a count. */
export const EGRESS_TITLE_DOMAINS = 3;

/**
 * The finding headline for a DECLARED egress, in the register's voice: it is the
 * developer's statement, and the word "declares" keeps it one — the enforced
 * phrasing (and the tick) arrive only with phase 2, only for "none".
 */
/**
 * Door 2's headline, platform-authored per kind so the wording is consistent and cannot
 * be gamed by a manifest. Null when the poppy declares no internet-facing infrastructure.
 */
export function infrastructureTitle(kind: InfrastructureEgress | undefined): string | null {
  // Every title says WHOSE the infrastructure is — "your", "for you" (founder,
  // 2026-09-01): a generic "servers"/"websites" reads as the poppy reaching the
  // DEVELOPER'S servers, the exact confusion this row exists to prevent.
  switch (kind) {
    case "servers":
      return "Your servers, which it creates for you, can reach the internet";
    case "websites":
      return "Your websites, which it creates for you, serve the public internet";
    case "email":
      return "Your mail system, which it builds for you, exchanges email with the outside world";
    default:
      return null;
  }
}

/**
 * Door 2's context — the purpose stated without alarm, then the standing catalogue rule
 * (AGENTS.md §3): what the infrastructure sends is what the user puts on it, and a poppy
 * routing the user's cloud data or activity out through it is delisted.
 */
export const INFRASTRUCTURE_CONTEXT =
  "That is their purpose — what they send is what you put on them. " +
  "Catalogue rules forbid a poppy from routing your cloud data or your activity out through infrastructure it creates.";

/**
 * Door 3's headline — the poppy's own code on THIS machine (its tab and its confined
 * backend). Same voice as door 1 ("declares"), deliberately different words: a reader
 * must be able to tell which plane a sentence is about, because only this one is
 * something the host can refuse.
 */
export function declaredMachineTitle(egress: EgressDeclaration): string {
  if (egress === "none") return "Declares it makes no internet connections from your machine";
  if (egress === "aws-only") return "Declares it connects only to AWS from your machine";
  if (egress === "user-directed") return "Declares it reaches the internet from your machine only under your request";
  const shown = egress.slice(0, EGRESS_TITLE_DOMAINS).join(", ");
  const more = egress.length - EGRESS_TITLE_DOMAINS;
  return more > 0
    ? `Declares it connects only to ${shown} and ${more} more from your machine`
    : `Declares it connects only to ${shown} from your machine`;
}

/**
 * Door 3's context. Unlike door 1, this plane is one the host can actually hold — but
 * whether it IS held for this poppy on this machine is the enforcement card's answer,
 * never this row's (a dev-path host arms no backend gate).
 */
export const MACHINE_EGRESS_CONTEXT =
  "This is the one plane AgentsPoppy can hold: the poppy's own code runs here, so the host checks the connections it opens " +
  "against this declaration and refuses the rest. Whether the gate is armed for this poppy on this machine is on the card above.";

export function declaredEgressTitle(egress: EgressDeclaration): string {
  if (egress === "none") return "Declares its cloud code makes no internet connections";
  if (egress === "aws-only") return "Declares its cloud code connects only to AWS";
  // The founder's wording (2026-09-01) for poppies whose agents browse on the user's
  // behalf — no fixed list exists, so this value is never shown as host-enforced.
  if (egress === "user-directed") return "Declares its cloud code reaches the internet only under your request";
  const shown = egress.slice(0, EGRESS_TITLE_DOMAINS).join(", ");
  const more = egress.length - EGRESS_TITLE_DOMAINS;
  return more > 0
    ? `Declares its cloud code connects only to ${shown} and ${more} more`
    : `Declares its cloud code connects only to ${shown}`;
}
