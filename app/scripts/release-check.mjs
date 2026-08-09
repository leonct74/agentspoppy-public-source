#!/usr/bin/env node
// Release pipeline gates for the AgentsPoppy desktop app. Run BEFORE publishing
// (and again with --live AFTER the download page deploys). Encodes the v0.2.0
// postmortem so it can't repeat:
//
//   v0.2.0 shipped signed + notarized + Gatekeeper-accepted, yet its broker
//   crashed on every user's machine (hardened runtime denied V8's JIT memory —
//   the JIT entitlements were missing). All the signature checks passed because
//   they check signatures, not behavior; the behavioral check passed because the
//   crash only manifests on quarantined (browser-downloaded) copies. The ONE
//   deterministic tell was the missing entitlement in the code signature itself.
//
// Gates (each prints PASS/FAIL; any FAIL exits 1):
//   1. version      — tauri.conf.json version matches the DMG filename
//   2. signature    — Developer ID authority + hardened runtime on app AND broker
//   3. entitlements — broker carries allow-jit + allow-unsigned-executable-memory
//                     (the v0.2.0 regression, caught statically and deterministically)
//   4. behavior     — bundled broker starts and answers HTTP (verify-bundle.mjs)
//   5. notarization — spctl accepts the .app; stapler validates the DMG
//   6. [--live]     — the LIVE download page's sha256 matches the LIVE artifact,
//                     and its version matches this build (funnel integrity:
//                     page ↔ GitHub release ↔ what users actually receive)
//
// NOT covered (and not honestly automatable on a dev machine): the quarantined
// first-launch path — Gatekeeper approval state can't be reset without sudo, and
// this machine has cached approvals. The human gate in RELEASE.md stays:
// download the published DMG in a real browser, install, launch, CONNECT AWS.
//
// Usage:
//   node scripts/release-check.mjs                # gates 1–5 on the local build
//   node scripts/release-check.mjs --live         # adds gate 6 (post-publish)

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(readFileSync(`${appDir}/src-tauri/tauri.conf.json`, "utf8"));
const version = conf.version;
const bundleDir = `${appDir}/src-tauri/target/release/bundle`;
const appPath = `${bundleDir}/macos/AgentsPoppy.app`;
const dmgPath = `${bundleDir}/dmg/AgentsPoppy_${version}_aarch64.dmg`;
const brokerPath = `${appPath}/Contents/MacOS/agentspoppy-broker`;
const live = process.argv.includes("--live");
const DOWNLOAD_PAGE = "https://agentspoppy.com/download";

let failures = 0;
function gate(name, ok, detail = "") {
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
function sh(cmd, args) {
  // codesign/spctl print their diagnostics to STDERR even on success — always
  // return both streams or every signature gate false-fails.
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

console.log(`release-check: AgentsPoppy ${version}\n`);

// ── 1. version consistency ───────────────────────────────────────────────
gate("version: DMG filename matches tauri.conf.json", existsSync(dmgPath), dmgPath);

// ── 2. signatures: Developer ID + hardened runtime, app AND broker ───────
for (const [label, path] of [["app", appPath], ["broker", brokerPath]]) {
  const out = sh("codesign", ["-dv", "--verbose=4", path]);
  gate(
    `signature: ${label} signed with Developer ID`,
    /Authority=Developer ID Application/.test(out),
  );
  gate(`signature: ${label} has hardened runtime`, /flags=.*\(runtime\)/.test(out));
}

// ── 3. THE v0.2.0 GATE: JIT entitlements on the Node SEA broker ──────────
const ent = sh("codesign", ["-d", "--entitlements", "-", brokerPath]);
for (const key of [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
]) {
  gate(
    `entitlements: broker has ${key}`,
    ent.includes(key),
    ent.includes(key) ? "" : "Node/V8 will SIGTRAP at startup on quarantined copies (the v0.2.0 bug)",
  );
}

// ── 4. behavior: bundled broker starts and serves HTTP ───────────────────
const beh = spawnSync("node", [`${appDir}/scripts/verify-bundle.mjs`, appPath], {
  encoding: "utf8",
});
gate("behavior: bundled broker starts and answers HTTP", beh.status === 0);
if (beh.status !== 0) console.log((beh.stdout + beh.stderr).trim());

// ── 5. notarization: Gatekeeper + stapled ticket ──────────────────────────
const sp = sh("spctl", ["-a", "-vv", "-t", "install", appPath]);
gate("notarization: spctl accepts the app", /accepted/.test(sp) && /Notarized Developer ID/.test(sp),
  /accepted/.test(sp) ? "" : "run AFTER notarize+staple; skip pre-notarize");
const st = sh("xcrun", ["stapler", "validate", dmgPath]);
gate("notarization: ticket stapled to DMG", /worked/.test(st));

// ── 6. --live: published funnel integrity ─────────────────────────────────
async function fetchRetry(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (res.ok) return res;
      last = new Error(`HTTP ${res.status}`);
    } catch (e) {
      last = e; // transient resets happen on big downloads — retry
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw last;
}

if (live) {
  try {
    const page = await (await fetchRetry(DOWNLOAD_PAGE)).text();
    const pageSha = (page.match(/[0-9a-f]{64}/) ?? [])[0];
    const pageUrl = (page.match(/https:\/\/github\.com\/[^"']+\.dmg/) ?? [])[0];
    gate("live: download page advertises this version", page.includes(`AgentsPoppy ${version}`));
    gate("live: page has a sha256 and a DMG link", Boolean(pageSha && pageUrl));
    if (pageSha && pageUrl) {
      const buf = Buffer.from(await (await fetchRetry(pageUrl)).arrayBuffer());
      const { createHash } = await import("node:crypto");
      const gotSha = createHash("sha256").update(buf).digest("hex");
      gate(
        "live: artifact users download matches the advertised sha256",
        gotSha === pageSha,
        gotSha === pageSha ? `${(buf.length / 1048576).toFixed(1)} MB verified` : `page=${pageSha} artifact=${gotSha}`,
      );
    }
  } catch (e) {
    gate("live: funnel reachable", false, String(e?.message ?? e));
  }
}

console.log(
  failures === 0
    ? `\n✅ all gates passed${live ? "" : " — after publishing, run again with --live"}\n\n⚠ FINAL GATE IS HUMAN and cannot be automated: download the DMG in a real\nbrowser, install to /Applications, launch via Finder, and CONNECT AWS.\n(Quarantined first-launch behavior can't be reproduced by scripts on a\nmachine with cached Gatekeeper approvals — see RELEASE.md.)`
    : `\n❌ ${failures} gate(s) failed — do NOT publish this build`,
);
process.exit(failures === 0 ? 0 : 1);
