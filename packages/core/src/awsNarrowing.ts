// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Rule C — say when AWS is the limit (docs/specs/tag-scoping-and-ratings.md §3).
 *
 * Some AWS actions cannot be narrowed by any policy anyone could write: AWS publishes
 * no resource types for them, so `Resource: "*"` is the only value that authorises
 * them. `ec2:DescribeInstances`, `sts:GetCallerIdentity` and `pricing:GetProducts` are
 * all in this class. A poppy asking for one at `*` has not been lazy — there is no
 * narrower grant to ask for.
 *
 * Until now the screen could not say so, and silence read as negligence. This module
 * is the distinct state: *AWS provides no way to narrow this*.
 *
 * WHAT IT MUST NOT DO. The state is an explanation, never an excuse, so it may not
 * change a rating or a scope. The blast radius of an account-wide read is an
 * account-wide read whatever the reason, and `hasUnscopedGrants` — which decides
 * supervision in the broker — must go on being true. Rule C only replaces the
 * *reason* the user reads. I6 (docs/SECURITY_MECHANISM.md): the rating may be
 * stricter than the compiled policy, never looser.
 *
 * VERIFIED LIVE, not assumed (2026-08-31, sandbox account, `iam:simulate-custom-policy`,
 * with a positive and a negative control so the run distinguishes something):
 *
 *   ec2:StopInstances     @ instance/*        allowed        <- positive control
 *   ec2:StopInstances     @ volume/*          implicitDeny   <- negative control
 *   ec2:DescribeInstances @ instance/*        implicitDeny   <- forced: scoping DENIES
 *   ec2:DescribeInstances @ "*"               allowed        <- forced: only "*" works
 *   ses:SendEmail         @ identity/*        allowed        <- narrowable, so NOT forced
 *   ses:CreateReceiptRule @ receipt-rule/*    implicitDeny
 *   ses:CreateReceiptRule @ "*"               allowed
 *
 * The `ses:SendEmail` row is why {@link grantCannotBeNarrowed} demands that EVERY
 * action in the grant be forced. MailPoppy's SES grant mixes 13 forced actions with 6
 * that AWS can narrow perfectly well; excusing the whole grant would launder the six.
 */
import { AWS_FORCED_ACTIONS } from "./generated/awsForcedActions";
import type { PermissionGrant } from "./types";

/** Lazily-built lookup per service, so the 6.6k-entry table is never scanned linearly. */
const cache = new Map<string, Set<string>>();

function forcedFor(service: string): Set<string> {
  const key = service.toLowerCase();
  let set = cache.get(key);
  if (!set) {
    const packed = AWS_FORCED_ACTIONS[key];
    set = new Set(packed ? packed.split(",") : []);
    cache.set(key, set);
  }
  return set;
}

/**
 * True if AWS publishes no resource type for this action, so `"*"` is the only Resource
 * that can authorise it.
 *
 * Fails CLOSED in every direction it can. An unknown service, an unknown action, or a
 * wildcard action all return false — i.e. no excuse is offered — because the damage
 * runs one way: wrongly claiming AWS forced a wide grant tells the user a lazy grant
 * was unavoidable. Being silent about a genuinely forced action merely leaves the
 * screen as it is today.
 */
export function awsCannotNarrowAction(service: string, action: string): boolean {
  if (!service || !action) return false;
  // A wildcard is never forced: `ec2:*` sweeps in every narrowable action there is.
  if (action === "*" || action.endsWith(":*")) return false;
  const i = action.indexOf(":");
  // A qualified action naming a DIFFERENT service than the grant is not something this
  // table can speak to — the grant's service is what the policy is written against.
  if (i >= 0 && action.slice(0, i).toLowerCase() !== service.toLowerCase()) return false;
  return forcedFor(service).has(action.slice(i + 1).toLowerCase());
}

/**
 * True if EVERY action in the grant is one AWS provides no way to narrow — so the grant
 * being at `"*"` is AWS's limit rather than the developer's choice.
 *
 * All-or-nothing on purpose. A grant mixing forced and narrowable actions is a grant
 * that could have been split into two, and saying "AWS gave us no choice" about it
 * would be false about the half that had one.
 */
export function grantCannotBeNarrowed(grant: PermissionGrant): boolean {
  if (!grant.actions.length) return false;
  return grant.actions.every((a) => awsCannotNarrowAction(grant.service, a));
}

/**
 * The actions in a grant that AWS *could* narrow — empty when Rule C applies. Lets a
 * caller explain a mixed grant precisely instead of rounding it to either story.
 */
export function narrowableActions(grant: PermissionGrant): string[] {
  return grant.actions.filter((a) => !awsCannotNarrowAction(grant.service, a));
}
