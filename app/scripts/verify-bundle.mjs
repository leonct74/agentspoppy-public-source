#!/usr/bin/env node
// Behavioral smoke test for a built AgentsPoppy.app bundle — REQUIRED before any
// release (see RELEASE.md). Signing checks (codesign/spctl/stapler) verify
// signatures, not behavior: v0.2.0 passed all of them while its broker crashed at
// startup (hardened runtime without JIT entitlements), so every user saw
// "AWS didn't accept those keys". This script launches the BUNDLED broker binary
// and requires it to come up and answer HTTP.
//
// ⚠ NECESSARY, NOT SUFFICIENT. This runs the broker UNQUARANTINED, and the v0.2.0
// class of crash (JIT denial) only manifests on quarantined copies — i.e. real
// browser downloads. A build can pass here and still be broken for users. The
// runbook's final gate — download the published DMG in a real browser, install,
// launch via Finder, and CONNECT AWS — is mandatory and cannot be replaced by
// this script.
//
// Usage: node scripts/verify-bundle.mjs [path/to/AgentsPoppy.app]

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appPath = resolve(
  process.argv[2] ?? `${appDir}/src-tauri/target/release/bundle/macos/AgentsPoppy.app`,
);
const broker = `${appPath}/Contents/MacOS/agentspoppy-broker`;
const PORT = 8977; // scratch port — never collides with a running app (8799)

if (!existsSync(broker)) {
  console.error(`❌ no broker binary at ${broker} — build first (npm run tauri:build)`);
  process.exit(1);
}

console.log(`verify-bundle: launching ${broker}`);
const child = spawn(broker, [], {
  env: { ...process.env, AGENTSPOPPY_PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));

const died = new Promise((res) => child.once("exit", (code, sig) => res({ code, sig })));

function fail(why) {
  console.error(`❌ ${why}`);
  if (out.trim()) console.error(`--- broker output ---\n${out.trim()}`);
  console.error(
    "\nA broker that can't start ships as 'AWS didn't accept those keys' for every user." +
      "\nUsual suspects: missing JIT entitlements under the hardened runtime (check" +
      "\nsrc-tauri/entitlements.plist is wired at bundle.macOS.entitlements), or a" +
      "\nbroker bundle/build regression. Crash reports: ~/Library/Logs/DiagnosticReports/",
  );
  child.kill("SIGKILL");
  process.exit(1);
}

// 1. It must survive startup (the exact v0.2.0 failure: SIGTRAP in V8 init).
const startupRace = await Promise.race([died, new Promise((r) => setTimeout(() => r(null), 4000))]);
if (startupRace) fail(`broker exited during startup (code=${startupRace.code} signal=${startupRace.sig})`);

// 2. It must answer HTTP (any status proves the server is up; 401 is fine — that's auth).
let status = null;
for (let i = 0; i < 10 && status === null; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/accounts`);
    status = res.status;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (status === null) fail("broker never answered HTTP on its port");

console.log(`✅ broker started and answers HTTP (status ${status}) — bundle is behaviorally sound`);
child.kill("SIGTERM");
process.exit(0);
