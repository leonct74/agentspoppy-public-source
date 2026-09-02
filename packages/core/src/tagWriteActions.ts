// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The tag-write table — ONE table, read by BOTH the policy compiler and the rating
 * (docs/specs/rating-reconciliation.md fix 4; the same shared-table pattern as
 * birthActions.ts, and for the same I6 reason: the rating must describe what the
 * compiled policy permits, and two copies of the truth WILL disagree).
 *
 * Moved verbatim from packages/broker/src/aws/policy.ts (the I2-precondition work):
 * the detector regex, the per-service rules, and every proof comment. Nothing about
 * the CONTENT changed in the move — only its address — pinned by the broker's
 * tag-adoption.test.ts running unchanged.
 */

/**
 * Detects an action that WRITES tags. Case-INSENSITIVE and enforcement-grade: a
 * security detector reading attacker-supplied text must not fail open on a one-letter
 * change. (Contrast permissions.ts's create filter, which is deliberately
 * case-SENSITIVE because it mirrors the compiler character-for-character; that one is
 * descriptive, this one is enforcement.)
 */
export const TAG_WRITE_ACTION =
  /^(Tag|Untag|AddTags|RemoveTags|CreateTags|DeleteTags|SetTags|PutTags|ChangeTags|PutBucketTagging|DeleteBucketTagging)/i;

/**
 * How a service's tag writes are allowed to be conditioned.
 *
 * This table is per-service and MUST stay that way. A condition key a service does not
 * populate can never be satisfied, so emitting one turns an Allow into a permanent Deny —
 * a deploy that breaks in the user's own account, discovered by them. Every entry here was
 * checked against the AWS Service Authorization Reference for the exact action.
 *
 * NOT LISTED = REFUSED. s3 is the worked example: `s3:PutBucketTagging` supports neither
 * `aws:RequestTag` nor `aws:ResourceTag`, so both shapes below would deny every bucket tag
 * write forever. S3 tag writes must be name-scoped, which every shipped poppy already does.
 */
export interface TagWriteRules {
  /** Bare action names that add or overwrite tags. */
  add: string[];
  /** Bare action names that remove tags. These NEVER get a request-tag condition: no tags
   *  ride along on a removal, so the key is unpopulated and the condition is a deny. */
  remove: string[];
  /**
   * `create-action` — the service can prove the tag write is part of a create call, so the
   *                   standalone claim path is removed entirely. No residual gap.
   * `none`          — PROVEN, per service, that AWS populates `aws:ResourceTag` with the
   *                   SUBMITTED tags during a tag-on-create. The re-tag-your-own statement
   *                   therefore authorises creates on its own, and a claim statement would
   *                   add nothing except the ability to claim an untagged resource. Also
   *                   no residual gap.
   * `request-tag`   — not yet proven for this service. Claim only something not already
   *                   claimed. Works, but LEAVES A RESIDUAL: a resource the user created
   *                   by hand carries no attribution tag and so counts as unclaimed.
   */
  claim: "create-action" | "request-tag" | "none";
}

export const TAG_WRITE_RULES: Record<string, TagWriteRules> = {
  // ec2:CreateAction is populated ONLY when CreateTags is evaluated as the tagging half of
  // a create call, and is absent when CreateTags is called directly — AWS: "users are not
  // permitted to tag any existing resources". It is NOT listed on DeleteTags (a delete is
  // never part of a create), so it must never be applied there.
  ec2: { add: ["CreateTags"], remove: ["DeleteTags"], claim: "create-action" },
  // PROVEN live (canary, 26 Aug 2026): a pool created WITH tags succeeds under a policy
  // carrying NO claim statement, so aws:ResourceTag really is populated with the submitted
  // tags during the dependent TagResource check. The claim statement was therefore doing
  // nothing for creates — its only remaining effect was to permit claiming an UNTAGGED
  // pool, which the same run confirmed was possible. Dropping it closes that gap at no
  // cost. See docs/specs/tag-adoption-canary.md.
  "cognito-idp": { add: ["TagResource"], remove: ["UntagResource"], claim: "none" },
  // PROVEN live (canary, 26 Aug 2026), all three parts — the founder authorised briefly
  // enabling a detector for it, and it was deleted immediately afterwards. Creating a
  // filter carrying its own tag succeeded with no claim statement; claiming an UNTAGGED
  // filter was DENIED without the statement and ALLOWED with it; re-tagging its own kept
  // working. Same shape as cognito-idp and amplify.
  guardduty: { add: ["TagResource"], remove: ["UntagResource"], claim: "none" },
  // PROVEN live (canary, 26 Aug 2026), BOTH halves — which is the only kind of proof that
  // counts here. Creating an app with its own tag succeeded under a policy carrying no
  // claim statement; and claiming an UNTAGGED app it did not create was DENIED without the
  // statement and ALLOWED with it, with the app's real tags confirming both. So the
  // statement was not authorising creates, only enabling the takeover.
  amplify: { add: ["TagResource"], remove: ["UntagResource"], claim: "none" },
};

/** Bare action name, without the optional `service:` prefix. */
function bareName(action: string): string {
  const i = action.indexOf(":");
  return i >= 0 ? action.slice(i + 1) : action;
}

/** Case-insensitive membership, for the same reason TAG_WRITE_ACTION is. */
export function listedInTagRules(names: string[], action: string): boolean {
  const bare = bareName(action).toLowerCase();
  return names.some((n) => n.toLowerCase() === bare);
}

/**
 * True iff the COMPILER will emit this action conditioned: the action is a tag write
 * listed in the service's rules, so the vended policy provably confines it to claiming
 * or releasing the poppy's own label — never touching a foreign resource's.
 *
 * This is the rating's hook (I6): a covered tag write must not rate as "can change
 * anything that exists", because the compiled policy makes that impossible. The
 * fail-safe direction is preserved by construction: a wildcard action, or a tag write
 * on a service this table has not cleared, returns false — and the compiler REFUSES to
 * vend the uncovered case at all, so red is also the honest rating for it.
 */
export function compiledTagWriteConfined(service: string, action: string): boolean {
  const rules = TAG_WRITE_RULES[service.toLowerCase()];
  if (!rules) return false;
  if (!TAG_WRITE_ACTION.test(bareName(action))) return false;
  return listedInTagRules(rules.add, action) || listedInTagRules(rules.remove, action);
}
