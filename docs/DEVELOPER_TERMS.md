# AgentsPoppy — Developer Terms (draft)

**Status:** Draft direction (2026-07-02). Records the governance contract for developers who
distribute a poppy (extension) through AgentsPoppy. This is a **product/policy draft, not vetted
legal text** — the enforcement, payout-forfeiture, and identity-retention clauses in particular
**must be reviewed by counsel before publication**.

Related: [`MARKETPLACE.md`](./MARKETPLACE.md) (distribution + the ban/blocklist mechanics),
[`CONTAINER_ARCHITECTURE.md`](./CONTAINER_ARCHITECTURE.md) (how an extension runs and the runtime
sandbox), [`AGENTS.md`](../AGENTS.md) (how to build one), [`LICENSE`](../LICENSE) /
[`TRADEMARK.md`](../TRADEMARK.md) (IP + branding).

> **Why terms at all, when there's a sandbox?** A poppy's backend is a real process that receives
> scoped AWS credentials for the user's own account. The runtime controls (per-app scoping, the
> broker's caller authentication, the leaves-no-trace certificate, teardown) are strong, but no
> sandbox is perfect and the biggest lever against abuse is **human**: a developer who is
> **registered, identifiable, and reachable** — and who has agreed to real consequences — is far
> less likely to ship something destructive. These terms are that human layer; the sandbox is the
> backstop, not the other way round.

---

## 1. Developer registration & identity

- **Curated-directory listing requires a connected Stripe account — even for free poppies.** Before
  a poppy can be listed in the in-app directory, its developer must **register by connecting a
  Stripe (Connect) account**, regardless of whether the poppy is free or ever charges. Opening a
  Stripe account requires the developer to give **Stripe** their verified real-world identity (legal
  name / entity, contact, tax / KYC), so connecting it gives us a **verified, reachable developer
  identity with no bespoke registration form** to build or run. Paid developers connect Stripe for
  payouts anyway (see [`MARKETPLACE.md` §3](./MARKETPLACE.md)); free developers connect the same way,
  purely for identity.
- **Identity is retained** by the commerce/directory service (which already handles identity,
  listings, and entitlements — never AWS credentials, never card data). It is used for trust,
  support, and enforcement, and handled under the published privacy policy.
- **Rationale — identity as deterrence.** Anonymity is what makes drive-by malicious code cheap. A
  developer who has already put their real, reachable identity on the line **with Stripe** — and
  agreed to these terms — is **materially less likely** to ship a poppy that attacks a user's
  resources or a rival poppy, and if they do, they can actually be held to account. Leaning on
  Stripe's existing KYC is the cheapest, highest-leverage identity control we have — real
  verification without us operating a KYC pipeline.
- **Sideloading stays open, but unverified.** Installing an unlisted poppy from disk remains
  possible for power users and self-distribution, at the user's own risk, clearly marked as
  unverified. Registration gates the **trusted directory**, not the open door.
- **The Verified tier additionally requires public, build-bound source.** The strongest trust badge —
  **Verified** — is earned by publishing the poppy's source (a repository the community can read,
  under a source-available licence such as PolyForm or MIT) and binding the installed build to it per version,
  so anyone can audit what the poppy does with the access it's granted. This is a **higher tier**, not
  a barrier to entry: registration (above) gets you Listed; public source gets you Verified. Full
  decision: [`MARKETPLACE.md` M14](./MARKETPLACE.md). MailPoppy is planned as the first poppy to
  publish public, auditable source — the first step toward Verified.

## 2. Prohibited conduct

A developer distributing a poppy through AgentsPoppy must not:

- **Attack the user's resources.** No destroying, encrypting/ransoming, exfiltrating, or holding
  hostage the user's data or cloud resources; no touching resources the poppy did not itself create
  (invariant I1).
- **Attack another poppy.** No attempting to enumerate, disable, revoke, pause, tear down, or
  otherwise interfere with another connected poppy or its resources — whether through the broker,
  the cloud account, or any side channel. (The broker now **authenticates callers** specifically to
  make this impossible via its API — see [`CONTAINER_ARCHITECTURE.md` §5](./CONTAINER_ARCHITECTURE.md);
  attempting to circumvent that is itself a violation.)
- **Deceive on permissions.** No requesting access broader than the poppy genuinely needs, and no
  misrepresenting what a poppy does or what it will access.
- **Paywall or steer to external payment inside the poppy.** A marketplace poppy must not gate its
  own features behind a paywall, nor include any link or message directing the user to pay or sign
  up on an external site to unlock features, remove limits, or obtain a "pro" / "better" version of
  the poppy. If you charge for the poppy's own functionality, use the platform's in-app purchase
  (the flat-5% checkout — [`MARKETPLACE.md`](./MARKETPLACE.md)). **Marketplace approval is a safety
  assurance to users — including for payments** — so an installed poppy will not funnel them
  off-platform to pay. (Selling a genuinely **separate** companion product or service elsewhere is
  permitted; the rule is only that the poppy itself is not that product's in-app upsell funnel.)
- **Circumvent the guardrails.** No attempts to bypass the sandbox, the broker's caller
  authentication, the credential scoping, or the teardown/leaves-no-trace obligations.
- **Ship known-malicious or knowingly-destructive code**, or code designed to degrade the trust or
  safety of the platform or its users.
- **Reserve a name without shipping a genuine poppy (squatting).** A directory listing must be a
  **real, working poppy in genuine use** — it does what its name and description say, for real
  users. Names may not be claimed by placeholder, non-functional, or effectively-abandoned apps.
  M15's "first listed keeps the name" holds **only while the listing remains genuine**: the
  platform may delist a placeholder or long-inactive listing (with notice and a reasonable window
  to respond), which frees the name for the next legitimate claimant and ends the "…Poppy" naming
  grant ([`TRADEMARK.md`](../TRADEMARK.md)).

The technical rules a poppy must follow — least-privilege scoping, destructive-action confirmation,
leave-no-trace teardown — are in [`AGENTS.md` §3–4](../AGENTS.md). Those host-enforced controls are
**backstops, not substitutes** for this conduct standard: meeting the letter of the sandbox while
acting in bad faith is still a violation.

## 3. Enforcement & penalties

Depending on severity and intent, a violation may result in any combination of:

- **Delisting** the poppy from the curated directory.
- **Blocklisting** the poppy so the host refuses to load or run it — **even if sideloaded** — and
  **revoking** its leaves-no-trace certificate / signing (see [`MARKETPLACE.md` M12](./MARKETPLACE.md)).
- **Banning the developer** from registering or listing further poppies — including **banning the
  developer's GitHub account (or organisation) outright**: every listing whose repository belongs
  to a banned account is delisted, and no repository under it is eligible for listing again. The
  GitHub account that owns a listed poppy's repository **is** the developer identity the directory
  relies on today (M11 Stripe registration will add verified legal identity on top, not instead),
  so consequences attach to it; re-appearing under a fresh account to evade a ban is itself a
  violation.
- **Forfeiture of pending platform payouts** associated with the violating poppy.
- **Referral for legal action** where conduct is malicious or causes user harm.

Deliberate, destructive attacks on users or on other poppies are treated as the most serious
category and attract the full set above.

## 4. Ban / blocklist — grounds & appeal

- **Grounds.** A poppy or developer may be banned for any prohibited conduct in §2 (including
  name-squatting via placeholder listings), for a credible report substantiated on review (§5),
  for a certificate found to no longer hold (e.g. a poppy that fails the leaves-no-trace guarantee
  it was certified against), or for evading a prior enforcement action under a different account.
- **Effect.** A ban is published to a platform blocklist keyed on the poppy's identity and exact
  build; the host enforces it at load time. The *mechanics* — where the check runs and how the list
  is distributed — are the **M12** decision in [`MARKETPLACE.md`](./MARKETPLACE.md).
- **Appeal.** A banned developer may contest via the enforcement contact below; reinstatement
  requires the underlying issue to be resolved and, where relevant, re-certification.

## 5. Reporting a poppy

Trust is a shared responsibility, and the community is the fastest early-warning system.

- **In-app reporting.** AgentsPoppy provides a **Report** control beside each connected poppy so any
  user can flag a bug, a privacy concern, or **malicious / destructive behaviour** in the moment —
  and, if they wish, immediately **pause the poppy locally** to protect themselves.
- **Community ring-fencing.** Reports are aggregated across users. A poppy that draws credible,
  independent reports is **auto-ring-fenced** pending review — surfaced to moderation, and, above a
  threshold, provisionally delisted and/or blocklisted via the same mechanism as an outright ban —
  so a bad poppy is contained quickly rather than after it has spread. (Aggregation and
  auto-ring-fencing depend on the commerce/directory backend; the in-app report control and local
  self-protection ship first, local-first.)
- **Security researchers** should report vulnerabilities in the platform or a poppy privately via
  the enforcement contact rather than disclosing publicly.
- **Enforcement contact:** `support@mailpoppy.com` (interim, until a dedicated abuse/security
  address is published).

## 6. Relationship to other documents

These terms are the **conduct and enforcement contract**. They sit alongside — and do not replace —
the [`LICENSE`](../LICENSE) (PolyForm Perimeter, which forbids shipping a competing host),
[`TRADEMARK.md`](../TRADEMARK.md) (the Poppy name/marks), and the technical build rules in
[`AGENTS.md`](../AGENTS.md). Where a runtime control and these terms both apply, both must be
satisfied.
