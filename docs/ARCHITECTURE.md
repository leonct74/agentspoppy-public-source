# AgentsPoppy — architecture (v1)

AgentsPoppy is an **agnostic, local-first permission broker for your own AWS**. This document
describes the v1 architecture. It contains no app-specific logic by design.

> **Status (2026-08-20).** Corrected against the line-by-line code audit of 16 Aug
> (`docs/AUDIT-2026-08-16.md`) and updated for backend confinement. Where this overview and
> [`SECURITY_MECHANISM.md`](./SECURITY_MECHANISM.md) differ in detail, the latter is
> authoritative — it is the mechanism-level document and is kept current first.

> For the **contract between a poppy and the broker** — the invariants, the per-service scoping
> matrix, connected-vs-disconnected credentials, the risk tiers, and decisions of record — see
> [`INTEGRATION.md`](./INTEGRATION.md).

## Principles

- **Local-first credentials.** AgentsPoppy never sends AWS keys anywhere and holds no keys
  server-side: the operator credential lives on the user's machine (in `~/.aws/credentials`
  at 0600 — the same place the AWS CLI puts one). The app does call our web services for the
  catalogue, products, purchases and entitlements; none of those requests ever carry a
  credential, and paid features fail closed with no network.
- **Agnostic.** The broker knows nothing about any particular consumer app. Apps connect
  through a documented API.
- **Trust by auditability.** The code that holds credentials and enforces scope is
  source-available so the guarantees can be verified.

## The model

```
ConnectedAccount        a linked AWS identity (more than one allowed)
└── Connection          a connected app/agent
     ├── status         pending | active | paused | revoked
     ├── permissionSet  declared by the app, approved by the user (in plain terms)
     ├── inventory      what this connection created in the cloud
     └── audit          append-only record of grants and actions
```

## Attribution & teardown (the core capability)

To show "what *this* app created" and remove it, every resource an app provisions must be
attributable to its connection. Three layers:

1. **CloudFormation stack = unit of deployment & teardown.** The live inventory is read from
   the stack; teardown = delete stack (atomic, dependency-ordered).
2. **Attribution tags** — `agentspoppy:account`, `agentspoppy:app`, `agentspoppy:connection`
   on every brokered resource. Enforced by AWS on tag-scoped creates (the birth-tag
   condition); advisory on grants written against a name pattern, where the name is the
   scope. Enables reconciliation against AWS (Resource Groups Tagging API) to catch drift
   and to sweep on teardown.
3. **Append-only ledger** for out-of-stack mutations, attributed per connection.

**Enforceable attribution:** scoping the vended credentials with IAM tag-conditions
(`aws:RequestTag` on create, `aws:ResourceTag` on mutate/delete) means that *under a
tagged-as-self grant* an app cannot create resources that aren't stamped as its own, nor
touch another app's — AWS refuses the call. A grant scoped by a name/ARN pattern instead of
a tag is bounded by that name, not by a tag condition. So "show / wipe what it made" is
enforced wherever tags are the scope, and bounded-by-name everywhere else.

### How credentials are vended (the real AWS layer)

The user's account holds **one IAM role** (`ConnectedAccount.roleArn`) that the account
itself trusts, and that only the operator identity is permitted to assume. Per connection the
broker performs **two STS hops** — the operator assumes the role plainly, then that session
re-assumes the same role — passing on the scoped hop:

- an inline **session policy** built from the connection's grants. Effective access is the
  *intersection* of the role and this policy, so it can only narrow — never widen — and every
  tag-scoped grant is pinned to ownership with `aws:ResourceTag/agentspoppy:app` (the app,
  deliberately, so a footprint survives a connection being replaced; the connection id rides
  along as an audit tag, not the ownership pin);
- the connection's attribution tags as **transitive session tags** — they stamp what the
  session tags at creation and what birth-tag-conditioned grants force to be tagged; they are
  not an automatic stamp on every possible resource.

The operator credential doing the first hop is resolved from the dedicated `[agentspoppy]`
profile the setup writes (0600), falling back to the standard AWS provider chain — stored
locally like any CLI credential, never transmitted.

The policy generation is pure and exhaustively unit-tested (`packages/broker/src/aws/policy.ts`).

The **monitoring/teardown plane runs with operator credentials** (not the app's scoped
session): inventory lists CloudFormation stacks across the account's regions and keeps only
those tagged for the connection; teardown **re-verifies that tag immediately before deleting**,
so a forged/stale stack name can never trick the broker into deleting a stack it doesn't own.

**Teardown completes in every poppy state — host residual cleanup.** A poppy's own teardown
hook can only run while the poppy can run; a revoked/blocked/uninstalled poppy can't clean up
after itself. So after the hook (best-effort) and the stack deletes, the **host itself deletes
whatever the tag sweep still attributes to the app** (`packages/broker/src/aws/deletion.ts`):
type-aware deleters (S3 incl. versions, DynamoDB, Cognito, Lambda, CloudWatch Logs, SES), each
deletion double-keyed on a **live per-service re-read of the `agentspoppy:app` tag**
(GetBucketTagging, ListTagsOfResource, … — not the eventually-consistent tag index; SES types,
which have no tag-read API, fall back to the index). Teardown refuses to run at all when the
operator credentials resolve to a different AWS account than the connection's. The user is never
forced to re-approve — let alone unblock — a poppy just to get rid of its footprint. Whatever
the host can't remove (untagged or unsupported) is reported with console links, never silently —
and a *denied* sweep is flagged as unverified, never shown as "clean". Certification runs with
host cleanup **off**, so a poppy's leaves-no-trace certificate still measures the poppy's own
compliance, not the host's backstop.

Because teardown is adoption-critical, it has a dedicated, repeatable acceptance runbook —
[`docs/TEARDOWN_TEST_PLAN.md`](./TEARDOWN_TEST_PLAN.md) — covering the real-AWS and hostile-poppy
cases unit tests can't reach. Run it before any release that touches teardown, the deletion
engine, credentials, or the operator IAM policy.

### One access policy, kept healthy

The user attaches **one** least-privilege policy —
[`infra/policies/agentspoppy-access-policy.json`](../infra/policies/agentspoppy-access-policy.json) —
to a single IAM user for day-to-day operation. Setup is the one moment that needs more: the
pasted **setup credential** (able to create a role and a user) is used in memory to deploy the
bootstrap — the broker role plus a limited `AgentsPoppyOperator` user — and is **never written
to disk**; what setup persists is the operator's own key, which is the setup key *minus all
IAM permissions* (it cannot create identities, mint keys, or widen access — the guardrail
denies are in `role-template.ts`). "Non-admin" means exactly that subtraction: the operator
can still assume the broker role, whose ceiling is what the role allows. (The activity feed
attributes the operator by the **live** connected identity — whatever IAM user your
credentials resolve to — and additionally always recognises the canonical
`AgentsPoppyOperator`, so its events read as "By AgentsPoppy" whichever key you connect with.)

**Health + policy drift.** The broker answers two questions about that credential — *do these keys
authenticate* (`sts:GetCallerIdentity`) and *can they actually operate the account* (`sts:AssumeRole`
on the broker role) — and the desktop surfaces the result as an always-visible sidebar panel
(connected · region · one-click fix). If the keys lapse it prompts **Reconnect**; if they
authenticate but a permission is missing — e.g. after an AgentsPoppy update adds one — it flags
**policy drift** and links the user straight back to the current access policy to re-copy onto their
IAM user, then re-checks. The same assume-role signal gates the per-connection inventory map, so the
sidebar's health and a poppy's own "can't read this account" banner can't disagree.

### Lifecycle

- **Pause** — stop vending credentials; existing infra keeps running.
- **Revoke** — kill access permanently; leave the user's data intact.
- **Tear down** — delete the connection's stack(s) + sweep its tagged resources + reverse
  ledger'd mutations.

## Long-running agents & the local runtime model

AgentsPoppy targets **local, co-located** agents: the broker is an always-on localhost
gatekeeper, and an agent runs *next to* it. Cloud/headless agents that must outlive the broker
are out of v1 scope (the AWS-native answer there is a role attached to the compute, which
AgentsPoppy would only provision and govern).

Vended credentials are short-lived (~1h) **on purpose** — they're auto-rotation, not a workload
time limit. A 24h+ agent never holds one token for its lifetime; it holds the **connection** and
lets a refreshing provider re-mint as expiry approaches. Revoke stops the next mint, so access
dies within the token's TTL — no secret to claw back. **Pause is stronger**: it *also stops the
poppy's backend* (and kills its credential token), so a paused poppy can't keep acting on a
cached token during that TTL window — it's a real, immediate halt, reversible with one click.

`@agentspoppy/client` ships that provider: an AWS-SDK-v3-compatible, zero-dependency credential
provider that calls `POST /connections/:id/credentials`, caches until it's within a refresh
buffer of expiry, and coalesces concurrent refreshes. Drop it into any SDK client as
`credentials` and a long-running agent just works — or stalls the moment the user revokes.

## The basic API (v1, localhost only)

**Caller authentication.** Bound to `127.0.0.1`, but loopback is **not** an access-control boundary
(every poppy backend is a local process too). The router is fronted by an auth gate
(`packages/broker/src/auth.ts` + `resolveCaller` at the top of `http.ts`'s `handle()`). A per-run
**host token** — generated at startup, emitted once on the broker's stdout (`AGENTSPOPPY_HOST_TOKEN=…`),
captured by the Tauri host off that pipe (unreadable to a spawned backend) and sent by the UI as
`Authorization: Bearer …` — is required for the entire **management plane** (every row below except
the credential mint). Each spawned poppy backend instead gets a per-connection **credentials token**
(`BackendBootstrap.credentialsToken`) that authorises **only** its own `POST
/connections/<its-id>/credentials`. The static asset routes (`/ext-ui/*`, `/ext-dl/*`) take no
token; the browser-only dev harness opts out with `AGENTSPOPPY_DEV_OPEN=1` (the packaged app never
does). Net effect: one poppy cannot enumerate, revoke, pause, or tear down another.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/aws/identity` | Operator identity (STS GetCallerIdentity) — "are my AWS creds working?" |
| `GET` | `/accounts` · `POST /accounts` | List / link AWS identities |
| `GET` | `/accounts/:id/role-template` | CloudFormation template for the role AgentsPoppy assumes |
| `POST` | `/accounts/:id/role` | Set the account's role ARN |
| `POST` | `/accounts/:id/verify` | Confirm the role is assumable |
| `POST` | `/connections` | App requests a connection → `pending` |
| `GET` | `/connections` · `/connections/:id` | List / inspect |
| `POST` | `/connections/:id/approve` · `/deny` | User decision |
| `POST` | `/connections/:id/credentials` | Vend short-lived scoped credentials (if `active`) |
| `POST` | `/connections/:id/pause` · `/resume` | Toggle |
| `GET` | `/connections/:id/inventory` | The per-app cloud footprint |
| `POST` | `/connections/:id/teardown` | Destroy this app's footprint |
| `DELETE` | `/connections/:id` | Revoke |
| `GET` | `/connections/:id/audit` | Per-app audit trail |

## v1 scope

**In:** linked accounts · connections + consent · scoped credential vending · attribution
tagging (+ IAM-condition enforcement) · per-app inventory · pause/resume/revoke/teardown ·
per-app audit · **caller authentication (host + per-backend bootstrap tokens)** · **backend
filesystem confinement** (`backend.isolation: "strict"` — Node's permission model limits a
poppy backend to its install dir + its data dir + temp, no child processes; a listing
requirement since 2026-08-20, and re-checked by the host at install time against the manifest it
extracted, see `SECURITY_MECHANISM.md` §6.1–6.2 and RUNTIMES.md R7) · the
**"What's new"** (the running version compared against the last one seen, so a user learns what
changed — the only such signal on a Microsoft Store install, which updates silently) · the
**curated poppy directory** (the primary install path, with tiered mechanical review,
package-integrity gates so the reviewed bytes and the installed bytes cannot diverge, and
verify-with-your-AI-agent audit prompts on installs and updates) · the broker UI · a small
client SDK.

**Roadmap:** full per-call enforcement proxy (sign + forward every request) · spend caps /
per-action approval / kill-switch · OS-level sandboxing (App Sandbox / AppContainer /
bubblewrap) beneath the runtime confinement · multi-cloud.

## Packages

- `packages/core` — domain types, the inventory/ledger helpers, and the consent/permission
  model. Pure and unit-tested; no network, no app specifics.
- `packages/broker` — the local service implementing the API above: a JSON-backed store
  (`~/.agentspoppy/state.json`), a status-guarded service layer, and a Node-`http` router
  bound to 127.0.0.1 behind a caller-auth gate (`auth.ts` + `resolveCaller`). The AWS seams
  (`CredentialVendor`, `CloudProvider`) have **real**
  implementations under `src/aws/` (STS `AssumeRole` vending + live CloudFormation
  inventory/teardown), with stub/demo variants retained for tests and offline UI work
  (`--seed` / `AGENTSPOPPY_DEMO=1`). The SDK sits behind injectable seams so the broker's
  logic stays pure and unit-tested.
- `packages/client` — the zero-dependency client SDK a poppy imports to talk to the broker.
  v1 surface is the auto-refreshing, AWS-SDK-compatible credential provider (see the runtime
  model above).
- `app/` — the React UI (Vite) plus a Tauri desktop wrapper that spawns the broker as a
  bundled `externalBin` sidecar: the connected-apps ("poppies") list grouped by account, the
  per-app footprint view, consent, and pause/revoke/teardown, over a typed broker client.

## Branding

In all communications (repo, UI, website), **"poppy" = any application connected to
AgentsPoppy** (e.g. MailPoppy); plural "poppies". Reinforces the shared Poppy family brand.
