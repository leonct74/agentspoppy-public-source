# AgentsPoppy v2 — the container / extension architecture

**Status:** Draft for review (2026-06-22). Proposes that AgentsPoppy become a **host container**
and that apps like MailPoppy become **extensions** rendered inside it, instead of separate desktop
apps that find and pair with the broker over localhost.

This **supersedes the integration model** in [`INTEGRATION.md`](./INTEGRATION.md) for
**first-party / co-distributed** apps. The v1 localhost API + `@agentspoppy/client` SDK stays as
the path for **external / third-party** apps (see §9, D-d). **Invariants I1–I7 do not change** —
only the seam by which an app and the broker meet. (The broker security model has since gained one
thing this draft predates: **caller authentication** — a host token gating the management plane +
per-backend credential tokens; see §5.)

---

## 0. TL;DR

One app. AgentsPoppy is a host with a sidebar; MailPoppy and future apps are extensions drawn as
tabs in the main view (see `stitch` mockup + the host shell in this repo's `DESIGN.md`). The
process/security boundary is **preserved but internalised**: the host owns each extension's
lifecycle and hands it scoped credentials directly, so the fragile two-app HTTP handshake — and
its entire bug class — disappears. Invariants I1–I7, the scoping matrix, attribution, and
supervised mode are unchanged; the broker additionally now **authenticates its callers** (host +
per-backend tokens, §5), so one poppy can't drive the management plane against another.

---

## 1. Why — the v1 pain that motivates this

Two **independently distributed** apps that discover and trust each other over localhost created a
whole class of bugs *orthogonal to the actual job* (brokering scoped AWS access). All observed in
the live MailPoppy↔AgentsPoppy bring-up:

- **Handshake / discovery.** Fixed ports (broker `:8799`, MailPoppy sidecar `:8787`), readiness
  races, "is the other side up yet?"
- **Connection identity drift.** The broker stores a connection's `permissionSet` at creation and
  never updates it; the client reused a stale connection; even after a grant fix, a deploy vended
  against a **revoked** connection's orphaned managed scope policy. The final apigateway failure was
  literally `assumed-role/AgentsPoppyBroker/agentspoppy-75896c7e…` — the *old* connection's scope,
  not the new one's. A pure scope-sync-across-processes failure.
- **Approval routed over HTTP + OS notifications.** Supervised approval can't reliably show an
  **Approve** button (macOS renders custom notification actions only in "Alerts" style, and
  `tauri dev` is flaky for actions), forcing a context switch to the other window.
- **Version skew.** Two binaries, two installers, two update cadences that must agree on a protocol.

None of these are essential to permission brokering. Collapsing the boundary removes them.

**Product/marketing/UX.** "Install AgentsPoppy, enable extensions" beats "install two apps and pair
them." One brand, one installer, a setup a non-expert can finish, and a per-extension permission +
activity view that *is* the product's pitch made visible.

---

## 2. The principle that must NOT change

AgentsPoppy's entire value is that **the app never holds your credentials** (I1–I7, especially I1
"only its own", I4 "no admin / no self-escalation"). A naïve reading of "extensions" — code running
**inside the host process** — would let a buggy or hostile extension read the operator credentials
straight out of host memory and bypass the broker. That destroys the pitch.

So the design rule is: **do not remove the boundary — internalise and own it.** Extensions stay
sandboxed. The host simply stops *negotiating* the boundary over localhost with a stranger and
starts *injecting* it into children it launched from a **declared manifest** it controls.

---

## 3. The model

```
┌──────────────────────────── AgentsPoppy (host container) ─────────────────────────────┐
│  Sidebar: Dashboard · <extensions…> · Activity · Settings · Support                     │
│                                                                                          │
│  ┌── Broker core (unchanged) ──┐   ┌── Extension registry & lifecycle ──┐                │
│  │ link account · STS vend     │   │ install/enable/disable/update      │                │
│  │ (two-hop role chain, tag    │   │ reads each extension's manifest    │                │
│  │  conditions) · guardrails · │   └────────────────────────────────────┘                │
│  │ audit · inventory/teardown  │                                                          │
│  └─────────────┬───────────────┘   ┌── Native supervised-approval modal ──┐              │
│                │  scoped creds      └───────────────────────────────────────┘              │
│   ┌────────────▼─────────────── per enabled extension ───────────────────────────┐       │
│   │  Frontend  → sandboxed webview TAB (no Node/AWS; host IPC bridge only)         │       │
│   │  Backend   → child PROCESS spawned by host (Node, when needed) ── creds ──► AWS │       │
│   │  Monitoring view → "what it can do" + access log, from permissionSet + audit   │       │
│   └────────────────────────────────────────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**An extension is:**

- **A manifest** (`extension.json`) — `id`, `name`, `icon`, the declared **`permissionSet`** (the
  same `{service, actions[], resourceScope}` grant shape as today), the backend entry (if any), the
  frontend entry, and the **capabilities** the frontend may call over the host bridge.
- **A frontend bundle** — React built to static assets, rendered by the host in a **sandboxed
  webview tab**. No Node, no AWS SDK, no direct network to AWS; it talks to the host through a
  capability-gated IPC bridge only.
- **An optional backend process** — for extensions that genuinely need Node (MailPoppy: CDK synth,
  AWS SDK orchestration, IMAP). The host **spawns and supervises** it and injects **only scoped
  session credentials** + a config/IPC channel. It never receives operator credentials.

**The host provides:** the shell (sidebar/tabs/theme), the broker core (unchanged), the extension
registry + lifecycle, the host API/IPC bridge, the native supervised-approval modal, and the
per-extension monitoring view.

---

## 4. How v2 maps onto — and preserves — the v1 contract

The integration *mechanics* change; the *guarantees* do not.

| v1 (two apps over localhost) | v2 (host + extension) |
|---|---|
| App POSTs `permissionSet` to `/connections`; broker stores it | Manifest **declares** `permissionSet`; host reads it at enable time → **single source of truth, re-read on load → drift impossible** |
| App reuses a stored connection; scope can go stale | Host reconciles connection ⇄ manifest deterministically; supersede is automatic + explicit |
| App calls `POST /connections/:id/credentials` over HTTP; discovery + drift | Host **injects** scoped creds into the child it spawned; no discovery, no drift |
| **Any local process could hit the plain loopback routes** (revoke / pause / teardown *another* app's connection) | Broker **authenticates callers**: a host token gates the management plane; each backend gets a per-connection token authorising only its own mint — one poppy can't touch another |
| Supervised approval via OS notification (no reliable button) | **Native host modal** — host knows the extension identity + operation; reliable Approve/Deny |
| Per-connection managed scope policy can be orphaned on revoke (the bug) | Host **owns** scope-policy lifecycle → created and cleaned deterministically; no orphans |

**Unchanged (the security core):** STS two-hop role-chain vend, IAM session-policy + tag-condition
scoping (`packages/broker/src/aws/policy.ts`), the role guardrails (`role-template.ts`), the
attribution tags, the scoping matrix (§3 of `INTEGRATION.md`), the risk tiers, supervised
cred-narrowing + no-widening, and **invariants I1–I7**. The credential a backend receives is still a
short-lived, tag-scoped STS session — it simply arrives by injection instead of an HTTP poll.

---

## 5. Security model (the sandbox)

- **Frontend** runs in a webview with **no Node integration**, a locked **CSP**, and access to the
  host **only** through an IPC bridge whose surface is the **capability allowlist from the
  manifest** (e.g. `aws.requestCredentials`, `mail.deploy`, `status.read`). It cannot reach AWS or
  the filesystem directly.
- **Backend** runs as a **separate OS process** (not in host memory). It receives only scoped
  session creds; the host owns its lifecycle and **kills it on disable / revoke / teardown**. Same
  isolation as today's separate sidecar — now host-managed.
- **Operator credentials never cross to any extension**, frontend or backend. The host mints and
  hands out only scoped sessions (I4).
- **Broker guardrails unchanged** — the deny set on the broker role (IAM-user management,
  account/org control, CloudTrail tampering, attaching admin policies) still bounds every vend.
- **Scope-policy ownership.** For large scopes that exceed STS's 2048-char inline limit, the
  per-connection customer-managed policy (`AgentsPoppyScope-<connId>`) is created and cleaned up by
  the host as part of connection lifecycle — eliminating the orphaned-policy failure from §1.
- **Caller authentication (broker HTTP API).** Loopback is **not** an access-control boundary — a
  poppy backend is a local process too — so the broker authenticates every caller by bearer token.
  A per-run **host token** (`generateToken()` in `packages/broker/src/auth.ts`) is emitted once on
  the broker's stdout as `AGENTSPOPPY_HOST_TOKEN=…`, captured by the Tauri host off that pipe (which
  a spawned backend cannot read), exposed to the webview via the `broker_host_token` command, and
  sent as `Authorization: Bearer …`. It is **required for the entire management plane** — list
  connections, approve/deny, pause/resume, revoke, teardown, forget, accounts, operator AWS calls,
  and extension start/stop. Each spawned backend instead gets a per-connection **credentials token**
  (`BackendBootstrap.credentialsToken`) that authorises **only** its own
  `POST /connections/<its-id>/credentials` mint, and is revoked when the host stops it. The only
  token-free routes are the static frontend assets (`/ext-ui/*`) and one-shot downloads
  (`/ext-dl/*`). The browser-only dev harness opts out with `AGENTSPOPPY_DEV_OPEN=1`; the packaged
  app never sets it. **This closes the hole where one installed poppy could enumerate and
  revoke / pause / tear down a competitor — and constrains no legitimate poppy-to-poppy
  integration, since "revoke my rival" is never a cooperation primitive.**

---

## 6. Migrating MailPoppy (extension #1)

MailPoppy already fits the shape: it declares a `permissionSet()`, speaks the broker protocol, and
has a clean frontend / Node-sidecar split.

- **Backend** (`apps/desktop/node-sidecar/` — `provisioning.ts`, fastify routes in `index.ts`) →
  packaged as the extension backend the host spawns. Remove self-spawn + broker HTTP discovery
  (`agentspoppyBroker.ts`'s connect/handshake); instead receive scoped creds + a host IPC channel by
  injection. **The AWS/CDK/IMAP logic is unchanged.**
- **Frontend** (`SetupWizard`, `DomainView`, `InboxView`, `AccountView`, …) → rendered in a host
  tab; calls the host API rather than hard-coded `http://127.0.0.1:8787` (the host assigns/knows the
  backend channel and proxies).
- **Monitoring view** — the mockup's "What it can do" service cards + "Recent Access Logs" is the
  host's per-extension view, driven by the connection's `permissionSet` + `audit` (data we already
  produce).
- **Keep MailPoppy shippable throughout** — the backend stays runnable both standalone and hosted
  behind a thin adapter, until in-container parity is proven, then standalone is retired.

---

## 7. Phased plan (every phase shippable; MailPoppy never broken)

- **Phase 0 — this doc + decision.** ✅ in progress.
- **Phase 1 — Contract.** `packages/extension-sdk` (+ manifest types in `packages/core`): the
  `extension.json` schema, the host-API/IPC surface, the capability list. Pure + unit-tested. No
  behaviour change to the shipping apps.
- **Phase 2 — Host runtime.** Extension registry + lifecycle; the tab shell (sidebar + tabs per
  `DESIGN.md`); child-process spawn/supervise; **direct cred injection** (replacing HTTP discovery
  for bundled extensions; the HTTP broker stays for external poppies); native approval modal;
  per-extension monitoring view.
- **Phase 3 — MailPoppy as extension #1.** Port it; prove **parity**: create a domain end-to-end
  *inside the container*, supervised-approve via the native modal, then tear it down. (This is the
  baseline we kept failing to reach over the two-app seam — minus the cross-process fragility.)
- **Phase 4 — Distribution.** One AgentsPoppy installer bundling MailPoppy as a built-in extension;
  enable/disable UI; auto-update.
- **Phase 5 — Generalise.** Public extension SDK + author docs + (later) a curated directory.

---

## 8. Reuse vs rebuild

- **Reused:** broker core (STS vend, `role-template` guardrails, store, audit, inventory/teardown);
  `packages/core` permission + risk model; the scoping matrix; **all AWS-IAM scope work** (incl. the
  apigateway `/tags` fix); MailPoppy's backend logic + frontend views; the `DESIGN.md` design system.
- **New:** the manifest + host-API contract; the host runtime (tabs, child lifecycle, cred
  injection, approval modal, monitoring view); packaging/distribution; the standalone↔hosted adapter
  in MailPoppy.
- **Retired:** the localhost broker-discovery handshake (for bundled extensions); MailPoppy's
  self-spawned sidecar lifecycle; OS-notification approval buttons; the connection-drift /
  stale-scope reconnect logic (the manifest replaces it).

---

## 9. Risks & open questions

- **Tauri multi-webview maturity** — verify child webviews / isolated frames, IPC isolation, and CSP
  enforcement are solid enough to be the sandbox for an untrusted extension frontend.
- **Heavy backends** — MailPoppy's backend is a Node SEA bundling CDK + a Lambda zip. Extensions
  likely ship **their own backend binary** that the host spawns (rather than a JS module the host
  `require`s) — keeps isolation and language/runtime freedom.
- **Signing / notarisation** of bundled extensions; host-version vs extension-version update cadence.
- **Ban / blocklist enforcement.** A malicious or de-listed poppy is blocked **at load time** — the
  host checks a published blocklist (keyed on developer/extension id + `manifestHash`) in the same
  disk-load + `start` path it already owns, and refuses to load or run it even if sideloaded. This
  is a distinct control from the per-action credential kill-switch (`ARCHITECTURE.md` §credentials):
  that stops a *credential*; the blocklist stops an *install/load*. Governance/policy: `MARKETPLACE.md`
  M12–M13 + [`DEVELOPER_TERMS.md`](./DEVELOPER_TERMS.md). (Load path has no gate today; a local
  id/hash blocklist is small, a signed remote revocation feed is the larger later piece.)
- **Backward-compat** — keep the v1 HTTP broker + `@agentspoppy/client` for external/third-party
  poppies (open ecosystem) alongside the internal channel for bundled ones (recommend: yes, dual
  path). The internal channel is an optimisation of the same contract, not a replacement of it.
- **Security review** of the IPC bridge + webview sandbox **before** any third-party extension is
  permitted. *(Caller authentication of the broker's HTTP API — the "any local process can drive it"
  gap — has since shipped, §5; the remaining review is scoped to the IPC bridge + webview sandbox.)*
- **Bonus** — the v1-roadmap "per-call enforcement proxy" becomes far easier in-host (the host can
  sit in the call path of a child it spawned). Out of scope here, but this architecture unlocks it.

---

## 10. Decisions needed (the real forks)

- **D-a — Backend hosting.** **Child process (recommended)** — preserves isolation, runtime freedom.
  (Rejected: in-process module = unsafe; webview-only = insufficient for MailPoppy's Node needs.)
- **D-b — Frontend embedding.** Tauri child webview vs iframe vs micro-frontend bundle. Recommend a
  webview/iframe with locked CSP + the IPC bridge.
- **D-c — Distribution.** **Bundle curated extensions in the host first**; open installable packages
  later, once the sandbox is security-reviewed.
- **D-d — Backward-compat.** Keep v1 HTTP broker + SDK for external poppies (recommend **dual path**).
- **D-e — Phase-3 "baseline" definition.** Domain create + supervised approve + teardown, entirely
  inside the container = done.

---

## Appendix — terminology

Carries over from `ARCHITECTURE.md` / `INTEGRATION.md`: **poppy** = any app connected to AgentsPoppy;
**ConnectedAccount**, **Connection**, **permissionSet**, the **scoping matrix**, **supervised mode**,
**I1–I7**. New in v2: **host** (the AgentsPoppy container), **extension** (a poppy distributed and run
*inside* the host), **manifest** (`extension.json`), **host API / IPC bridge**. Broker auth (§5):
**host token** (per-run secret gating the management plane, held only by the desktop UI),
**credentials/backend token** (per-connection, in the bootstrap, authorises only that poppy's own
credential mint), the token-free asset routes `/ext-ui/*` and `/ext-dl/*`, and the
`AGENTSPOPPY_DEV_OPEN` dev bypass.
