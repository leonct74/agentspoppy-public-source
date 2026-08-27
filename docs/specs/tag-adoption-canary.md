# Canary — proving the tag-adoption fix against real AWS
**Status:** ready to run · 26 August 2026
**Proves:** `docs/specs/tag-adoption.md` — that the conditions the compiler now emits
actually behave, in a real account, the way the unit tests assume they do.
**Runs against:** the founder's AWS account. **Nothing here runs without explicit approval.**
---
## Why this exists
The unit tests prove what AgentsPoppy **generates**. They cannot prove what AWS **does with
it**. Two assumptions carry the whole fix and neither is ours to assert:
1. **`ec2:CreateAction` is populated** when `CreateTags` is evaluated as the tagging half of
   a create, and **absent** when `CreateTags` is called directly. If that is wrong in either
   direction the EC2 rule either denies every legitimate launch or blocks nothing.
2. **`Null: {"aws:ResourceTag/agentspoppy:app": "true"}`** evaluates true for a resource that
   has other tags but not this one. If it does not, either every claim is refused (broken
   deploys) or every claim is permitted (the hole is still open).
A wrong assumption here does not show up in CI. It shows up as a stranger's deploy failing
in their own account, or as an attack that still works.
## What the research already changed — read this first
Two findings from checking the AWS documentation, before a single command has run.
### The Cognito half of the fix may not work as designed
The claim statement for cognito / guardduty / amplify assumes that during a tag-on-create
the resource has no tags yet, so `aws:ResourceTag/agentspoppy:app` is **absent** and the
`Null` test passes. **AWS documents the opposite.** From the IAM global condition key
reference, verbatim:
> *"This key is included in the request context when the requested resource already has
> attached tags **or in requests that create a resource with an attached tag**."*
If `aws:ResourceTag` is populated with the submitted value during a create, then the claim
statement's `Null` test is **false** and does not authorise the create at all. The create
may still succeed — via the *second* statement, since `aws:ResourceTag` would then equal the
app's own id — but that is not the design, and it may equally be denied outright.
Either way the `Null` branch is not doing the job it was written for on these services, and
which of the two happens decides whether CrewPoppy still deploys. **This is now the single
most important thing the canary settles, and it must be settled before this reaches any
user.** The EC2 branch is unaffected: `ec2:CreateAction` + `aws:RequestTag` on
`ec2:CreateTags` is AWS's own documented tag-on-create pattern, and the IAM reference's
worked example for `aws:RequestTag` is literally an `ec2:CreateTags` policy.
### The simulator cannot be trusted in one direction
`SimulateCustomPolicy`'s own documentation says it does **not** simulate scope-down policies
— *"do not use policies designed to restrict what a user can do while using the temporary
credentials"* — which is exactly what AgentsPoppy compiles. It evaluates our document as a
standalone identity policy and does not model session-policy ∩ role-policy.
The practical rule that follows, and it is not symmetric:
- **a simulated DENY is trustworthy** — an intersection can only ever remove more;
- **a simulated ALLOW is an upper bound**, not a guarantee.
So simulation can prove the attack is blocked. It cannot prove the product still works.
Rows 1–3 of the table below therefore *require* tier 2.
## Two tiers, cheapest first
**Tier 0 — settle two undocumented mechanics.** Both are single calls and both must happen
before anything is read as a pass or a failure.
- **Does the simulator model an ABSENT key?** Omitting a context entry returns
  `implicitDeny` *and* lists the key in `missingContextValues` — which is indistinguishable
  from a genuine deny if you only read the decision. Probe it with a policy whose only
  condition is `Null: "true"`, run with the key omitted: `allowed` means the `Null` branch
  is simulatable; `implicitDeny` + the key in `MissingContextValues` means it is not, and
  every `Null` result must come from tier 2 instead.
- **Does EC2 `DryRun` perform the dependent `CreateTags` check?** The documentation is
  silent, and there is precedent for DryRun under-reporting. Calibrate with one free
  dry-run using a deliberately WRONG app id: if it fails, DryRun does exercise the
  dependent check and can be used for the rest; if it succeeds, DryRun proves nothing here
  and every EC2 result must come from a real call.
**Tier 1 — simulation. Read-only, creates nothing, costs nothing.** Proves the *policy
logic*: given these context keys, does our document allow or deny. Subject to the
one-direction caveat above — trust the denies, verify the allows.
Two ways to misread it, both easy:
- **pass `--resource-arns`.** The Cognito statements are scoped to `userpool/*`; without an
  ARN the simulated resource defaults to `*` and returns `implicitDeny` for a resource-scope
  reason that has nothing to do with the conditions under test.
- **read `ResourceSpecificResults`, not the top-level decision.**
For keys used with `StringEquals`, absence and mismatch are equivalent, so an absent key can
be modelled faithfully with a sentinel non-matching value. `Null` is explicitly carved out
of that rule — no sentinel can stand in for absence — which is why tier 0 exists.
Caller needs `iam:SimulateCustomPolicy`. **Neither existing IAM user in the account has it**,
so this needs a deliberate IAM grant — a real change, and yours to approve.
**Tier 2 — real calls, minimum footprint.** Only the assumptions tier 1 structurally cannot
reach.
## The footprint is deliberately tiny
**EC2 uses security groups, not instances.** `CreateSecurityGroup` is one of the two actions
named in the compiled `ec2:CreateAction` list, it accepts tags in the create call
(`--tag-specifications`), and it is free and instant. **No compute is ever started**, so
nothing can be left running and billing.
Do not substitute a "cheaper" taggable resource — a key pair or placement group would fail
the `StringEquals` on `ec2:CreateAction` for the wrong reason and prove nothing.
Use the JSON form of `--tag-specifications`, not the shorthand: the tag key
`agentspoppy:app` contains a colon and the shorthand parser mis-splits it. Same for
`--context-entries` in tier 1.
**Cognito uses one throwaway user pool**, free at this scale.
Everything is deleted at the end, and the last step re-checks that nothing survived.
## The control that makes results attributable
Every test runs against **both** policies: the one HEAD compiled before this change, and the
one it compiles now. Without that, a failure caused by something pre-existing gets blamed on
the fix, or worse, the reverse.
One known pre-existing quirk to control for: `cognito-idp:CreateUserPool` is scoped to
`arn:aws:cognito-idp:*:*:userpool/*` in CrewPoppy's manifest, though the action has no
resource ARN at call time. **Verified identical before and after this change** — so if
`CreateUserPool` misbehaves, it is not this fix.
## What must be true
Each row is a claim the fix depends on. A single unexpected result stops the run.
| # | Claim | Expected |
|---|---|---|
| 1 | A poppy can tag a resource it is creating, with its own tag | **allowed** |
| 2 | A poppy can re-tag a resource already carrying its own tag (the CloudFormation delta) | **allowed** |
| 3 | A poppy can untag a resource already its own | **allowed** |
| 4 | A poppy **cannot** tag a pre-existing resource it did not create | **denied** |
| 5 | A poppy **cannot** claim a resource carrying another app's tag | **denied** |
| 6 | A poppy cannot tag at create using someone *else's* tag value | **denied** |
| 7 | Nothing a poppy legitimately did before is refused now | **unchanged vs HEAD** |
| 8 | **Cognito tag-on-create still works at all** — whichever statement authorises it | **allowed** |
Row 8 is the one the documentation put in doubt. If it fails, CrewPoppy cannot deploy and
the fix must not ship for Cognito in its current shape.
Rows 1–3 are the "did we break the product" half. Rows 4–6 are the "did we close the hole"
half. **Both halves have to pass** — a rule that blocks the attack by blocking everything is
not a fix.
## Safety rules for the run
- Read-only commands (`simulate-custom-policy`, `describe-*`, `list-*`) may run freely.
- **Every command that creates, tags, or deletes anything is shown and confirmed first.**
- Throwaway names only, all prefixed `agentspoppy-canary-`, so anything stranded is obvious.
- Cleanup runs even if the canary fails partway.
- Never run against a resource that already exists for real work.
## If it fails
A tier-1 failure means the policy shape is wrong → fix the compiler, re-run. Nothing was
created, so there is nothing to undo.
A tier-2 failure on rows 1–3 means the rule is too tight and would break real deploys → the
fix must not ship to users until corrected. A failure on rows 4–6 means the hole is not
actually closed → the spec's claims must be corrected before anything is published, and
`scripts/export-denylist.txt` keeps the spec withheld until then.
Either way: **the spec stays withheld from the public mirror until this passes.** Publishing
"we closed this" before proving it is the failure mode the whole exercise exists to avoid.
## Two things the docs could not settle, recorded so nobody assumes them
1. **Whether a failed dependent `CreateTags` check rolls back the security group.** The docs
   say only that "the request fails" — not that no resource is created. Check with
   `describe-security-groups` after the wrong-app-id test, and clean up whatever is there.
2. **Whether `aws:ResourceTag` is populated during a Cognito tag-on-create** — the finding
   at the top of this document. This is row 8, and it is the reason the canary exists.
---
# RESULT — run 26 August 2026, the founder's account, eu-west-1
**Both branches pass, and the run improved the fix.** Every canary resource was deleted and
swept: no user pools, no security groups.
| Test | EC2 | Cognito |
|---|---|---|
| Tag while creating, own tag | allowed ✅ | allowed ✅ |
| Tag while creating, **another app's** tag | **refused** ✅ | — |
| **The attack** — claim a resource it did not create | **refused** ✅ | **refused** ✅ |
| CloudFormation delta re-tag | allowed ✅ | allowed ✅ |
| Untag its own | allowed ✅ | allowed ✅ |
| Untag one that is not its own | **refused** ✅ | — |
Row 8 — whether Cognito tag-on-create still works — **passes**. CrewPoppy still deploys.
## The finding: the claim statement was pointless, and harmful
The AWS documentation warned that `aws:ResourceTag` might be populated during a create,
which would stop the `Null` test firing. It is, and it does not fire. Proven by removing the
claim statement entirely and creating a tagged pool anyway: **allowed**.
So for Cognito the claim statement never authorised a single create. Its only remaining
effect was to permit claiming an **untagged** resource — and the same run confirmed that
worked, taking over an untagged pool.
**Removing it closes the residual gap at no cost.** Cognito now matches EC2: no residual.
`TAG_WRITE_RULES["cognito-idp"].claim` is `none`.
**guardduty and amplify keep the weaker shape deliberately.** The global condition-key
reference implies the same behaviour, but "implies" is what this canary exists to stop
trusting, and being wrong means MailPoppy or HostingPoppy stops deploying. Each needs its
own run. Testing amplify needs `amplify:CreateApp`/`TagResource` added to the canary user;
guardduty may carry cost and should be priced before it is touched.
## Two process lessons worth more than the result
**A shell quirk nearly produced a false pass.** zsh parses `$ACCT:userpool` as `$ACCT:u` —
its upcase modifier — silently mangling every ARN. Four tests reported as *denied* had never
reached AWS at all. It was caught only by reading the resources' actual tag state instead of
trusting the harness's own output. **On a security test, check the world, not the script.**
**The CLI on the machine is aws-cli 2.2.3 (2021).** It does not expose `--user-pool-tags`
(worked around with `--cli-input-json`) and renders empty responses as
`Unknown output type: none`, which reads like a failure. Worth updating independently.
## Still open
- amplify and guardduty: same test, then move them to `claim: "none"` if they pass.
- The id-prefix limit (`instance/i-*`) — CLOSED, see below.
## Follow-up run — Amplify, same day
Same two-part test as Cognito, and **both halves passed**, so amplify moves to `claim: "none"`:
| | with the claim statement | without it |
|---|---|---|
| create an app carrying its own tag | ALLOWED | **ALLOWED** |
| claim an UNTAGGED app it did not create | **ALLOWED** — the gap, real | **DENIED** |
The second row is the one that mattered, and it was checked against the app's real tags
rather than the script's own reporting: with the statement, the app genuinely ended up
carrying `agentspoppy:app=com.hostingpoppy.desktop`; without it, its tags stayed empty.
Only the first row was available on the first attempt, because an IAM permission change was
still propagating and `CreateApp` flapped between allowed and denied within a minute. **Half
a result was not acted on** — removing the statement on "creates still work" alone would
have assumed the protective half follows from the permissive half, which is the exact
mistake the Cognito documentation had already caught once.
GuardDuty was NOT tested and keeps the weaker shape: a detector would have to be created,
which enables a paid service on the account.
**Process note:** an IAM policy update propagates unevenly — `delete-app` succeeded while
`list-apps` and `create-app` were still denied, seconds apart. Two Amplify apps were created
under a permission that then vanished; they were deleted by direct id, since listing was
unavailable. **Keep a written record of every id created, at creation time** — an
unlistable resource is still yours to clean up.
## Follow-up run — GuardDuty, same day. All four services now closed.
The founder authorised briefly enabling a detector. It was created, used, and deleted; the
account was verified back to no detectors, and MailPoppy's live malware-protection plan
 was confirmed untouched.
| | with the claim statement | without it |
|---|---|---|
| create a filter carrying its own tag | — | **ALLOWED** |
| claim an UNTAGGED filter it did not create | **ALLOWED** — the gap, real | **DENIED** |
| re-tag a filter it already owns | — | **ALLOWED** |
Same result as Cognito and Amplify, read off the filters' real tags each time.
**A correction that mattered.** The run was nearly not done at all, because a check for
GuardDuty *detectors* came back empty and was reported as "GuardDuty is off". The founder
said he remembered enabling it with MailPoppy, and he was right: `MailpoppyMailStack` holds
a live `AWS::GuardDuty::MalwareProtectionPlan`. **Malware Protection for S3 and the
detector are separate features** — the first was on, the second was not. Checking one and
reporting on the other understated what the account already had, and would have left the
last gap open on a false premise.
## Final state
| Service | Residual gap |
|---|---|
| EC2 | none — `ec2:CreateAction` |
| Cognito | none — proven, claim statement removed |
| Amplify | none — proven, claim statement removed |
| GuardDuty | none — proven, claim statement removed |
The `request-tag` shape is retained in the compiler for a service added in future, which
sits there until it has had this same run. Nothing uses it today.
## Postscript — the "known limit" was a live bypass
Preparing to publish these documents, the id-prefix caveat was checked rather than taken on
trust. It was not a caveat. `arn:aws:ec2:*:*:instance/i-*` and
`arn:aws:cognito-idp:*:*:userpool/eu-west-1_*` **skipped the tag rule completely** — the rule
only applied to scopes that did not narrow, and these look like name patterns while matching
everything of their type.
So a hostile manifest could have written a scope that reads as *more* specific than `*`,
been rated as confined, and kept an unconditioned tag write. The whole fix, bypassed by
looking tidier.
Fixed by removing the assumption rather than special-casing the symptom: for a service whose
conditions are proven, **the scope no longer decides** — tag writes are conditioned always.
The fleet is unaffected (no poppy loses or gains an action), because a tag-on-create is
authorised by the re-tag-your-own statement, which these runs established on real AWS.
The lesson generalises past this fix: **a "known limitation" written into a document is a
claim, and it decays.** This one was true when written — the rule genuinely could not tell
the two patterns apart — and became false the moment the rule stopped needing to. Checking it
before publishing cost one command.
