# Poppy dependencies — policy + shared-runtime architecture

Status: **SHIPPED.** 0.2.9 (downloader hardening + `minHost`) and 0.3.0 (shared `node22`
runtime) released on all platforms; VPN-Poppy 0.1.4 (3.3 MB) + MailPoppy 0.1.10 (19 MB)
repacked as `node22` and live in the catalog; the web-side R1 gate (§4.8) — `scan-package.mjs`
+ dev-hub docs + Developer Agreement clause — landed 2026-07-25.
Owner: founder decision 2026-07-24 — *"a poppy must declare an external runtime; runtimes are
provided/downloaded by AgentsPoppy, never shipped inside the poppy — anything else is a
security problem."* Generalized the same day with the Redis example: this covers **any
third-party dependency**, not just language runtimes — *"if the poppy requires a Redis
database, it shouldn't be the poppy to ship the Redis runtime, because the user cannot verify
the provenance; it should declare it as a dependency, the user approves it after
installation, and AgentsPoppy downloads it from the official source."*

---

## 1. The problem, measured (VPN-Poppy 0.1.3 case study)

| Piece | Bytes | Share |
|---|---|---|
| darwin-arm64 package zip | 115,535,509 | 100% |
| `backend/vpnpoppy-sidecar` (Node SEA) | 115,298,928 | 99.8% |
| … of which the poppy's own code (esbuild bundle incl. AWS SDK) | 3,198,992 | **2.8%** |
| frontend + manifest | ~235,000 | 0.2% |

~97% of the package is a private copy of the Node.js runtime (V8 + full ICU + OpenSSL +
libuv). Meanwhile the **container already ships Node**: the broker binary
(`app/src-tauri/binaries/agentspoppy-broker-*`) is a 118 MB Node SEA — and it is the *parent
process* of every poppy backend. Every Node poppy re-downloads what its own parent already is.

Concrete damage (all observed live 2026-07-24):
- The 110 MB download exceeds what the broker's plain `fetch()` → `arrayBuffer()` path
  (`packages/broker/src/extensions/directory.ts::httpFetchBytes`) survives on real
  connections → the perpetual "update available / update fails" loop on VPN-Poppy 0.1.3.
- Installs are slow; every poppy update re-ships an unchanged runtime.
- The package is dominated by an opaque binary — see §2.

## 2. Threat model — why bundled runtimes are a *security* problem

1. **The audit story breaks.** The marketplace pitch is: open repo, users' AI audits the
   source, the catalog-pinned sha256 ties the download to the listing. But sha256 pins bytes
   to *whatever the developer uploaded* — a 110 MB SEA binary cannot be diffed against the
   open repo. A ~3 MB JS bundle can (rebuild from the repo → compare).
2. **Dependency provenance.** A developer-built runtime can be a trojaned Node (patched
   TLS, weakened crypto, exfiltrating stdlib) — and the same holds for any bundled
   dependency: a poppy that ships "Redis" ships bytes *nobody can trace to redis.io*.
   Review and certify cannot detect a modified runtime embedded in a SEA. When the
   *platform* pins the dependency and the bytes come from the *official upstream*, this
   class vanishes: the developer never touches the dependency bytes at all.
3. **Patch lag.** N poppies × N private runtimes = N stale copies when a Node CVE lands.
   One shared runtime = one container update fixes everyone.

Conclusion: **runtime provisioning is the platform's job. Poppies declare; they never ship.**

## 3. Policy (the enforceable rules)

- **R1 — No bundled third-party dependencies.** A poppy package MUST NOT contain a
  language runtime (Node, Python, Electron, JVM, .NET…) **or a bundled service binary
  (Redis, Postgres, ffmpeg…)**. Detected mechanically: the Node SEA fuse sentinel
  (`NODE_SEA_FUSE_` string), known runtime/service signatures, and size caps.
- **R2 — Declare, don't ship.** A backend declares what it needs in the manifest:
  `backend.runtime` (§4.1) and, later, `backend.dependencies` (§4.4). Absent → `"node22"` (it was
  `"native"` before 0.3.5, while the pre-confinement fleet migrated)
  (a small self-contained binary of the developer's *own* code, size-capped).
- **R3 — Dependencies are provisioned by AgentsPoppy, from official sources.** Either
  *embedded* in the signed container (v1: `node22` = the broker's own runtime) or
  *downloaded by AgentsPoppy from the dependency's official upstream* (nodejs.org,
  redis.io…), verified against a curated pin manifest (name → version → official URL →
  sha256) **compiled into the signed container**. The poppy never supplies a URL and the
  catalog never supplies a sha for dependencies — a catalog or listing compromise must not
  become a dependency compromise. Provenance chain: official upstream bytes + platform-pinned
  integrity + user consent; the poppy developer never touches the dependency bytes.
- **R4 — User consent.** The install/update consent screen states every dependency.
  `node22`: "runtime already included — nothing extra is downloaded." A downloadable
  dependency: explicit approval showing name, version, size, and the official source it
  will be fetched from. No dependency bytes ever land without the user approving them.
- **R5 — Enforced at three gates.** `certify` (developer machine — fails the run) →
  submission review (hard reject; admin `scan-package` script) → broker (minHost gate +
  package-size guard at install).
- **R6 — Size caps.** Listing rules: reject packages > 25 MB (native poppies may request an
  exception with justification); expected Node-poppy size ≈ 3–5 MB. Broker
  `MAX_PACKAGE_BYTES` drops 1 GB → 256 MB.
- **Hard-reject from day one.** No third-party poppies are live yet and both first-party
  poppies migrate in the same release — a grace period would protect nobody.
- **R7 — Confined from the user's files (2026-08-20; the default since 0.3.5).** A listing with a
  backend runs confined. `"isolation": "strict"` is what the host applies when the manifest says
  nothing at all, so confinement is what you get by writing no opinion; an unconfined backend has to
  be asked for in writing, with `"isolation": "none"`, and is then refused at listing review anyway —
  and, since 0.3.6, refused again by the HOST at install time, checked against the manifest actually
  extracted from the package. The sanctioned migration exemption is granted on the LISTING
  (`allowUnconfined`, set by a reviewer), never by the package about itself.
  Under strict (which requires `runtime: "node22"`): the host runs the backend under Node's
  permission model — read its install root; write only its `bootstrap.dataDir` and the OS temp
  dir; **no child processes, workers, or native addons** — so `~/.aws/credentials` and the rest
  of the user's home are denied by the RUNTIME, not by convention. Enforced at the same gates as
  R1: the founder review CLI and the mechanical update review refuse a strict manifest whose
  listing `minHost` predates 0.3.1 (an older host silently ignores the flag and runs the poppy
  UNCONFINED — the label would be a lie), and refuse/flag an unconfined backend outright. The one
  sanctioned exception is a **named, one-release data migration** (moving pre-confinement state
  out of the user's home can only run unconfined — the VM-Poppy 0.1.11→0.1.12 pattern), with the
  confined successor identified in the release notes. Every first-party poppy with a backend is
  strict as of 2026-08-20 (CrewPoppy 0.9.3, MailPoppy 0.1.17, VM-Poppy 0.1.12, TrafficPoppy
  0.2.4, LiveOpsPoppy 0.3.2; VPN-Poppy 0.1.9 pending its migrator gate). Migration record:
  `docs/CONFINEMENT.md`.

**Explicitly rejected alternative:** using the *user's system* Node. It may be absent, the
wrong major, or unvetted; running poppy code on an arbitrary PATH interpreter is a support
and security nightmare. The container is the runtime provider, not the user's PATH.

## 4. Architecture

### 4.1 Manifest (`packages/extension-sdk/src/manifest.ts`)

```json
"backend": { "entry": "backend/index.cjs", "transport": "http", "runtime": "node22" }
```

- New optional `runtime?: "node22" | "native"`, default `"node22"` since 0.3.5 (it was
  `"native"` when introduced, matching pre-0.3.0 behaviour).
- Versioned names on purpose: a future `node24` is a *distinct declared value*, so the
  contract between poppy and container Node major is explicit.
- `runtime: "node*"` ⇒ `entry` is a CJS bundle, not an executable.
- `parseManifest` validates the enum; unknown value → validation error.

### 4.2 Broker — shared-Node child host

- **Child branch** at the very top of `packages/broker/src/serve.ts`: if argv contains
  `--poppy-backend <absolute entry>`, load that file via
  `Module.createRequire(entry)(entry)` and never start the broker server. (Documented SEA
  pattern: embedded mains load external CJS via `createRequire`; the poppy bundle only
  requires Node builtins — everything else is esbuild-bundled.)
- **Spawn** (`packages/broker/src/extensions/backend-host.ts::NodeBackendHost.start`): when
  `runtime` starts with `node`:
  - SEA build (`require('node:sea').isSea()`): `spawn(process.execPath,
    ["--poppy-backend", entryAbs], …)` — the broker re-execs itself as the interpreter.
  - Dev (plain `node`/`tsx`): `spawn(process.execPath, [entryAbs], …)` — a real Node can run
    the CJS directly; no flag needed (and plain `node` would reject the unknown flag).
  - SEA argv quirk: in a SEA, `process.argv[1]` is the binary itself; scan from index 1
    for the flag rather than assuming positions.
- **Version gate:** broker checks its `process.versions.node` major satisfies the declared
  runtime (`node22` ⇒ major ≥ 22); mismatch → clear `BrokerError`, never a silent crash.
- **Isolation unchanged:** still a separate OS process (own PID/memory); `liveChildren`,
  `killAllBackends`, `watchParent` apply as-is.
- **Orphan reaper unchanged:** `isOrphanSidecarCommand` matches the extensions-root path
  anywhere in the command line — the entry path in argv satisfies it (verified against
  `reap-orphans.ts`).

### 4.3 Platform-neutral packages

A pure-JS backend is identical on every OS. Add platform key `"any"` to the catalog
`packages` map; broker lookup falls back `platformKey → "any"`. One upload, one sha, and the
win32 `.exe`-resolution hack in `backend-host.ts` becomes irrelevant for Node poppies.

### 4.4 Future downloadable dependencies (design now, build when the first poppy needs one)

Covers both *runtimes* (`python312`) and *services* (`redis7`) with one mechanism:

- Manifest: `backend.dependencies?: string[]` of names from the platform's curated
  registry — e.g. `["redis7"]`. Unknown name → validation error (certify + broker).
- Pin registry **compiled into the broker at build time** (R3): name → version →
  per-platform **official upstream URL** (nodejs.org, download.redis.io…) → sha256.
  AgentsPoppy curates the pins; the bytes come from the official source; the sha check
  makes a compromised CDN/mirror inert.
- Store: `~/.agentspoppy/deps/<name>/` — one shared copy per machine, reused by every
  poppy that declares it (never per-poppy copies).
- Install flow: poppy declares `redis7` → not present → consent card (R4: name, version,
  size, official source) → broker downloads, sha-verifies, unpacks → recorded in the
  transparency ledger like any other mutation.
- **Service lifecycle** (Redis-class deps) is more than a download: the broker must
  start/stop the service per poppy, allocate a loopback port, isolate data dirs
  (`deps-data/<poppy-id>/`), and pass the connection address via the bootstrap env.
  Specced when the first real service-dependent poppy exists — the *policy* (R1–R6) is
  already binding on it.
- v1 ships **only** `node22` (embedded) and zero download machinery. (Precedent for the
  pinned-official-fetch pattern: `vpn-poppy/scripts/build-sidecar.mjs` already
  SHASUMS256-verifies official nodejs.org downloads for its win32 cross-build.)

### 4.5 Catalog compatibility + sequencing

- Entries gain `minHost: "0.3.0"`. An older broker ignores unknown fields (verified) and
  would fail ugly spawning a `.cjs` — so **minHost enforcement ships in 0.2.9, before any
  node-runtime poppy is listed**, and the self-updater converges the fleet first. UI shows
  "Update AgentsPoppy to install this poppy."
- `schemaVersion` stays **1** (broker hard-rejects other values; passes unknown fields).
- Order: **0.2.9** (downloader hardening §4.6 + minHost + lower MAX_PACKAGE_BYTES) → fleet
  auto-updates → **0.3.0** (shared runtime) → repack VPN-Poppy 0.1.4 + MailPoppy as `node22`
  (minHost 0.3.0), update `catalog-seed.json` URLs/shas → web-side policy gates (§4.8).

### 4.6 Downloader hardening (0.2.9 — fixes the live VPN-Poppy bug on its own)

`httpFetchBytes` → stream to a temp file with Range-resume and bounded retries; no fixed
body-timeout wall; enforce `MAX_PACKAGE_BYTES` *while streaming*. This alone ends the
perpetual-update failure for large packages — and stays valuable even after packages shrink.

**Do NOT "fix" size via zip compression:** `scripts/pack-extension.mjs` uses a deterministic
STORE-method writer *on purpose* (byte-reproducible packing → stable shas for the
audit/reproduce story). Deflate would trade determinism for a palliative. Removing the
runtime is the real fix; STORE on a ~3 MB bundle is immaterial.

### 4.7 Build tooling + developer experience

- Poppy build becomes: esbuild bundle → `backend/index.cjs`. **Stop.** No SEA blob, no
  postject, no lipo, no per-arch matrix.
- `validate-manifest` learns `runtime`; `certify` gains a package scan (R1 detection:
  SEA sentinel, entry size, undeclared executables) that FAILS the run.
- hello-poppy template, STARTER_PROMPT, and the dev-hub docs (getting-started, tutorial,
  approval) switch to the declare-a-runtime flow.
- Per-poppy SEA build scripts are retired (kept only as reference for `native` poppies).

### 4.8 Web-side enforcement (`agentspoppy-web`)

- `src/lib/listingRules.ts::checkEntry` **and its lockstep twin
  `scripts/lib/catalog-rules.mjs`**: validate `minHost` format + package size caps.
- New admin review script `scan-package.mjs`: download the submitted zip, scan for the SEA
  sentinel / oversized backend entry / undeclared runtime — run before any approval.
- Developer Agreement + `/developers/approval` + `/developers/privacy`: add the
  no-bundled-dependencies clauses (R1–R4), including the audit rationale and the Redis
  example (declare → user approves → AgentsPoppy fetches from the official source).

## 5. What this wins

- VPN-Poppy package: **110 MB → ~3.3 MB (~33×)**. MailPoppy similar. Installs in seconds.
- Download failures of the 0.1.3 class disappear (and 0.2.9 hardens the path anyway).
- The audit story is real again: the package ≈ the diffable JS the open repo builds.
- One runtime to patch when Node has a CVE — a container release fixes every poppy.

## 6. Trade-offs (stated honestly)

- **Node-major coupling:** poppies now run on the container's Node. Mitigations: the
  versioned `runtime` name is an explicit contract; `certify` tests against the real shared
  runtime; Node majors are strongly backward-compatible for the API surface poppies use.
- **A container release (0.3.0) is required** before any poppy can shrink; hence the 0.2.9
  bridge so nothing breaks mid-transition.
- **Native poppies remain possible** (Go/Rust single binaries) under the size cap — the rule
  targets *re-shipping a runtime the platform already has*, not small self-contained tools.

## 7. Verification plan

- **Unit:** NodeBackendHost runtime branch (Stub specs); serve.ts child branch (fixture CJS
  that opens its assigned port); manifest `runtime` validation; minHost filtering;
  downloader resume against a fake Range server; reaper match on the new command shape.
- **Live:** repack VPN-Poppy as `node22`; install from a staging catalog; connect → mint
  scoped creds → launch endpoint; quit app → child dies (no orphan); update 0.1.3 → 0.1.4
  through the hardened downloader.
- **CI size gate:** packed Node-poppy ≤ 5 MB or the build fails (no silent regressions).

## 8. Rollout checklist

1. **0.2.9:** downloader hardening + `minHost` enforcement + `MAX_PACKAGE_BYTES` 256 MB → release (RELEASING.md).
2. SDK `runtime` field + broker child-branch/spawn/version-gate + certify scan + tests.
3. **0.3.0** release, all platforms.
4. Repack + publish VPN-Poppy 0.1.4 and MailPoppy as `node22` (minHost 0.3.0); update
   `catalog-seed.json`; live-verify install/update/run/teardown.
5. ✅ Web: listing rules (`minHost`) + `scan-package.mjs` (admin R1 gate, shared with
   `review-submission.mjs`) + dev-hub docs (approval/privacy/getting-started/tutorial) +
   Developer Agreement §7 clause (v2026-07-25). — done 2026-07-25.
6. Retire SEA build scripts in first-party poppy repos.
   - ✅ **MailPoppy — done 2026-07-25** (0.1.11): deleted `build-sidecar.mjs` + the
     `build:sidecar`/`build:binary` scripts + the `postject` dep, dropped `externalBin` and the
     `spawn_sidecar`/`tauri-plugin-shell` wiring from the Tauri shell (now dev-only, spawns nothing),
     and rewrote RELEASE.md/README/DESIGN/CLAUDE/REPRODUCE around `build:bundle`. Verified: the
     regenerated `lambdaCodeKey` is **byte-identical** (`lambda-code-a6297b379e842c9b.zip`), so
     deployed customer stacks see no diff; typecheck + 231 desktop tests + 6 core tests + `cargo
     check` all green. Bonus: with no embedded Node/ad-hoc signature the shipped package is now
     **reproducible**, which REPRODUCE.md previously had to disclaim.
   - ✅ **VPN-Poppy — done 2026-07-25** (commit `59cd5ea`): deleted `scripts/build-sidecar.mjs` +
     `build:sidecar` + `postject`, and fixed CLAUDE.md/DESIGN.md. Its script header had drifted into
     a lie — it claimed the `vpnpoppy-sidecar` output was `manifest.backend.entry`, but the manifest
     has pointed at `backend/index.cjs` since 0.1.4. Verified: typecheck + 31 tests, `npm run build`
     → 3.1 MB bundle, validate-manifest OK.
   - **Item 6 COMPLETE — no first-party poppy can build a runtime-embedding package any more.**
