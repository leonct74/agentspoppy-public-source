# The Delegated-Access Mechanism — Canonical Specification

> **This document is the single source of truth for AgentsPoppy's patent-pending
> secure-delegation mechanism.** Every change that touches an enforcement point listed in
> §4 MUST be checked against the invariants in §2 before merging, and must update this
> document in the same commit if it changes any of them. Other documents (AGENTS.md,
> INTEGRATION.md, SUPERVISION.md) are derived, developer-facing views — where they
> disagree with this file, this file wins and they are the bug.

## 1. What the mechanism is

AgentsPoppy lets a third-party app (a *poppy*) operate inside a user's AWS account
without ever holding the user's credentials. The broker assumes the account's role and
vends the poppy **short-lived credentials constrained by an inline session policy** it
generates from the poppy's declared, user-approved grants. The mechanism's promise to
the user, in one sentence:

> *An app can create things in your account only under its own name tag, can touch only
> what carries that tag, and everything it ever made can be shown to you and removed —
> all enforced by AWS IAM, not by trusting the app.*

## 2. The invariants (normative)

Each invariant names the property, why it holds, and the test that pins it.

**I1 — Narrowing-only.** The vended session policy can only *reduce* the assumed role's
permissions (IAM session-policy intersection). Nothing the broker emits can widen access
beyond the role the user installed.
*Pinned by:* IAM semantics; `sts.test.ts` (policy is always attached).

**I2 — Touch-only-your-own.** Under a `tagged-as-self` grant, every read / change /
delete action is conditioned on `aws:ResourceTag/agentspoppy:app == <appId>`: a resource
that doesn't carry the app's own tag is invisible and untouchable. Name-scoped grants
achieve the same confinement by ARN pattern.
*Pinned by:* `policy.test.ts` "splits a tag-scoped grant…" (rest-statement assertion).

**I3 — Born-tagged-or-refused** *(added 2026-07-23)*. Under a `tagged-as-self` grant,
create-class actions (`Create*` / `Request*`) are conditioned on
`aws:RequestTag/agentspoppy:app == <appId>`: the resource is **born carrying the app's
tag, or it is not born at all**. An untagged create is refused by IAM. This closes the
only attribution gap creation could open — nothing an app makes can escape I4's sweep.
Consequence: a service whose create API cannot accept tags at creation **cannot** be
granted via `tagged-as-self`; it must use name-scoping (I2's second form).
*Pinned by:* `policy.test.ts` "splits a tag-scoped grant…" (create-statement assertion).

**I4 — Complete, sweepable attribution.** Because of I3 (birth-tagged creates) plus
CloudFormation stack-tag propagation and transitive session tags, the app's entire
footprint is discoverable by one tag query — which is exactly what teardown and the
`certify` (leaves-no-trace) harness sweep. Teardown completeness is certified against a
real deploy/use/teardown cycle, with the host's cleanup backstop OFF.
*Pinned by:* `certify.ts` / `runCertification` (residuals must be zero).

**I5 — Ownership pinned to the app, not the connection.** Conditions use the stable
`agentspoppy:app` tag, never the ephemeral connection id: connections are superseded on
scope drift, but the footprint outlives them and must remain reachable for teardown.
*Pinned by:* `policy.test.ts` "flattens per-grant statements; every tag-scoped one pins
to the stable app id".

**I6 — The rating tells the truth.** What `assessPermissionSet` shows the user at
approval time must match what the compiled session policy actually permits. Creates are
rated "additive, cannot harm what exists" — and I3 makes the compiled policy exactly
that. Any change that lets rating semantics and policy semantics diverge is a
mechanism-integrity bug, even if both sides are individually "safe".
*Pinned by:* `permissions.ts` (`assessGrant`) + this document's §5 checklist.

## 3. The create/mutate split, precisely

One condition cannot cover both halves of a resource's life: a create can never satisfy
`aws:ResourceTag` (nothing exists yet — this silently denied *every* create under
`tagged-as-self` until TrafficPoppy's edge stack found it live, 2026-07), and a mutate
must not rely on `aws:RequestTag` (no tags ride on a delete). Hence one grant compiles
to two statements:

| Action class | Detected by | Condition | Meaning |
|---|---|---|---|
| Create | `/:(Create\|Request)/` on the qualified action | `aws:RequestTag/agentspoppy:app == appId` | born tagged as this app, or not born |
| Everything else | (the rest) | `aws:ResourceTag/agentspoppy:app == appId` | touch only what is already yours |

The verb filter is load-bearing: `Put*`/`Update*`/`Delete*` can overwrite or destroy
*existing* resources and must never migrate to the create side. Widening that regex is a
mechanism change and requires updating this document (§5).

## 4. Enforcement points (the files a patch must respect)

| File | Role |
|---|---|
| `packages/broker/src/aws/policy.ts` | Compiles grants → session policy. **The mechanism's heart.** |
| `packages/broker/src/aws/sts.ts` | Assumes the role with that policy + transitive attribution session tags. |
| `packages/core/src/permissions.ts` | `assessPermissionSet` — the rating shown at approval (I6's other half). |
| `packages/broker/src/aws/tagging.ts`, `deletion.ts` | The tag sweep + typed deletion behind teardown (I4). |
| `scripts/certify.ts`, `packages/broker/src/certify.ts` | The leaves-no-trace proof harness (I4's audit). |

## 5. Changing the mechanism — the approval protocol

Edits to any §4 file (and to this spec) are **physically blocked** by a deterministic
guard (`.claude/hooks/mechanism-guard.mjs`) — it fires whether or not the agent has read
any documentation. The protocol it enforces:

1. The agent must STOP, relay this banner to the founder **verbatim** —

   **🚨 ATTENTION — THIS CHANGE MIGHT IMPACT THE SECURITY MECHANISM 🚨**

   — and explain in plain language *what* it wants to change and *which invariants
   (I1–I6) the change touches*. A generic "may I edit policy.ts?" is not compliant.
2. Approval is an **action, not a word**: the founder personally runs
   `touch .claude/mechanism-approval` at the repo root, opening a 60-minute window.
   Agents must NEVER run that command themselves or instruct a tool to — routing
   around the guard is itself a mechanism-integrity violation, whatever the intent.
   A casual "ok go ahead" in chat does not open the window; only the founder's own
   command does. That asymmetry is the point: it converts naive authorization into
   conscious authorization.
3. Every change made inside the window walks the checklist below and updates this
   spec in the same commit; then the guard re-arms by itself.

### The checklist for any patch touching §4 files

1. State which invariants (I1–I6) the change interacts with.
2. For each: does it still hold? Cite the test that proves it (add one if none does).
3. Does the rating (`assessGrant`) still describe what the compiled policy permits (I6)?
4. Did the create-verb filter change? If yes: justify per §3, update §3's table.
5. Update THIS document in the same commit if any invariant, table, or file map changed.
6. Full broker suite green (`packages/broker`: vitest) + a real `certify` run before the
   next release ships.

## 6. Known boundaries (accepted, documented)

- **Untaggable-at-birth services** (create API takes no tags): out of `tagged-as-self`'s
  reach by I3 — served by name-scoped grants instead.
- **Services with no resource-level IAM at all** (e.g. SES send, Route53 record changes):
  `*`-scoped by necessity, allowed case-by-case, surfaced honestly by the rating.
- **Cost of tagged junk:** a misbehaving app can create many (tagged) resources; I4
  guarantees they're all findable and removable, and "Show the money" (AGENTS.md §9)
  surfaces the spend — but money spent before teardown is spent.

### 6.1 Local credential custody — what the mechanism does and does not cover

The invariants above govern what a poppy can do with the access it is *given*. They say
nothing about what a poppy could take by acting as ordinary local software, and that
distinction has to be stated plainly because it is the most common objection.

**The operator credential lives on the user's disk.** The broker writes it to the
`[agentspoppy]` profile in `~/.aws/credentials` (mode 0600) — see
`packages/broker/src/aws/credentials.ts`. This is true on every installation, with or
without the AWS CLI: AgentsPoppy creates that file itself. A backend runs as the same OS
user, so at OS level it can read that path, exactly as the AWS CLI, Terraform, an npm
`postinstall` script or any editor extension on that machine can.

Two channels, and they close differently:

| Channel | Status |
|---|---|
| **Environment** — `AWS_*` inherited from the process that launched AgentsPoppy | **Closed.** `poppyEnv()` in `extensions/backend-host.ts` strips the entire `AWS_*` namespace from every spawned backend's environment. The whole prefix rather than a list of known names, so a variable AWS invents later is covered by construction. Enforced by a real-spawn test. |
| **Filesystem** — reading `~/.aws/credentials` directly | **Closable, opt-in today.** A backend declaring `backend.isolation: "strict"` runs under the runtime's permission model and is denied every path outside its own three (below). Default is still `"none"` for compatibility. |

**Why the environment one mattered.** Nothing had to go wrong for it to leak: a developer
who exports `AWS_ACCESS_KEY_ID` in the shell they launch AgentsPoppy from was handing every
poppy the operator's long-lived key, no attack required. That is a strictly worse starting
position than the file, which at least takes a deliberate act to read.

**Constraining the filesystem — `backend.isolation: "strict"`.** Because a `runtime: node22`
backend runs on the host's own Node, the runtime's permission model confines it with no
OS-specific code. `confinementOptions()` in `extensions/backend-host.ts` builds the flags;
they reach the child through `NODE_OPTIONS`, because the packaged host re-execs *itself* as
the interpreter (`--poppy-backend <entry>`) and argv is already spoken for.

The allowlist is exactly three places, and nothing else:

| Place | Access |
|---|---|
| The poppy's install directory | read |
| `BackendBootstrap.dataDir` — created by the host under `~/.agentspoppy/extension-data/<id>/` | read + write |
| The OS temp directory | read + write |

`--allow-child-process` is deliberately absent: `cat ~/.aws/credentials` would otherwise walk
straight around a filesystem allowlist. A real-spawn test asserts what a confined backend can
actually do — `ERR_ACCESS_DENIED` on the credentials file, on listing the home directory, and
on the subprocess escape, while still reading its own code and writing its data directory —
with a negative control proving an unconfined backend can do the first of those.

Two implementation notes that cost time to find:

- **Real paths.** The permission model resolves symlinks, and both the temp directory and an
  installed-app directory are usually symlinked on macOS (`/var/…` → `/private/var/…`).
  Granting only the path we were handed makes the runtime ask for read on `/var` and the
  backend dies before its first line. The host resolves the entry and cwd, and grants both
  spellings.
- **`dir` and `dir/*`.** A bare directory path matches only the directory entry itself.

**Default is `"none"`, and that is a compatibility decision, not a recommendation.** Making
it the default requires migrating the poppies that write outside these three places:

1. **MailPoppy's backend reads and writes `~/.aws/credentials`**
   (`node-sidecar/src/awsProfile.ts`) — a legacy of its standalone, pre-poppy credential
   entry. Benign in intent, precisely the capability this removes, and proof the concern is
   not hypothetical. Under the broker it resolves credentials via `brokerCredentials()`, so
   the code path is dead weight there.
2. **State outside the data directory** — MailPoppy keeps its provisioning ledger and buyer
   id under `~/.mailpoppy/`. Those move to `bootstrap.dataDir`.
3. **Saving files for the user.** A poppy must not write to `~/Downloads` itself. The host
   already has the right affordance: serve the bytes from a one-shot `/local-download/<token>`
   route and let the browser save them (`http.ts`, `/ext-dl/:id/local-download/:token`).

**What this is not.** It is a runtime barrier, not an OS one, and it covers `node22` backends
only — a `runtime: "native"` backend is an arbitrary binary, which is why the manifest
validator rejects `isolation: "strict"` on one rather than pretending. Real OS sandboxing
(macOS App Sandbox / `sandbox-exec`, Windows AppContainer, Linux bubblewrap+seccomp) is
stronger, needs a launcher per platform, and is not done.

**The stronger answer is fewer backends.** A poppy's frontend already runs in a sandboxed
iframe with no filesystem, no processes and no environment — for a frontend-only poppy this
whole section is moot. A backend should be an exception a poppy justifies, not the default
(`backend.runtime` currently defaults to `"native"` when omitted), and the fact that a poppy
ships one is **not yet surfaced in the risk rating** — a user approving a connection sees a
careful breakdown of AWS grants and no mention that native code is about to run on their
machine. For this threat that line matters more than any single grant.

## 7. Change history

- **2026-08-10** — §6.1 added. `poppyEnv()` strips the whole `AWS_*` namespace (and any
  inherited `NODE_OPTIONS`) from every spawned backend's environment; before this, a poppy
  launched from a shell holding `AWS_ACCESS_KEY_ID` inherited the operator's long-lived key
  outright. `BackendBootstrap.dataDir` added, and `backend.isolation: "strict"` confines a
  `node22` backend to {install dir, data dir, tmp} with child processes denied — opt-in,
  intended to become the default. `extensions/backend-host.ts`.
- **2026-07-23** — I3 added (birth-tag-enforced creates, `aws:RequestTag` condition) and
  the create/mutate split introduced in `statementForGrant`, fixing the create-always-
  denied defect found live by TrafficPoppy (acm:RequestCertificate). Commit `6ed3108`.
- **(earlier)** — Ownership pinned to `agentspoppy:app` (I5) replacing the connection-id
  pin, so footprints survive connection supersedes.
