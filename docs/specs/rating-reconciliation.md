# Rating reconciliation — five fixes so the doctrine, the rater, the compiler and the gate agree

**Status:** APPROVED and BUILT (2026-09-02; the founder opened the mechanism window for
item 4 the same day). Origin: an adversarial review by a parallel session. Outcome of the
fleet re-run: **all seven listed poppies pass the reconciled gate with ZERO manifest
changes** — the two initially flagged (LiveOpsPoppy, CrewPoppy) were failing purely on
the rater/compiler tag-write disagreement item 4 healed. Item 5b (per-service id formats
+ the "guarded by disclosed code-level checks" register) remains committed to the next
mechanism window.

The theme of all five: **four authorities describe what a grant may do — AGENTS.md (the
doctrine), `assessPermissionSet` (the rating), the policy compiler (the enforcement), and
the repo gate scripts (the CI check) — and they have drifted apart.** Every fix below
reconciles one disagreement, always in the same direction: the compiler is the ground
truth for what happens; the rating must describe the compiled reality (I6); the doctrine
must describe AWS's actual authorization model; the gate must enforce exactly the
doctrine, from one shared implementation.

## 1. AGENTS.md is wrong about Route 53 (docs fix)

The handbook claims `route53:ChangeResourceRecordSets` has "no resource-level permissions
at all" and blesses `resourceScope: "*"` in its worked example. AWS's authorization
reference says otherwise: the action authorizes against a **hosted-zone ARN**
(`arn:aws:route53:::hostedzone/<Id>`), and since 2022 offers **record-level condition
keys** (`route53:ChangeResourceRecordSetsNormalizedRecordNames`, `…RecordTypes`,
`…Actions`) — tighter than any ARN. The rater already knows this — it rates the
handbook's own example red — the handbook is the bug.

Fix: correct the text; the blessed shape becomes the hosted-zone ARN (a concrete zone id
where known; the `hostedzone/Z*` id-prefix shape where the zone cannot be known in
advance — which then falls under rule 5a's disclosure); mention the condition keys as the
real tightening (the compiler does not emit them yet — noted as future work, not
promised). The "(b) no resource-level permissions" bucket keeps only true members
(account-level settings actions, e.g. `ses:PutAccountDetails`).

## 2. The gate is stricter than the doctrine it quotes (rule fix)

Doctrine (AGENTS.md §3): an **unscoped create-only** grant is acceptable — creating is
additive — provided it carries its `reason`. The rating agrees (medium). But the copied
gate scripts fail on any unscoped **mutating** grant, and `grantCanMutate` counts
creates. A poppy following the platform's own Cognito recipe fails the platform's own
gate.

Reconciled gate rule (this is the doctrine, mechanized):
- **FAIL** — an unscoped grant that can **destroy/change existing** resources
  (`grantCanDestroy`), or **launch untracked** compute (`grantCanLaunchUntracked`).
- **FAIL** — an unscoped **create-only** grant with **no `reason`** (the doctrine's
  "with its required reason" is a requirement, not a suggestion).
- **PASS** — an unscoped create-only grant with a reason; unscoped **reads** (noted
  loudly, justified in the description); everything scoped.
- Assessor warnings remain failures (today's fleet has none; a new one deserves a stop).
- The gate never fails on the overall rating **colour** — the acceptance-test note in
  AGENTS.md already explains why chasing colour is wrong (identity-class creates rate
  red by nature, however tightly scoped).

## 3. One gate, not seven copies (structure fix)

Seven poppy repos carry `scripts/validate-manifest.mjs`; a checksum sweep found **six
distinct versions**. This is the MailPoppy `.json`/`.yaml` twin-drift disease — three
silent drifts there proved a prose promise is not a mechanism.

Fix: the rules move into **`@agentspoppy/core/src/listingGate.ts`** as one exported
`assessListing(permissionSet)` returning `{problems, notes}` — pure, unit-tested, and
the ONLY place the fail rules live. Each repo's script shrinks to a thin loader (the
repos already bundle core from the monorepo checkout via `AGENTSPOPPY_REPO`; same
mechanism, one function). The loader prints, the core decides. The web catalogue's
mechanical review remains a separate, structural gate (R1, network, compliance) — it
cannot import the monorepo from its cloud build; if it ever grows rating rules they must
be vendored with a sha-recorded sync, never re-implemented.

## 4. The rater contradicts the compiler on tag writes (mechanism change — I6)

Since the I2-precondition work, the compiler **conditions every unnarrowed tag write**
(claim modes per service in `TAG_WRITE_RULES`) — a poppy provably cannot stamp its tag
on, or strip it from, a foreign resource; a service the table hasn't cleared is
**refused at compile time**. But `tag`/`untag` sit on the rater's destructive-verbs
list, so an unbounded `TagResource` still rates as "can change anything that exists" —
a red for something the compiled policy makes impossible. That violates I6 (the rating
describes what the compiled policy permits) — the same class of bug as the false-green,
in the alarming direction.

Fix, on the `b74c247` birth-actions pattern — **one table, read by both**:
- `TAG_WRITE_ACTION` + `TAG_WRITE_RULES` move verbatim to
  **`@agentspoppy/core/src/tagWriteActions.ts`** with a helper
  `compiledTagWriteConfined(service, action)` — true iff the action is a tag write on a
  service the rules table covers (i.e. the compiler will emit it conditioned).
- `policy.ts` imports the table from core — a pure move, zero behavioural change,
  pinned by the existing `tag-adoption.test.ts` suite running unchanged.
- `grantCanDestroy` (and `assessGrant`'s wording) treats a destructive-classified action
  that is a **covered tag write** as confined rather than destroy-class; the rating
  sentence says why in plain words ("tag writes are compiled with conditions — it can
  only claim or release its own label"). `grantCanMutate` still counts them (they write).
- **Fail-safe stays fail-safe**: a tag write on a service NOT in the table keeps rating
  destructive — the compiler refuses to vend it, and red correctly says the manifest
  shape is wrong. `Start*`/unknown verbs keep their destructive default untouched.
- `rating-matches-compiler.test.ts` gains the tag-write agreement cases, both ways.

Guarded files touched: `packages/core/src/permissions.ts`,
`packages/broker/src/aws/policy.ts`. **Founder approval window required.** Invariants:
I6 (this IS the I6 fix); I2-precondition unchanged (the table's content does not move an
inch — only its address).

## 5. The Amplify class — id-prefix scopes (doctrine decision)

Some actions authorize against sub-resources that can carry no tag and no ownable name
(Amplify's builds/domain-attachments — the proven case). HostingPoppy ships id-prefix
scopes (`apps/d*`, `hostedzone/Z*`) that **rate as scoped but practically reach every
resource of the type** (every Amplify app id starts with `d`, every zone id with `Z`).

Decision (founder, 2026-09-02, on the reviewing session's recommendation with two
conditions added):
- **(a) NOW — blessed, with MACHINE-CHECKED disclosure.** The listing gate recognises
  known id-prefix shapes (a small per-service table: `amplify …:apps/d*`,
  `route53 …:hostedzone/Z*`) and REQUIRES a substantive `reason` (≥ 40 chars) on any
  grant using one; missing/short reason = FAIL. The gate also emits a mandatory note —
  *"this scope practically reaches any <service> resource of this type"* — so the truth
  is in every CI log and review. Prose-only disclosure is not a mechanism (see fix 3);
  the reason-presence check is the mechanical half, the reason's honesty is what review
  reads it against.
- **(b) END-STATE — committed, not indefinite: lands with the next mechanism window**
  (it edits `scopeIsUnbounded`, guarded). Teach per-service id formats so `d*` rates as
  what it is, paired with a new rating register — *"AWS gives nothing to hold here;
  guarded by disclosed code-level checks"* — rated medium, so HostingPoppy keeps a
  passing, honest shape. Until (b) lands, (a)'s gate note is the honest voice.

## Rollout

1. This spec (unguarded) + fixes 1, 2, 3, 5a + tests → commit.
2. Founder opens the mechanism window → fix 4 (+ SECURITY_MECHANISM.md §4 map gains
   `tagWriteActions.ts` beside the birth-actions entry if listed) → broker suite green.
3. Re-vendor the assessor to agentspoppy-web (`sync-assessor` FILES gains
   `tagWriteActions.ts`), dossier + approval-preview tests green.
4. Re-run ALL poppy manifests (the 7 listed + hosting-poppy) through the reconciled
   gate; fix any genuinely-wrong manifest it flags (expected: LiveOps' delete-class
   Cognito actions move into its tagged grant), leave the rest untouched.
5. Mirror sync.
