#!/usr/bin/env node
/**
 * Boot every released poppy's SHIPPED backend bundle through the host's real spawn path.
 *
 * The host decides a poppy's environment, so a change there can break an already-released
 * poppy that we cannot patch retroactively — the user has that version installed. Unit
 * tests in this repo prove the host does what we meant; this proves the poppies still
 * start when it does.
 *
 * It deliberately runs with AWS_ACCESS_KEY_ID and friends set in the parent, because that
 * is the case the environment scrub changed: if a poppy quietly depended on inheriting
 * them, this is where it fails.
 *
 *   node scripts/smoke-poppies.mjs                       # the default set, from ~/Projects
 *   node scripts/smoke-poppies.mjs /path/to/a/poppy ...  # explicit roots
 *
 * A poppy passes when its backend starts and accepts a connection on the assigned port.
 * That covers boot-time regressions (a missing env var read at module scope is the whole
 * risk class here); it does not exercise their features.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(fileURLToPath(import.meta.url), "..", "..");
const { poppyEnv } = await import(join(repo, "packages/broker/dist/extensions/backend-host.js"));

const DEFAULT_ROOTS = [
  join(homedir(), "Projects", "mailpoppy", "apps", "desktop"),
  join(homedir(), "Projects", "vm-poppy"),
  join(homedir(), "Projects", "vpn-poppy"),
  join(homedir(), "Projects", "traffic-poppy"),
  join(homedir(), "Projects", "mission-control-poppy"),
];

const roots = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_ROOTS;

/** A loopback port nothing is listening on. */
async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

const accepts = (port) =>
  new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    sock.once("connect", () => (sock.destroy(), resolve(true)));
    sock.once("error", () => resolve(false));
  });

async function waitForPort(port, alive, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive()) return false;
    if (await accepts(port)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function smoke(root) {
  const manifestPath = join(root, "extension.json");
  if (!existsSync(manifestPath)) return { root, skip: "no extension.json" };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = manifest.backend?.entry && join(root, manifest.backend.entry);
  if (!entry) return { name: manifest.name, skip: "frontend-only — nothing to spawn" };
  if (!existsSync(entry)) return { name: manifest.name, skip: `not built (${manifest.backend.entry})` };

  const port = await freePort();
  const bootstrap = {
    connectionId: "smoke",
    credentialsUrl: "http://127.0.0.1:1/creds",
    credentialsToken: "smoke-token",
    port,
    dataDir: join(repo, ".smoke-data", manifest.id),
    account: { accountId: "123456789012", region: "eu-west-1" },
  };
  const { mkdir } = await import("node:fs/promises");
  await mkdir(bootstrap.dataDir, { recursive: true });

  // The parent environment a developer actually has. If a poppy needs any of it, we want
  // to know now rather than from a user.
  const parent = {
    ...process.env,
    AWS_ACCESS_KEY_ID: "AKIASMOKETEST",
    AWS_SECRET_ACCESS_KEY: "smoke",
    AWS_PROFILE: "agentspoppy",
    AWS_REGION: "us-east-1",
  };

  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: { ...poppyEnv(parent), AGENTSPOPPY_BOOTSTRAP: JSON.stringify(bootstrap) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  let running = true;
  child.once("exit", () => (running = false));

  const ok = await waitForPort(port, () => running);
  child.kill();
  return {
    name: manifest.name,
    version: manifest.version,
    ok,
    output: ok ? "" : output.trim().split("\n").slice(-6).join("\n"),
  };
}

console.log(`Booting released poppies through the host's spawn path (AWS_* set in the parent)\n`);
let failures = 0;
for (const root of roots) {
  const r = await smoke(root);
  const label = (r.name ?? r.root ?? root).padEnd(14);
  if (r.skip) {
    console.log(`  –    ${label} ${r.skip}`);
    continue;
  }
  if (r.ok) {
    console.log(`  PASS ${label} ${r.version} — started and listening`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label} ${r.version} — never listened\n${r.output.replace(/^/gm, "         ")}`);
  }
}
console.log(
  failures === 0
    ? `\nAll good: no released poppy depends on the environment the host no longer passes.`
    : `\n${failures} poppy(ies) failed to start. Do not release the host until this is understood.`,
);
process.exit(failures === 0 ? 0 : 1);
