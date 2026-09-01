# Releasing a poppy — first listing, and every update after it

For the AI agent (or human) shipping a poppy. Two different jobs live here, with different
failure modes — do not mix them up:

- **[A. First listing](#a-first-listing)** — proving the poppy deserves to be in the catalog.
- **[B. Shipping an update](#b-shipping-an-update)** — getting a new version to people who
  already installed it, without breaking their trust or their install.

Everything below is mechanical fact about how the directory works, verified against the
broker's real code (`packages/broker/src/extensions/directory.ts`). When an instruction has a
gate, **run the gate** — "it should work" is not a verification.

---

## The three invariants (learn these before either flow)

1. **The catalog is what ships.** A perfect GitHub release that never reaches the catalog is
   invisible — AgentsPoppy reads only the catalog. Conversely, a catalog entry whose package
   URL isn't live yet turns every user's Update button into a failing download. Which leads to:

2. **Order is load-bearing.** Always: publish the package → **verify the live URL serves the
   exact pinned sha256** → then, and only then, the catalog entry. Never the reverse.

3. **The version string is the entire update signal.** `updateAvailable` is
   `installedVersion !== catalogVersion` — plain string inequality:
   - Changing package contents **without bumping the version ships nothing**: no badge, no
     update, and even a forced update short-circuits. There is no content hashing against
     installs — the sha256 only verifies fresh downloads.
   - *Inequality*, not ordering: a dev-installed version **ahead of** the catalog is offered
     the catalog's older version as an "update" (that's the rollback path working as designed
     — don't report it as a bug, and don't leave dev installs on user machines).

---

## A. First listing

The bar is the [AGENTS.md](../AGENTS.md) §10 checklist — all of it. Release-specific gates:

1. **The package contains ONLY your code** (rule R1, [docs/RUNTIMES.md](RUNTIMES.md)):
   no language runtime, no bundled service binaries. A Node backend is an esbuild bundle
   (`backend/index.cjs`) plus `"runtime": "node22"` declared in the manifest's `backend`
   block — the platform provides Node. Gate: the packer rejects embedded runtimes; a correct
   Node-backend package is single-digit-to-tens of MB, and ~100 MB+ means a runtime got in.
2. **`npm run validate-manifest`** passes — the same `parseManifest` the host runs.
3. **`npm run certify`** passes a real deploy → use → teardown cycle (leaves no trace).
4. **Pack with the directory's packer — never `zip`/`ditto`:**
   ```bash
   node <agentspoppy>/scripts/pack-extension.mjs --src <poppy-root> [--frontend <dist-dir>]
   ```
   It writes a deterministic STORE (uncompressed) zip — the sha256 *is* the trust story — and
   prints the catalog entry to submit. A compressed zip is rejected by the installer.
5. **Click-test the packed build in the real host** (install-dev + full app restart). Reading
   the code is not the test. **If you declared `network.machine`, this is where you find out
   whether you declared it correctly** — the host refuses undeclared connections on the real
   spawn path, and a missing host shows up as a failed call in your poppy, not as a warning
   at pack time. Exercise every screen that talks to anything.
6. **Submit through the developer portal** for review. Curated first-party poppies are
   maintained separately by the AgentsPoppy team.

## B. Shipping an update

The whole flow, in order. Steps 1–5 happen in your repo; 6–8 are the publish.

1. **Bump the version** — one notch up, semver (`X.Y.Z`; the catalog validator rejects
   anything else). The single source is `extension.json` unless your repo's own RELEASE.md
   names more files that must stay in sync (some poppies mirror the version in a build
   manifest — grep your repo for the old version string and update every hit that isn't a
   changelog).
2. **Rebuild everything, in dependency order.** If your backend embeds generated artifacts
   (templates, lambda zips), regenerate them BEFORE bundling — a stale embedded artifact
   ships silently and "deploys" old code. Then the backend bundle, then the frontend.
3. **Typecheck + full test suite green.** No exceptions for "docs-only" — you already bumped
   a manifest.
4. **Click-test the changed surfaces in the running host.** Every new control gets a real
   click; a button that looks wired but isn't is the classic escaped defect.
5. **Pack** (same command as A.4). Record the printed sha256.
6. **Publish the package** as a GitHub release on the poppy's repo:
   - Tag `v<version>` pointing at the released commit (so the audit compare link is honest).
   - Attach the packed zip. In the notes: what changed, the compare link
     (`.../compare/v<prev>...v<version>`), and the package sha256.
   - Gate — verify the asset from the outside before going anywhere near the catalog:
     ```bash
     curl -sL <download-url> | shasum -a 256   # must equal the packer's sha256 exactly
     ```
7. **Update the catalog entry** — `version`, package `url`, package `sha256`, and `minHost`
   if the runtime/host requirements changed. External poppies: submit the updated entry
   through the developer portal (same channel as the first listing). **Updates are
   tier-reviewed mechanically, from inside your sha-pinned packages:**
   - An update that asks for **nothing new** — same permission set, same capabilities,
     same teardown, same runtime, same identity — **publishes automatically**, usually
     within a minute. Ship bug fixes as fast as you can write them.
   - An update that **moves the trust surface** (any added grant or action, a widened
     resource scope, a new capability, a teardown/runtime/identity change) is **held for
     human review** — and your currently listed version keeps serving meanwhile, so
     submitting an update never unlists you. State the change and the reason in your
     release notes; unexplained widenings are the main reason updates get rejected.
   - You don't choose the tier and can't argue for one — the manifest diff decides.
     Same-version submissions are refused outright (invisible to every install), and a
     lower version than listed always gets human eyes (rollbacks are deliberate acts).
   Gate — after it's live, fetch the public catalog and confirm it serves your new
   version before telling anyone it's shipped.
8. **Verify the real update path**: on an install of the previous version, the badge appears
   within ~5 minutes; Review shows your compare link; Apply downloads, verifies, swaps, and
   the poppy runs. That last click is the release actually working.

### Update rules that exist to protect your users

- **Never widen the permission set as a side effect.** Grant/capability changes are shown to
  every user as a diff at update time and re-consent is demanded — a "bug fix" that quietly
  adds grants reads as exactly what it looks like. Declare only what the new code calls, and
  say so in the release notes.
- **A new endpoint is a manifest change.** If the update makes your code talk to somewhere it
  did not before — your own API, a third party, a new AWS service — update `network.machine`
  (and `network.egress` if it is the deployed code) in the same release. On the machine plane
  the host *refuses* what you did not declare, so a forgotten host is a broken feature for
  every user who updates; on the cloud plane it is a false statement on their permission
  screen. Adding a host is a declaration change users see and re-approve — that is the point.
- **`minHost` honestly.** If the update needs a newer host (e.g. a shared runtime), set it —
  users on older hosts are then *not shown* the update, which beats offering them a button
  that can only fail.
- **Rollback is a release.** To roll back, re-publish the older version under a NEW higher
  version number. Re-pointing an existing version's URL/sha at different bytes is the one
  thing you must never do — the sha mismatch bricks the update for everyone until fixed.
- Users can audit any update against your open repo before applying ("verify with your AI
  agent"). Write release notes an auditor can confirm — undersell, never oversell.
