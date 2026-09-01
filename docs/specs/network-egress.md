# Network egress — declare it, show it, then enforce it

**Status:** phase 1 APPROVED by the founder (2026-09-01: *"You can start phase 1"*, with
the enterprise-priced full-lockdown option explicitly endorsed: *"an enterprise wouldn't
have problem to pay some extra dollars per month to be more secured"*) — and built the
same day. Phases 2–4 remain design, not commitment.

**Phase 1 as built** (one deviation from the draft below): the declaration lives at
**`permissionSet.network`**, not at the manifest top level — the permission set is the
declared-scope contract that already flows manifest → broker → connection → screen with
reconcile-on-load, so the field arrives everywhere with no new plumbing. Pieces:
`core/types.ts` (`NetworkDeclaration`), `core/network.ts` (compute-deploy predicate —
exact action names, never substrings; declaration validator; headline builder),
`findingGroups.ts` (the two rows, "know" tier), the extension-sdk manifest validator,
and the AGENTS.md contract. The undeclared row appears only for poppies that can deploy
cloud compute (lambda/cloudformation/ec2/ecs create-class actions); declared rows always
say "Declares…" and never carry a tick. The risk-assessor weighting is deliberately NOT
in phase 1's first cut — it touches guarded `permissions.ts` and waits for the founder's
mechanism window.

**Phase 1b, same day (founder: undeclared egress must be FORBIDDEN, not noted):** the
catalogue now refuses it. `agentspoppy-web/scripts/lib/mechanical-review.mjs::checkPackageBytes`
— the same gate that refuses unconfined backends — refuses any package whose grants can
deploy cloud compute and whose manifest carries no `permissionSet.network` (and refuses a
malformed declaration rather than listing it as "declared"). Applies to new listings AND
updates, so every poppy adopts at its next release. The undeclared screen row now states
the standing rule: *"A poppy can no longer enter or update in the AgentsPoppy catalogue
without declaring this."* The word the screen may NOT use yet is "cannot connect" — that
becomes true per-poppy only when phase 2's sealed VPC enforces it. Listing-forbidden is
true today; behaviour-forbidden is phase 2.

**The two egress doors (founder's model, 2026-09-01, replacing the open question that
stood here):** *"There are two possible egress points and we need to discern the egress
from the poppy and the egress from the infrastructure."*

- **Door 1 — the poppy's own cloud code** = `network.egress` ("none" / "aws-only" /
  named hosts). VM-Poppy runs no cloud code of its own → `"none"`.
- **Door 2 — infrastructure created FOR the user, whose nature is to be on the
  internet** = `network.infrastructure`: `"servers"` (VM-Poppy), `"websites"`
  (HostingPoppy), `"email"` (MailPoppy), `"none"`/absent. The screen states its purpose
  in PLATFORM-authored words — "The servers it creates for you can reach the internet…
  That is their purpose — what they send is what you put on them" — never as a leak,
  because egressing is what the user bought it for.
- **The rule that makes door 2 honest (the founder's requirement: it "shouldn't egress
  cloud data or user navigation data without his knowledge"):** a listing condition in
  AGENTS.md §3 — infrastructure carries what the user puts on it and nothing else;
  routing the user's cloud data or activity out through it without explicit, visible
  consent is delisting. The screen cites this rule in the door-2 row's context.
- **Door 3 — the poppy's own code on the USER'S MACHINE** = `network.machine`, added
  2026-09-01 when the machine gate shipped. Same vocabulary as door 1, different
  population: the frontend tab and the confined backend, running on someone's laptop.
  It exists as its own field because one value cannot be true of both planes — the
  pilot itself proves it, MailPoppy's Lambdas being AWS-only while its desktop half
  calls its vendor Hub and whatever IMAP server the user types. **This is the only door
  the platform can actually enforce**, and it does: see `machine-gate.md`. Absent =
  observed, never refused.
Prompted by an external adversarial review (Gemini, 2026-09-01) whose central criticism
we accept: **the broker controls which AWS resources a poppy may touch; it controls
nothing about where a poppy's cloud code may send data.**

**The money answer, first,** because it shapes the whole design: **phases 1 and 3 cost
nothing — not to AgentsPoppy and not to the user.** Phase 2 costs nothing for the
poppies it fits (S3/DynamoDB-only backends). The ONLY money anywhere in this spec is
a small, opt-in AWS charge **in the user's own account** for two specific situations,
both labelled before consent, both following the GuardDuty precedent (recommended,
cost-bearing, the user decides). The default path keeps the ~$0-at-idle promise intact.

## The gap, in plain words

A Lambda deployed outside a VPC has unrestricted outbound internet. So a poppy with
legitimate *read* access to a bucket can read it legitimately and send the contents
anywhere on the internet — and no IAM policy the broker writes even sees it happen.
IAM is a control plane for *identity*, not for the *network*.

The same blindness applies to money: IAM says what an app may call, never how much.
A recursive Lambda loop (function writes to the bucket that triggers it) burns real
money using only permissions the user approved.

Neither of these is a flaw in what we enforce today — nothing in our copy claims
network confinement. But "we never claimed it" is a weaker position than "we enforce
it", and this review is a preview of what every serious evaluator will write.

## Design principles (the same ones as everything else)

1. **The manifest declares, the broker enforces, the permission screen tells the truth.**
2. **Never a false green.** A declaration gets shown as the developer's claim; the
   enforced tick appears only where enforcement is real (the attribution-tags lesson:
   key the guarantee on enforcement, never on the manifest's say-so).
3. **The default path stays ~$0 at idle.** Anything cost-bearing is opt-in and priced
   in plain sight before consent (GuardDuty precedent, DESIGN cost-bearing bucket).
4. **Fail closed on enforcement, fail honest on display.**

## Phase 1 — declaration + honest copy (free, no AWS changes, ships first)

New manifest field:

```json
"network": {
  "egress": "none" | "aws-only" | ["api.stripe.com", "hooks.slack.com"]
}
```

Meaning, per value — **declared, not yet enforced** (exactly how attribution tags
started):

- `"none"` — the poppy's deployed compute needs nothing beyond S3/DynamoDB-class
  access (the services with free VPC gateway endpoints). This is the value phase 2
  can fully enforce at $0.
- `"aws-only"` — the cloud code calls other AWS services (SES, Cognito, SQS, another
  poppy's Lambda) but no third-party endpoints.
- a domain list — the third parties it talks to, named.
- **absent, on a poppy with cloud compute** — "undeclared": the risk assessor weighs
  it, and the screen states the standing fact.

Permission screen copy (register discipline):

- Undeclared + cloud compute → a standing fact in the boundary register, stated once,
  no alarm: *"Its cloud code can reach the internet. AWS does not restrict where
  deployed code sends data, and this poppy does not say where it connects."*
- Declared → shown in the developer's-own-words register: *"In its own words: its
  cloud code connects only to AWS"* (or the named domains). **No tick.** The tick
  arrives with phase 2, only for `"none"`, only when the template proves it.
- A poppy with no cloud compute gets no network line at all — no fact, no copy
  (rule 6: honest, never alarming).

Also in phase 1: `AGENTS.md` gains the field and the writing rule for it (a human
sentence, not scope mechanics), and the risk assessor weighs undeclared egress on
poppies that deploy compute.

**Cost: zero.** It is a JSON field, screen copy, and an assessor rule.

## Phase 2 — enforce `"none"` (still $0 for the poppies it fits)

For a manifest declaring `"none"`, the certifier and the broker verify the poppy's
**shipped** CloudFormation template statically (the artifact, never the source — the
two drift):

- every Lambda carries `VpcConfig` into a template-defined VPC;
- the template contains **no Internet Gateway and no NAT Gateway**, and no route to
  either;
- the only endpoints are the **free** gateway endpoints (S3, DynamoDB).

The broker **refuses the deploy** if a `"none"` poppy's template smuggles a gateway
in (fail closed). With that proof, the permission screen's enforced-floor register
may finally say, with the tick: *"Its cloud code physically cannot reach the
internet — the network it runs in has no way out."*

Cost truth table, in the user's account:

| Piece | Monthly base |
|---|---|
| VPC, subnets, security groups | $0 |
| Hyperplane ENIs (AWS-managed Lambda attachment) | $0 |
| S3 / DynamoDB **gateway** endpoints | $0 |
| Lambda in a VPC | $0 (same on-demand pricing) |
| **NAT Gateway** | **~$32/mo — deliberately forbidden.** Its absence IS the enforcement. |
| **Interface endpoints** (SES, Cognito, SQS, CloudWatch Logs, …) | **~$7–8/mo each, per AZ — why `"none"` is only for S3/DynamoDB poppies** |

So: a poppy whose backend needs SES or Cognito **cannot declare `"none"` honestly**.
It declares `"aws-only"`, which phase 2 does not enforce — the screen keeps labelling
it as the developer's claim. If we later want enforced `"aws-only"`, the only honest
route is interface endpoints, offered as a **recommended, cost-bearing toggle** at
deploy time with the price printed (the GuardDuty pattern, to the letter). That is
the single place in this spec where a user could ever spend money, and only by
choosing to.

Non-goal: forcing every poppy into a VPC. MailPoppy stays out of one.

## Phase 3 — wallet guardrails (free)

- **One AWS Budget**, provisioned by the broker at bootstrap (the first two budgets
  per AWS account are free; we create one), default threshold modest and shown at
  consent, SNS notification surfaced in the app. The response to the alarm already
  exists: the kill switch.
- **Certifier rules**, both static and free:
  - every Lambda in a poppy template declares `ReservedConcurrentExecutions`
    (default ceiling small; a manifest may justify more, and the justification is
    shown to the user);
  - an S3-triggered Lambda's event notification must carry prefix/suffix filters
    that exclude every prefix the function writes to — the classic self-invocation
    loop becomes a certification failure instead of a bill.
- **Honest limit, stated on the screen and in docs:** a budget ALERTS — AWS billing
  data lags hours, and no AWS-native mechanism hard-stops spend. We never write
  "cannot overspend". We write "you find out the same day, not from the invoice".

New grants (Budgets, SNS) mean one host re-consent wave — batch it with the next
grant-changing release so users are asked once, not twice.

## The end state (founder, 2026-09-01): declared-or-blocked, everywhere

*"The intention in the next phase is to block the poppy sandbox to egress, unless a
specific network request is declared"* — and, clarified: **egress from the USER'S
MACHINE.** Confirmed as the destination. The machine gate is therefore the NEXT
enforcement phase, ahead of the cloud seal: it applies to every poppy on day one
(all of them run on the machine; few run cloud code declaring "none").

**The machine gate (new phase 2 — design, to be spec'd in detail before building):**
strict confinement today denies file reads and child processes, NOT network — Node's
permission model has no network restriction, which is why every screen sentence
deliberately says "its CLOUD code". Two surfaces, two mechanisms:

- **Frontend (the webview tab):** the host compiles the declaration into the tab's
  content-security policy — undeclared destination refused by the browser engine
  itself. Real, engine-level enforcement; also covers the founder's "user navigation
  data" concern directly.
- **Backend (the confined process):** the host preloads a network gate into its own
  runtime before any poppy code runs — every outgoing connection checked against the
  declaration; undeclared → refused and logged (observed-register material). This
  holds BECAUSE of two existing confinement denials — no child processes, no native
  addons — which are exactly the routes around an in-runtime gate. Broker loopback is
  always allowed; fail-closed for everything else.

**Honesty grading (screen wording law):** the machine gate is "the host refuses
undeclared connections" — host-enforced, never "cannot connect". The sealed VPC is
the only place "physically cannot" is ever written. The wording widens from "cloud
code" to "code" only on the day the gate actually holds.

**The cloud seal (was phase 2, now phase 3).** Unchanged in content: `"none"` refused
at deploy unless the template seals the network (free); `"aws-only"`/named hosts
enforceable through the paid networking option (the enterprise toggle). Undeclared is
already unlistable.

## Phase 4 — observed connections (later, opt-in, pennies)

Route 53 Resolver query logging can record every DNS name the poppy's cloud
resources resolve, for fractions of a cent at poppy volumes. That would let the
observed register grow from "what it actually did" to "where it actually connected",
checked against the manifest's declared domains. Detection, not prevention — and
labelled as such. Opt-in, cost-bearing, GuardDuty-style.

## What this spec deliberately does not claim

- DNS logging is detection, not prevention.
- The desktop half of a poppy runs on the user's machine with the machine's normal
  network access. Confining the local process is the separate confinement-migration
  track (`backend.isolation: "strict"`), not this spec.
- `"aws-only"` without the paid endpoints stays a claim, and the screen says so.
- The review's "local Wasm sandboxing" suggestion is out of scope here — the
  confinement track is our answer to that surface.

## Pilot

MailPoppy declares `"aws-only"` (SES, Cognito, S3, DynamoDB, one cross-poppy Lambda
invoke — no third-party endpoint anywhere in its cloud code). First declared poppy;
the fleet follows in the ordinary catalogue cadence. A future S3/DynamoDB-only poppy
(PhotoVault-shaped) becomes the first enforced-`"none"` poppy and the proof the tick
is real.

**Door 3 adoption is a separate, per-poppy step, and MailPoppy is not the easy one.**
Its desktop half connects to AWS, to `mailpoppy.com`, to `agentspoppy.com`, and — in
the IMAP import — to a host the user types, which no list can name in advance. The
honest value for it today is `"user-directed"` (logged, never refused), while a poppy
whose desktop half only talks to AWS and the platform can declare a real list and earn
the enforced chip. Naming the first enforced door-3 poppy is a catalogue decision, not
a platform one.
