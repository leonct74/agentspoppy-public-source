# Welcome back — the uninstall → reinstall (and new-machine) workflow

**Status:** design APPROVED by the founder (2026-09-02: *"yes, let's write it"*), from his
question while field-testing the onboarding redesign: *"I'm interested about a user who
uninstalls and re-installs AgentsPoppy — what should be the ideal workflow?"* Target:
**0.3.17** — the natural sequel to the 0.3.16 onboarding. Nothing here is built yet.

## The asymmetry this spec exists for

Uninstalling removes the app and its local records; it removes almost nothing that
matters. Three things survive the user's decision to start over:

1. **In AWS:** the `AgentsPoppyBroker` role and the non-admin operator user — idempotent
   setup already reuses them ("a retry resumes"), and the second-computer flow already
   joins them.
2. **In AWS:** every poppy's footprint — stacks and tagged resources — fully discoverable
   through the `agentspoppy:app` tag sweep the platform already ships.
3. **On macOS, usually:** the operator key, because **keychain entries outlive the app**
   (the same OS behaviour MailPoppy documented on iOS). A "fresh" install often has a
   working credential from minute zero and doesn't know it.

Today the app treats every launch with an empty local registry as a first run, walks the
returning user through console work they already did, and forgets which poppies were
connected even though their resources still stand. The ideal is the inverse: **recognise
everything that survived, re-ask only what consent requires.**

## The three tiers (recognise the most, ask the least)

### Tier 1 — the keychain survived: zero-ceremony return

Before showing ANY onboarding, probe the OS keychain for an operator credential. If one
exists, **verify it live** (identity + role assumption — the same verify the wizard runs)
before trusting it:

- Verifies → skip the wizard entirely: a **"Welcome back"** screen (the celebration's
  calmer sibling: *"Everything is where you left it"*), straight into tier 3's
  re-adoption offer.
- Fails (revoked key, deleted role) → clear the stored credential and fall through to
  tier 2 with honest copy ("your previous key no longer works"), never a raw error.

The probe must be fast and silent — a slow keychain or a locked keychain falls through to
normal onboarding rather than blocking the first paint.

### Tier 2 — keychain gone, cloud remembers: the reshaped wizard

Once the wizard can see the account (identity resolved, or keys pasted), probe for the
broker role. If it exists, the flow **reshapes instead of repeating**:

- The IAM-user screen collapses to one card: *"This account already knows AgentsPoppy —
  your `agentspoppy` user is still there. Just create a fresh access key for it and
  paste it below."* No create-user ceremony, no policy paste (it's still attached).
- Region is **not re-asked** where the deployed setup pins it (the linked-account rule
  the wizard already has).
- Operator-key minting handles IAM's **two-key limit** on the operator user: when both
  slots are full, delete the operator's own dead keys first — **only ever keys of the
  operator user AgentsPoppy itself created, never a human's** — and when the second slot
  may belong to another computer still in use, say so and ask (the second-computer flow's
  eviction warning, promoted to a rule).

### Tier 3 — poppy re-adoption (the missing piece today)

After any reconnect (tier 1 or 2), run the existing tag sweep and group what stands by
app id:

> *"We found what your poppies built here: MailPoppy — 14 resources · VM-Poppy — 3
> resources. Re-adopt them?"*

Re-adopting recreates the local connection records **bound to the existing footprints**,
so inventory, activity and teardown see them as their own again — instead of a later
sweep flagging them as orphaned leftovers.

**DECIDED (founder, 2026-09-02: "auto-reconnect and re-ask permission").** Re-adoption
of the *bookkeeping* proceeds automatically — the app reads the labels and re-links the
records without ceremony — and **the permission screen is the real gate**: before any
credential is vended again, each poppy's grants go through the **full approval screen**,
exactly as on first install. Declining a poppy's permissions leaves it visible but
powerless (adopted, paused) — never a consent bypass, never invisible leftovers. The
record of what stands is discoverable fact; the right to act on it is a fresh yes.

## The finishing touch

The celebration screen learns the difference: a first-time finish keeps *"Your cloud is
ready 🎉"*; a returning user gets *"Welcome back — everything is where you left it"* with
the re-adoption summary beneath. Same confetti; the wow belongs to both.

## Edge cases the implementation must hold

- **Role exists, `agentspoppy` IAM user deleted** (the founder's own test account today):
  tier 2 detects the role but the key paste fails identity — copy must route to "create
  the user again" (one screen back), not claim the key is mistyped.
- **Two computers:** never silently evict a possibly-live operator key (see tier 2).
- **Half-torn-down accounts** (role deleted, tags remain): tier 3 may run without tier
  1/2 shortcuts — re-adoption after a full re-setup is still valid.
- **Keychain present but AWS account changed** (different account id than the key
  resolves to): treat as no-match, fall through; never mix accounts.

## Teams — the same infrastructure from many machines and many people

**Founder requirement (2026-09-02):** *"people from a team might need to connect to the
same infrastructure — if they have AWS access they should be able to manage the same
piece of infrastructure from multiple machines."* The reinstall story and the teammate
story are the SAME machinery seen twice: a teammate's first connect is tier 2 (the cloud
already knows AgentsPoppy) followed by tier 3 (adopt the standing footprints) — nothing
about it is a special case, except one structural ceiling:

- **The two-key ceiling is the blocker.** Today one shared operator user holds the
  machine credentials, and IAM caps an IAM user at TWO access keys — a hard limit of two
  machines, with the third evicting someone. Teams need **per-machine (per-person)
  operator identities**: each connect mints its own operator (e.g.
  `agentspoppy-op-<name>`), each holding its own key. This is not just capacity — it is
  **attribution**: CloudTrail then records WHICH person's machine did what, which a
  shared operator can never say and an enterprise audit will always ask.
- **Consent is per person, per machine.** Each teammate approves each poppy's permission
  set on their own machine (the tier-3 rule applied to people, not just reinstalls). One
  colleague's yes never authorises another's laptop.
- **The kill switch grows a scope.** Revoking MY operator key cuts off MY machine —
  correct and unchanged. A team also needs the account-level cut (disable the broker
  role's trust) for "cut everyone off now"; both must exist and say plainly which is
  which.
- **Poppies already tolerate this more than the host does:** MailPoppy's cross-machine
  join ("reused your existing setup") proves the pattern against a real stack. The
  host-side registry and approvals are the part that must learn it.

Sizing honesty: per-machine operators change the bootstrap, the deploy policy, teardown
(sweep all `agentspoppy-op-*`), and the consent model — a real slice of 0.3.17, not a
footnote. It is listed here because the founder named it a requirement, and because
tiers 1–3 should be built so it slots in (nothing in them may assume "one operator").

## Non-goals (v1)

- No cloud backup of the local registry. A possible tier 4 — an opt-in, cost-bearing
  "settings backup into your own S3" (BYO ethos, GuardDuty-style toggle) — is noted as an
  **open question for the founder**, not designed here.
- Bookkeeping re-adoption is automatic (decided above); the never-assumed part is
  AUTHORITY — the per-poppy permission screens.

## Open questions for the founder

1. Tier 4 backup-to-your-own-cloud: want it designed, or is tag-sweep re-adoption enough?
2. ~~Re-adoption grouping~~ — superseded by the decision above: adoption is automatic,
   per-poppy consent is the gate.
3. Teams: are per-person operator names (visible in the customer's IAM and CloudTrail,
   e.g. `agentspoppy-op-marco`) acceptable, or should machines stay anonymous
   (`agentspoppy-op-7f3a`)? Attribution argues for names; privacy inside the account is
   the counter-argument.
