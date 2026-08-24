// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeBackendHost, confinementOptions, killAllBackends, nodeRuntimeArgs, nodeRuntimeError, poppyBackendEntry, poppyEnv, stopChild, waitForPort } from "./backend-host";
import type { ExtensionManifest } from "@agentspoppy/extension-sdk";

/** A throwaway TCP server on an OS-assigned loopback port. */
async function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;
  return { port, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

/** A loopback port that is guaranteed NOT to be listening. */
async function deadPort(): Promise<number> {
  const { port, close } = await listen();
  await close(); // released → nothing accepts here now
  return port;
}

const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of servers.splice(0)) await close();
});

describe("killAllBackends", () => {
  it("synchronously reaps a live spawned backend (no orphans on broker exit)", async () => {
    // A real long-running child, via the real spawn path (stdio transport = no
    // readiness probe), so this covers exactly what the broker's exit handler does.
    // Deliberately a runtime:node22 bundle rather than a shell script: Windows can't
    // spawn a .sh, and this suite must run on the OS whose file-locking rules caused
    // the 2026-08-22 update bug (a Windows-only defect CI structurally could not catch).
    const root = await mkdtemp(join(tmpdir(), "ap-backend-"));
    const entry = join(root, "backend.cjs");
    await writeFile(entry, "setInterval(() => {}, 1000);\n");
    const manifest = {
      id: "com.test.sleeper",
      backend: { entry: "backend.cjs", transport: "stdio", runtime: "node22" },
    } as unknown as ExtensionManifest;

    // Confinement is the default since 0.3.5, so a start needs a dataDir — exactly as the
    // real bootstrap always supplies one (registry.ts dataDirFor).
    const dataDir = await mkdtemp(join(tmpdir(), "ap-backend-data-"));
    const proc = await new NodeBackendHost().start({
      manifest,
      root,
      bootstrap: { connectionId: "c1", credentialsUrl: "http://127.0.0.1:1/creds", dataDir } as never,
    });
    expect(proc.running).toBe(true);

    killAllBackends();

    // The kill signal is delivered asynchronously; the exit must land promptly.
    const deadline = Date.now() + 5000;
    while (proc.running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(proc.running).toBe(false);
    await rm(root, { recursive: true, force: true });
  });
});

describe("shared node runtime (docs/RUNTIMES.md)", () => {
  it("nodeRuntimeArgs: SEA re-execs itself with the flag; dev node runs the bundle directly", () => {
    expect(nodeRuntimeArgs("/x/index.cjs", true)).toEqual(["--poppy-backend", "/x/index.cjs"]);
    expect(nodeRuntimeArgs("/x/index.cjs", false)).toEqual(["/x/index.cjs"]);
  });

  it("poppyBackendEntry: finds the flag anywhere in argv (SEA argv[1] quirk), null otherwise", () => {
    expect(poppyBackendEntry(["/bin/broker", "/bin/broker", "--poppy-backend", "/e.cjs"])).toBe("/e.cjs");
    expect(poppyBackendEntry(["node", "serve.js", "--poppy-backend", "/e.cjs"])).toBe("/e.cjs");
    expect(poppyBackendEntry(["node", "serve.js", "--seed"])).toBeNull();
    expect(poppyBackendEntry(["node", "serve.js", "--poppy-backend"])).toBeNull(); // flag with no path
  });

  it("nodeRuntimeError: satisfied / too-old / unknown names fail closed", () => {
    expect(nodeRuntimeError("node22", "22.4.1")).toBeNull();
    expect(nodeRuntimeError("node22", "23.0.0")).toBeNull();
    expect(nodeRuntimeError("node24", "22.4.1")).toMatch(/update AgentsPoppy/);
    expect(nodeRuntimeError("python312", "22.4.1")).toMatch(/unknown backend runtime/);
  });

  it("runs a runtime:node22 CJS bundle on this host's own Node — real spawn, real port", async () => {
    // The dev-path spawn (plain node runs the bundle directly) — the SEA path differs
    // only in argv (covered above) and lands in serve.ts's child branch.
    const root = await mkdtemp(join(tmpdir(), "ap-noderuntime-"));
    const dataDir = await mkdtemp(join(tmpdir(), "ap-noderuntime-data-"));
    const port = await deadPort(); // released OS-assigned port for the fixture to bind
    await writeFile(
      join(root, "index.cjs"),
      `const http = require("node:http");
       const boot = JSON.parse(process.env.AGENTSPOPPY_BOOTSTRAP);
       http.createServer((q, r) => r.end("ok")).listen(boot.port, "127.0.0.1");`,
    );
    const manifest = {
      id: "com.test.nodepoppy",
      backend: { entry: "index.cjs", transport: "http", runtime: "node22" },
    } as unknown as ExtensionManifest;

    const proc = await new NodeBackendHost({ readinessTimeoutMs: 10_000, readinessIntervalMs: 25 }).start({
      manifest,
      root,
      bootstrap: { connectionId: "c1", credentialsUrl: "http://127.0.0.1:1/creds", port, dataDir } as never,
    });
    expect(proc.running).toBe(true); // resolved ⇒ the bundle is listening on the assigned port
    await proc.stop();
    await rm(root, { recursive: true, force: true });
  });

  it("never passes an AWS_* variable to a backend — a real spawn reports what it received", async () => {
    // The whole point of the broker is that a poppy is given scoped, short-lived creds and
    // nothing else. Inheriting the launching shell's AWS_ACCESS_KEY_ID would hand it the
    // operator's long-lived key with no attack required at all.
    const root = await mkdtemp(join(tmpdir(), "ap-envscrub-"));
    const dataDir = await mkdtemp(join(tmpdir(), "ap-envscrub-data-"));
    const port = await deadPort();
    await writeFile(
      join(root, "index.cjs"),
      `const http = require("node:http");
       const boot = JSON.parse(process.env.AGENTSPOPPY_BOOTSTRAP);
       const leaked = Object.keys(process.env).filter((k) => /^AWS_/i.test(k));
       http.createServer((q, r) => r.end(JSON.stringify(leaked))).listen(boot.port, "127.0.0.1");`,
    );
    const manifest = {
      id: "com.test.envscrub",
      backend: { entry: "index.cjs", transport: "http", runtime: "node22" },
    } as unknown as ExtensionManifest;

    const saved = { ...process.env };
    process.env.AWS_ACCESS_KEY_ID = "AKIALEAKEDTOAPOPPY";
    process.env.AWS_SECRET_ACCESS_KEY = "super-secret";
    process.env.AWS_SESSION_TOKEN = "tok";
    process.env.AWS_PROFILE = "agentspoppy";
    process.env.aws_lowercase_variant = "also-blocked";
    process.env.NOT_AWS_RELATED = "keep me";
    try {
      const proc = await new NodeBackendHost({ readinessTimeoutMs: 10_000, readinessIntervalMs: 25 }).start({
        manifest,
        root,
        bootstrap: { connectionId: "c1", credentialsUrl: "http://127.0.0.1:1/creds", port, dataDir } as never,
      });
      const leaked = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.json());
      expect(leaked).toEqual([]);
      await proc.stop();
    } finally {
      process.env = saved;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a strictly-isolated backend is denied the credentials file, and keeps its own dirs", async () => {
    // The claim this test exists to defend: a poppy cannot read ~/.aws/credentials. Not by
    // policy, not by review — by the runtime refusing. So the fixture reports what it can
    // actually do, and we assert on that rather than on the flags we passed.
    const root = await mkdtemp(join(tmpdir(), "ap-confine-"));
    const dataDir = await mkdtemp(join(tmpdir(), "ap-confine-data-"));
    const port = await deadPort();
    await writeFile(
      join(root, "index.cjs"),
      `const http = require("node:http"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
       const boot = JSON.parse(process.env.AGENTSPOPPY_BOOTSTRAP);
       const probe = (fn) => { try { fn(); return "allowed"; } catch (e) { return e.code || "error"; } };
       const report = {
         credentials: probe(() => fs.readFileSync(path.join(os.homedir(), ".aws", "credentials"))),
         homeListing: probe(() => fs.readdirSync(os.homedir())),
         escapeViaSubprocess: probe(() => require("node:child_process").execSync("cat ~/.aws/credentials")),
         ownInstallDir: probe(() => fs.readFileSync(path.join(__dirname, "index.cjs"))),
         ownDataDir: probe(() => fs.writeFileSync(path.join(boot.dataDir, "state.json"), "{}")),
       };
       http.createServer((q, r) => r.end(JSON.stringify(report))).listen(boot.port, "127.0.0.1");`,
    );
    const manifest = {
      id: "com.test.confined",
      backend: { entry: "index.cjs", transport: "http", runtime: "node22", isolation: "strict" },
    } as unknown as ExtensionManifest;

    const proc = await new NodeBackendHost({ readinessTimeoutMs: 10_000, readinessIntervalMs: 25 }).start({
      manifest,
      root,
      bootstrap: { connectionId: "c1", credentialsUrl: "http://127.0.0.1:1/creds", port, dataDir } as never,
    });
    const report = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.json());
    await proc.stop();

    expect(report.credentials).toBe("ERR_ACCESS_DENIED");
    expect(report.homeListing).toBe("ERR_ACCESS_DENIED");
    expect(report.escapeViaSubprocess).toBe("ERR_ACCESS_DENIED"); // no shelling out around it
    expect(report.ownInstallDir).toBe("allowed"); // it can still run
    expect(report.ownDataDir).toBe("allowed"); // ...and still keep state

    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it("an unconfined backend can read the credentials file — the fixture is not lying to us", async () => {
    // Negative control. Without this, the test above would pass just as happily if the
    // fixture were broken and every probe returned ERR_ACCESS_DENIED for some other reason.
    //
    // Note what it takes to BE unconfined since 0.3.5: the manifest has to say
    // `isolation: "none"` out loud. Saying nothing gets you confined. That one word is the
    // difference this release makes, and this test is where it is visible.
    const root = await mkdtemp(join(tmpdir(), "ap-unconfined-"));
    const port = await deadPort();
    await writeFile(
      join(root, "index.cjs"),
      `const http = require("node:http"), fs = require("node:fs"), os = require("node:os");
       const boot = JSON.parse(process.env.AGENTSPOPPY_BOOTSTRAP);
       let home; try { fs.readdirSync(os.homedir()); home = "allowed"; } catch (e) { home = e.code; }
       http.createServer((q, r) => r.end(JSON.stringify({ home }))).listen(boot.port, "127.0.0.1");`,
    );
    const manifest = {
      id: "com.test.unconfined",
      backend: { entry: "index.cjs", transport: "http", runtime: "node22", isolation: "none" },
    } as unknown as ExtensionManifest;

    const proc = await new NodeBackendHost({ readinessTimeoutMs: 10_000, readinessIntervalMs: 25 }).start({
      manifest,
      root,
      bootstrap: { connectionId: "c1", credentialsUrl: "http://127.0.0.1:1/creds", port, dataDir: root } as never,
    });
    const report = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.json());
    await proc.stop();
    expect(report.home).toBe("allowed"); // only reachable by declaring isolation "none"
    await rm(root, { recursive: true, force: true });
  });

  it("confinementOptions is ON by default, off only when a manifest opts out, and refuses to pretend without a dataDir", () => {
    const base = { root: "/opt/poppy", bootstrap: { dataDir: "/data/poppy" } };

    // THE 0.3.5 CHANGE. A manifest that never mentions isolation is CONFINED. Before this
    // release the same manifest ran with the user's full file access — the unsafe answer by
    // omission, which is what an external audit reported the platform as doing.
    const silent = { ...base, manifest: { id: "x", backend: { entry: "i.cjs", runtime: "node22" } } as never };
    expect(confinementOptions(silent, "/tmp")).toContain("--permission");

    // Unconfined is still reachable — but only by writing it down.
    const optedOut = {
      ...base,
      manifest: { id: "x", backend: { entry: "i.cjs", runtime: "node22", isolation: "none" } } as never,
    };
    expect(confinementOptions(optedOut, "/tmp")).toBeNull();

    const strict = {
      ...base,
      manifest: { id: "x", backend: { entry: "i.cjs", runtime: "node22", isolation: "strict" } } as never,
    };
    const opts = confinementOptions(strict, "/tmp")!;
    expect(opts).toContain("--permission");
    expect(opts).toContain("--allow-fs-read=/opt/poppy");
    expect(opts).toContain("--allow-fs-write=/data/poppy");
    expect(opts).not.toContain("--allow-child-process");
    expect(opts).not.toContain("--allow-fs-write=/opt/poppy"); // its own code stays read-only

    expect(() => confinementOptions({ ...strict, bootstrap: {} }, "/tmp")).toThrow(/dataDir/);
  });

  it("poppyEnv drops the whole AWS_ namespace and keeps everything else", () => {
    const out = poppyEnv({
      AWS_ACCESS_KEY_ID: "a",
      AWS_SECRET_ACCESS_KEY: "b",
      AWS_SESSION_TOKEN: "c",
      AWS_PROFILE: "d",
      AWS_SHARED_CREDENTIALS_FILE: "e",
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "f",
      AWS_WEB_IDENTITY_TOKEN_FILE: "g",
      aws_region: "h", // case-insensitive: env vars are case-sensitive on POSIX
      PATH: "/usr/bin",
      HOME: "/home/x",
    });
    expect(Object.keys(out).sort()).toEqual(["HOME", "PATH"]);
    // A future AWS_* name we have never heard of is covered by construction.
    expect(poppyEnv({ AWS_SOMETHING_INVENTED_IN_2030: "x" })).toEqual({});
  });

  it("refuses a node runtime newer than this host's Node, with an 'update AgentsPoppy' error", async () => {
    const root = await mkdtemp(join(tmpdir(), "ap-noderuntime-"));
    await writeFile(join(root, "index.cjs"), "// never runs");
    const manifest = {
      id: "com.test.futurepoppy",
      backend: { entry: "index.cjs", transport: "stdio", runtime: "node99" },
    } as unknown as ExtensionManifest;
    await expect(
      new NodeBackendHost().start({
        manifest,
        root,
        bootstrap: { connectionId: "c1", credentialsUrl: "http://127.0.0.1:1/creds" } as never,
      }),
    ).rejects.toThrow(/update AgentsPoppy/);
    await rm(root, { recursive: true, force: true });
  });
});

describe("waitForPort", () => {
  it("resolves true once the port accepts connections", async () => {
    const { port, close } = await listen();
    servers.push(close);
    expect(await waitForPort(port, { timeoutMs: 2000, intervalMs: 25 })).toBe(true);
  });

  it("resolves false when nothing ever listens (timeout)", async () => {
    const port = await deadPort();
    const start = Date.now();
    expect(await waitForPort(port, { timeoutMs: 150, intervalMs: 25 })).toBe(false);
    expect(Date.now() - start).toBeGreaterThanOrEqual(140);
  });

  it("gives up immediately once isAlive() goes false (child exited)", async () => {
    const port = await deadPort();
    const start = Date.now();
    // isAlive false from the outset → no waiting, returns false fast.
    expect(await waitForPort(port, { timeoutMs: 5000, intervalMs: 25, isAlive: () => false })).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

// stop() must not resolve while the process still lives: the update swap renames the
// install dir the moment stop() returns, and on Windows that fails EBUSY while the
// dying child still holds handles in it (field bug 2026-08-22).
describe("stopChild", () => {
  it("resolves only once the child is really gone — even one that ignores SIGTERM", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"]);
    await new Promise<void>((r) => child.once("spawn", () => r()));
    await stopChild(child, 250); // short grace → must escalate to SIGKILL
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("is an immediate no-op for a child that already exited", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", ""]);
    await new Promise<void>((r) => child.once("exit", () => r()));
    const start = Date.now();
    await stopChild(child, 3000);
    expect(Date.now() - start).toBeLessThan(200);
  });
});
