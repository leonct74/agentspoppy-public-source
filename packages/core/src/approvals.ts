// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The supervised-mode logic: deciding when a poppy's request needs the user's
 * explicit approval, and the safety check that an app can never use a declared
 * "operation" to ask for more than its connection already grants. All pure and
 * unit-tested — the broker wires these into credential vending (see broker/service).
 */
import { grantCanMutate } from "./permissions";
import type { OperationIntent, PermissionGrant } from "./types";

/** The grants in a set that can only read (used to vend an un-gated read subset). */
export function readOnlyGrants(grants: PermissionGrant[]): PermissionGrant[] {
  return grants.filter((g) => !grantCanMutate(g));
}

/** True if an operation would change or destroy something (so it needs approval when supervised). */
export function operationIsMutating(operation: OperationIntent): boolean {
  return operation.grants.some(grantCanMutate);
}

/** A wildcard action — `"*"` or a service wildcard like `"s3:*"`. */
function isWildcardAction(a: string): boolean {
  return a === "*" || a.endsWith(":*");
}

/** Action name without its optional `service:` prefix, lower-cased, for comparison. */
function bareAction(a: string): string {
  const i = a.indexOf(":");
  return (i >= 0 ? a.slice(i + 1) : a).toLowerCase();
}

/** True if `supActions` covers `action` (exact name, or a wildcard). */
function actionCoveredBy(action: string, supActions: string[]): boolean {
  if (supActions.some(isWildcardAction)) return true;
  const want = bareAction(action);
  return supActions.some((s) => bareAction(s) === want);
}

/**
 * True if the broader scope `sup` covers the requested scope `sub`. We only treat
 * an exact match, or a literal `"*"` ceiling, as coverage — never attempt to prove
 * one ARN pattern subsumes another (fail-closed: a mismatch is "not covered").
 */
function scopeCovers(sup: string, sub: string): boolean {
  return sup === "*" || sup === "" || sup === sub;
}

/** True if a single requested grant is fully covered by some grant in `sup`. */
export function grantCoveredBy(g: PermissionGrant, sup: PermissionGrant[]): boolean {
  return sup.some(
    (s) =>
      s.service.toLowerCase() === g.service.toLowerCase() &&
      scopeCovers(s.resourceScope, g.resourceScope) &&
      g.actions.every((a) => actionCoveredBy(a, s.actions)),
  );
}

/**
 * True if every grant in `sub` is covered by `sup` — i.e. the declared operation
 * asks for nothing the connection's permission set doesn't already allow. The
 * broker uses this to refuse an operation that tries to widen its own access.
 */
export function grantsSubsetOf(sub: PermissionGrant[], sup: PermissionGrant[]): boolean {
  return sub.every((g) => grantCoveredBy(g, sup));
}
