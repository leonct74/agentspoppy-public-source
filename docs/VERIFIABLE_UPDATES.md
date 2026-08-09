# AgentsPoppy — Verifiable Poppy Updates (design)

> Status: **design**. The update *mechanism* (one‑click apply) ships in the MailPoppy
> reference implementation today; the *verification* layer described here is proposed,
> staged in the roadmap at the end. Nothing in this document should be marketed as
> shipped until its roadmap item lands. See the calibration note in §9.

A poppy runs code in the **user's own cloud**. An update therefore changes the user's
own infrastructure — it is not a passive app refresh. Asking the user to trust a
one‑line "what's new" before we mutate their account is not good enough.

The thing that makes a better answer possible is a rule AgentsPoppy already imposes:
**to be approved, a poppy must have an open repository.** That public source is the
substrate this design stands on. If the source is open, an update can be made
*auditable* — the user, or **the user's own AI agent**, can independently check what an
update does, and (with reproducible builds) prove that the artifact being deployed is
exactly that open source.

This extends the [ARCHITECTURE](./ARCHITECTURE.md) principle *"trust by auditability"*
from the **running code** to the **update pipeline**.

---

## 1. Principles

- **The user gates every update.** No silent auto‑apply, ever. The whole point is to put
  a human (optionally advised by their agent) in front of the change.
- **Describe, then prove.** An update carries a human description *and* the machine facts
  needed to check that description against the open source.
- **Verify against the open repo, not against us.** A verifier needs only the public
  repository and a well‑formed prompt — never any privileged access, and never our word.
- **Calibrate the claim.** "Openly auditable" (Layer 1) and "reproducibly / cryptographically
  verifiable" (Layer 2) are different guarantees. We use the weaker language until the
  stronger layer actually ships.

## 2. Threat model

**In scope — a bad update:** a malicious or compromised release that tries to exfiltrate
data, plant a backdoor, silently weaken a security setting, request broader IAM, or ship
code that simply does not match its stated description or the public repo.

**Trust roots (out of scope):** the user's own machine, AWS itself, and the user's own
agent. And the honest recursion: any guarantee bottoms out at *"the poppy binary that
reports these facts is itself built from the open source."* A binary that lies about its
own manifest defeats Layer 1. That is why the strong guarantee (Layer 2) must extend
reproducibility to **the poppy/host binary too**, not just the deployed artifact.

## 3. Two questions, very different difficulty

An update is ultimately one artifact — for MailPoppy, a Lambda bundle that is already
**content‑addressed** (its filename *is* its hash: `lambda-code-<sha>.zip`). Verifiability
means answering two separable questions:

1. **What does this update do?** → audit the *source*. Tractable today: the repo is open,
   so a diff `A..B` is readable by a human or an agent.
2. **Is the deployed artifact actually built from that source?** → *provenance*. Hard:
   requires reproducible builds so the artifact hash can be recomputed from source.

Layers 1–3 below map onto these.

## 4. Layer 1 — Transparency (openly auditable)

At **build time**, emit an **update manifest** next to the code:

```jsonc
{
  "poppy": "mailpoppy",
  "repo": "https://github.com/leonct74/mailpoppy",
  "commit": "34d2161…",            // the source this build came from
  "artifact": "lambda-code-7099a2cf….zip",  // content hash of the deployed bundle
  "changed": [                      // per-file provenance
    { "path": "lambdas/src/inbound-processor.ts", "sha256": "…" }
  ],
  "changelog": "Honest 'Uncategorised' + lighter body-only reading copy…",
  "builtAt": "2026-07-06T…Z"
}
```

The app records the **deployed** commit (e.g. as a CloudFormation stack tag) at every
deploy/update, so `from → to` is always known. Then, **before** the Apply button, the
panel shows:

- the human changelog;
- **Source: `repo@to` (diff from `from`)** with a one‑click **View diff** deep‑link
  (`.../compare/<from>...<to>`);
- the list of changed files with hashes.

And a **"Verify with your AI agent"** action that copies a **self‑contained audit prompt**
(see §6). The user pastes it into their own agent; the agent reads the *public* diff and
reports back.

**Guarantee at this layer:** *openly auditable.* A dishonest description is catchable
because the code is public and the diff is right there. What Layer 1 does **not** prove
is that the bytes being deployed equal that source — that is Layer 2.

## 5. Layer 2 — Provenance (reproducible / cryptographically verifiable)

Make the build **reproducible**: from `source@commit`, anyone (including the agent) can
rebuild the bundle and get the **same hash** as the `artifact` in the manifest. A match is
a cryptographic proof that the deployed artifact is that open source — no trust in us
required.

Requirements (each is real work):

- **Deterministic archive** — sorted entries, fixed permissions, a fixed mtime
  (`SOURCE_DATE_EPOCH`), no embedded absolute paths.
- **Pinned toolchain + lockfile** — pinned Node, pinned bundler (esbuild), committed
  lockfile; the bundler invoked with deterministic options.
- **No build‑time nondeterminism** — no timestamps, random ids, or machine paths baked
  into output.
- **The trust root** — the poppy/host binary that *reports* the hash must itself be
  reproducibly built and independently rebuildable, or it can lie about everything above.
  Only once this holds is *"cryptographically verifiable"* an honest phrase.

**Status — the deployed backend is shipped; the host binary is not.** In MailPoppy the
Lambda backend (the code that runs in the *user's* cloud) now meets the first three bullets:
esbuild is exact‑pinned, deps are lockfile‑pinned, and the zip is written by a small,
audited, dependency‑free deterministic writer (sorted, `0644`, fixed UTC mtime, **STORED /
no compression** so there is no zlib‑version variance). A verifier reproduces every hash
from source with one command (see §7). The **host/sidecar binary** — the trust root — is
*not yet* byte‑reproducible (it wraps a stock Node runtime + an ad‑hoc code signature), so
the honest system‑level phrase remains *"the backend code is reproducibly verifiable"*, **not**
*"the whole system is cryptographically verifiable."* The host binary is the remaining §10
item.

## 6. Layer 3 — The agent verdict (the audit protocol)

The "Verify with your agent" prompt is self‑contained and needs only the open repo:

> You are auditing an update a program wants to apply to my own cloud infrastructure.
> Poppy: `mailpoppy`. Open repo: `<repo>`. It proposes going from commit `<from>` to
> `<to>`. Claimed description: `"<changelog>"`. Deployed artifact hash: `<artifact>`.
> Please:
> 1. Read the diff `<from>..<to>` in the repo.
> 2. Confirm the code changes **match the description** — flag anything the description omits.
> 3. Flag anything security‑relevant: new outbound network calls / egress, access to
>    credentials or secrets, broader IAM/permissions, changes to how my data is stored or
>    encrypted, or new third‑party dependencies.
> 4. *(If the build is reproducible)* rebuild the artifact from `<to>` and confirm its hash
>    equals `<artifact>`.
> Give a verdict: **apply** / **do not apply** / **needs a human**, with reasons.

The agent gives a **semantic** verdict from Layer 1 ("matches the description, no red
flags") and, with Layer 2, a **cryptographic** one ("…and the bytes provably are this
source"). The **human still clicks Apply.** The agent advises; it does not act.

## 7. Reference implementation — MailPoppy

MailPoppy is the first poppy to carry this, because it already deploys backend code into
the user's AWS:

- **Content‑addressed artifact** — `build-backend-bundle.mjs` produces
  `lambda-code-<hash>.zip`; the hash changes whenever any Lambda handler changes.
- **Update mechanism (shipped)** — `getBackendVersion` compares the bundled key to the
  deployed `LambdaCodeKey` stack parameter; `updateBackendCode` runs a CloudFormation
  `UpdateStack` that changes **only** the code + template and keeps every other parameter
  via `UsePreviousValue` (so an update can't reset a security toggle). Surfaced in
  **Account → Backend**.
- **Layer 1 (shipped)** — `build-backend-bundle.mjs` emits the manifest (§4); the source
  commit is recorded as a `mailpoppy:sourceCommit` stack tag on deploy/update;
  `getBackendVersion` returns the offered manifest + deployed commit; the Backend panel
  renders "what this update is" + "Verify with your agent".
- **Layer 2 (shipped — backend)** — the manifest adds `archiveSha256` (the exact deployed
  zip) and a `build` block (`node`, pinned `esbuild`, `target`, `sourceDateEpoch`, the exact
  reproduce `command`). The archive is written by an audited deterministic ZIP writer
  (`scripts/lib/deterministic-zip.mjs`, unit‑tested); esbuild is exact‑pinned. A verifier
  runs `npm ci && npm run verify:backend -w @mailpoppy/desktop-sidecar -- --expected <manifest>`
  to rebuild from source and confirm every hash (see `apps/desktop/node-sidecar/REPRODUCE.md`).
  The audit prompt gains the reproduce step; the panel shows a "Reproducible build" badge +
  "Copy manifest" + "How to reproduce". **Not yet done:** the host/sidecar binary (the trust
  root) is not byte‑reproducible.

The `UsePreviousValue` safety property is itself something the agent can confirm from the
diff — the audit covers *how* the update is applied, not just *what code* ships.

## 8. Generalizing to any poppy (the SDK story)

Nothing here is MailPoppy‑specific except the artifact type. The ecosystem standard is:

- **A standard manifest schema** (§4) any poppy emits at build time.
- **SDK helpers** so a vibe‑coded poppy gets `emitUpdateManifest()` + a "Verify with your
  agent" affordance for free.
- **The open‑repo approval rule** as the enabler — already required for approval.

This is what makes *"every poppy's updates are auditable — by you or your agent"* a
property of the marketplace, not of one app.

## 9. Honest calibration (do not overclaim)

Consistent with the security‑claims discipline used across AgentsPoppy:

- Layer 1 shipped → say **"openly auditable"**.
- Layer 2 shipped **for the backend** → you may say **"the backend code is reproducibly
  verifiable — rebuild it from source and the hashes match."** Do **not** generalise this to
  the whole app: the host/sidecar binary that reports the hashes is not yet byte‑reproducible,
  so **"the whole system is cryptographically verifiable" is not yet an honest phrase.**
- State the limits plainly: reproducible builds are hard; the trust root is the poppy
  binary itself (still pending); a compromised user machine or a compromised user‑agent is
  out of scope.
- The strongest *honest* argument even at Layer 1 is **legibility**: the code is open, the
  diff is one click away, and an agent will read it for you. Layer 2 adds a **proof** for the
  code that actually runs in the user's cloud.

## 10. Roadmap

1. ✅ **This design doc.**
2. ✅ **Layer 1 in MailPoppy** — manifest + "what this update is" + agent‑audit prompt in the
   Backend panel; record the deployed commit. (mailpoppy `b325be4`)
3. **Layer 2** — ✅ **reproducible Lambda build** (deterministic archive, pinned esbuild,
   `verify:backend`, `REPRODUCE.md`, `archiveSha256` + `build` in the manifest, panel +
   prompt reproduce step); ⬜ **the reproducible host/sidecar binary** (the trust root) —
   still pending. Language upgraded to "the backend code is reproducibly verifiable" only.
4. **SDK + vibe‑coder docs** — the standard manifest + helpers so any poppy adopts it.
5. **Test** — a poppy‑update audit walk‑through end‑to‑end.
6. **Website** — an AgentsPoppy explainer: *how poppy updates are audited*. Marketing‑only,
   calibrated to whatever layer has actually shipped.
