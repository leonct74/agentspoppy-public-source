// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeBackendHost, killAllBackends, nodeRuntimeArgs, nodeRuntimeError, poppyBackendEntry, waitForPort } from "./backend-host";
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
    const root = await mkdtemp(join(tmpdir(), "ap-backend-"));
    const entry = join(root, "backend.sh");
    await writeFile(entry, "#!/bin/sh\nsleep 60\n");
    await chmod(entry, 0o755);
    const manifest = {
      id: "com.test.sleeper",
      backend: { entry: "backend.sh", transport: "stdio" },
    } as unknown as ExtensionManifest;

    const proc = await new NodeBackendHost().start({
      manifest,
      root,
      bootstrap: { connectionId: "c1", credentialsUrl: "http://127.0.0.1:1/creds" } as never,
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
      bootstrap: { connectionId: "c1", credentialsUrl: "http://127.0.0.1:1/creds", port } as never,
    });
    expect(proc.running).toBe(true); // resolved ⇒ the bundle is listening on the assigned port
    await proc.stop();
    await rm(root, { recursive: true, force: true });
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
