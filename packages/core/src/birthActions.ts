// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * How a tag-scoped grant's actions are classified, and what that costs the promise.
 *
 * This lives in core rather than in the broker's policy compiler because BOTH the compiler and
 * the RATING have to agree about it. Invariant I6 says what `assessPermissionSet` shows the user
 * at approval time must match what the compiled session policy actually permits — and the way
 * that invariant breaks in practice is one of them keeping its own copy of the rule. It already
 * happened once: the rating↔compiler drift guard held a private copy of the compiler's verb
 * regex and went on passing while modelling a compiler that no longer existed.
 *
 * One table. Both readers.
 */

/**
 * Births that touch SEVERAL resources, and therefore cannot take one blanket condition.
 *
 * Why a table and not a verb test. The split used to be `/:(Create|Request)/`, and
 * `ec2:RunInstances` matches neither word — so the action that launches every VM landed in the
 * `aws:ResourceTag` branch, whose condition can never match a resource being born. Every launch
 * was denied, silently, until a user pressed the button. That is the same failure
 * `statementForGrant`'s own doc-comment records for `Create*` in July 2026; the lesson was patched into the regex
 * instead of being generalised, so it returned wearing a different verb.
 *
 * But "is it a birth" was never the real question. `ec2:CreateSecurityGroup` IS a birth and
 * still cannot take a blanket condition, because AWS authorises it against two resources: the
 * security group it creates (which carries our request tags) and the **VPC it is created in**
 * (which does not). One condition over both denies the call. So the axis that matters is how
 * many resource LEGS an action is authorised against, and which of those legs carry
 * `aws:RequestTag`. AWS publishes exactly that, per action, in its service reference.
 *
 *   - `bornTagged`  — legs created carrying our tags. Conditioned on `aws:RequestTag`, so the
 *                     resource is born ours or is not born at all.
 *   - `referenced`  — legs the call must name but does not tag (a foreign AMI, the VPC), or
 *                     creates untagged. Allowed unconditioned.
 *
 * ⚠️ TWO RULES, both learned the hard way:
 *
 * 1. `bornTagged` must list EXACTLY the legs the caller actually tags. Conditioning a leg the
 *    poppy does not tag denies the call as surely as conditioning none — a launch that tags only
 *    `instance` is refused by a policy that also conditions `volume`. This list is therefore
 *    coupled to the poppy's own `TagSpecifications`, and nothing detects a mismatch until
 *    runtime. Both shipped EC2 poppies tag instance + volume.
 *
 * 2. `referenced` is a hole in the tag-scoped promise, so it holds the MINIMUM that makes the
 *    call work and nothing more. An earlier draft of this table also listed `snapshot/*` for
 *    RunInstances, which would have let a poppy restore the user's database snapshot onto an
 *    instance it owns — fully tagged, indistinguishable from a compliant launch, with the data
 *    leaving over the network. Never add a leg speculatively: add it when a real call site needs
 *    it, and prove it with a dry-run.
 *
 * PROVEN LIVE (a dedicated sandbox account, `--dry-run`, with an unconditional positive control and
 * negative controls for untagged, wrongly-tagged and partially-tagged calls). See
 * docs/specs/tag-scoping-and-ratings.md.
 */
export interface SpreadBirth {
  /** Legs created carrying our tags — conditioned on aws:RequestTag. */
  bornTagged: readonly string[];
  /** Legs referenced but not tagged by the call — allowed unconditioned. Keep minimal. */
  referenced: readonly string[];
}
export const SPREAD_BIRTHS: Record<string, SpreadBirth> = {
  "ec2:runinstances": {
    bornTagged: ["arn:aws:ec2:*:*:instance/*", "arn:aws:ec2:*:*:volume/*"],
    referenced: [
      "arn:aws:ec2:*::image/*",
      "arn:aws:ec2:*:*:subnet/*",
      "arn:aws:ec2:*:*:security-group/*",
      "arn:aws:ec2:*:*:key-pair/*",
      "arn:aws:ec2:*:*:network-interface/*",
    ],
  },
  "ec2:createsecuritygroup": {
    bornTagged: ["arn:aws:ec2:*:*:security-group/*"],
    referenced: ["arn:aws:ec2:*:*:vpc/*"],
  },
};

/**
 * A birth that creates ONE resource, so a single `aws:RequestTag` condition on `Resource: "*"`
 * confines it — `ec2:CreateKeyPair` is the shipped example.
 *
 * An action that is a birth, is NOT in SPREAD_BIRTHS, and has a leg that does not carry
 * `aws:RequestTag` will be DENIED at runtime. That is the safe direction (a visible denial, not
 * a silent hole), but it is still a bug, and the fix is a SPREAD_BIRTHS entry — never a broader
 * condition. There is deliberately no list of extra birth verbs here: an earlier draft carried
 * `AllocateAddress`, `RegisterImage`, `CopyImage` and `CopySnapshot` with no call site, and AWS's
 * service reference shows three of the four are multi-leg (so they would have been denied) while
 * the copy actions would have allowed copying a snapshot the poppy does not own.
 */
export function isSimpleBirth(action: string): boolean {
  return /:(Create|Request)/.test(action);
}

/**
 * Does the tag-scoped compiler treat this action as a BIRTH — something that does not exist yet,
 * and so is confined by `aws:RequestTag` rather than `aws:ResourceTag`?
 *
 * Exported so the rating↔compiler drift guard can ask the REAL classifier. It used to keep its
 * own copy of the verb regex, which meant the guard went on passing while modelling a compiler
 * that no longer existed — a drift detector that had itself drifted.
 */
export function compilerTreatsAsBirth(action: string): boolean {
  return Boolean(SPREAD_BIRTHS[bareKey(action)]) || isSimpleBirth(action);
}


/** Bare `service:action`, lowercased — the key SPREAD_BIRTHS is indexed by. */
export function bareKey(action: string): string {
  return action.toLowerCase();
}

/** `ec2:RunInstances` → `RunInstances`, for a readable and unique Sid. */
export function sidPart(action: string): string {
  return (action.split(":")[1] ?? action).replace(/[^A-Za-z0-9]/g, "");
}

/**
 * Does compiling this grant emit a statement with NO tag condition on it?
 *
 * True exactly when a tag-scoped grant contains a spread birth, because such a birth needs its
 * referenced legs (a foreign AMI, the VPC) allowed unconditioned or the call is denied. Nothing
 * UNTAGGED can be created through those legs — the born-tagged legs are still conditioned — but
 * the grant can *reference* resources it does not own, and the consent line must not claim
 * otherwise. This is the hook the rating uses to tell the truth.
 */
export function grantHasReferencedLeg(grant: { actions: string[]; service: string }): boolean {
  return grant.actions.some((a) => {
    const qualified = a.includes(":") ? a : `${grant.service}:${a}`;
    return Boolean(SPREAD_BIRTHS[bareKey(qualified)]);
  });
}
