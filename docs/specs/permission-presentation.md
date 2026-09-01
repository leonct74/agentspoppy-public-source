# How a permission is presented, and why two sections can disagree

**Status:** adopted 2026-08-31. The rule below is the founder's; this document records it and
what it implies, so every poppy is presented the same way for the same permission.

## The rule

> **"What it can do"** should reflect the **boundaries** of a permission.
> **"What's at stake"** is what happens **if those boundaries are not maintained**.

Two questions, two answers. They are allowed to carry different colours for the same grant, and
that is not an inconsistency — it is the point.

## Worked example: AffiliatePoppy's IAM grant

| section | says | colour |
| --- | --- | --- |
| What it can do | Create, change & delete — only its own resources (`arn:aws:iam::*:role/AffiliatePoppy*`) | amber |
| What's at stake | Controls who can do what in your account | red |

Both are true. The fence is narrow — it can only touch roles it named itself. But roles *are*
the mechanism that decides access, so if that fence ever failed, what escapes is the ability to
grant permissions. A narrow boundary around a serious power is exactly that: narrow, and serious.

## What this replaced, and why

The stake section used to be headed **"Risks to the rest of your account"**. That asserted reach —
and for a grant scoped to `role/AffiliatePoppy*` it asserted reach the capability card had denied
one line above. Readers were right to call it a contradiction; the heading was making a claim about
scope when it should have been making a claim about consequence.

An earlier fix moved confined grants into a separate section instead. That removed the
contradiction but split one question across two places, and it left the reader to work out that
"powerful but confined" and "reaches beyond" are the same kind of concern at different distances.
The rule above is better: one place for consequence, one for boundary, applied to every grant.

## Consistency is computed, not curated

A natural worry is that poppies get rated by different standards. They cannot: every rating comes
from `assessGrant` in `packages/core`, a pure function of the grant's service, actions and scope.
Verified across all seven shipped poppies — **54 distinct permission shapes, 0 rated
inconsistently**, and no case where two poppies declare the same service and actions at different
scopes. If two poppies ask for the same thing, they are described identically and coloured
identically, by construction.

So consistency work belongs in the *wording*, which this document fixes, and in the *grants* — a
poppy asking for more than it needs is a poppy problem, not a rating problem.

## Rules that follow

1. **A confined grant may be red under "what's at stake".** Confinement bounds the blast radius;
   it does not make the power harmless. Do not filter a grant out of the stake section for being
   scoped.
2. **A confined grant is never the reason a connection is supervised.** Supervision is
   `hasUnscopedGrants` (broker `service.ts`). The Supervised pill's tooltip states the capability
   "reaches beyond its own resources", so it must appear only on grants where that is true.
3. **The boundary line is the authority on reach.** Nothing elsewhere on the page may assert a
   reach the scope contradicts.
4. **Where AWS offers no way to narrow something, say so** rather than showing an unexplained
   wide scope — DONE (2026-08-31). The boundary card carries *"AWS offers no way to narrow this"*
   when every action in the grant publishes no resource type, which is proven by AWS's own service
   reference and was verified live against IAM before it was written. It explains the boundary; it
   never lowers the rating, because the reach is the same whoever chose it. (Rule C in
   `tag-scoping-and-ratings.md`.)
5. **A mitigation that is enforced may lower the stake.** The permissions boundary caps what a
   created role can ever hold, which is precisely the consequence rule 1 describes — so once
   fault-A step 3 enforces it, the IAM stake can honestly fall. It drops on what the platform
   enforces, never on what a manifest claims. (Rule B, approved; needs step 3.)
6. **Honest, never alarming** (founder, 2026-09-01: *"the purpose to honestly inform the user
   should not translate into over-concerning or scaring the user"*). Honesty is the facts;
   fear is a tone, and the tone carries no information. In practice:
   - **Say each fact once.** The ceiling is stated on the boundary card and in the stake
     panel; no other section repeats it as a warning. The quiet observed state is "nothing
     recorded" plus the coverage caveat — not a sermon that restraint proves nothing (the
     sections above already carry what the permission could do).
   - **No shouting.** "any" and "contents" carry the meaning in lowercase; capitalising them
     added alarm, not information. De-shouted across every rating string.
   - **Labels state standing, not suspicion.** "Developer's note — in their own words" says
     whose claim it is; "their words, unverified" read as an accusation stamp. The guard is
     unchanged: the label may never claim the platform checked it.
   - **Reassurance is as honest as warning, where it is true.** The enforcement floor opens
     the page, Rule C explains a forced grant instead of accusing it, and a fully-confined
     poppy gets its green empty state. Calm is not softness: no rating, scope, or supervision
     decision moved for tone, and the tone guards are mutation-tested in both directions —
     praising a quiet record fails the suite exactly as relabelling a claim "verified" does.

---

## The four panels (design agreed 2026-08-31, not yet built)

The rules above fix the *wording* of a permission. This section fixes the *structure* of the
screen, and it came out of the founder pressing on three specific lines until each one turned
up a real defect. Worked example and mock: the "What This Poppy Can Do" audit page.

**Why the current screen cannot be assessed.** Measured over the eight shipped manifests with the
live assessor: **6 of 8 poppies rate `high`, 8 of 8 are supervised, 65 of 79 grants are `medium`,
and `low` fires once in the fleet.** Two distinct verdicts across eight poppies. The overall level
is `max()` over grants and "creates an IAM role" is always high — so the verdict is decided by the
one fact nearly every infrastructure poppy shares, which by construction cannot discriminate.
AffiliatePoppy (changes nothing it did not create) and HostingPoppy (rewrites your DNS) print the
same word.

### Panel 1 — What the broker enforces — IMPLEMENTED (2026-09-01)

The platform floor, each line naming where it is pinned (`core/guarantees.ts` →
`ConnectionDetailView`). Building it surfaced the design's own trap: the floor is NOT identical
for every poppy. Three guarantees are conditional — born-tagged (I3) needs a tag-scoped grant,
the one-query sweep (I4) needs the attribution tags declared, and supervision is a per-connection
switch the user can flip. Printing those as universal would be the same overstatement the rest of
this spec fixes, in the reassuring direction — the worse one, since nobody presses on a green
line. So `brokerGuarantees()` returns `holds: false` with the reason, and the UI STRIKES the
line rather than dropping it: a user comparing two poppies sees what one of them is not getting.
Mutation-tested: printing a conditional as universal, ignoring the live supervision state, and
filtering out failed guarantees in the UI each turn the suite red.

The quoted numbers (1 h session, 15 min approval window) are mirrored in browser-safe core and
tethered to the broker's real constants by `guarantees-match-broker.test.ts`, which reads the
SOURCE of `sts.ts`/`service.ts` — sts.ts is a §4 mechanism file, and adding an export to feed a
test is a worse trade than a strict, non-vacuous regex.

### Panel 2 — What the poppy is designed to do — the per-grant half is IMPLEMENTED (2026-09-01)

The manifest's own account of itself, shown beside the permissions it explains, labelled as a
claim. Two halves:

- **Per-grant (done):** each grant's `reason` — required by AGENTS.md on every unconfined grant,
  now written across all seven affected poppies — renders on its capability card under the label
  *"Developer's note — their words, unverified"*. The label IS the standing: a claim shown
  without whose claim it is would read as the platform's own assessment. Pinned by test in four
  directions: it renders, it is labelled, a hostile reason renders as text not markup (the
  validator refuses angle brackets, but an installed manifest may predate that rule, so the
  render path must not depend on it), and — the load-bearing one — **the boundary line and the
  rating are byte-identical with and without a reason**, so prose can never buy a softer screen.
- **Set-level (open):** `permissionSet.description` beside the permission list as the poppy's
  overall purpose. Small; falls naturally out of Panel 3's regrouping.

### Panel 3 — What to weigh, permission by permission

Grouped by meaning rather than by service, worst first, each row opening to the exact actions,
scope and reason. This replaces the single verdict. A user must be able to disagree with any one
line; that is the point. Needs no new analysis — `grantCanDestroy`, `scopeIsUnbounded`,
`grantExposesSecrets`, `grantCannotBeNarrowed` all ship today. What is missing is the grouping,
the service qualification, and a per-service plain-English sentence that policy analysis cannot
produce ("mail receiving rules apply to the whole account") — that table has to be written by hand,
honestly.

### The three registers inside a finding

The founder's correction, and the most important part of the design: *"it is missing the bit of
reality."* Everything the screen says today is the **ceiling** — what the permission would allow
if the poppy were malicious. That is worth knowing and it is not a description of the app.

| register | source | who can write it |
| --- | --- | --- |
| **If it were malicious** — "change or delete any DNS record in any domain you host" | the IAM permission | AWS |
| **What it is for** — "writes one record, for the domain you typed" | the manifest + source | the developer |
| **What it has done** — "2 changes in 30 days, both in one zone" | CloudTrail | **nobody** |

The third register is load-bearing precisely because neither the platform nor the developer
authors it.

**It is a wiring job, not new capability.** `packages/broker/src/aws/cloudtrail.ts` already calls
`LookupEvents`, and `core/activity.ts::classifyActor` already attributes each event to a
`connectionId` (vended sessions are named `agentspoppy-<connection>`). `Inventory` and `InfraGraph`
— the poppy's real footprint — are already props of `ConnectionDetailView`. Both shipped; neither
sits next to the permission it explains.

**Honest limits, to be stated on the screen and not buried:**
- **At approval time the third register is empty.** A poppy never run has done nothing. This makes
  the observed column a tool for the *keep-it-installed* decision, which is the one a user actually
  revisits — and the one today's screen serves worst, showing the same static verdict on day 200 as
  on day 0.
- CloudTrail is the user's own account-wide setting; a region with it off reports nothing.
- "Never used this" is evidence of restraint, not proof of safety. An unused permission is still a
  permission.

### Build order

1. ✅ **Panel 1.** Shipped as above — and not static after all.
2. ✅ **Scope registers in the wording** (rule 3 above) — shipped 2026-09-01. The capability card
   now has three registers: *"Only what it created — born tagged as its own, enforced by AWS"* ·
   *"Anything named `<pattern>` — bounded by name, not by ownership"* · *"Any resource in your
   account"*. The negative is pinned by test: a name-scoped card may never again say "its own
   resources". `assessGrant`'s reasons already said "named X" honestly and are untouched.
3. **Panel 3** — the per-service sentence table is DONE (2026-09-01): `core/serviceStakes.ts`,
   one platform-authored sentence per service saying what it controls ("one active rule set
   decides where incoming mail for every domain goes"), rendered under each stake finding.
   Sentences describe the SERVICE, never the caller — tested so none may pre-judge a poppy —
   and a missing entry renders nothing, never filler.

   The page ORDER is the founder's (2026-09-01): **the floor opens the page, the risks close
   it** — What AgentsPoppy enforces · What it built · What it can do · What it has actually
   done · Activity · What's at stake. Within the closing risks panel, findings sort
   worst-first (high before medium, account-wide before confined), never in manifest order —
   most readers stop after a card or two, so the order decides what they actually learn.
   Both pinned by test; inverting the sort turns the suite red.
4. ✅ **The observed register — IMPLEMENTED (2026-09-01).** "What it has actually done", from
   CloudTrail, on the connection detail view. The pieces and the decisions:
   - `core/observed.ts::summarizeObserved` — pure per-service counts, classified with the
     rating's own verb classifier (so "change" here can never disagree with the permission
     screen), inheriting its fail-destructive default: an unknown verb counts as a change,
     overstating rather than understating.
   - broker `getConnectionActivity` + `GET /connections/:id/activity` — **keyed to the APP,
     not the connection id**: a connection is superseded on scope drift while the poppy and
     its history continue, and without this every re-approval would wipe the record at
     exactly the moment the user is re-deciding. Pinned by a supersession test.
   - The view keeps three states strictly apart: loading · **unreadable** ("CloudTrail could
     not be read" — the provider swallows per-region failures, so silence must never imply
     quiet) · readable-but-quiet ("nothing recorded", stated once and calmly — see rule 6).
   - The record can never SOFTEN the sections above it: with and without an observed record,
     the boundary line and stake findings are byte-identical (pinned by test).
   Mutation-verified: collapsing unreadable into quiet, editorialising quiet as good
   behaviour, and keying the filter to the connection id each turn the suite red.

### Still undecided, founder's call

- **The catalogue badge.** A row of facts does not sort, and a listing still needs something short.
  A colour cannot carry this; a count might — *"changes 4 services it did not create"*. That is a
  decision, not a derivation.
- **Whether supervision should keep triggering on reads.** VmPoppy is supervised only because it
  can call `ec2:DescribeInstances`. That is why the flag is true for all eight poppies and
  therefore means nothing.

