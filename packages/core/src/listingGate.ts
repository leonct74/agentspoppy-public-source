// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The listing gate — the ONE place the repo-side manifest acceptance rules live
 * (docs/specs/rating-reconciliation.md, fixes 2, 3 and 5a).
 *
 * Before this module, seven poppy repos carried their own `validate-manifest` script
 * with their own fail rules; a checksum sweep found six distinct versions, and the
 * strictest of them failed grants the doctrine and the rating both call acceptable
 * (an unscoped create-only grant, which is additive). That is the MailPoppy
 * `.json`/`.yaml` twin-drift disease: a prose promise ("keep these in step") is not a
 * mechanism. The rules now live here; the repo scripts are thin loaders that print
 * what this function decides.
 *
 * The rules ARE the doctrine (AGENTS.md §3), mechanized — no stricter, no looser:
 *  - FAIL  an unscoped grant that can change/delete what already exists, or launch
 *          compute that teardown cannot see.
 *  - FAIL  an unscoped create-only grant with no substantive `reason` — the doctrine's
 *          "with its required reason" is a requirement, not a suggestion.
 *  - FAIL  a known id-prefix scope (looks narrow, practically reaches every resource
 *          of the type — `apps/d*`, `hostedzone/Z*`) whose `reason` does not carry a
 *          substantive disclosure. The gate also ALWAYS emits the practical-reach note,
 *          so the truth is in every CI log (machine-checked disclosure, not prose hope).
 *  - NOTE  unscoped reads (deliberate, justified in the description) and passing
 *          create-only grants — loud, never fatal.
 *  - Never fail on the overall rating COLOUR: identity-class creates rate red however
 *    tightly scoped (see AGENTS.md's acceptance-test note) — colour is display, these
 *    rules are the contract.
 */
import { assessPermissionSet, grantCanDestroy, grantCanLaunchUntracked, grantCanMutate, grantIsTagScoped, scopeIsUnbounded } from "./permissions";
import type { PermissionGrant, PermissionSet } from "./types";

export interface ListingAssessment {
  /** Any entry means: not listable. */
  problems: string[];
  /** Mandatory disclosures and loud passes — print every one. */
  notes: string[];
}

/** A reason must say something, not merely exist. */
const REASON_MIN = 20;
/** An id-prefix disclosure has more to admit, so it owes more words. */
const ID_PREFIX_REASON_MIN = 40;

/**
 * Scopes that RATE as narrow but practically reach every resource of their type,
 * because the service's ids share a fixed prefix (every Amplify app id starts with
 * `d`, every Route 53 zone id with `Z`). Rule 5a: blessed, but only with a mandatory,
 * machine-checked disclosure — and the honest end-state (5b: rate them as what they
 * are, in a "guarded by disclosed code-level checks" register) is committed for the
 * next mechanism window, not indefinite.
 */
const ID_PREFIX_SCOPES: { service: string; pattern: RegExp; reach: string }[] = [
  { service: "amplify", pattern: /:apps\/[a-z]\*$/i, reach: "any Amplify app in the account" },
  { service: "route53", pattern: /:hostedzone\/[A-Z]\*$/i, reach: "any DNS zone in the account" },
];

function idPrefixReach(grant: PermissionGrant): string | null {
  const hit = ID_PREFIX_SCOPES.find(
    (e) => e.service === grant.service.toLowerCase() && e.pattern.test(grant.resourceScope),
  );
  return hit ? hit.reach : null;
}

function label(grant: PermissionGrant): string {
  return `${grant.service}: ${grant.actions.join(", ")} @ ${grant.resourceScope}`;
}

function hasSubstantiveReason(grant: PermissionGrant, min: number): boolean {
  return typeof grant.reason === "string" && grant.reason.trim().length >= min;
}

/** The gate. Pure; every problem reported at once, CI decides on `problems.length`. */
export function assessListing(ps: PermissionSet): ListingAssessment {
  const problems: string[] = [];
  const notes: string[] = [];

  const risk = assessPermissionSet(ps);
  // Set-level assessor warnings (e.g. missing attribution tags) stay fatal: today's
  // fleet has none, and a new one deserves a stop, not a footnote.
  problems.push(...risk.warnings.map((w) => `assessor warning: ${w}`));

  for (const g of ps.grants) {
    // Fix 5b made id-prefix scopes rate as the unbounded grants they are; fix 5a's
    // contract still holds here: blessed WITH a substantive disclosure, refused without.
    // Handled first so the unscoped-destroy rule below never fires on a disclosed one.
    const reach = idPrefixReach(g);
    if (reach) {
      notes.push(`${label(g)} — id-prefix scope: reads as narrow but practically reaches ${reach}.`);
      if (!hasSubstantiveReason(g, ID_PREFIX_REASON_MIN)) {
        problems.push(
          `${label(g)} — an id-prefix scope practically reaches ${reach}, so its \`reason\` must own up to that ` +
            `in the user's language (≥ ${ID_PREFIX_REASON_MIN} chars). Add the disclosure.`,
        );
      }
      continue;
    }

    const scoped = grantIsTagScoped(g) || !scopeIsUnbounded(g.resourceScope, g.service);

    if (!scoped && grantCanDestroy(g)) {
      problems.push(
        `${label(g)} — an unscoped grant that can change or delete resources beyond the poppy's own. ` +
          `Scope it tagged-as-self, or to a concrete name/ARN pattern the poppy owns.`,
      );
      continue;
    }
    if (!scoped && grantCanLaunchUntracked(g)) {
      problems.push(
        `${label(g)} — an unscoped grant that can launch compute teardown cannot see (no birth tag, no name). ` +
          `Scope it, or use a create-class action the compiler birth-tags.`,
      );
      continue;
    }
    if (!scoped && grantCanMutate(g)) {
      // Create-only: additive by doctrine — acceptable WITH its required reason.
      if (!hasSubstantiveReason(g, REASON_MIN)) {
        problems.push(
          `${label(g)} — an unscoped create-only grant is acceptable (creating is additive), ` +
            `but ONLY with a substantive \`reason\` (≥ ${REASON_MIN} chars) saying why the scope can't be narrower. Add one.`,
        );
      } else {
        notes.push(`${label(g)} — unscoped create-only (additive); reason present. Rated on its own terms by the assessor.`);
      }
      continue;
    }
    if (!scoped) {
      notes.push(
        `${label(g)} — read-only grant AWS gives no way to scope. Deliberate: justify it in permissionSet.description (the user reads that at install).`,
      );
      continue;
    }

  }

  return { problems, notes };
}
