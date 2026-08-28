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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(readFileSync(`${appDir}/src-tauri/tauri.conf.json`, "utf8"));
const version = conf.version;
// macOS ships ONE universal binary (Intel + Apple Silicon) so a user never has to know
// which Mac they own. The per-arch layout is still recognised: a plain `tauri build`
// during development writes to target/release, and older releases were aarch64-only.
// Prefer the universal artifact, fall back to the arch-specific one, so this gate
// follows what was actually built instead of dictating it.
const CANDIDATES = [
  { bundle: `${appDir}/src-tauri/target/universal-apple-darwin/release/bundle`, suffix: "universal" },
  { bundle: `${appDir}/src-tauri/target/release/bundle`, suffix: "aarch64" },
];
const built =
  CANDIDATES.find((c) => existsSync(`${c.bundle}/dmg/AgentsPoppy_${version}_${c.suffix}.dmg`)) ?? CANDIDATES[0];
const bundleDir = built.bundle;
const appPath = `${bundleDir}/macos/AgentsPoppy.app`;
const dmgPath = `${bundleDir}/dmg/AgentsPoppy_${version}_${built.suffix}.dmg`;
const brokerPath = `${appPath}/Contents/MacOS/agentspoppy-broker`;
const updaterTar = `${bundleDir}/macos/AgentsPoppy.app.tar.gz`;
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

// ── The updater archive ───────────────────────────────────────────────────────────────
// v0.3.1 shipped an update that every user's app refused to install, while every gate
// above passed: signatures, entitlements, notarization and the minisign signature were
// all correct. The archive was the problem.
//
// The updater strips the leading path component of each entry
// (`entry.path().iter().skip(1)`) and unpacks the rest over the installed .app. macOS
// `tar` stores extended attributes as AppleDouble side-files, and the one for the bundle
// root is named `._AgentsPoppy.app` — a SINGLE component, so skip(1) leaves nothing and
// the destination becomes the extraction directory itself. Unpacking a file onto a
// directory errors, and that aborts the whole install.
//
// Let Tauri build this archive. If something ever hand-rolls it again with system `tar`,
// fail here rather than in front of a user. `tar -tzf` silently re-merges AppleDouble
// entries and will NOT show them, so this reads the raw member list.
const rawEntries = sh("python3", [
  "-c",
  "import tarfile,sys\n" +
    "for m in tarfile.open(sys.argv[1],'r:gz').getmembers(): print(('D' if m.isdir() else 'F') + m.name)",
  updaterTar,
]);
const entries = rawEntries.split("\n").filter(Boolean).map((l) => ({ dir: l[0] === "D", name: l.slice(1) }));
const appleDouble = entries.filter((e) => e.name.split("/").some((p) => p.startsWith("._")));
gate(
  "updater archive: no AppleDouble entries (they abort the install)",
  existsSync(updaterTar) && entries.length > 0 && appleDouble.length === 0,
  appleDouble.length ? appleDouble.slice(0, 3).map((e) => e.name).join(", ") : `${entries.length} entries`,
);
// Replay the strip so a future path-shape change is caught too. The bundle root itself
// reduces to nothing, which is fine — it is a directory, and the updater unpacks it onto
// its own (already existing) extraction directory. A FILE that reduces to nothing is the
// fatal case: it lands on that directory and the install aborts.
const collides = entries.filter((e) => !e.dir && e.name.split("/").length === 1);
gate(
  "updater archive: no file collapses onto the extraction root",
  collides.length === 0,
  collides.length ? collides.map((e) => e.name).join(", ") : "",
);

// ── 5b. USER-FACING LINKS must resolve WITHOUT credentials ────────────────
// On 2026-08-11 the onboarding's "copy the access policy" link pointed into the PRIVATE
// monorepo. It resolved perfectly for the maintainer and 404'd for every user, stranding
// them mid-setup. Same trap that broke MailPoppy's installs. So: extract every https URL
// the app ships and fetch each one anonymously.
//
// Also asserts the bundled copy of the policy matches infra/policies — the copy button is
// the primary path now, and a stale embedded policy would grant the wrong permissions.
// Scan EVERY shipped source file, not one hand-picked view — the first version of this
// gate read only ConnectAwsView.tsx, and the very next refactor (moving the links into
// connectShared.tsx) would have quietly reduced it to checking nothing.
const srcFiles = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) srcFiles.push(p);
  }
};
walk(`${appDir}/src`);
const viewSrc = srcFiles.map((f) => readFileSync(f, "utf8")).join("\n");
const shippedLinks = [...new Set((viewSrc.match(/https:\/\/[^"'`\s)]+/g) ?? []))].filter(
  (u) =>
    !u.includes("console.aws.amazon.com") && // requires a signed-in AWS session by design
    !u.includes("schemas.") && // XML/JSON schema namespaces, not links a user follows
    !u.includes("www.w3.org"),
);
const brokenLinks = [];
for (const url of shippedLinks) {
  const head = sh("curl", ["-sIL", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "20", url]).trim();
  if (/^(200|301|302)/.test(head)) continue;
  // A HEAD refusal is not proof a link is broken. apps.microsoft.com answers 403 to HEAD
  // from any client, browser user-agent included, while a real GET returns the product
  // page — so the first version of this gate failed a link that works perfectly for every
  // user. Confirm with a GET before calling it broken: a genuinely dead link (the 404 that
  // stranded users mid-setup in v0.3.2, which is why this gate exists) fails both.
  const get = sh("curl", [
    "-sL", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "25",
    "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    url,
  ]).trim();
  if (!/^(200|301|302)/.test(get)) brokenLinks.push(`${url} → HEAD ${head}, GET ${get}`);
}
gate(
  "links: every shipped user-facing URL resolves anonymously",
  brokenLinks.length === 0,
  brokenLinks.join(" · ") || `${shippedLinks.length} checked`,
);
gate(
  "links: no user-facing link points into the PRIVATE monorepo",
  !shippedLinks.some((u) => /github\.com\/leonct74\/agentspoppy\//.test(u)),
);
const bundledPolicy = readFileSync(`${appDir}/src/assets/access-policy.json`, "utf8");
const sourcePolicy = readFileSync(`${appDir}/../infra/policies/agentspoppy-access-policy.json`, "utf8");
// BYTE equality, not JSON equality. A semantic compare passed while the two files differed
// in whitespace — so the app's Copy button produced a 161-line policy and GitHub showed a
// 150-line one, and a careful user reasonably concluded one of them must be wrong
// (2026-08-28). The exact bytes are part of the product for a security-conscious audience:
// the file is canonical JSON.stringify(…, null, 2), which is also what the Copy button emits.
gate(
  "policy: the copy-button's bundled policy matches infra/policies byte-for-byte",
  bundledPolicy === sourcePolicy,
  "re-copy infra/policies/agentspoppy-access-policy.json → app/src/assets/access-policy.json",
);
gate(
  "policy: the file is in canonical form (so the Copy button's output matches it)",
  bundledPolicy === JSON.stringify(JSON.parse(bundledPolicy), null, 2) + "\n",
  "run: node -e 'const f=\"infra/policies/agentspoppy-access-policy.json\",fs=require(\"fs\");fs.writeFileSync(f,JSON.stringify(JSON.parse(fs.readFileSync(f,\"utf8\")),null,2)+\"\\n\")' and re-copy",
);

// A link that RESOLVES can still be wrong. The gate above this one was written after v0.3.2
// shipped a policy link into the private repo and 404'd every new user for weeks — so it
// checks that every shipped URL answers 200 anonymously. It does not check WHAT the URL
// serves. When the app gains a permission and the public mirror has not been re-synced, the
// "open it on GitHub" link returns a perfectly healthy 200 carrying the PREVIOUS policy, and
// a user who copies from there attaches a policy that cannot deploy — surfacing as an
// asynchronous CloudFormation rollback, which is about as unhelpful as an error gets.
const POLICY_RAW_URL =
  "https://raw.githubusercontent.com/leonct74/agentspoppy-public-source/main/infra/policies/agentspoppy-access-policy.json";
const publishedPolicy = sh("curl", ["-sL", "--max-time", "25", POLICY_RAW_URL]).trim();
let publishedMatches = false;
let publishedNote = "";
try {
  publishedMatches = publishedPolicy + "\n" === bundledPolicy || publishedPolicy === bundledPolicy;
  if (!publishedMatches) {
    const sids = (p) => new Set(JSON.parse(p).Statement.map((st) => st.Sid));
    const missing = [...sids(bundledPolicy)].filter((x) => !sids(publishedPolicy).has(x));
    publishedNote = missing.length ? `mirror is missing: ${missing.join(", ")}` : "mirror differs";
  }
} catch {
  publishedNote = "the published policy could not be read as JSON";
}
gate(
  "policy: the public link serves the SAME policy the app ships",
  publishedMatches,
  publishedMatches
    ? "in step with the mirror"
    : `${publishedNote} — re-run scripts/export-public.sh before releasing, or users copy a policy that can't deploy`,
);

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
