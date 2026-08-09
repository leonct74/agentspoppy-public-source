# AgentsPoppy — marketplace & monetisation model

**Status:** Decided direction (2026-06-26). Records how poppies are distributed and how their
developers get paid. Implementation is later (it needs the host runtime + a thin commerce service,
not just docs); this doc is the contract those will follow.

Related: [`CONTAINER_ARCHITECTURE.md`](./CONTAINER_ARCHITECTURE.md) (how an extension runs),
[`AGENTS.md`](../AGENTS.md) (how to build one), [`LICENSE`](../LICENSE) / [`TRADEMARK.md`](../TRADEMARK.md).

---

## 0. TL;DR

A **curated in-app directory** plus an always-open **sideload-from-disk** path. Developers monetise
**however they want** — free, open source, their own paid checkout/license, or an **optional** in-app
checkout. The in-app checkout uses **Stripe Connect (Standard accounts)**: the developer connects
**their own** Stripe, keeps their payouts and customer relationship, and **stays the merchant of
record**; AgentsPoppy takes a **flat, transparent 5%** application fee **on platform-processed sales
only**. No Apple-style mandate — selling outside the platform costs the developer nothing.

---

## 1. Principles

- **Built for vibe-developers.** We *love* vibe-developers — people (and the coding agents they
  direct) turning an idea into a working poppy fast. Our mission is to help you **ship** it and, if
  you want, **monetise** it — with the least friction and the smallest fee we can, in a
  **collaborative** ecosystem, not a walled garden. Every decision below serves that: low barriers to
  build, your choice of how (or whether) to charge, and a fee kept deliberately tiny.
- **Freedom to monetise.** A poppy author chooses: free, OSS, their own paid checkout, their own
  license, or the in-app checkout. We never require ours. An app that bills its own end-users
  off-platform (e.g. MailPoppy charging for mailboxes) is expected and fine — that revenue is theirs
  and outside our view.
- **Local-first holds.** The firewall stays 100% on the user's machine; AWS credentials never leave
  it. A thin commerce service only ever handles identity, listings, entitlements and payments — and
  card data stays inside **Stripe's hosted checkout**, never in AgentsPoppy. **Commerce metadata ≠
  credentials.**
- **Trust over take-rate.** The whole product is trust. A transparent **5%** kept to the bare minimum
  beats a "0% now" hook that signals a future increase. Our mission is to grow the ecosystem, not tax
  it.

---

## 2. Distribution — two doors

| Door | Who | What the user gets |
|---|---|---|
| **Curated directory** | Registered, identity-verified, signed/notarised, lightly reviewed developers | The trusted in-app catalog most users browse + install from. |
| **Sideload from disk** | Anyone, unlisted, at their own risk | The open path — already works via [`scripts/install-dev-extension.mjs`](../scripts/install-dev-extension.mjs). Preserves openness for power users / self-distribution. |

Anonymous "install from any URL by default" is deliberately **not** offered — a poppy's backend is a
native process that receives scoped AWS credentials, so unvetted code must not reach normal users by
default. (Security review of the sandbox precedes opening third-party listings — see
`CONTAINER_ARCHITECTURE.md` §9–10.)

### The directory is a security control, not just a catalogue

Curation is **defence in depth on top of** the runtime sandbox, not a replacement for it. The
runtime already isolates a poppy (per-app credential scoping, the broker's caller authentication so
one poppy can't touch another — `CONTAINER_ARCHITECTURE.md` §5, teardown / leaves-no-trace). The
directory adds the **human and governance** layer the sandbox can't provide on its own:

- **verified developer identity** (M11) — anonymity is what makes drive-by malicious code cheap;
- **platform-signed certification** (M7) — a poppy is what it claims and leaves no trace;
- **light review** against the submission criteria (M8–M10);
- **the power to delist, ban, and blocklist** a poppy that turns out to be malicious (M12), fed by
  **community reporting** (M13).
- **public, build-bound source for the Verified tier** (M14) — so the community can read exactly what
  a poppy *does with* the access it's granted, not just what it *can reach*.

None of these replaces the still-pending "security review of the IPC bridge + webview sandbox before
any third-party extension is permitted" (`CONTAINER_ARCHITECTURE.md` §9); they layer on top of it.
Distribution gating is decision **D-c** in `CONTAINER_ARCHITECTURE.md` §10.

---

## 3. Monetisation — phased, developer's choice

**v1 — BYO (bring your own).** Developers sell/license on their own (their site, their Stripe, their
license key checked by their own backend), or give it away. AgentsPoppy lists + links. **We take
nothing.**

**v2 — optional in-app checkout (Stripe Connect, Standard accounts).**

- The developer connects **their own** Stripe account (OAuth). They keep their dashboard, payout
  schedule and customer data, and **remain the merchant of record** — so VAT/sales tax, refunds,
  chargebacks and billing support are **theirs**.
- An in-app **Buy** opens **Stripe's hosted Checkout in the browser** — a **direct charge on the
  developer's account**, with our **application fee** split off automatically. On success the commerce
  service records an **entitlement**, and the host **auto-unlocks** the poppy.
- **Our cut: a flat 5% application fee, on platform-processed sales only.** Stripe's own processing
  fee is the developer's (charged on their account); our 5% is **on top**. A developer nets
  `price − Stripe fee − 5%`.

**Why a developer adopts the in-app checkout (carrot, not stick):** the buyers are already in the app
at the moment of need; the purchase **auto-unlocks** the poppy with **zero licensing code** for the
developer to build or support; and the "verified purchase through AgentsPoppy" badge reassures buyers.
Because they keep their own Stripe, adopting it just changes **where the charge is initiated** — they
give up nothing they care about.

### Common monetisation patterns

You're free to mix and match — these are just the shapes that work well. A key economic fact runs
through all of them: a poppy deploys infrastructure into the **user's own AWS account**, so **the user
pays their own AWS bill**. You're not reselling compute; you're selling **software and the
experience** around it (which is why margins can be healthy and your hosting cost ~zero).

| Pattern | How it works | Where the 5% applies |
|---|---|---|
| **Free / open source** | Give the poppy away — reputation, community, a lead-in to your paid clients or services. | n/a (no sale) |
| **Paid poppy** | Charge for the app itself (one-time or subscription); a free trial can convert to paid. | Only if sold through the in-app checkout |
| **Free poppy, monetise the clients/usage it enables** | The poppy stands up the backend in the user's cloud **for free**; you charge on the **client apps or end-users** that connect to it — e.g. a polished mobile/web client, **per-seat / per-mailbox / per-end-user** billing, or a premium add-on — on **your own terms, off-platform**. (This is MailPoppy's shape.) | **0% to us** — it's your own client-side billing, outside AgentsPoppy |
| **Open-core / freemium** | Free poppy with a paid **Pro** unlock or paid hosted/enterprise add-ons. | On the Pro unlock if sold in-app |
| **Both / hybrid** | Combine the above — e.g. a free poppy, a paid Pro unlock via the in-app checkout, **and** per-seat billing in your own SaaS that the deployed clients use. | Only on the in-app portion |

The point: AgentsPoppy never dictates your model and only ever takes its 5% on sales that actually
flow through the optional in-app checkout. Everything else — client apps, usage billing, support,
sponsorship — is yours, untouched.

### ⚠️ Designing a mobile companion that survives the app stores (founder, 2026-07-30)

Several patterns above monetise a **mobile client** (MailPoppy's shape, CrewPoppy's plan). Mobile
clients live under Apple's and Google's rules, not ours — and those rules can quietly make a poppy
**unmonetisable**: a developer builds everything, submits, gets rejected, and leaves the ecosystem
blaming us. So this section is a hard warning, learned on CrewPoppy Mobile *before* it hurt:

1. **Never ship a mobile app whose ONLY use requires a subscription sold outside the store.**
   Apple's core rule: if a payment unlocks the app, the payment must be buyable IN the app (their
   checkout, their cut). "We sell it on our own platform" is not an accepted answer, and "the
   desktop part is free" doesn't help — Apple only looks at the phone.
2. **The free app must genuinely work when opened.** Design a real free tier into the mobile app
   itself (viewing, acting-when-opened). A login wall over a paid-only service is the pattern
   reviewers bounce hardest — and a store rule even *requires* apps to function without push.
3. **Sell the upgrade in BOTH places, same entitlement.** In-app purchase on the phone (price the
   store's cut in — 15% under the small-business program) and your own checkout on desktop. The
   store's cut applies only to phone-originated purchases; it's a shelf fee, not a tax on your
   whole product.
4. **Lock something that is NATURALLY vendor-hosted — the push relay is the canonical choice.**
   Push notifications can only be delivered through the app publisher's own keys, so the relay is
   the one component that can never live in the user's cloud: enforceable server-side (an open
   repo can't unlock it), honest to charge for (it's real recurring cost YOU carry), and
   privacy-clean (payloads stay minimal and generic — "X needs your approval" — with content
   fetched from the user's own backend). "Pay so it can reach you instantly" is also simply a
   good pitch.
5. **Never paywall a safety mechanism** (approvals, kill switches, caps) and **never move the
   user's data through your servers to create something lockable**. The product promise —
   everything in the user's own cloud — outranks any monetisation idea that dents it.

**The one line we do draw — no in-poppy paywall or steering.** Monetising a **separate** client or
product off-platform is your business (0%, above). But the poppy **distributed in the marketplace**
must not itself contain a paywall, nor link or verbally steer the user to an external site to pay or
sign up to unlock **its own** features or a "pro" version. Marketplace approval is a **safety promise
to users** — that an installed poppy is vetted and won't funnel them off-platform to pay — so
charging for a poppy's own features is exactly what the optional in-app checkout is for. A free poppy
that stands up a backend for a **separate** paid client you sell elsewhere stays fine: that client is
a distinct product, not a paywall inside the poppy. Enforced as prohibited conduct in
[`DEVELOPER_TERMS.md` §2](./DEVELOPER_TERMS.md).

---

## 4. The 5% pledge

- **Flat 5%, transparent, published.** Applies **only** to the optional in-app checkout. Sell outside
  the platform → **0% to us**.
- **A promise, not a hook.** Kept to the bare minimum; we commit **not to raise it by surprise**, and
  to **lower it as scale allows**. (Contrast: App Store / Play 15–30%.)
- **Honest math, shown to developers up front:** `you receive = price − Stripe processing fee − 5%`,
  and you stay the merchant of record.

---

## 5. What we deliberately DON'T do

- **No mandatory platform billing.** No "you must use our checkout." External monetisation is always
  allowed and never taxed by us.
- **We are not the merchant of record.** Standard Connect keeps tax/refund/dispute liability with the
  developer — which also keeps AgentsPoppy out of the VAT/MoR swamp.
- **No back-catalog migration.** We capture **new** in-app sales; a developer's **existing external
  subscriptions stay where they are** (you can't move live external subs without re-subscribing every
  customer).
- **No control over a poppy's own client-side monetisation.** A poppy billing its end-users
  off-platform is theirs.

---

## 6. First-party poppies (MailPoppy)

MailPoppy keeps its **own** Stripe and bills its users directly; in the directory it's simply
**featured**, not special-cased into platform billing. It's the reference for "a poppy that monetises
its own client off-platform."

MailPoppy is also slated to be the **first poppy with public, auditable source** — the first step
toward the **Verified** tier (M14), with build-binding attested once the provenance mechanics ship
(§8). The standard we ask of developers is one the founder means to hold themselves to first: MailPoppy
is already the reference implementation for the poppy design kit, and making it the reference for
auditable source too is deliberate. See [`ROADMAP.md`](./ROADMAP.md).

---

## 7. Decisions of record

- **M1 — Distribution = curated directory + always-open sideload.**
- **M2 — Monetisation is the developer's choice;** the in-app checkout (Stripe Connect Standard) is
  **optional**.
- **M3 — The developer is the merchant of record** (Standard Connect); AgentsPoppy is not.
- **M4 — Never mandatory.** Selling outside the platform is always allowed and untaxed by us.
- **M5 — Commission is a flat, transparent 5%** on platform-processed sales only; bare-minimum pledge,
  no surprise increases; we capture new sales, not the back-catalog.
- **M6 — First-party (MailPoppy) keeps its own Stripe and is "featured."**
- **M7 — Listing in the curated directory requires a "leaves-no-trace" certificate.** A poppy is
  only listed once an automated lifecycle harness — deploy → seed real state → tear down → assert
  the `agentspoppy:app` tag sweep is **empty** — passes and the platform **signs** a certificate
  bound to `{id, version, manifestHash}`. The cert is **platform-issued, not self-asserted**
  (developers iterate locally with a `certify` CLI; the platform re-runs the same harness at
  submission and signs). Sideload stays open and uncertified — certification gates the _curated
  directory_, which is the trust signal. Rationale: an uncleanable BYOC app destroys trust in the
  whole platform; the cert makes "you can always tear it all down" a verified claim, backed at
  runtime by the tag sweep (which catches paths the harness didn't exercise). See the teardown
  contract in [`AGENTS.md` §4](../AGENTS.md). _(Harness: **built** — `npm run certify` runs the
  deploy-already → teardown → empty-sweep lifecycle and issues a `leaves-no-trace.cert.json`; the
  developer self-runs it (`issuer: "self"`, unsigned) and the platform re-runs + signs the same
  harness at submission. Code: `packages/broker/src/certify.ts`, `scripts/certify.ts`. Still to
  build for v2: the platform-side signing key + the submission service that re-runs it.)_
  **AWS deletion lag does not fail certification.** Some services confirm a delete long before it
  disappears from every listing (the tag index; Cognito user pools in their own console). Measured
  on live teardowns: CloudFront distributions clear in ~10 minutes, **Cognito user pools have been
  seen listed for days**. The harness reports such a resource as a ⚠️ warning — "couldn't be
  confirmed present" — and still passes; reviewers treat that warning as normal, and both the
  teardown result and the certify output name each resource with a link to its console page, so
  checking is one click per resource. Only a resource that verifiably STILL EXISTS in the console
  after teardown is a leak, and that is a hard fail. (Full developer note: `AGENTS.md` §4.)
  **Reviewer rule (founder, 2026-08-05): a verify/⚠️ state is never on its own a reason to reject.**
  Open the linked resources; if they are gone from AWS, approve. The submission is judged on what
  the account actually holds after teardown, not on how quickly AWS's own listings caught up —
  penalising a developer for someone else's cache would be both unfair and unfixable by them. Only
  a confirmed-present resource blocks approval.
- **M8 — Curated listings must run cloud work in the background and survive navigation.** Any deploy
  or provisioning flow must keep running server-side and reconstruct its live status on return — no
  blocked navigation, no dead spinners, no lost progress (see [`AGENTS.md` §5](../AGENTS.md)). Unlike
  leaves-no-trace this isn't (yet) machine-certified — it's a submission-review criterion. Rationale:
  a poppy that traps or strands the user during a long AWS workflow ships the kind of broken UX that
  makes "bring your own cloud" feel unsafe, and that reputation cost falls on the whole directory.
- **M9 — Curated listings must confirm before destroying resources.** Every control that deletes or
  irreversibly changes cloud resources (remove a domain, drop a table, wipe a bucket, "reset
  everything") must take a deliberate two-step confirmation that names the blast radius and warns it
  can't be undone — never a single bare click, and the destructive button isn't the auto-focused
  default (see [`AGENTS.md` §4](../AGENTS.md)). Like background+resume this is a submission-review
  criterion, not (yet) machine-certified. Rationale: a poppy that nukes a user's infrastructure on an
  accidental click is the single fastest way to destroy trust in "bring your own cloud" — and the
  blast lands on the whole directory, not just that poppy.
- **M10 — Curated listings must speak plain language and reuse shared patterns.** The guided path is
  clear enough for a non-technical person (picture a bright 12-year-old) to set the poppy up without
  confusion or losing control — real things named *and explained* (DNS is "DNS", with a plain line on
  what it does), internal plumbing hidden, errors that say what happened + what to do (never a raw
  exception or lone "Error"), and technical/security depth (ARNs/IAM/resources/audit) **relocated to
  the Dashboard rather than deleted**. Common UI — stepper/progress, confirm-teardown, banners, empty
  states — reuses the host's shared components rather than bespoke reinventions, so a user who adopts
  several poppies feels they're in one coherent product (see [`AGENTS.md` §9](../AGENTS.md)). A
  submission-review criterion. Rationale: confusing copy and mismatched UI are the everyday friction
  that makes "bring your own cloud" feel intimidating and incoherent — the opposite of the trust the
  directory sells.
- **M11 — Curated listing requires a connected Stripe account — even for free poppies.** Every
  directory developer must register by connecting a Stripe (Connect) account **whether or not they
  ever charge for anything**. This is deliberate: to open a Stripe account the developer must give
  **Stripe** their verified real-world identity (legal name/entity, contact, tax/KYC), so we get a
  **verified, reachable developer identity for free** — no bespoke KYC/registration form to build or
  operate on our side. Rationale: **identity is deterrence** — a developer who has already put their
  real identity on the line with Stripe (and agreed to our terms) is far less likely to ship
  destructive code, and can actually be held to account; paid developers already connect Stripe for
  payouts (§3), so this simply extends the same, low-friction gate to free ones. The obligation +
  prohibited-conduct + penalties live in [`DEVELOPER_TERMS.md`](./DEVELOPER_TERMS.md). (Resolves the
  "listing bar" open question from §8.) **Note:** this raises the bar to *list in the curated
  directory* only — the always-open **sideload** door (M1) stays available for developers who won't
  register, so a free/OSS author who declines Stripe can still self-distribute, uncertified. Open
  sub-question: the exact Stripe onboarding depth for a free-only developer (full Standard payout
  account vs a lighter Express identity-only onboarding).
- **M12 — Delist + ban + blocklist enforcement, checked at load time.** The platform publishes a
  signed blocklist keyed on `{developer-id, extension-id, manifestHash}`; the host **refuses to load
  or run** a blocklisted poppy **even if sideloaded**, and revokes a listed poppy's leaves-no-trace
  certificate / signing. This is the enforcement teeth behind the terms; the *grounds and appeal*
  are in [`DEVELOPER_TERMS.md`](./DEVELOPER_TERMS.md) §3–4. It is distinct from the per-action
  **credential kill-switch** (that stops a *credential*; this stops an *install/load*). Today the
  load path has **no gate** — a local id/hash blocklist is ~30 lines at `installExtensionsFromDisk`
  + `ExtensionRegistry.start`; a signed remote revocation feed and the platform signing key are the
  bigger, later pieces (see §8 open questions and `M7`'s "still to build").
- **M13 — In-app reporting + community ring-fencing.** AgentsPoppy shows a **Report** control beside
  each connected poppy so any user can flag a bug, a privacy concern, or malicious/destructive
  behaviour — and immediately **pause the poppy locally** to protect themselves. Reports aggregate
  across users; a poppy drawing credible independent reports is **auto-ring-fenced** pending review
  (provisional delist/blocklist via the M12 mechanism). Rationale: the community is the fastest
  early-warning system, and contains a bad poppy before it spreads. The in-app report control +
  local self-protection ship **first, local-first**; cross-user aggregation and auto-ring-fencing
  depend on the commerce/directory backend. See [`DEVELOPER_TERMS.md` §5](./DEVELOPER_TERMS.md).

- **M14 — The Verified tier publishes auditable source, bound to the build.** The top trust badge in
  the directory — **Verified** — additionally requires the poppy's **source to be public**: a
  repository the whole AgentsPoppy community can read, under a **source-available licence** (like AgentsPoppy's own
  — readable and auditable, *not* necessarily give-it-away OSS, so a developer selling a poppy keeps
  their IP). This closes the one gap the sandbox cannot: the runtime scoping bounds **what a poppy can
  reach**, but not **what it does within the access you granted** — a mail poppy quietly forwarding
  your mail is acting entirely inside its own scope. Only readable source addresses that half; it is
  the natural companion to M11 (who the developer is) and M12/M13 (catching and removing bad ones).
  - **The non-negotiable — source must be bound to the build, per version.** A public repo proves
    nothing if the installed artifact wasn't built from it. So Verified requires the artifact to be
    **provably that source at that version**: trivial for frontends (they ship *as* source), and for
    compiled backends via reproducible builds / build provenance tying the artifact hash to the source
    commit — the `manifestHash` + platform-signed cert of M7/M12 is the hook. Without this binding,
    "public source" is theatre, and we will not award the badge. **Re-published on every version** —
    the audited version must be the installed one.
  - **A badge, not a gate.** Sideloading stays open; a basic **Listed** poppy still needs only M11
    registration. Public source unlocks **Verified**, the strongest trust signal — it raises the trust
    ceiling, never the entry floor. (This resolves the §8 "tier flag" open question in favour of a
    trust *tier*, not a hard refuse-to-load.)
  - **Amplifies review, doesn't replace it.** Open code has hidden backdoors for years (xz-utils), so
    public source *enables* audit without guaranteeing anyone did it. Verified still rides on M11
    identity, listing-time review, and M13 reporting; source is the amplifier, not the whole control.
  - **UX:** a Verified poppy carries a **"Source: public · build verified"** chip linking to the exact
    installed commit — the moment a wary user actually clicks through and trusts it.
  - **Dogfood:** MailPoppy is slated to be the **first poppy to publish public, auditable source** —
    the first step toward Verified (§6, [`ROADMAP.md`](./ROADMAP.md)); the founder holds themselves to
    the standard before asking it of anyone else. See also [`DEVELOPER_TERMS.md` §1](./DEVELOPER_TERMS.md).

- **M15 — Directory naming: the "…Poppy" suffix, and one name per poppy (decided 2026-07-07).**
  A listed poppy's display name must **end in "Poppy"** — `MailPoppy`, `Mail-Poppy`, `Backup Poppy`.
  The suffix marks membership in the ecosystem (the reason a user instantly reads `MailPoppy` as
  "a poppy for mail"); everything before it is the developer's own brand, and *must* be their own —
  "AgentsPoppy", plain "Poppy", the logos, and names confusingly similar to the host remain
  reserved ([`TRADEMARK.md`](../TRADEMARK.md), which carves the suffix out explicitly). The name's
  **shape is locked** so the convention can't be worked around: ASCII letters and digits only, in
  words joined by *single* spaces or hyphens, the suffix cased exactly "Poppy", and a real brand
  before it — `mail-poppy`, `Mail---Poppy`, `Mail@Poppy`, bare `Poppy`, and homoglyph lookalikes
  (a Cyrillic "Рорру") are all rejected. Directory names are also **unique**: compared
  case-insensitively and ignoring spaces/hyphens, so `Mail-Poppy` cannot shadow `MailPoppy` —
  first listed keeps the name; later collisions are rejected at listing time. **"First listed
  keeps the name" holds only while the listing remains a genuine, working poppy**: name-squatting
  via placeholder or non-functional apps is a terms violation
  ([`DEVELOPER_TERMS.md` §2](./DEVELOPER_TERMS.md)) — the platform may delist it (with notice),
  freeing the name and ending the "…Poppy" naming grant; repeat offenders can have their whole
  GitHub account banned from listing (§3). Enforcement is mechanical, not editorial: the website build **fails**
  if `catalog.json` contains a non-conforming or colliding name (`scripts/validate-catalog.mjs`
  in the website repo), and the broker independently drops duplicate ids/names from any catalog it
  fetches (defence in depth — a bad catalog can't render two poppies with one name). Sideloading
  is unaffected: the convention is the price of a listing, not a runtime gate.

- **M16 — App icons: every listing carries the poppy's own mark (decided 2026-07-08).**
  A poppy's icon is its face across the whole platform — the listing card in **Poppies** (the
  in-app catalog surface's name), the host's sidebar, the AWS-approval screen, and its own tab.
  The spec, in the two places an icon lives:
  - **In the package:** a square PNG (512×512 source, transparency welcome) inside the frontend
    dir, declared in the manifest (`"icon": "frontend/icon.png"`). The host serves it from the
    installed files and shows it wherever the poppy appears; a declared path that doesn't exist
    (or points outside the frontend dir) is simply ignored — letter monogram fallback, never a
    broken image.
  - **In the catalog listing:** a **128×128 PNG embedded as a data URI** (≤50KB) — *never a URL*,
    so browsing the catalog loads nothing from third parties (no tracking pixels). Required for
    every listing; validated at publish time (`validate-catalog` fails the deploy on a missing,
    non-square, oversized or non-PNG icon) and again broker-side (a non-conforming icon is
    stripped to the monogram, the listing survives).
  Two conduct rules ride along: the icon must be **legible at 24px** (a bold simple mark — not a
  screenshot, photo, or paragraph), and it must be **the developer's own** — imitating another
  poppy's mark or AgentsPoppy's is grounds for delisting ([`TRADEMARK.md`](../TRADEMARK.md)).
  And one UI convention completes the identity loop: every poppy displays its icon at the
  **top-left of its own interface, beside its name** — the user who tapped an icon in Poppies
  lands in an app wearing the same face (MailPoppy is the reference implementation). The host
  draws the rounded corners everywhere it renders icons, so poppies ship them square.

---

## 8. Open questions (decide before building v2)

- **Listing bar (decided — M11):** curated listing requires a connected Stripe account for **all**
  developers (free or paid), which doubles as verified identity via Stripe's KYC. Remaining open
  sub-questions: the exact **Stripe onboarding depth for free-only developers** (full Standard payout
  account vs a lighter Express identity-only onboarding), the code-signing/notarisation mechanics,
  and the security review of an extension's backend before it's directory-listed.
- **Ban/blocklist distribution (M12):** local host-managed blocklist for day one vs a signed remote
  revocation feed; keying (`manifestHash` to resist rename-evasion vs `developer-id`, which does not
  yet exist as a code primitive). _(The "verified vs at-your-own-risk tier flag" sub-question is now
  **decided by M14**: a trust **tier**, not a hard refuse-to-load — sideload stays open, Verified is a
  badge.)_
- **Build-provenance mechanics (M14):** how the artifact is proven to be the published source, per
  version — reproducible builds vs a signed build-attestation the host verifies at install; whether
  the platform runs the build itself for Verified poppies; and how a frontend's shipped bundle is
  diffed against its source. This is the load-bearing piece — until it exists, "Verified" can promise
  *readable* source but not *build-bound* source, so the badge copy must not overclaim.
- **Entitlement/license format:** how the host proves "this user owns poppy X" — a signed token the
  poppy's backend verifies, or fully host-managed unlock — and how it survives offline (local-first).
- **Commerce service:** part of `agentspoppy.com` or separate; the minimal data it stores (identity,
  listings, entitlements — never AWS credentials, never card data).
- **Pricing shapes:** one-time vs subscription vs usage in-app (`application_fee_percent` for subs),
  free trials, and refund/dispute UX when the developer is MoR but the sale happened in-app.
- **Commission review cadence:** when/how the 5% is revisited downward as scale grows.

## 9. Directory v1 — the shipped implementation (2026-07-07)

The **curated directory door is now code**, at the smallest honest scope. What exists:

- **Catalog = a static JSON file, and the only remote source.** The broker fetches
  `AGENTSPOPPY_DIRECTORY_URL` (default: the AgentsPoppy website's `/directory/catalog.json`) and
  will install **only** ids found there — the app sends an id, never a URL, so
  install-from-arbitrary-URL is structurally impossible (per §2). The catalog carries, per poppy:
  `id, name, tagline, description, publisher, website, repo` (required — the open-repo rule),
  `featured, version`, and per-platform `packages: { "<platform>-<arch>": { url, sha256 } }`.
- **Packages live in each poppy's own repository releases, not on our infrastructure.** The
  platform hosts kilobytes of catalog; the bytes come from the poppy's public repo. Hosting is
  untrusted by design: the broker verifies the catalog-pinned sha256 (and per-file CRCs) locally
  before anything lands on disk.
- **Package format:** a STORE-method (uncompressed, byte-reproducible) zip of exactly the on-disk
  extension layout — `extension.json` + `frontend/**` + `backend/<binary>` — built by
  `scripts/pack-extension.mjs`, which also emits the sha256 and a ready-to-paste catalog entry.
- **Install engine (broker, host-token-gated):** `GET /directory/catalog` +
  `POST /directory/install {id}` — download → hash-verify → zip-slip-guarded extract into a
  staging dir → manifest validation (id/version must match the catalog entry — the id-squatting
  defence) → blocklist check → atomic rename into the extensions root → **hot** registration (no
  broker restart). Installing never auto-starts a poppy: the AWS-approval prompt remains a
  deliberate user click.
- **The app's Directory view** lists the catalog with MailPoppy **featured**, an install button,
  and each listing's open-repo link as the audit affordance. Copy stays inside the honesty
  ceiling: no "verified", no "signed", no "identity-verified" — v1 is a founder-curated list
  (M11 registration and platform-signed certification remain unbuilt, see §7/§8).

Still deliberately NOT in v1: uninstall-from-disk (block/stop remain the controls), in-app
checkout (v2), the signed remote revocation feed, and any Verified-tier claims.
