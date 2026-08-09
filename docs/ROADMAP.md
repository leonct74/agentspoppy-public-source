# AgentsPoppy — Roadmap

The order we ship in, and why. This is a **sequencing** document, not a promise of dates: it records
what's done, what's next, and the reasoning behind the order. Product/business decisions it depends
on live in [`MARKETPLACE.md`](./MARKETPLACE.md); developer obligations in
[`DEVELOPER_TERMS.md`](./DEVELOPER_TERMS.md).

## Where we are

The runtime is real: the broker vends per-connection scoped, short-lived credentials; the container
model isolates a poppy's frontend + backend; caller authentication stops one poppy touching another;
teardown leaves no trace; the activity feed surfaces every change, attributed and cross-region. The
**poppy design kit** (`packages/extension-sdk/poppy.css` + `DESIGN.md`) and the agent-onboarding docs
(`AGENTS.md`, SDK README, `examples/hello-poppy`, `docs/STARTER_PROMPT.md`) ship, so a poppy can be
vibe-coded against a documented, governed standard.

The **curated directory / marketplace is not built yet** — its model is decided (`MARKETPLACE.md`
M1–M14) but the commerce backend, the signed-certification gate, and cross-user report aggregation are
still to build.

## Sequence

1. **MailPoppy — complete, tested, and published in the app stores.** The first-party poppy is the
   distribution and monetisation priority: fully functional, with the mobile client live on the Apple
   App Store and Google Play. (App-store submission is founder-driven — Apple/Play accounts,
   credentials, review — not something the tooling does for you.)

2. **AgentsPoppy website.** `agentspoppy.com` is marketing-only today. It must carry the
   **Security & Trust** section (answering "is it safe to let agents near my AWS?") and a
   **Donate / Sponsor** button (positioning: community + personal effort, not squeezing developers).
   Prerequisite: enrol `leonct74` in **GitHub Sponsors** early — it needs a bank account, identity +
   tax forms, and GitHub's review (days–weeks of lead time); until approved the button won't render.

3. **MailPoppy goes public — auditable source, the first step to Verified.** Make MailPoppy's source
   public so the whole community can read exactly what it does — the *readable* half of the **Verified**
   standard (`MARKETPLACE.md` M14), under its source-available licence. Full **build-bound** Verified status follows once the
   M14 build-provenance mechanics land (step 6); until then MailPoppy is the first poppy with public,
   auditable source. The founder holds themselves to the standard before asking it of any other
   developer — MailPoppy is already the design-kit reference, and becomes the reference for auditable
   source too. **Gate it behind the pre-public checklist below.**

4. **Vibe-coding validation (dogfood).** A fresh coding-agent session with **zero** AgentsPoppy
   context builds a brand-new poppy using only the public website + repo (`AGENTS.md`, SDK README,
   `hello-poppy`, `STARTER_PROMPT.md`). Goal: prove a cold agent can ship a *compliant* poppy from the
   docs alone; every point of friction is a doc/SDK/scaffold bug to fix. This is the real test of the
   vibe-developer onboarding, and a gate for going public.

5. **Make the AgentsPoppy repo public.** After the readiness audit and the same pre-public checklist.

6. **The marketplace, in build order** (`MARKETPLACE.md`): registration via Stripe Connect (M11) →
   platform-signed certification + the M14 build-provenance mechanics (the load-bearing piece for
   "build verified") → the curated directory + Verified badges → in-app checkout (M2–M5) →
   cross-user report aggregation + auto-ring-fencing (M13).

7. **On-premises, hybrid and other clouds — see [`ON_PREM_AND_HYBRID.md`](./ON_PREM_AND_HYBRID.md).**
   Recurring prospect question ("we still run our own servers"). Summary of the analysis: the
   guarantee comes from the *provider* refusing, not from the broker being careful, so a port is
   only worth doing where an authorization plane exists to push the rule into. **AWS Outposts /
   Local Zones already work unmodified** (same IAM/STS, control plane in the parent region) — that
   answers most residency objections for free. **A second cloud (Azure/GCP) should precede
   on-premises**: both have the primitives, and it widens the market further. **On-prem Kubernetes
   is the only faithful port** (bound tokens + labels + an admission controller = platform-enforced
   attribution); vSphere and friends would be proxy/broker-enforced and must never be sold under
   the same promise. Also identifies a **DR/contingency poppy** (stand up a standby environment,
   prove it, tear it down with evidence — untested DR plans are a universal audit finding) as a
   high-value first-party candidate needing **no new architecture**. ⚠️ Ask counsel before writing
   multi-cloud or on-prem code — the provisionals are drafted around cloud primitives.

8. **Developer insights (later).** Give a developer, on their dashboard, how many installs and
   uninstalls each of their poppies has — the basic adoption/retention signal. Needs the host to
   report anonymous install/uninstall events to the commerce plane (a new endpoint + a per-poppy
   counter), surfaced next to each poppy in the "Your poppies" overview. Privacy-preserving by
   design: counts only, no per-user identities. Post-commerce; not required for launch.

9. **Analytics poppy (next first-party poppy — HIGH conviction, right after the Windows Store
   submission lands).** Privacy-first web analytics that runs entirely in the site owner's own
   AWS: a one-click serverless collector stack (CloudFront/Lambda ingest → DynamoDB/S3
   aggregates), a ~1 KB script tag, and the poppy screen as the dashboard. Why it beats the
   Fathom/Plausible/Simple-Analytics class rather than merely matching it:
   - **No vendor in the data path at all** — visitor data never leaves the owner's cloud; the
     compliance story collapses from "trust our vendor's design" to "there is no vendor".
     Same banner-free privacy design (no cookies, no persistent IDs, daily-rotating salt for
     uniques, IPs never at rest) — self-hosting doesn't waive GDPR/ePrivacy, the design does.
   - **First-party collection survives ad blockers** that blocklist every analytics SaaS domain
     (20–40% of traffic invisible to them) — measurably better data, not just equal data.
   - **Serverless cents/month vs €10–20/month per site**, unlimited retention, no sampling.
   - **The data lives in YOUR infrastructure → an open integration surface.** Because raw
     aggregates sit in the owner's own DynamoDB/S3, the poppy can expose a simple first-party
     API (and Athena/QuickSight/BI tooling plugs straight in) for analysing and reporting that
     data on any other platform — the lock-in-free integration story no analytics SaaS offers.
   - First deployment: **agentspoppy.com itself** (dogfood + live demo for the listing); first
     poppy whose audience is every developer with a website, not only AWS admins.
   MailPoppy-scale build (collector + script + aggregation + dashboard); starts with a
   DESIGN.md in its own repo, per the VM-Poppy playbook. *(→ TrafficPoppy — in development,
   delegated to its own repo/session 2026-07-17.)*

10. **First-party poppy pipeline (after TrafficPoppy).** Founder's next two, in order, then the
   backlog. Each starts with a DESIGN.md in its own repo per the VM-Poppy/TrafficPoppy playbook
   (BYO-AWS, serverless where possible, tight name-scoped permission set, teardown + certify,
   costs visible in-app, free core + one premium feature via the in-app checkout).
   - **VPN-Poppy (founder pick #1)** — a personal VPN **on the fly** in your own AWS: pick a
     region, one click spins up a WireGuard endpoint (ephemeral by default — cents), QR-code
     config for phone/laptop, tear down when done. Honest positioning matters: it's for
     public-Wi-Fi safety, a stable IP, and region testing — **not anonymity** (your own AWS
     account is attributable) and not media-unblocking (streaming services block datacenter
     IPs). Egress ($/GB) dominates cost — the "show the money" rule is load-bearing here.
     Shares VM-Poppy's DNA (EC2 + security groups, no IAM).
   - **Mission Control Agents (founder pick #2)** — create and run a fleet of task-specific AI
     agents in your own AWS: each agent gets a role/instructions ("trained" = prompt+tools, not
     fine-tuning), runs on demand or on schedule, with Bedrock (or the owner's API key) so
     tokens bill to the owner's cloud like everything else. The most on-brand poppy possible;
     also the biggest — needs its own design phase (execution model, tool permissions, cost
     guardrails, agent isolation vs the poppy sandbox).
   - **Backlog (all validated as interesting, order TBD):** **BackupPoppy** — folders → your own
     S3/Glacier Deep Archive (~$1/TB/mo vs $9+/mo SaaS; potentially the greenest rating yet:
     pure S3, name-scoped bucket, no compute; premium: scheduled/versioned + object-lock
     ransomware protection) · **SitePoppy** — drag-drop static hosting on your domain
     (S3+CloudFront+ACM+Route53; synergy: TrafficPoppy measures what SitePoppy hosts) ·
     **UptimePoppy** — uptime checks from your own AWS (scheduled Lambda pings → alerts;
     smallest scope, fast win).

## Pre-public checklist (runs before steps 3 and 5)

Making a repo public is one-way. Before flipping either MailPoppy or AgentsPoppy:

- **Scan the full git _history_ for secrets**, not just the current tree — committed AWS keys, `.env`
  files, tokens. A clean working tree says nothing about old commits.
- **Confirm license headers + LICENSE** are correct and the license fields in `package.json` match.
- **Fix cross-repo links** that point at still-private repos (they 404 publicly) — repoint at the
  in-repo `hello-poppy` example or a public URL.
- **Strip personal/machine paths** and any local-only scratch.
- **For MailPoppy specifically:** the site's `REPO_PUBLIC` flag stays `false` until the repo is
  actually public, so the "Read the source on GitHub" CTA only appears once it resolves.

## The Verified-source standard (why step 3 matters)

Public, build-bound source is the layer the runtime sandbox can't provide. Scoping bounds **what a
poppy can reach**; readable source is how the community sees **what it does with the access it was
granted** — the two cover different halves of "can I trust this poppy?". Full decision, including the
non-negotiable build-binding requirement and why it's a trust *tier* (not an entry gate), is
`MARKETPLACE.md` **M14**.
