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

11. **MCP server — expose installed poppies as tools to any AI client (parked; assessed 2026-08-14).**
   Not scheduled; recorded so the reasoning isn't re-derived. The desktop app would speak **MCP**, so
   an AI client (Claude Desktop, Cursor, …) can *operate* the user's poppies — "spin a throwaway VM",
   "publish config v3 to prod", "how many visitors yesterday" — with every call routed through the
   machinery that already exists: manifest scope → risk rating → user consent → short-lived scoped
   STS credentials → attribution.
   - **Why it's worth doing:** the differentiated claim, which almost no MCP server can make —
     *every other cloud MCP server asks you to paste long-lived keys into a config file; this one
     never hands your AI a credential at all.* Exposure comes from that claim travelling, **not**
     from a directory listing (there are thousands of servers; presence ≠ traffic). Secondary
     benefit: poppy authors get an AI-agent surface for free, just by declaring tools.
   - **It is a SURFACE, not an alternative install path.** The broker hosts the poppies, so the app
     is still required. Going standalone is technically possible (`npm run broker` already serves
     headless on 127.0.0.1:8799 against real AWS) but consent would have to become terminal prompts,
     and the visual approve-this-scope ceremony *is* the product. Keep consent in the app.
   - **The hard part, and the only genuinely risky piece:** `auth.ts` has exactly two token classes
     (HOST = desktop UI, BACKEND = one poppy's own credential mint) and its header is explicit that
     loopback is *not* a trust boundary, because every poppy backend is a local process too. An MCP
     client is a **third caller class** — neither host nor poppy — so it needs its own token, scoped
     to tool invocation and structurally unable to reach the management plane (revoke / pause /
     teardown / credential mint). Get that wrong and it opens the exact hole the broker exists to
     close. Everything else is small: a stdio adapter proxying to the existing local HTTP server, a
     `tools` block in the manifest, and a proxy hop to the backend port the registry already tracks.
   - **Manifest rule if built:** each tool must declare its mutability **explicitly** — never infer
     it from the action name (the risk assessor's substring trap already proves that inference
     fails). Read-only tools flow under the granted scope; mutating tools need per-call consent or a
     bounded session, because an MCP client sits outside our confinement and is prompt-injectable.
   - **Effort:** ~1 day for a spike (one poppy, read-only tools, no consent queue) that produces the
     demo video; ~1 week for a shippable version, plus a release cycle. **Do the spike first** — it
     tests the only assumption that matters (does anyone connect a client?) before real time is spent.
   - **Risk:** MCP's transport and auth spec have been revised repeatedly; keep the adapter thin and
     never let MCP types leak into the broker core.

12. **OpenClaw on a VM — a VM-Poppy recipe, not a new poppy (parked; assessed 2026-08-14).**
   [OpenClaw](https://docs.openclaw.ai) (formerly Clawdbot/Moltbot, **MIT-licensed**, so packaging is
   legally clean) is a self-hosted agent harness with shell access, browser automation, persistent
   memory and 20+ messaging integrations (WhatsApp/Telegram/Slack/…). It fills a real capability gap
   CrewPoppy doesn't cover — but the shape of the offer is not what it first appears.
   - **🪤 It does NOT save tokens, and this is the single most important thing recorded here.**
     OpenClaw is a harness, not a model. The only route that ever avoided metered tokens was routing
     a Claude Pro/Max subscription through it, and **Anthropic banned third-party harnesses from
     subscription credentials in January 2026, enforced at the API layer** — there is no supported
     workaround and attempts risk the user's account. **Never ship anything that helps a user route
     subscription credentials into OpenClaw**: it facilitates a ToS breach, and for a platform whose
     brand is safe delegation that is a disproportionate risk to save someone $20/month.
   - **Open-source models are a first-class path, but rented GPUs invert the economics.** Consensus
     is 14B minimum and 32B+ for reliable tool calling (Qwen3 / Qwen2.5 / GPT-OSS rank best for
     OpenClaw's tool-call format); below 14B agentic use falls apart. Approximate us-east-1, 24/7:
     | Tier | VRAM | Instance | On-demand | Spot (~65% off) |
     |---|---|---|---|---|
     | Qwen2.5 14B | 16 GB | g4dn.xlarge | ~$384/mo | ~$135/mo |
     | Qwen3/GPT-OSS 32B | 24 GB | g5.xlarge | ~$734/mo | ~$260/mo |
     | Bring-your-own API key | — | t4g.small/medium | ~$15–30/mo | — |
     Metered Claude API for a personal always-on agent is realistically **$20–80/mo**. The rule:
     **local models are cheap on hardware you OWN and expensive on hardware you RENT** — GPU rental
     only pays at high utilisation, and an agent that idles most of the day is the worst possible
     fit. Spot halves it but interruptions break the always-on promise that is OpenClaw's whole point.
   - **So the pitch is PRIVACY, never price:** *nothing leaves your account, not even the inference.*
     That is on-thesis and unmatchable by Hostinger-style hosts (their box isn't the customer's
     infrastructure). The buyer is anyone handling confidential/regulated/client data for whom "never
     sent to a third-party API" is a requirement — for them $384/mo is unremarkable. Natural tiering:
     free recipe = BYO API key on a small instance; premium = the GPU profile + zero-egress guarantee.
   - **Competitive honesty:** hosts like Hostinger already sell pre-installed OpenClaw VPSes (~$5–15/mo
     flat, managed) — real demand validation, and also a competitor we lose to on price and simplicity.
     Unlike other poppies the software is cloud-agnostic, so ownership is the *only* differentiator.
   - **Security — the non-negotiable rule.** OpenClaw is prompt-injectable by design and has hands:
     shell + browser. It shipped **CVE-2026-25253** (cross-site WebSocket hijacking → RCE via a single
     malicious link) and Cisco found **26% of community skills carried at least one vulnerability**.
     Therefore: the instance gets **ZERO AWS credentials** — no instance role, no broker access. It is
     a *tenant in* the cloud, never an *agent of* it. No inbound ports by default, pinned versions, no
     preinstalled community skills. Shipping a preconfigured install means inheriting patch duty.
   - **Shape:** a VM-Poppy recipe (preset image/user-data), reusing its EC2/no-IAM DNA — days, not
     weeks. The one genuine departure from VM-Poppy: this box is **persistent, not ephemeral**, and
     holds an API key, so secret handling and a "this is not throwaway, here is the monthly cost"
     disclosure are new surface. The "show the money" rule is load-bearing.
   - **🪤 Build gotcha:** point the gateway at Ollama's **native `/api/chat`**. If the baseUrl ends in
     `/v1`, tool calls **fail silently** — the agent looks alive and simply never acts. Hard-code it
     in the template; do not leave it to a doc.

**Post-AffiliatePoppy-release sweep — every paywall speaks the code-first checkout (founder,
2026-08-20).** AffiliatePoppy's D18 made `/api/checkout` return the `/buy` confirmation page,
where a buyer enters an affiliate code BEFORE the session exists — the only moment a discount
can be pre-applied and the commission folded into the application fee. Anything routed through
`/api/checkout` inherited this for free: the catalogue's Buy, the `commerce:purchase` bridge
(TrafficPoppy's tiers, AffiliatePoppy Pro), and MailPoppy (already on the central checkout).
After AffiliatePoppy ships to production, run the sweep: (a) verify each paid poppy's purchase
path actually passes through `/api/checkout` — no bespoke Stripe sessions anywhere; (b) any
found are migrated to the commerce plane, never patched locally; (c) the rule for every FUTURE
paid poppy: purchases go through the central checkout, which is what makes them affiliate-able
on day one. (CrewPoppy mobile is out of scope by nature — App Store billing carries no Stripe
codes.)

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
