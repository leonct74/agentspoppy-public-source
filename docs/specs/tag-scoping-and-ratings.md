# Tag-scoping that works, and a rating that reflects it

**Status:** §1, §2 and Rule B's prerequisite are IMPLEMENTED and committed (unreleased). §3's
Rules A and C are not.

**Why now.** The founder's requirement, verbatim: *"we need to maintain the promise that we tag
and remove whatever we can, and when that happens the risk cannot be red."* Both halves of that
sentence are currently unmet, for two unrelated reasons — one is a bug in the credential compiler,
the other is a policy question about what red means.

---

## 1. The promise is kept in behaviour and lost in the declaration

`isFullyAttributable()` in `packages/core/src/permissions.ts` is the promise, written as code:
declare all three attribution tags, **and** have every mutating grant either tag-scoped or narrowed
by a name that genuinely constrains.

**No shipped poppy satisfies it** — but not for the reason I first wrote here. An earlier draft
of this section claimed *"not one uses `TAGGED_AS_SELF`"*. That was wrong, and wrong because of a
bug in my own check (it tested `resourceScope === "tag"`, which is not the sentinel). Corrected:

| poppy | tag-scoped grants |
| --- | --- |
| MailPoppy, CrewPoppy, AffiliatePoppy, LiveOpsPoppy | 1 each (cognito-idp) |
| TrafficPoppy | 3 (acm, cloudfront, cognito-idp) |
| VpnPoppy, VmPoppy | 1 each (ec2) |

**Every poppy already tag-scopes something.** What none of them tag-scopes is the grant that
CREATES things — and that is not an oversight, it is the compiler bug in §2. Both VM poppies
already tag-scope their *mutate-my-own-resources* grant (Terminate, Stop, Delete…), which works
because none of those actions is a birth. The creates sit at `*` because tag-scoping them denied
every launch, which `vm-poppy/DESIGN.md` records as "cannot be tag-scoped".

So the gap is narrower and more precise than "nobody uses the mechanism": the mechanism works for
everything except the births, and the births are exactly what the promise is about.

The sharpest case is VpnPoppy and VmPoppy. Both **already stamp all three attribution tags on
everything they create**, via `TagSpecifications` on the create call itself (`vpn-poppy/backend/src/ec2.ts`,
`vm-poppy/backend/src/ec2.ts`). The behaviour is exactly what we promise. Only the *declared scope*
fails to say so, and so the rating reads:

> Can start up new EC2 resources anywhere in your account — and because they are not tagged as they
> are created, AgentsPoppy cannot show you or remove them afterwards.

That sentence is false about these two poppies' behaviour and true about their grant. It is also
the single most damaging line in the fleet, because a leftover VPN or VM is a running bill and an
open door.

---

## 2. Why they cannot simply adopt tag-scoping today

`statementForGrant()` in `packages/broker/src/aws/policy.ts` splits a `TAGGED_AS_SELF` grant into
two statements, deciding which is which with:

```js
const isCreate = (a) => /:(Create|Request)/.test(a);
```

`ec2:RunInstances` matches neither word. It therefore lands in the `aws:ResourceTag` branch — the
condition for resources that *already exist* — which can never match an instance being born.

**Proven, not assumed** (`iam:simulate-custom-policy`, sandbox account, against the exact two
statements the compiler emits today):

| call | decision |
| --- | --- |
| `ec2:RunInstances` on a new instance, tags supplied at create | `implicitDeny` |
| `ec2:RunInstances` on the AMI it must reference | `implicitDeny` |
| same policy, wrong app tag (negative control) | `implicitDeny` |

So switching either poppy to `TAGGED_AS_SELF` right now would mean **no VM ever launches again.**

The compiler's own doc-comment already describes this exact failure class — *"an `aws:ResourceTag`
condition can never match (this denied every create until TrafficPoppy's edge stack found it live,
2026-07)"*. The lesson was applied to `Create*` and never generalised. `RunInstances` is the same
bug wearing a different verb, and it is not the last one: `AllocateAddress`, `ImportKeyPair` and
`RegisterImage` are all births that do not say "Create".

### The fix

1. **Replace the regex with an explicit, per-service list of birth actions**, in the same style as
   `TAG_WRITE_RULES` — that table exists precisely because guessing this was already shown to be
   unsafe once.
2. **Make the compiler refuse to emit a policy it cannot classify.** If a `TAGGED_AS_SELF` grant
   names an action that is neither a known birth action nor known to carry `aws:ResourceTag`, throw
   at compile time. The compiler already refuses wildcard actions on unbounded scopes; this is the
   same instinct applied to the same file.

Point 2 is the more important of the two. Today the failure is invisible until a user clicks
"create VM" and gets a denial; a refusal surfaces it to the developer at pack time.

### ANSWERED LIVE (2026-08-30) — a working shape exists

Run against real IAM in a dedicated sandbox account with `ec2:RunInstances --dry-run`, which performs
the full authorization check and creates nothing. One role per policy shape (no in-place policy
replacement, so no propagation ambiguity) and an **unconditional positive control**, without which
a uniformly-denied run proves nothing:

| policy shape | tags sent | result |
| --- | --- | --- |
| **P0** unconditional `ec2:*` — positive control | instance+volume | `AUTHORIZED` |
| **P1** what the compiler emits today (`aws:ResourceTag`) | instance+volume | `DENIED` |
| **P2** `aws:RequestTag` on `Resource: "*"` | instance+volume | `DENIED` |
| **P4** condition on `instance/*` + `volume/*` only, everything referenced unconditioned | instance+volume | **`AUTHORIZED`** |
| P4 | instance only, volume untagged | `DENIED` |
| P4 | none | `DENIED` |
| P4 | wrong app tag | `DENIED` |

So: the bug is real (P1), the naive fix does **not** work (P2 — `vm-poppy/DESIGN.md` is right that a
blanket tag-scope fails, because the condition then also lands on the AMI and subnet, which carry no
request tags), and a correct shape does exist (P4). The DESIGN.md line saying EC2 *"cannot be
tag-scoped"* is true of the naive shape and false in general; it should be corrected when the change
lands.

**The design rule this establishes.** The condition must cover *exactly* the resource types that
receive tags in the request — no more, no less:

- **conditioned**: what is born tagged (`instance`, `volume`)
- **unconditioned**: what the call merely references (`image`, `subnet`, `security-group`,
  `key-pair`, `snapshot`) and what it creates untagged (`network-interface`)

Both halves are load-bearing. Conditioning a type the poppy does not tag denies the call — that is
the `instance only, volume untagged` row, and it is a silent, runtime-only failure.

**Consequence for the compiler:** it cannot emit a generic tag-scoped statement for a multi-resource
create. It must know, per birth action, which resource types are born tagged — and that list has to
agree with what the poppy's own code passes in `TagSpecifications`. A mismatch is undetectable until
a user clicks the button. That coupling should be a declared, tested part of the grant, not a
convention two files apart.

Both VM poppies already send the same set — `instance` + `volume` on launch (`vpn-poppy` also tags
`security-group` on its separate create) — so one shape serves both.

### Superseded: the open question

Whether `RunInstances` under an `aws:RequestTag` condition still authorises against the **referenced**
resources — the AMI, the subnet, the security group — which carry no request tags of their own.

`vm-poppy/DESIGN.md` asserts it cannot: *"They reference untagged/foreign resources (VPC, subnet,
AMI) so they cannot be tag-scoped."* If that is right, the fix needs statements split **by resource
type** — the condition on `instance/*`, `volume/*`, `network-interface/*`, and no condition on
`image/*`, `subnet/*`, `security-group/*`, `key-pair/*`.

**The policy simulator cannot settle this.** It applies supplied context globally rather than
modelling which resource ARNs AWS populates `aws:RequestTag` for, so it returned `allowed` for both
candidate shapes — including for the AMI, which is the case in doubt. That is a limitation of the
instrument, not evidence. Settling it needs one real `RunInstances` in the sandbox account, launched
and terminated.

That question is now answered above; the paragraph is kept because it records why the simulator's
`allowed` was discarded as evidence.

---

## 2b. What the adversarial review of the fix caught (2026-08-30)

The first cut of the compiler fix was reviewed by four adversarial lenses before it was committed.
24 claims, 12 survived verification — **two blocking and four serious, all in code I had just
written**. Worth recording, because the two worst were opposite failures of the same habit:
filling a table from memory instead of from evidence.

**Blocking — the fix did not actually work.** `ec2:CreateSecurityGroup` is *also* a spread birth:
AWS authorises it against the group being created **and the VPC it is created in**, and the VPC
carries no request tags. My first cut left it a "simple" birth on `Resource: "*"`, so a VM launch
would have died on its first call, before `RunInstances` was ever reached. My comment claiming
`Create*` actions are "births by construction" was true and irrelevant — being a birth was never
the question; being multi-leg is.

**Serious — I opened a data-exfiltration path.** The first `referenced` list included
`arn:aws:ec2:*::snapshot/*`, which I had added speculatively. `RunInstances` accepts
`BlockDeviceMappings[].Ebs.SnapshotId`, so a poppy could restore the user's database snapshot onto
an instance it owns — every created resource correctly tagged, indistinguishable from a compliant
launch to the tag sweep, the resource list and teardown, while the data leaves over the network.

Proven, then closed, then re-proven (sandbox, `--dry-run`, with a positive control):

| policy | mount a foreign snapshot | ordinary tagged launch |
| --- | --- | --- |
| unconditional `ec2:*` (control) | `AUTHORIZED` | — |
| **my first draft** | **`AUTHORIZED`** | — |
| **what ships** | **`DENIED`** | `AUTHORIZED` |

`CopySnapshot` and `CopyImage` were the same mistake in the other table: they condition the
*copy's* tags while leaving the *source* unconstrained. `AllocateAddress` and `RegisterImage` were
wrong the other way — multi-leg, so they would have been denied at runtime. All four had no call
site. **The whole `NAMED_BIRTHS` list is gone**; `Create*` covers what ships, and an unlisted
multi-leg birth fails closed with a visible denial rather than a silent hole.

**Serious — the drift guard had itself drifted.** `rating-matches-compiler.test.ts` kept a private
copy of the compiler's verb regex and asserted `RunInstances` is not a birth. It went on passing
while modelling a compiler that no longer existed. It now imports `compilerTreatsAsBirth` from
`policy.ts`, so the mirror is checked against the real thing.

### Still open, and blocking for Rule A

The `referenced` leg is a real hole in the tag-scoped promise — small and deliberate now, but real.
Meanwhile `describeGrant` still tells the user a tag-scoped grant touches *"only resources tagged as
its own"*, and `isFullyAttributable()` returns true for it. **That is an I6 divergence**: the
consent line promises more than the compiled policy delivers.

Nothing is live-wrong today, because no shipped poppy uses `TAGGED_AS_SELF`. But **Rule A must not
be implemented until the wording is fixed**, or the rating will start trading on a promise the
policy does not keep. The fix is to derive the wording from the compiler's output rather than from
`resourceScope`: a grant whose compilation emits an unconditioned statement must say so.

---

## 2c. DONE — the first fully attributable poppies (2026-08-30)

VpnPoppy and VmPoppy now tag-scope their create grants. Verified live with `--dry-run` against
each poppy's **real compiled session policy**, with an unconditional positive control:

| | VpnPoppy | VmPoppy |
| --- | --- | --- |
| launch a tagged VM | `AUTHORIZED` | `AUTHORIZED` |
| create its security group | `AUTHORIZED` | `AUTHORIZED` |
| describe (read) | `AUTHORIZED` | `AUTHORIZED` |
| **launch UNTAGGED** | **`DENIED`** | **`DENIED`** |
| **mount a foreign EBS snapshot** | **`DENIED`** | **`DENIED`** |

Both move `high` → `medium`, and `isFullyAttributable()` returns **true** for the first time in
the fleet. The line that motivated all of this — *"because they are not tagged as they are
created, AgentsPoppy cannot show you or remove them afterwards"* — is gone, because it is no
longer true of them.

**Note what did NOT have to change: the rating.** Tag-scoping alone moved these two from red to
amber through the rules that already existed, because `grantCanLaunchUntracked` stops firing once
the grant is confined. Rule A was not needed for this case and remains unimplemented.

`vm-poppy/DESIGN.md` has been corrected: it recorded that these actions *"cannot be tag-scoped"*,
which is true of a blanket condition and false in general.

**What remains for these two:** they still each carry a `Describe*` grant at `*`, rated amber.
That one is genuinely forced — EC2 `Describe*` supports no resource-level permissions at all — and
is exactly the case Rule C exists to explain.

---

## 3. What red should mean

The audit found four unrelated situations sharing one colour:

| situation | poppies | honest? |
| --- | --- | --- |
| Correctly name-scoped, red because it is IAM | all 5 role-creating | yes, but indistinguishable from the row below |
| Genuinely account-wide (`*`) | MailPoppy ×4 | yes |
| Looks scoped, isn't (`userpool/*`) | CrewPoppy, LiveOps | yes — documented known limit |
| Creates resources we cannot track | VpnPoppy, VmPoppy | yes, and it contradicts the promise |

The founder's rule — *tag and remove whatever we can, and then it cannot be red* — is right, but it
needs to be **two rules, not one**, because tagging mitigates two different risks unequally.

### Rule A — for resource-creating grants: attribution caps the rating

A poppy that is `isFullyAttributable()` has, by definition, no grant that can touch anything it did
not create. Its blast radius **is** its own footprint. That should cap at `medium`, and the reason
string should say why: *everything it makes is tagged as its own, and removing the poppy removes
exactly that.*

This is the rule that makes the promise legible on the screen, and it is currently unreachable
because no poppy can pass `isFullyAttributable()` until §2 is fixed. **Order matters: §2 before §3.**

### Rule B — for the IAM control plane: the boundary is the mitigation, not the tag

Do **not** let tagging lower the IAM rating. A role tagged as ours can still be created carrying
`AdministratorAccess`; the tag says who made it, not what it can do. The grant is red because
creating a role is creating an identity, and that is true however it is labelled.

What *does* mitigate it is the permissions boundary — the work shipped across the fleet on
2026-08-30. A role created under `AgentsPoppyBoundary` cannot exceed the ceiling the broker itself
is held to. So the IAM rating should fall to `medium` **when the boundary is enforced for that
account**, and stay `high` when it is not.

Note what this must *not* be: a manifest claiming "my roles are bounded". A manifest is the
developer's assertion. The rating may only drop on what the **platform** enforces — that is, once
fault-A step 3 denies `iam:CreateRole` without the boundary, at which point the broker structurally
cannot mint a credential that creates an unbounded role.

**This gives step 3 a second reason to exist**, and it is the user-visible one: it is what turns
five red listings amber, honestly.

### Rule B is APPROVED (founder, 2026-08-30)

> *"it should drop on boundary if that represents better what's the real blast radius of a
> permission given to a poppy."*

Adopted. The rating drops on what is **enforced**, never on what is claimed — so it drops once
fault-A step 3 makes it structurally impossible for the broker to mint a credential that creates an
unbounded role. That is the second, user-visible reason to finish step 3.

### On certification as evidence — and why it cannot carry rating weight today

The same message raised a fair point: *"Every poppy to be certified, need to be teared down, so
somehow we know it will not leave resources."* The rule is real, but its current state is not what
it needs to be for the rating to lean on it:

| poppy | shipped | certified | tracked? |
| --- | --- | --- | --- |
| CrewPoppy | 0.9.4 | 0.4.0 | gitignored |
| TrafficPoppy | 0.2.6 | 0.1.0 | gitignored |
| AffiliatePoppy | 0.1.3 | 0.1.0 | gitignored |
| LiveOpsPoppy | 0.3.4 | **never** | — |
| VpnPoppy | 0.1.9 | **never** | — |
| VmPoppy | 0.1.14 | **never** | — |

**No listed poppy has a current certification.** Three have never been certified; the other three
are certified at versions three to five releases old, and every certificate is gitignored — a local
artifact on one machine, not something a user or an auditor can see.

There is also a deeper reason to keep the two apart even once that is fixed. **The rating is about
capability; certification is about observed behaviour.** Certification proves that in the run we
performed, this version cleaned up after itself. It does not bound what the credential *could*
reach on a path the certify run never exercised — and blast radius is exactly that bound. Folding
an observation into a capability rating would make the number mean less than users take it to mean.

The right shape is both, side by side: the rating says what it can reach, and a separate line says
*teardown verified for this version on <date>*. That is strictly more information than either alone.

For certification to be worth showing it needs three things it does not have: to be **per-version**,
to be **enforced at listing** rather than by habit, and to be an **artifact the user can see**.
That is its own piece of work.

### Rule C — say when AWS is the limit

Twenty of MailPoppy's actions cannot be narrowed by any policy we could write — thirteen SES actions
(the whole receipt-rule API, `GetAccount`, `PutAccountDetails`) support no resource-level permission
of any kind, per AWS's published service reference. The screen has no way to say so, and silence
reads as negligence. A distinct state — *AWS provides no way to narrow this* — is honest and costs
no security.

---

## 4. Order of work

1. Fix the compiler (§2), with the birth-action table and the refuse-to-guess guard.
2. Prove `RunInstances` live in the sandbox — one launch, one terminate.
3. Switch VpnPoppy and VmPoppy to `TAGGED_AS_SELF`; they become the first fully attributable poppies.
4. Rule A in the assessor, so that fact reaches the screen.
5. Rule B, gated on step 3 of broker-role-v2.
6. Rule C wording.

Steps 1–3 are the promise. Steps 4–6 are the screen telling the truth about it.

## 5. What is verified, and what is not

**Verified:** the compiler's current output denies `RunInstances` (simulator, with a working negative
control). Both VM poppies stamp all three tags at create (source). MailPoppy was the only poppy
under-declaring its attribution tags (real assessor over all seven shipped manifests). Per-action
scoping capability throughout (AWS service reference).

**Verified since:** the working shape (P4), live, with a positive control and three negative
controls. The sandbox was returned to its original six roles with no instances created.

**Still not verified:** nothing in §3 is implemented or tested. The compiler change itself (§2) is
designed but not written.
