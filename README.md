<p align="center">
  <img src="brand/AgentsPoppy.png" alt="AgentsPoppy" width="160">
</p>

<h1 align="center">AgentsPoppy</h1>

<p align="center"><strong>OAuth for your own AWS — open, local-first, auditable.</strong></p>

<p align="center">
  <a href="https://github.com/sponsors/leonct74"><img src="https://img.shields.io/badge/Sponsor-%E2%9D%A4-EA4AAA?logo=githubsponsors&logoColor=white" alt="Sponsor AgentsPoppy on GitHub Sponsors"></a>
</p>

AgentsPoppy is a **permission broker for your own cloud**. An app or AI agent declares the
AWS access it needs; you approve it in plain language; AgentsPoppy holds your credentials
**locally**, grants the app a scoped, revocable connection, and **tracks everything that app
builds in your account** — so you can watch it, pause it, or tear it all down in one click.

It is deliberately **agnostic**: it knows nothing about any particular app. Apps connect
*through* it.

> **Status: early — v1 in progress.** This repo contains the agnostic core (`packages/core`),
> the local broker service + basic API (`packages/broker`), the React UI (`app/`) — the
> connected-apps list, the per-app footprint view, consent, and pause/revoke/teardown — and a
> Tauri desktop wrapper. The AWS-touching seams now have **real** implementations (STS
> `AssumeRole` scoped-credential vending + live CloudFormation inventory/teardown), with
> stub/demo variants for offline UI work (`npm run broker:seed`). The broker now **authenticates
> its callers** — a per-run host token (held only by the desktop UI) gates the management plane,
> and each poppy backend gets a token scoped to its own credential mint, so one poppy can't
> enumerate, revoke, or tear down another. Still ahead: the full per-call enforcement proxy. See
> [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Branding — what's a "poppy"?

In our communications (this repo, the app UI, the website), **a "poppy" means any application
connected to AgentsPoppy** (MailPoppy is one). Plural "poppies." It reinforces the shared
**Poppy** family — a common, trusted house.

## Why it's source-available

The whole pitch is trust: *an app you connect can only do what you approved, only to its own
resources, and you can prove it.* A claim like that is worth nothing unless you can read the
code that holds your credentials and enforces the scope. So that code is here, in the open, to
be **read, audited, and self-hosted** (see the [license](./LICENSE) for the terms).

## Patent pending

AgentsPoppy's core security mechanism — the credential broker that grants apps and AI agents
**bounded, self-attributing, human-approved, fully reversible** access to a user's own cloud
account — is the subject of a **pending patent application** by Marco Tomasello. Publishing the
source does not waive those rights: the code is source-available under the [license](./LICENSE),
and the patent application covers the underlying mechanism.

A patent and a non-compete licence on an otherwise open project deserve a reason, not just a
notice. Ours is in **[section VI of the Manifesto](./MANIFESTO.md#vi-why-theres-a-patent-and-a-licence-with-teeth)**:
what's worth protecting here isn't the code, it's the rules that make it trustworthy.

## Local-first — a hard boundary

Your AWS credentials live on **your** machine and never leave it. There is **no server** that
holds keys. (agentspoppy.com is a marketing site only — no credential ever touches it.)

## Declared-only egress — the network sandbox

Every poppy must **declare where it connects** in its manifest (`permissionSet.network`) — a
poppy without the declaration is not listable in the catalogue. And on your machine the host
**enforces** it: before a poppy's backend code loads, AgentsPoppy arms a network gate inside the
process, and every socket connect and DNS lookup is checked against the declaration —
**undeclared destinations are refused**, not just logged. The poppy's web view is held to the
same list by a Content-Security-Policy the browser engine itself enforces.

Why this matters beyond honest poppies: it also contains the **supply chain**. A poppy's author
ships an esbuild bundle of their dependencies, and a poisoned npm package inside it would
normally be free to exfiltrate whatever the poppy can read. Behind the gate it cannot quietly
phone home — its connection is refused (and shown to you as something the poppy *tried*).
Poppies packaged before the declaration existed are observed instead of blocked: every external
destination they contact is logged once onto their record. The permission screen says
"Host-enforced" only when the running host reports the gate armed for that poppy — never on the
manifest's say-so. Details: [`docs/specs/machine-gate.md`](docs/specs/machine-gate.md) and
[`docs/CONFINEMENT.md`](docs/CONFINEMENT.md).

## The model

```
AgentsPoppy
└── ConnectedAccount        a linked AWS identity (you can link more than one)
     └── Connection         a connected app/agent  ·  pending | active | paused | revoked
          ├── permissionSet what it's allowed to do (you approve it, in plain terms)
          ├── inventory     what THIS app built in your cloud   →  monitor + tear down
          └── audit         what it was granted and did
```

## What's in this repo

| Area | What it is |
|---|---|
| `packages/core` | The agnostic domain model + pure helpers: connection/permission types, the per-app cloud-footprint inventory (CloudFormation + tagged resources + an append-only ledger), and plain-language consent descriptions. |
| `packages/broker` | The local broker service + basic API (connect · approve · vend scoped credentials · inventory · pause/revoke/teardown). JSON-backed store, status-guarded service, AWS work behind injectable providers (stubbed in v1). |
| `app/` | The React UI — its own AgentsPoppy brand: connected "poppies" grouped by account, the per-app cloud footprint, consent, and pause/revoke/teardown. Talks to the broker over localhost. (Tauri desktop wrapper is the next step.) |

## Run it locally (dev)

Two terminals from the repo root:

```bash
npm install
npm run broker:seed     # broker on 127.0.0.1:8799 + demo poppies (MailPoppy active, BackupPoppy pending)
npm run app             # the UI (Vite dev server) — open the printed localhost URL
```

The AWS layer is stubbed/simulated in v1, so you can click the whole flow — approve a pending
poppy, open a poppy to see its cloud footprint, pause/revoke, and tear down — without touching
a real AWS account. State persists under `~/.agentspoppy/` (override with `AGENTSPOPPY_HOME`).

### As the desktop app (Tauri)

```bash
npm install
npm run -w @agentspoppy/app tauri:dev
```

This bundles the broker into a **self-contained binary** (esbuild → Node SEA, no Node needed
on the user's machine), launches the AgentsPoppy desktop window, and runs the broker as a
managed child process — started on launch, killed on exit. `npm run -w @agentspoppy/app
tauri:build` produces the installable `.app`/`.dmg`. (The first Rust build takes a few minutes.)

## License

Source-available under the **[PolyForm Perimeter License 1.0.0](https://polyformproject.org/licenses/perimeter)** —
read, run, modify and self-host it for any purpose **except** offering a product that competes
with AgentsPoppy. See [`LICENSE`](./LICENSE).

The **AgentsPoppy** and **Poppy** names and logos are trademarks — see
[`TRADEMARK.md`](./TRADEMARK.md).

## Docs

- [`MANIFESTO.md`](./MANIFESTO.md) — what we're for and what we refuse: who the cloud belongs to,
  how this is paid for without your data, and why an open project carries a patent and a
  non-compete licence.
- [`AGENTS.md`](./AGENTS.md) — **building an extension** (a "poppy"): the guide for coding agents —
  the manifest, capabilities, the security rules, and the build/install/run loop.
- [`docs/STARTER_PROMPT.md`](./docs/STARTER_PROMPT.md) — a **copy-paste prompt** to hand your coding
  agent: fill in what your poppy does and go (vibe-coding).
- [`packages/extension-sdk/README.md`](./packages/extension-sdk/README.md) — the extension SDK
  reference (manifest validation + the host bridge).
- [`docs/SUPERVISION.md`](./docs/SUPERVISION.md) — **for users:** how Supervised mode gates an app's
  access, what scope vs supervision vs expiry each guarantee, and why an "expired" session is the safe
  state (no standing access).
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — the broker's internals (v1).
- [`docs/INTEGRATION.md`](./docs/INTEGRATION.md) — the **poppy ↔ broker contract**: invariants,
  per-service scoping, connected-vs-disconnected credentials, risk tiers, decisions of record.
- [`docs/CONTAINER_ARCHITECTURE.md`](./docs/CONTAINER_ARCHITECTURE.md) — the v2 host/extension model.
- [`docs/MARKETPLACE.md`](./docs/MARKETPLACE.md) — how poppies are distributed and monetised:
  curated directory + open sideload, developer-chosen monetisation, the optional Stripe Connect
  in-app checkout, and the flat **5%** pledge.
- [`docs/DEVELOPER_TERMS.md`](./docs/DEVELOPER_TERMS.md) — the developer conduct contract (draft):
  mandatory registration/identity, prohibited destructive conduct, enforcement/penalties, the
  ban/blocklist, and in-app reporting + community ring-fencing.

## Support

AgentsPoppy is built in the open and kept deliberately lean — the marketplace fee is a flat **5%**,
and the rest is personal effort and community contribution. We'd rather grow with the community than
by squeezing it. If AgentsPoppy is useful to you, you can
[**sponsor the project**](https://github.com/sponsors/leonct74) — entirely optional. Contributing
extensions, code, or feedback helps just as much.

<p align="center">
  <a href="https://github.com/sponsors/leonct74"><img src="https://img.shields.io/badge/%E2%9D%A4_Sponsor_this_project-EA4AAA?style=for-the-badge&logo=githubsponsors&logoColor=white" alt="Sponsor AgentsPoppy on GitHub Sponsors"></a>
</p>

## Links

Poppies built on AgentsPoppy — each one runs entirely in your own AWS account:

- [MailPoppy](https://mailpoppy.com) — your own private email, in your own cloud. The first app built on AgentsPoppy.
- [CrewPoppy](https://crewpoppy.com) — the Crew HQ for your AI crew.
- [TrafficPoppy](https://trafficpoppy.agentspoppy.com) — privacy-first web analytics.
- [VPN-Poppy](https://agentspoppy.com/poppies/vpn-poppy) — a personal WireGuard VPN, on the fly.
- [VM-Poppy](https://agentspoppy.com/poppies/vm-poppy) — throwaway Linux & Windows VMs.

Coming in a few days: **LiveOpsPoppy**.
