# Boundary-capped identity creates — the honest way to fewer "Broad access" chips

**Status:** BUILT + LIVE-PROVEN 2026-09-02 (host half; ships in 0.3.17 — the Deny's polarity was proven in the sandbox through the real operator path, see broker-role-v2.md's proof table; fleet dry-run: Affiliate/Crew/LiveOps/Traffic graduate to medium, MailPoppy stays high on its own SES/Route 53/GuardDuty `*` grants) — APPROVED to build by the founder (2026-09-02: *"yes, I want you to proceed
with the AgentsPoppyBoundary is verifiably attached"*), from his observation that 5 of 7
listed poppies show "Broad access". Verified same day: all five highs share ONE cause —
`iam:CreateRole` (Lambda execution roles, unavoidable for any serverless poppy) — and the
two EC2-only poppies rate medium. The guarded halves run only inside a founder-opened
mechanism window; this spec also claims that window for rating-reconciliation.md's owed
fix 5b, so one window closes both debts.

## The principle (unchanged, restated)

"Creating a role is creating an identity" rates high because a name scope confines which
ROLES exist, not what POWERS a role can be handed. The rater must not soften that by
words. The only honest way down is a **new AWS-enforced ceiling**: when every role a
poppy can create MUST carry the `AgentsPoppyBoundary` permissions boundary — refused by
IAM otherwise — then "can create identities" has a provable cap, and the rating may say
so. Mechanism first, chip second — the machine-gate graduation law, applied to IAM.

## The three mechanisms (two exist, one is the missing tooth)

1. **The boundary parameter in poppy stacks** — EXISTS (broker-role-v2 step 2, shipped
   in MailPoppy 0.1.25): a CFN `PermissionsBoundaryArn` parameter + a CDK Aspect bounds
   every role in the stack; the ARN arrives via `AGENTSPOPPY_BOOTSTRAP`, only when the
   host confirmed the policy exists; an unreadable host state ABORTS the deploy rather
   than stripping a boundary (the fail-open lesson).
2. **The confirmation that attaching works** — EXISTS (2026-08-30, live in the sandbox
   against the real policies): attaching a boundary authorizes against the ROLE, so the
   broker's `iam:*` Deny on the boundary policy itself does not block poppies from
   attaching it.
3. **The Deny that makes it universal** — MISSING (broker-role-v2 step 3): a conditional
   statement in the BROKER ROLE itself:
   - Deny `iam:CreateRole` unless `iam:PermissionsBoundary == AgentsPoppyBoundary`;
   - Deny `iam:DeleteRolePermissionsBoundary` on poppy-scope roles outright;
   - (`iam:PutRolePermissionsBoundary` allowed only WITH the right boundary, same
     condition shape).
   With it live, no vended credential can ever mint an unbounded role — not MailPoppy's,
   not a hostile poppy's, not a confused one's. Also required: **bootstrap ensures the
   `AgentsPoppyBoundary` managed policy exists** in the account (creating it at setup if
   absent), because a Deny conditioned on a policy nobody created would refuse every
   role create — the deploy-breaking shape step 2 was explicitly built to avoid.

## The graduated rating (guarded — the mechanism window)

`assessGrant` gains a context, exactly like the enforcement card's `machineGateArmed`:

- `boundaryEnforced: true` ONLY when the running broker reports, for THIS account, that
  (a) the AgentsPoppyBoundary policy exists, AND (b) the deployed broker role carries
  the step-3 Deny (probed from the live role, not assumed from any file). A manifest, a
  bootstrap flag, or an old role never graduates anything.
- Under that context, an identity-class create grant that is otherwise confined (tag- or
  name-scoped) rates **medium**, wording: *"Can create roles for its own functions —
  every one capped by your AgentsPoppyBoundary, enforced by AWS."* Uncapped accounts,
  wide-scoped role grants, and `iam:PassRole`-style escalations keep rating high,
  untouched.
- Pinned both ways in `rating-matches-compiler.test.ts`-style tests: graduates only with
  the live report; never graduates the wide or passrole cases; the wording never says
  "cannot" beyond what the Deny actually refuses.

Expected effect on the fleet, honestly stated: the five `iam:CreateRole` highs become
mediums **only for accounts where the ceiling is live** — the chip tells the truth per
account, which means a screenshot of the catalogue may still show high for an account
that never updated its role. That is correct behaviour, not a bug.

## What ships where — the founder's question answered (CORRECTED by audit, same day)

1. **Poppy releases: NONE NEEDED — the fleet already adopted step 2.** An audit of the
   four repos AND of the packages the live catalogue serves found every one already
   carrying MailPoppy's shape: every role in every shipped template bounded by the
   optional `PermissionsBoundaryArn` parameter (LiveOps 2/2, Traffic 2/2, Affiliate 2/2,
   CrewPoppy 3/3), the bootstrap ARN threaded through a resolver that aborts on an
   unreadable stack, and both boundary IAM actions granted in every released manifest.
   VM-Poppy and VPN-Poppy create no roles. The spec's premise was stale; the released
   fleet is ready for the Deny today. (Lesson, again: verify the artifact, not the memory.)
2. **A host release (0.3.17)**: bootstrap ensures the boundary policy; the broker-role
   template gains the step-3 Deny; the app's "Update policies" flow (which already
   exists for role updates) carries existing users' roles forward; the broker reports
   `boundaryEnforced` per account; the rating graduates on that report.
3. **Existing users**: one "Update policies/redeploy" click in the app (or re-running
   setup — idempotent) updates the deployed role. Until they do, their chip stays
   honest-high.

**Rollout order:** the poppies-first half is already satisfied by the released fleet, so
the host may ship the Deny + graduation directly. The order still matters for any FUTURE
role-creating poppy: the catalogue's mechanical review should refuse a template that
creates roles without the `PermissionsBoundaryArn` parameter once the Deny is live
(follow-up gate; otherwise that poppy's deploys roll back in updated accounts).

## Shared window: fix 5b lands too

Same window, same files (`permissions.ts` + `scopeIsUnbounded`): the per-service id
formats and the "AWS gives nothing to hold; guarded by disclosed code-level checks"
register from rating-reconciliation.md §5b. One banner, one touch, both debts closed,
one full-suite + certify pass.
