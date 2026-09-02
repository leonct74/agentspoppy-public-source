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

**I2 has a precondition, and it was violated in production** *(added 2026-08-26)*. The
condition is only worth anything while the app cannot write the tag it is judged by.
Six of the seven shipped poppies held an unconditioned power to write tags on every
resource of some type — so the lock and the key were in the same hand: stamp
`agentspoppy:app` onto another poppy's user pool, or onto a server the user made, and I2
then authorises acting on it. **A tag write on a scope that does not narrow must itself be
conditioned**: permitted only as part of a create the app is making (`ec2:CreateAction`,
which leaves no residual path), or — where the service cannot prove that — only onto a
resource not already claimed, plus a separate allow for re-tagging what is already the
app's own. A service whose tag actions support neither condition key cannot hold an
unnarrowed tag write at all and must be name-scoped; a service that has not been checked
is **refused at compile time**, never emitted unconditioned.
*Pinned by:* `policy.test.ts` "splits a tag-scoped grant…" (rest-statement assertion);
`aws/tag-adoption.test.ts` (every unnarrowed tag write is conditioned, untag never carries
a request-tag condition, unchecked services are refused).

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

Divergence is a bug in **both** directions *(clarified 2026-08-26)*. Under-stating a
grant is the obvious failure — `ec2:TerminateInstances` was once described as *"Can read
ANY EC2 resource in your account"*. Over-stating one is the same bug with the sign
flipped: telling a user that `ec2:RunInstances` can *"create, change and delete ANY EC2
resource"* claims a power the compiled policy does not grant, and a rating that accuses
everything is no more informative than one that accuses nothing.

The additive bucket is the sharpest edge. Its promise — *"can create new things, but
cannot change or delete anything that already exists"* — is true on its own terms for any
scope. What is borrowed from I3 is the stronger guarantee sitting behind it under a
`tagged-as-self` grant: that the created thing is born carrying the app's tag and is
therefore sweepable. (Under a wildcard scope there is no birth-tag at all, which is why
`isFullyAttributable` refuses a wildcard mutating grant outright — a different guardrail
for the same worry.) The bucket is only safe to widen while the compiler birth-tags
exactly the actions the rating calls additive.
The rating's `CREATE_VERBS` therefore mirrors the compiler's `/:(Create|Request)/` filter
by construction, and an action that is a "create" in English but not to the compiler —
`ec2:RunInstances` — gets its own **`launch`** class rather than the additive
reassurance, because under a `tagged-as-self` grant it is born UNTAGGED and so escapes
I4's sweep and teardown.
*Pinned by:* `permissions.ts` (`assessGrant`), `permissions-rating.test.ts` (a table of
real AWS action names asserted against what they actually do),
`aws/rating-matches-compiler.test.ts` (fails if the additive bucket ever outruns the
compiler's birth-tagging), + this document's §5 checklist.

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

It is load-bearing a second time, through I6. The consent rating's additive bucket tells
the user an action "cannot change or delete anything that already exists", which is only
true because this filter birth-tags it. The two sets live in different packages
(`policy.ts` here, `CREATE_VERBS` in `core/permissions.ts`) and nothing in the type system
links them, so `aws/rating-matches-compiler.test.ts` asserts the one direction that must
hold: **the rating may be stricter than this filter, never more generous.** Widening the
regex therefore also permits widening the rating; narrowing it obliges narrowing the
rating in the same commit.

## 4. Enforcement points (the files a patch must respect)

| File | Role |
|---|---|
| `packages/broker/src/aws/policy.ts` | Compiles grants → session policy. **The mechanism's heart.** |
| `packages/broker/src/aws/sts.ts` | Assumes the role with that policy + transitive attribution session tags. Also **verifies the managed scope policy's contents** before binding a session to it (large scopes are referenced by ARN, and an ARN is only a name). |
| `packages/core/src/permissions.ts` | `assessPermissionSet` — the rating shown at approval (I6's other half). |
| `packages/core/src/tagWriteActions.ts` | The tag-write detector + per-service conditioning table (I2's precondition), moved here 2026-09-02 so the compiler and the rating read ONE table (the birthActions.ts pattern; rating-reconciliation.md fix 4). Content changes here are mechanism changes exactly as they were inside policy.ts. |
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
| **Filesystem** — reading `~/.aws/credentials` directly | **Closed for every listed poppy (2026-08-20).** A backend declaring `backend.isolation: "strict"` runs under the runtime's permission model and is denied every path outside its own three (below). Every first-party poppy with a backend now declares it (see below), and an unconfined backend is refused at listing review (RUNTIMES.md R7). **Since 0.3.5 the field itself defaults to `"strict"`**: omitting it confines the backend, and running unconfined requires writing `"isolation": "none"` deliberately. Three independent gates then refuse that: the manifest validator exits non-zero, the submissions API rejects the listing server-side (re-reading the manifest from the uploaded bytes), and the mechanical update review refuses a `strict`→`none` downgrade. The host additionally logs an explicit unconfined-start warning. **Since 0.3.6 the HOST verifies it too**, on the bytes it extracted rather than on the bytes a reviewer read: a catalog install whose manifest asks to run unconfined is refused at install time unless the *listing* carries `allowUnconfined` (the sanctioned migration, granted by a reviewer — a package cannot declare its own exemption). The one sanctioned exception is a named, one-release data migration (docs/CONFINEMENT.md). |

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

**The migration is DONE (2026-08-20) — every listed first-party poppy with a backend is
confined in production.** The three classes of work it took (the full record, per poppy and
per release, is `docs/CONFINEMENT.md`):

1. **The local `~/.aws` credential plane retired.** MailPoppy's backend read and wrote
   `~/.aws/credentials` (`awsProfile.ts`) — benign in intent, precisely the capability this
   removes, and proof the concern was never hypothetical. In the container the route now
   refuses plainly, two fromIni-only paths (the IMAP import, the capability probe) resolve
   broker-first, and every existence probe survives the permission model's throwing
   `existsSync`.
2. **State moved into `bootstrap.dataDir`** — with one-time, idempotent, unconfined
   *migration releases* first, because pre-confinement state in the user's home can only be
   copied out by an unconfined run (MailPoppy's ledger — an input to teardown correctness —
   and buyer id; VM-Poppy's SSH keys and configs; VPN-Poppy's device keys and the
   teardown-sweep region pointer). Pattern: ship the migrator, gate on one run, flip the flag.
3. **Every write to the user's folders replaced** by the one-shot `/local-download/<token>`
   handoff (`http.ts`, `/ext-dl/:id/local-download/:token`) — the system browser does the
   saving. Files come *in* through the frontend's OS picker (sandboxes gate downloads, not
   pickers — the user hands the poppy one file; it never browses their disk).

Fleet state at 2026-08-20: CrewPoppy 0.9.3, MailPoppy 0.1.17, VM-Poppy 0.1.12,
TrafficPoppy 0.2.4, LiveOpsPoppy 0.3.2 — all `strict`, all listed with `minHost 0.3.1`
(the first host that honours the flag; an older host would ignore it and run the poppy
unconfined, so the listing refuses to install there). VPN-Poppy 0.1.8 is the last live
migrator; its strict 0.1.9 is staged.

**And the requirement is enforced, not aspirational (R7):** the mechanical update review
hard-refuses a confinement *downgrade* and never auto-publishes an unconfined backend
(human review is the sanctioned migration exception); the admin approve route verifies the
package and refuses a first listing with an unconfined backend; and the user-facing audit
prompts — updates *and* first installs — command the user's own AI agent to check the flag
and treat its absence as grounds for DO NOT INSTALL.

**What this is not.** It is a runtime barrier, not an OS one, and it covers `node22` backends
only — a `runtime: "native"` backend is an arbitrary binary, which is why the manifest
validator rejects `isolation: "strict"` on one rather than pretending. Real OS sandboxing
(macOS App Sandbox / `sandbox-exec`, Windows AppContainer, Linux bubblewrap+seccomp) is
stronger, needs a launcher per platform, and is not done.

**The stronger answer is fewer backends.** A poppy's frontend already runs in a sandboxed
iframe with no filesystem, no processes and no environment — for a frontend-only poppy this
whole section is moot. A backend should be an exception a poppy justifies, not the default.
**The manifest defaults were flipped in 0.3.5**: `backend.runtime` now defaults to `"node22"`
and `backend.isolation` to `"strict"`, so a poppy that never thinks about confinement gets the
confined combination rather than the opaque one (it was `"native"` + unconfined while the
pre-confinement fleet migrated — see `docs/CONFINEMENT.md`). What remains is that the
fact a poppy ships a backend at all is **still not surfaced in the risk rating** — a user
approving a connection sees a careful breakdown of AWS grants and no mention that native
code is about to run on their machine. For this threat that line matters more than any
single grant.

### 6.1.1 What holding the operator key grants — template v4 (2026-08-29)

§6.1 is about *where* the key lives; this is about *what it is worth if taken*. The two are
independent — a key can be perfectly stored and still be over-powered — and the second is
what template v4 (`TEMPLATE_VERSION = 4`, `role-template.ts`) addresses. Full detail:
`docs/specs/operator-key-least-privilege.md`.

Before v4 the operator IAM user was **two doors, and only one had a guard**. It could
`sts:AssumeRole` the broker role (where the five Deny guardrails and the boundary apply) —
*and* it carried, directly on the user, account-wide `cloudformation:DeleteStack` plus an
S3/DynamoDB/Cognito/Lambda/Logs/SES/EventBridge delete set. Those direct powers sat on the
*user*, where no guardrail is written, so a stolen key could destroy resources without ever
touching the role the whole mechanism is built to police.

v4 collapses that to one guarded door. It does **not** touch I1–I6, the guardrails, or the
boundary; it changes the operator user and the role's trust policy only:

- **Operator inline policy → assume-only.** `MonitorAndTeardown` + `HostResidualCleanup` are
  removed from the user and now travel as the **session policy** of a broker-role session
  (`maintenance.ts`) — identical effective permissions for the host's own housekeeping, but
  every use now passes the guarded door and is bounded by I1 (narrowing-only) like any other
  session. What remains on the user: assume the broker role, `GetCallerIdentity`, and
  `SelfRevoke`.
- **`SelfRevoke` — the kill switch.** The operator may delete *its own* access key and
  nothing else. Self-DoS only: no `iam:CreateAccessKey` is granted anywhere, so a revoked
  key can never be replaced except by re-running setup with elevated credentials. It is a
  direct operator call because through the role it would (correctly) be refused by
  `CannotTamperWithAgentsPoppy`; the operator user carries no boundary and no Deny, so the
  single Allow suffices.
- **Trust policy → conditioned, two hops.** *HopOne* admits only the operator user's
  **long-term** key (`aws:PrincipalArn` = the operator user, `Null aws:TokenIssueTime` =
  true). The `TokenIssueTime` clause is load-bearing: `sts:GetSessionToken` needs no
  permission and cannot be denied by policy, so without it a thief could pre-mint up to 36 h
  of temporary sessions that survive deleting the key — the clause refuses every temporary
  credential, which is what makes the kill switch *terminal*. *HopTwo* admits the broker
  role re-assuming itself (`aws:PrincipalArn` = the role ARN — the documented value for an
  assumed-role session; the session ARN is explicitly **not** it). The existing
  tag-conditioned `PoppySessionCannotReAssumeTheBrokerRole` Deny is unchanged and is what
  still stops a tagged poppy session re-entering to shed its scope.

This narrows the mechanism; it relaxes nothing. Because the host's own housekeeping now runs
as a broker-role session, it is **subject to** the same guardrails and narrowing as a poppy,
where before it ran outside them.

### 6.2 Reviewed bytes and installed bytes are the same bytes

A checksum proves an archive did not change between review and install. It does **not** prove
that both sides read the same thing *inside* it, and two places got that wrong.

**Duplicate entry names.** A ZIP may legally name the same file twice. The reviewer searched the
entry list and took the first `extension.json`; the host's extractor wrote every entry in turn,
so the last one landed on disk. One archive, one sha256, two manifests — the reviewed one
`strict`, the installed one `none`. Both readers now **refuse** an archive that names any file
more than once (`store-zip.mjs`, `extensions/zip.ts`). In the extractor the check is a pre-pass
over the central directory, deliberately: refusing part-way through leaves earlier entries
already written, and the attacker chooses the order.

**Per-platform packages.** A listing may declare one package per platform. Both server-side
gates resolved `packages["any"] ?? first`, while the host resolves
`packages[<platform>] ?? "any"` — opposite ends. `{ any: clean, darwin-arm64: hostile }` was
reviewed clean and installed hostile on every Mac. Submission and admin approval now verify
**every** package a listing declares, and an update auto-publishes only if all of them pass.

**The install-time backstop.** Neither of the above is the last line. The host re-checks
confinement against the manifest it actually extracted, so the refusal does not depend on a
reader catching the trick. Authority for the one exemption sits on the listing
(`allowUnconfined`), never in the package — a package that can declare itself exempt is not
gated at all.

## 7. Change history

- **2026-08-29 (operator key least privilege — template v4)** — the operator IAM user was two
  independent powers: assume the broker role (guarded), *and* a direct account-wide
  `cloudformation:DeleteStack` + multi-service delete set written straight onto the user,
  where no guardrail reaches. A stolen key could destroy resources without ever touching the
  policed role. v4 makes the user **assume-only**: the two cleanup statements moved to the
  broker role's session policy (`maintenance.ts`), so the host's own housekeeping is now
  bounded by I1 like any poppy; the only remaining IAM power is `SelfRevoke` (delete its own
  key — the kill switch, self-DoS only, no replacement possible without re-setup). The trust
  policy gained two conditions: HopOne pins the caller to the operator user's **long-term**
  key (`Null aws:TokenIssueTime = true` refuses every temporary session, which is what makes
  key revocation terminal against an un-forbiddable `GetSessionToken` pre-mint), HopTwo
  admits the role's own re-assume by role ARN. **Touches no invariant, no guardrail, no
  boundary — it removes standing power and tightens trust, nothing is relaxed.** Found by the
  founder asking whether the key saved on disk could be better protected. `TEMPLATE_VERSION`
  3 → 4. `aws/role-template.ts`, `aws/maintenance.ts`, spec
  `docs/specs/operator-key-least-privilege.md`. §6.1.1.

- **2026-08-27 (fault A — the boundary protects itself)** — `CannotTamperWithAgentsPoppy`
  denied `iam:*` on the broker role and the operator user, and **not on
  `policy/AgentsPoppyBoundary`**. Once step 3 caps every poppy-created role with that
  boundary, whoever can call `iam:CreatePolicyVersion` on it raises the ceiling for all of
  them at once — and could do so **now**, while the policy is still inert and nothing depends
  on it, leaving the trap already set when the requirement turns on. A ceiling the thing
  beneath it can rewrite is not a ceiling. The boundary is now the third resource in that
  Deny, which the boundary itself repeats — so a role created *under* the boundary cannot
  lift it either.
  `iam:*` rather than an enumerated mutation list is deliberate: an allowlist goes stale the
  moment AWS adds an action, and this is the policy that protects every other protection. It
  costs nothing legitimate — attaching a boundary is authorised against the ROLE being
  created, not against the policy; nothing in AgentsPoppy reads the boundary at runtime; and
  the bootstrap stack is deployed with SETUP credentials, never with this role.
  `TEMPLATE_VERSION` 2 → 3. No shipped poppy declares any `iam:CreatePolicy*` action today
  (checked: MailPoppy and CrewPoppy declare `CreateRole` on name-scoped ARNs only), so there
  was no live exploit — but nothing prevented the next manifest from asking. **Found by the
  founder asking whether `iam:CreatePolicy` in the setup policy was dangerous.** It was not
  (that grant is pinned to one ARN, held by a human, and its holder can already rewrite the
  broker role's guardrails directly) — but the question was aimed one resource away from a
  real hole. `aws/role-template.ts`.

- **2026-08-27 (fault A, step 1 — detection, and three defects an adversarial review found)** —
  the second half of step 1: the app now READS the deployed `TemplateVersion` and tells the user
  when their broker role is older than the one this build ships. Without it the whole versioning
  exercise was inert — a guardrail tightened here changes nothing in a user's account until they
  re-apply, and nothing asked them to. `aws/setup-version.ts` (pure, fail-safe: an unreadable
  version is **unknown, never current**, and `absent`/`pending` stay silent so the banner never
  nags someone with no setup or one mid-deploy), `aws/bootstrap.ts::readSetupStack`,
  `service.getSetupStatus`, `GET /aws/setup-status`, `app/components/SetupUpdateBanner.tsx`.
  **A user-facing message was corrected, not just added**: re-applying with the everyday operator
  key hits AccessDenied, and that was translated into a flat *"there's nothing to set up"* — true
  for someone re-running out of caution, and exactly backwards for someone who followed the new
  banner here. It now answers against the deployed version.
  **Also fixed: step 1 shipped a live blocker.** The template gained an `AWS::IAM::ManagedPolicy`
  and the least-privilege access policy has no `iam:CreatePolicy`, so every user who followed the
  project's own advice would fail their next re-apply. Admin users never see it — which is why it
  shipped. Now granted (pinned to `policy/AgentsPoppyBoundary`) with a tripwire that fails when
  any IAM resource in the template lacks a matching create grant, plus one that fails when the
  policy README stops describing what the policy actually grants.
  **An adversarial review then confirmed three defects, each reproduced, and each a violation of
  a stated principle rather than a nitpick:**
  (1) the banner's default loader was a new closure per render *and* an effect dependency —
  ~11,500 CloudFormation-backed calls in 300 ms, enough to throttle the account into the very
  "couldn't check" state the module exists to avoid, and fast enough that "Not now" was undone
  before the click finished. Every test had injected a stable loader, so none saw it;
  (2) an update CloudFormation ROLLED BACK resolved as success, because `UPDATE_ROLLBACK_COMPLETE`
  is a fine state to *find* a stack in and the same set was reused as the verdict on an update we
  had just started. The affected population is exactly the least-privilege cohort above: their
  `cloudformation:UpdateStack` is permitted, so the API call succeeds and AWS fails asynchronously.
  It now fails loudly and names the missing grant;
  (3) "Update setup" was a silent no-op whenever the setup stack lives in a region other than the
  account's — the join branch returned the existing stack untouched and reported success, so those
  users had **no path through the app to their own guardrails**. The template is now re-applied
  where the stack actually lives; a machine whose credentials may not update it is still connected
  but says so (`setupNotUpdated`) instead of claiming success.
  ⚠️ **Migration:** anyone holding a pre-boundary copy of the access policy must re-copy it before
  their next re-apply. `docs/specs/broker-role-v2.md`.

- **2026-08-26 (fault A, step 1 of 3)** — groundwork for closing the IAM escalation path.
  A poppy that may create roles named `MyPoppy*` can write `*:*` onto one, pass it to a
  Lambda and invoke it; that Lambda runs as a **new principal**, so none of the broker
  role's Denies reach it, it carries no attribution tag so I4's sweep never sees it, and it
  **survives revoking the connection**. Three shipping poppies declare that grant
  legitimately, so a reviewer cannot tell an honest manifest from a hostile one.
  The template now ships `AgentsPoppyBoundary` — **deliberately inert**: requiring it before
  every poppy references it would break their deploys, and referencing it before it exists
  fails the other way, which is why this is three steps. It repeats the guardrails rather
  than being a bare `Allow *:*`, because a boundary is evaluated independently of the role
  that created the role. Also added: a `TemplateVersion` output (nothing recorded what was
  deployed, so "re-apply setup" was a button nobody knew to press) and a Deny on a poppy
  session re-assuming the broker role — conditioned on the principal already carrying
  `agentspoppy:app`, because the vend's own second hop re-assumes that role and an
  unconditioned Deny would break every credential issued.
  **Two of the spec's three proposed Denies were dropped on contact with the code**: the
  `agentspoppy:` tag-key Deny is superseded by the compiler-side tag-adoption fix (no
  re-apply, already shipped) and would have broken CrewPoppy; and "deny attaching a policy
  that grants `*:*`" is **not expressible** — IAM conditions match a policy's ARN, never its
  contents. That gap is what the boundary itself closes at step 3.
  `aws/role-template.ts`, `docs/specs/broker-role-v2.md`. Still to build: version detection
  and the banner. Steps 2 and 3 need a re-apply from every user.

- **2026-08-26 (canary)** — the tag-adoption rule PROVEN against real AWS, and tightened by
  the run. Both branches pass: a poppy can tag what it creates and re-tag what it owns, and
  cannot claim a resource carrying another app's tag — verified live on EC2 and Cognito, all
  fixtures deleted afterwards. The run also overturned a documented assumption: AWS populates
  `aws:ResourceTag` with the SUBMITTED tags during a tag-on-create, so for Cognito the
  claim-if-unclaimed statement never authorised a single create. Its only effect was to
  permit claiming an UNTAGGED resource, which the same run confirmed worked. Removed:
  Amplify and GuardDuty were proven the same way later the same day and moved too, so
  **all four services now have no residual gap**. GuardDuty needed a detector enabled
  briefly (founder-authorised, deleted immediately, account verified back to none, and
  MailPoppy's separate malware-protection plan confirmed untouched — the two are different
  GuardDuty features, and conflating them nearly caused this run to be skipped on a false
  premise). The weaker `request-tag` shape stays in the compiler as the place a
  newly-added service sits until it has had the same run; nothing uses it today.
  Also closed a bypass found while preparing to publish: an id-prefix scope
  (`instance/i-*`, `userpool/eu-west-1_*`) matches everything of its type while reading as a
  name pattern, and so skipped the rule entirely. For a proven service the scope no longer
  decides — tag writes are conditioned always, and the name is a bonus rather than the
  protection. `aws/policy.ts`, `docs/specs/tag-adoption-canary.md`.
- **2026-08-26** — tag adoption closed in the compiler (`docs/specs/tag-adoption.md`).
  I2 says an app may touch only what carries its own tag; six of seven shipped poppies
  could also WRITE that tag on every resource of some type, so the guarantee was
  self-defeating. VM-Poppy was the complete chain — `ec2:DescribeInstances` on `*` to
  enumerate, `ec2:CreateTags` on `*` to claim, then `TerminateInstances` under its
  tagged-as-self grant. An unnarrowed tag write now compiles to conditioned statements:
  EC2 uses `ec2:CreateAction`, which authorises tagging only as the tagging half of a
  create the poppy is making and so removes the claim path entirely; cognito-idp,
  guardduty and amplify use claim-if-unclaimed plus re-tag-your-own. **Both halves are
  load-bearing** — CloudFormation issues tag updates as deltas that do not restate
  `agentspoppy:app`, so the second allow is what keeps every release working; shipping
  only the first would have reproduced CrewPoppy's 30 July rollback for every user, which
  is also why this REPLACES fault F's proposed blanket deny on `agentspoppy:*` tag writes.
  Services are listed per-service because a condition key a service does not populate is a
  permanent deny (s3:PutBucketTagging supports neither, and must stay name-scoped);
  anything unlisted is refused at compile time rather than guessed at. Name-scoped and
  `tagged-as-self` tag writes are untouched — they were already confined.
  Compiler-side only: no bootstrap re-apply, no manifest change, no re-consent.
  `aws/policy.ts`. **Shape is unit-tested; AWS's evaluation of the conditions needs a
  canary deploy per service before rollout.**

- **2026-08-26** — faults C and E from the 16 August adversarial review closed
  (`docs/specs/scope-policy-and-rating.md`).
  **C:** `ensureScopePolicyDoc` reused a managed scope policy whenever one already
  occupied the content-addressed name, without reading it. Every input to that name is
  known to a poppy in advance, so a poppy holding `iam:CreatePolicy` could plant
  `Allow *:*` there and have its own next vend bound to a document it wrote. The broker
  now reads the policy's **default version** (a `CreatePolicyVersion`+`SetAsDefault` swap
  leaves the policy object intact, so checking mere existence would miss it), compares it
  semantically, and **refuses the vend** on any mismatch — including when the read itself
  fails, because unverifiable is not distinguishable from hostile. It never repairs:
  deleting an impostor is racy, and destroying a customer's IAM policy on a false positive
  is worse than stopping. Needs no new IAM permission — `iam:GetPolicy`/`GetPolicyVersion`
  fall outside all four broker-role denies — so it reaches every account on app update
  with no re-apply. A narrow time-of-check race remains, closed by the fifth deny
  guardrail shipping with fault F.
  **E (this is the I6 half):** the rating classified actions by an UNANCHORED substring
  search, so `ec2:TerminateInstances` rated as a read and `ec2:GetConsoleOutput` rated
  destructive on the "put" inside "Output"; and any scope that was not literally `"*"`
  counted as confined, so `arn:aws:iam::*:role/*` was described as *"cannot touch any IAM
  resource with a different name"* and passed `isFullyAttributable`. Now: anchored verb
  classes, explicit dangerous/secret-read action sets, unknown verbs defaulting to
  mutating, the new `launch` class, `scopeIsUnbounded()`, and `CONTROL_PLANE` consulted
  for every grant rather than only wildcard ones. Ratings get **stricter**: no grant is
  refused that was allowed before and no compiled policy changes, but
  `hasUnscopedGrants` seeds `supervised` for NEW connections, so CrewPoppy and
  TrafficPoppy now start supervised. `aws/sts.ts`, `core/permissions.ts`, and the
  connection-detail labels, which would otherwise have shown "Create only" beside a red
  badge on the same card.

- **2026-08-20** — §6.1's filesystem channel CLOSED fleet-wide. Every listed first-party
  poppy with a backend runs `isolation: "strict"` in production (per-poppy record:
  `docs/CONFINEMENT.md`); RUNTIMES.md R7 makes an unconfined backend a listing
  refusal, enforced server-side in the mechanical update review and the admin approve
  route (`agentspoppy-web`); the update AND new first-install audit prompts command the
  user's AI agent to verify the flag (`app/src/lib/updateAudit.ts`); `UpdatePreview`
  carries `installedIsolation` so a strict→none downgrade is visible to the agent.
  hello-poppy and the developer docs (AGENTS.md, STARTER_PROMPT.md) now model strict as
  the shape a poppy is built in.
- **2026-08-24** — §6.2 added. Both zip readers refuse duplicate entry names, both submission
  gates verify every declared per-platform package, and the host re-checks confinement on the
  manifest it extracted (exemption via the listing's `allowUnconfined`, not the package). Closes
  a route by which a package could be reviewed as confined and installed unconfined under a
  matching sha256. `extensions/zip.ts`, `extensions/directory.ts`, `store-zip.mjs`, the
  submissions and admin-approval routes.
- **2026-08-10** — §6.1 added. `poppyEnv()` strips the whole `AWS_*` namespace (and any
  inherited `NODE_OPTIONS`) from every spawned backend's environment; before this, a poppy
  launched from a shell holding `AWS_ACCESS_KEY_ID` inherited the operator's long-lived key
  outright. `BackendBootstrap.dataDir` added, and `backend.isolation: "strict"` confines a
  `node22` backend to {install dir, data dir, tmp} with child processes denied — opt-in at
  the time, while the existing fleet still kept state in the user's home. `extensions/backend-host.ts`.
- **2026-08-24** — the confinement migration completed, so the defaults were flipped:
  `backend.runtime` → `"node22"` and `backend.isolation` → `"strict"`. Omitting either now
  yields the confined combination; unconfined is reachable only by declaring
  `"isolation": "none"`, which the manifest validator (exit 1), the submissions API and the
  mechanical update review each refuse, and which the host logs loudly if it ever starts.
  Shared `effectiveRuntime`/`effectiveIsolation` helpers apply the defaults in ONE place so the
  spec, the validator and the host cannot drift. `extension-sdk/src/manifest.ts`.
- **2026-07-23** — I3 added (birth-tag-enforced creates, `aws:RequestTag` condition) and
  the create/mutate split introduced in `statementForGrant`, fixing the create-always-
  denied defect found live by TrafficPoppy (acm:RequestCertificate). Commit `6ed3108`.
- **(earlier)** — Ownership pinned to `agentspoppy:app` (I5) replacing the connection-id
  pin, so footprints survive connection supersedes.
