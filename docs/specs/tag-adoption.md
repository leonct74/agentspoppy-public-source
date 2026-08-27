# Spec — a poppy must not be able to claim what it did not create

**Status:** proposed · 26 August 2026
**Closes:** tag adoption — a live privilege-escalation path in six of the seven shipped poppies
**Replaces:** fault F's first deny, which as specced would break CrewPoppy's deploy
**Type:** security fix in the policy compiler. No manifest changes. No poppy-author action.

---

## The hole

A poppy is authorised to act on resources carrying its own attribution tag
(`agentspoppy:app = <its id>`). That is invariant I2, and it is what makes "touch only your
own" enforceable by IAM rather than by trust.

Six of seven shipped poppies **also hold an unconditioned permission to write tags on every
resource of some type**. So the tag that decides "this is mine" is a tag the poppy may write.
It is the lock and the key issued to the same hand.

CrewPoppy's compiled session policy, today, in two statements:

```
Grant10   cognito-idp:TagResource        Resource: arn:aws:cognito-idp:*:*:userpool/*
          (no Condition)

Grant11   cognito-idp:DeleteUserPool,    Resource: *
          UpdateUserPool,                Condition: aws:ResourceTag/agentspoppy:app
          AdminCreateUser,                          == com.crewpoppy.desktop
          AdminSetUserPassword …
```

Tag MailPoppy's mailbox pool as CrewPoppy's, and Grant11 now covers it: create a mailbox,
reset a password, or delete the pool outright.

**The two statements do not constrain each other.** IAM evaluates each independently — a
condition on one says nothing about the other. That is worth stating plainly because it is
exactly how this was misread when the manifest was reviewed: the assessor's summary for the
*tag-scoped* grant ("only resources tagged as its own") was taken to describe the *unscoped*
one as well.

## Blast radius, measured

Every grant that can write tags on a scope that does not narrow to particular resources:

| Poppy | Can tag | Can enumerate targets? |
|---|---|---|
| TrafficPoppy | — | — |
| CrewPoppy, LiveOpsPoppy | any Cognito user pool | **no** (no `ListUserPools`) |
| MailPoppy | any Cognito user pool, any GuardDuty plan | no |
| HostingPoppy | any Amplify app | yes (`amplify:ListApps` on `*`) |
| **VM-Poppy, VPN-Poppy** | **anything in EC2** | **yes** (`ec2:DescribeInstances` on `*`) |

The EC2 row is the severe one: a complete chain with nothing missing. List every instance in
the account → tag one → terminate it under the tagged-as-self grant. Including production.

The Cognito rows need the target pool's id from somewhere else, which is a real speed bump
but a weak thing to rely on — ids leak, and the CrewPoppy↔MailPoppy bridge is a poppy that
legitimately learns about another one.

## Why the obvious fixes are wrong

**Remove the permission.** No. CrewPoppy's deploy rolls back without it — a logged live
failure (30 July 2026). Cognito's tag-on-create requires `TagResource` permission alongside
`CreateUserPool`.

**Name-scope it.** No. A user pool's id does not exist until the pool has been created, so
there is nothing to name-scope against — unlike the `CrewPoppy*` naming used for log groups
and event rules.

**Deny writes to `agentspoppy:*` tag keys** (fault F as specced). No — that is precisely the
call CrewPoppy needs. Shipping it would reproduce the 30 July rollback for every user.

## The rule

**A poppy may put its tag on a resource only at the moment it is creating that resource, or
on a resource that already carries its tag.**

Pre-existing resources are never being created, so they can never be claimed. There is no
window and no need to reason about whether something is "unclaimed".

How that compiles is **service-specific**, and it has to be, because a condition key a
service does not populate can never be satisfied — adding one silently turns an Allow into a
permanent Deny, i.e. a broken deploy in a user's account, discovered by them.

### EC2 — `ec2:CreateAction`, and it closes the hole completely

EC2 has a purpose-built key. `ec2:CreateAction` is populated **only** when `CreateTags` is
evaluated as the tagging half of a create call, and is absent when `CreateTags` is called
directly. AWS's own documentation on the pattern:

> *"Users are not permitted to tag any existing resources (they cannot call the
> `ec2:CreateTags` action directly)."*

```
Allow  ec2:CreateTags
       Condition: StringEquals ec2:CreateAction        ∈ {RunInstances, CreateSecurityGroup, …}
                  StringEquals aws:RequestTag/agentspoppy:app == <appId>

Allow  ec2:CreateTags, ec2:DeleteTags
       Condition: StringEquals aws:ResourceTag/agentspoppy:app == <appId>
```

The second half of the first statement matters: AWS's own example permits *any* tags during a
create, which is not what we want — the tag must be self-attesting.

**No claim-unclaimed branch for EC2.** Statement 1 covers every legitimate creation and
statement 2 every legitimate update. Adding a third would re-open the very path this exists
to close — and on EC2 that path is wide, because untagged instances are the normal case in a
real account.

The value is the API action **name without the service prefix** — `RunInstances`, not
`ec2:RunInstances`.

🪤 **`ec2:CreateAction` must never be put on `DeleteTags`.** It is not listed there (correctly
— a delete is never part of a create), so a condition on it would be a permanent deny.

### Cognito, GuardDuty, Amplify — the two-allow pattern

All three support `aws:RequestTag` and `aws:ResourceTag` on their tag-write actions.

```
(A) claim-at-create   Allow  <svc>:TagResource
                      Condition: StringEquals aws:RequestTag/agentspoppy:app == <appId>
                                 Null         aws:ResourceTag/agentspoppy:app  = "true"

(B) re-tag your own   Allow  <svc>:TagResource, <svc>:UntagResource
                      Condition: StringEquals aws:ResourceTag/agentspoppy:app == <appId>
```

**Both are load-bearing, and (B) is the one that is easy to miss.** CloudFormation issues tag
updates as **deltas** carrying only the changed keys. CrewPoppy's release-day stack updates
send `{crewpoppy:lambdaCodeKey, crewpoppy:sourceCommit}` with **no** `agentspoppy:app` — so
they fail (A)'s `StringEquals` and survive only on (B). Shipping (A) alone breaks every
release. (Established from 90 days of CloudTrail on the founder's account, not from reading
CloudFormation's behaviour — its Cognito handler is AWS's closed code.)

🪤 **Never add an `aws:TagKeys` allow-list.** CloudFormation injects its own
`aws:cloudformation:stack-name` / `stack-id` / `logical-id` keys into the create's tag map. An
allow-list that omits them breaks the deploy. (Verified: the compiler uses no `aws:TagKeys`
today. Keep it that way.)

🪤 **`UntagResource` never gets (A).** Cognito, GuardDuty, Amplify and EC2's `DeleteTags` all
agree: `aws:RequestTag` is not supported on removal — no tags ride along on a delete. This is
the same reasoning already in SECURITY_MECHANISM §3 for the create/mutate split.

### S3 — never

`s3:PutBucketTagging` supports **neither** key. Applying the pattern would not merely break
the first deploy; it would permanently deny every bucket tag write, including the very delta
updates (B) exists to protect. S3 must stay name-scoped — which every shipped poppy already
does, so nothing changes today.

*(Correction for the record: the belief that "a bucket is necessarily born untagged" is out of
date — AWS shipped S3 ABAC on 2025-11-20 and `CreateBucket` now accepts tags. It does not
change the conclusion.)*

### Any other service — fail closed

If a manifest declares a tag-write on a scope that does not narrow, for a service **not in the
table above**, the compiler must **refuse** rather than emit an unconditioned grant. Otherwise
this is a fix with a hole reserved for the next service someone adds.

## What this does NOT close

Stated plainly so it is not mistaken for complete:

- **EC2: nothing.** `ec2:CreateAction` is total.
- **Cognito: nothing either, as of the canary run (26 Aug 2026).** This section previously
  said the gap was unavoidable here. It was not. AWS populates `aws:ResourceTag` with the
  submitted tags during a tag-on-create, so the re-tag-your-own statement authorises creates
  by itself and the claim statement was doing nothing but permitting the takeover of an
  untagged resource. It has been removed.
**Nothing. All four services are closed** — EC2 by `ec2:CreateAction`, and cognito-idp,
amplify and guardduty by dropping the claim statement once each was proven live not to need
it (canary, 26 August 2026). This section previously said the gap was unavoidable for the
non-EC2 services. It was not.

The mechanism worth remembering: AWS populates `aws:ResourceTag` with the SUBMITTED tags
during a tag-on-create, so the re-tag-your-own statement authorises creates by itself. The
claim statement was never doing the job it was written for — its only effect was to permit
taking over an UNTAGGED resource, which each canary run confirmed was possible before it was
removed and refused afterwards.

The `request-tag` shape remains in the compiler on purpose: it is where a NEWLY added
service sits until it has had its own run. Nothing uses it today.

## Correction to DESIGN §15h (CrewPoppy)

§15h records that CloudFormation makes a *separate* `cognito-idp:TagResource` call after
`CreateUserPool`. CloudTrail shows otherwise: the 30 July failure was **`CreateUserPool`
itself** being denied, because Cognito's tag-on-create requires both permissions — and the
error names the missing *permission*, not the API that was called. There is no separate
post-create call; the pool is **born tagged and never spends a moment unclaimed**.

The permission is still required. Only the mechanism was misread. Worth remembering as a
class: **an AWS `AccessDenied` names the permission you lacked, not the call you made.**

## What the adversarial review changed

Three lenses attacked the implementation before commit. Every finding was the detector
**failing open** — the direction that matters, because a name the detector misses compiles
unconditioned *and* the fail-closed refusal never fires either. None was reachable by any
shipped manifest; all three were reachable by a hostile or careless one.

1. **Casing.** IAM matches the `Action` element case-insensitively, so
   `cognito-idp:tagresource` grants exactly what `cognito-idp:TagResource` grants — but the
   detector was capitalised and anchored, so a one-letter change restored the whole
   pre-fix chain. It also defeated the refusal: an unchecked service spelling its tag
   action in lower case was emitted unconditioned instead of throwing. The detector is now
   case-insensitive. (The contrast with `permissions.ts`'s create filter is deliberate and
   worth keeping straight: that one is case-*sensitive* because it mirrors the compiler
   character-for-character. It is descriptive; this one is enforcement, and enforcement
   must not fail open on spelling.)

2. **Wildcard actions.** A grant of `["*"]` or `["cognito-idp:*"]` *is* the tag write,
   spelled in one character — and it cannot be split into a half that can be conditioned
   and a half that cannot. It now **refuses** on an unnarrowed scope. On a name-scoped
   resource it is untouched, because the name still confines it.

3. **`?` wildcards.** IAM treats `?` as a single-character wildcard, so
   `arn:aws:ec2:*:*:instance/?*` reaches every instance while looking like a name pattern
   to a test for `"*"`. `scopeIsUnbounded` now treats any segment made only of wildcard
   characters as narrowing nothing. This one also fixes the **rating**, which was calling
   such a scope confined.

**This was a known limit, and then it turned out to be a live bypass — now closed.** A
pattern can be a genuine name prefix and still match everything, because AWS ids have fixed
prefixes: `instance/i-*` is every EC2 instance, `userpool/eu-west-1_*` every pool in the
region. Nothing in the ARN distinguishes those from `table/CrewPoppy*`, which really does
narrow. Since the rule originally applied only to scopes that did not narrow, such a pattern
**skipped it entirely** — which was checked, reproduced, and fixed while preparing to publish
this document.

The fix is to stop letting the scope decide. For a service whose conditions are proven, tag
writes are conditioned **always**; the name pattern is a bonus, not the protection. It costs
nothing, because a tag-on-create is authorised by the re-tag-your-own statement — established
on real AWS by the canary. A service with no proven conditions still relies on its name,
since conditioning it with a key that service never populates would be a permanent deny.

**Measured, not argued:** compiling all seven shipped manifests before and after, no poppy
loses or gains a single action (157→157, 78→78, 87→87, 20→20, 19→19, 71→71, 13→13). The
statement count rises because tag writes are split out; the permission set is identical.
Every Sid stays unique.

## Verification

- unit: each service's tag-write grant compiles to the shape above, and to nothing else;
- unit: an unbounded tag-write for an unlisted service is refused, not silently emitted;
- unit: `UntagResource` / `DeleteTags` never carry a `RequestTag` or `CreateAction` condition;
- unit: a *name-scoped* tag-write grant is left exactly as it is today (S3, and CrewPoppy's
  `table/CrewPoppy*` family) — the rule applies only where the scope does not narrow;
- unit: the delta case — a `TagResource` carrying only `crewpoppy:*` keys is authorised by (B);
- **live, before rollout:** one canary deploy per affected poppy. The create-time evaluation
  of `RequestTag` is the standard AWS pattern and consistent with the Service Authorization
  Reference, but only a real deploy proves it. CrewPoppy (Cognito) and VM-Poppy (EC2) are the
  two that matter.

## Sequencing

This lands **before** fault F, and replaces fault F's first deny. Faults A and F both change
the bootstrap template and need a re-apply from every user; this one does not — it is
compiler-side, so it reaches everyone on the next app update with nothing for them to do.
