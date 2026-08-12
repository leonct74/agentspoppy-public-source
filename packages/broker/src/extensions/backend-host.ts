// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The backend-process seam — how the host launches an extension's backend.
 *
 * In the container model an extension's backend is a SEPARATE child process the
 * host owns (not code in the host's memory), so the isolation that made the two-app
 * model safe is preserved — only now the host spawns it, hands it a
 * {@link BackendBootstrap} directly (connection id + a loopback credentials endpoint
 * + an assigned port), and kills it on disable/revoke. No fixed-port discovery, no
 * cross-app handshake.
 *
 * The spawn is an injectable seam ({@link BackendHost}) so the registry's lifecycle
 * logic is unit-tested with {@link StubBackendHost} and never touches a real process.
 * {@link NodeBackendHost} is the real implementation (exercised for real once
 * MailPoppy is ported, Phase 3).
 */
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BackendBootstrap, ExtensionManifest } from "@agentspoppy/extension-sdk";

/** Everything the host needs to launch one backend. */
export interface BackendStartSpec {
  manifest: ExtensionManifest;
  /** Absolute path to the extension's installed root (where `manifest.backend.entry` lives). */
  root: string;
  bootstrap: BackendBootstrap;
}

/** A running (or stopped) backend process. */
export interface BackendProcess {
  /** The loopback port it listens on, for an "http" backend. */
  readonly port?: number;
  /** True while the process is alive. */
  readonly running: boolean;
  /** Stop the process. Idempotent. */
  stop(): Promise<void>;
}

/** Launches an extension backend. */
export interface BackendHost {
  start(spec: BackendStartSpec): Promise<BackendProcess>;
}

/** Test double: records starts, hands back a controllable fake process. No real spawn. */
export class StubBackendHost implements BackendHost {
  readonly started: BackendStartSpec[] = [];
  async start(spec: BackendStartSpec): Promise<BackendProcess> {
    this.started.push(spec);
    let running = true;
    return {
      port: spec.bootstrap.port,
      get running() {
        return running;
      },
      async stop() {
        running = false;
      },
    };
  }
}

/**
 * Every live backend child this process has spawned. The broker must take its
 * children with it — a backend that outlives the broker keeps running (and polling
 * AWS on live scoped credentials) as an unkillable-from-the-UI orphan. `process.on("exit")`
 * handlers must be synchronous, which the async {@link BackendProcess.stop} can't
 * provide, so the composition root wires {@link killAllBackends} instead.
 */
const liveChildren = new Set<import("node:child_process").ChildProcess>();

/** Synchronously signal every live backend child. Safe inside an `exit` handler. */
export function killAllBackends(): void {
  for (const child of liveChildren) child.kill();
  liveChildren.clear();
}

/** Tunables for {@link NodeBackendHost}'s readiness wait (overridable in tests). */
export interface NodeBackendHostOptions {
  /** Max time to wait for an http backend's port to start accepting connections. */
  readinessTimeoutMs?: number;
  /** Poll cadence for the readiness probe. */
  readinessIntervalMs?: number;
}

/**
 * The argv for running a `"runtime": "node*"` backend on THIS process's own Node
 * (docs/RUNTIMES.md §4.2 — the poppy ships a CJS bundle, never a runtime):
 * - packaged (SEA): re-exec our own binary with `--poppy-backend <entry>` — serve.ts's
 *   child branch loads the bundle instead of starting a second broker.
 * - dev (plain node): `node <entry>` directly — real node would reject the unknown flag.
 * Pure; exported for tests.
 */
export function nodeRuntimeArgs(entry: string, isSea: boolean): string[] {
  return isSea ? ["--poppy-backend", entry] : [entry];
}

/**
 * The environment a poppy backend is allowed to inherit.
 *
 * A backend gets its AWS access ONE way: by minting short-lived, session-policy-narrowed
 * credentials against the loopback endpoint in its bootstrap. It has no legitimate use for
 * an `AWS_*` variable of any kind — so passing the parent's through would hand a poppy the
 * operator's own long-lived key for free whenever AgentsPoppy is launched from a shell that
 * exports one. That is common for exactly the developer audience most likely to look.
 *
 * The rule is deliberately the whole `AWS_*` namespace rather than a list of known-dangerous
 * names: `AWS_ACCESS_KEY_ID`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, `AWS_SHARED_CREDENTIALS_FILE`,
 * `AWS_CONTAINER_CREDENTIALS_FULL_URI` and friends are all routes to a credential, and AWS
 * keeps adding more. An allowlist of one prefix cannot go stale; an exclusion list can.
 *
 * This does NOT stop a backend reading `~/.aws/credentials` off disk — same OS user, same
 * permissions. Closing that needs the filesystem to be constrained too (docs/SECURITY_MECHANISM.md).
 */
export function poppyEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (/^AWS_/i.test(key)) continue;
    // NODE_OPTIONS is ours to set for a confined backend (see confinementOptions). An
    // inherited one could carry `--allow-fs-read=*` and quietly undo the allowlist.
    if (key === "NODE_OPTIONS") continue;
    env[key] = value;
  }
  return env;
}

/**
 * The `NODE_OPTIONS` value that confines a `runtime: node22` backend, or null when the
 * poppy has not asked to be confined.
 *
 * Node's permission model is **allowlist-only** — there is no way to express "everything
 * except `~/.aws`" — so this enumerates the three places a backend legitimately needs and
 * nothing else. `~/.aws/credentials`, the browser profile, the SSH keys and the user's
 * documents are all denied by the runtime, not by convention.
 *
 * Child processes stay denied (no `--allow-child-process`), because `cat ~/.aws/credentials`
 * would otherwise walk straight around the filesystem allowlist.
 *
 * Passed via `NODE_OPTIONS` rather than argv because the packaged host re-execs *itself*
 * as the interpreter (`--poppy-backend <entry>`), so argv is already spoken for. Verified
 * that the permission model engages this way.
 */
export function confinementOptions(
  spec: { manifest: ExtensionManifest; root: string; bootstrap: { dataDir?: string } },
  tmp: string,
): string | null {
  const backend = spec.manifest.backend;
  if (backend?.isolation !== "strict") return null;
  const dataDir = spec.bootstrap.dataDir;
  if (!dataDir) throw new Error(`extension ${spec.manifest.id} asked for strict isolation but was given no dataDir`);
  const read = [spec.root, dataDir, tmp];
  const write = [dataDir, tmp];
  return [
    "--permission",
    ...read.flatMap((p) => grantsFor("read", p)),
    ...write.flatMap((p) => grantsFor("write", p)),
  ].join(" ");
}

/**
 * The allowlist entries for one directory.
 *
 * Two subtleties, both of which cost a debugging session if missed:
 *  - The permission model resolves symlinks, and the usual temp directory is one on macOS
 *    (`/var/folders/…` → `/private/var/folders/…`). Granting only the path we were handed
 *    denies the path the runtime actually checks, and the backend dies at startup. So both
 *    spellings are granted.
 *  - A bare directory path matches only the directory entry itself; `dir/*` is how this
 *    model spells "and everything under it". Both are needed.
 */
function grantsFor(kind: "read" | "write", dir: string): string[] {
  const paths = new Set([dir]);
  try {
    paths.add(realpathSync(dir));
  } catch {
    // Not created yet — the literal path is still worth granting.
  }
  return [...paths].flatMap((p) => [`--allow-fs-${kind}=${p}`, `--allow-fs-${kind}=${join(p, "*")}`]);
}

/**
 * Parse the child-interpreter flag out of an argv (serve.ts's counterpart to
 * {@link nodeRuntimeArgs}): the entry path after `--poppy-backend`, or null for a
 * normal broker start. Scans the whole argv on purpose — in a SEA, argv[1] is the
 * binary path itself and real args start at index 2; under plain node they start at 1.
 */
export function poppyBackendEntry(argv: string[]): string | null {
  const i = argv.indexOf("--poppy-backend");
  if (i < 0) return null;
  return argv[i + 1] ?? null;
}

/**
 * Enforce a declared node runtime against the Node this host actually runs
 * ("node22" → major ≥ 22). Returns an error message, or null when satisfied.
 * Unknown/malformed names fail CLOSED here (unlike the catalog's minHost, which
 * fails open): this is the last line before spawning code on the wrong runtime,
 * and the manifest validator already constrains the field upstream.
 */
export function nodeRuntimeError(runtime: string, currentNodeVersion: string): string | null {
  const required = Number(/^node(\d+)$/.exec(runtime)?.[1]);
  if (!Number.isFinite(required)) return `unknown backend runtime "${runtime}"`;
  const current = Number(currentNodeVersion.split(".")[0]);
  if (current < required) {
    return `needs the ${runtime} runtime, but this AgentsPoppy runs Node ${currentNodeVersion} — update AgentsPoppy first`;
  }
  return null;
}

/**
 * The real host: spawns the extension's backend executable as a child process,
 * injecting the bootstrap via the environment (`AGENTSPOPPY_BOOTSTRAP` = JSON). The
 * backend reads it to learn its connection id, the loopback credentials endpoint to
 * mint scoped creds against, and (for "http") the port to listen on — replacing the
 * old self-spawn + broker-discovery dance. SDK/process modules are loaded lazily so
 * importing this module stays cheap and offline.
 *
 * For an "http" backend, `start` does NOT resolve until the assigned loopback port is
 * actually accepting connections (or the child dies / a timeout elapses). So a
 * resolved {@link BackendProcess} means the host can safely point the extension's
 * webview tab at it — no race where the tab loads against a not-yet-listening port.
 */
export class NodeBackendHost implements BackendHost {
  private readonly readinessTimeoutMs: number;
  private readonly readinessIntervalMs: number;

  constructor(opts: NodeBackendHostOptions = {}) {
    this.readinessTimeoutMs = opts.readinessTimeoutMs ?? 30_000;
    this.readinessIntervalMs = opts.readinessIntervalMs ?? 250;
  }

  async start(spec: BackendStartSpec): Promise<BackendProcess> {
    if (!spec.manifest.backend) {
      throw new Error(`extension ${spec.manifest.id} declares no backend to start`);
    }
    const { spawn } = await import("node:child_process");
    const { isAbsolute, join } = await import("node:path");
    const { existsSync } = await import("node:fs");
    let entry = isAbsolute(spec.manifest.backend.entry)
      ? spec.manifest.backend.entry
      : join(spec.root, spec.manifest.backend.entry);

    const runtime = spec.manifest.backend.runtime ?? "native";
    let executable: string;
    let args: string[];
    if (runtime !== "native") {
      // Shared-runtime backend (docs/RUNTIMES.md): the entry is a CJS bundle run on
      // this host's OWN Node — the packaged SEA re-execs itself as the interpreter.
      const versionProblem = nodeRuntimeError(runtime, process.versions.node);
      if (versionProblem) throw new Error(`extension ${spec.manifest.id} ${versionProblem}`);
      if (!existsSync(entry)) {
        throw new Error(`extension ${spec.manifest.id} backend bundle not found at ${entry}`);
      }
      const isSea = await import("node:sea").then((m) => m.isSea()).catch(() => false);
      executable = process.execPath;
      args = nodeRuntimeArgs(entry, isSea);
    } else {
      // Native executable. Manifests keep a platform-neutral entry ("backend/foo");
      // Windows packages ship the binary as foo.exe — resolve it explicitly rather
      // than relying on CreateProcess extension guessing.
      if (process.platform === "win32" && !existsSync(entry) && existsSync(`${entry}.exe`)) {
        entry = `${entry}.exe`;
      }
      executable = entry;
      args = [];
    }

    const confinement = confinementOptions(spec, tmpdir());
    let cwd = spec.root;
    if (confinement) {
      // Under the permission model the runtime checks REAL paths, and it walks the entry
      // path to load it. Handed a path through a symlink (`/var/...` → `/private/var/...`,
      // the usual shape of a temp or installed-app directory on macOS) it asks for read on
      // the link's root — `/var` — which no sane allowlist grants, and the backend dies
      // before its first line runs. Resolve here so the runtime and the allowlist agree.
      try {
        cwd = realpathSync(spec.root);
        const resolved = realpathSync(entry);
        args = args.map((a) => (a === entry ? resolved : a));
        if (executable === entry) executable = resolved;
        entry = resolved;
      } catch {
        // Missing paths are reported by the spawn itself, with a better message.
      }
    }
    const child = spawn(executable, args, {
      cwd,
      env: {
        ...poppyEnv(process.env),
        AGENTSPOPPY_BOOTSTRAP: JSON.stringify(spec.bootstrap),
        ...(confinement ? { NODE_OPTIONS: confinement } : {}),
      },
      stdio: "inherit",
    });

    let running = true;
    liveChildren.add(child);
    child.once("exit", () => {
      running = false;
      liveChildren.delete(child);
    });

    const proc: BackendProcess = {
      port: spec.bootstrap.port,
      get running() {
        return running;
      },
      async stop() {
        if (running) child.kill();
        running = false;
      },
    };

    // An http backend must be listening before the host hands a tab to it. (A "stdio"
    // backend has no port to probe — it's ready as soon as it's spawned.)
    const port = spec.bootstrap.port;
    if (spec.manifest.backend.transport !== "stdio" && port !== undefined) {
      const ready = await waitForPort(port, {
        isAlive: () => running,
        timeoutMs: this.readinessTimeoutMs,
        intervalMs: this.readinessIntervalMs,
      });
      if (!ready) {
        await proc.stop();
        throw new Error(
          running
            ? `extension ${spec.manifest.id} backend did not listen on 127.0.0.1:${port} within ${this.readinessTimeoutMs}ms`
            : `extension ${spec.manifest.id} backend exited before listening on 127.0.0.1:${port}`,
        );
      }
    }

    return proc;
  }
}

/**
 * Resolve true once a TCP connection to `127.0.0.1:port` succeeds, else false when
 * `timeoutMs` elapses or `isAlive()` goes false (the child exited). Transport-agnostic
 * readiness: a backend that's accepting connections is up, regardless of its routes.
 */
export async function waitForPort(
  port: number,
  opts: { host?: string; timeoutMs: number; intervalMs: number; isAlive?: () => boolean },
): Promise<boolean> {
  const net = await import("node:net");
  const host = opts.host ?? "127.0.0.1";
  const deadline = Date.now() + opts.timeoutMs;
  const isAlive = opts.isAlive ?? (() => true);
  while (Date.now() < deadline && isAlive()) {
    const up = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ port, host });
      const done = (v: boolean) => {
        sock.destroy();
        resolve(v);
      };
      sock.once("connect", () => done(true));
      sock.once("error", () => done(false));
      sock.setTimeout(opts.intervalMs, () => done(false));
    });
    if (up) return true;
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  return false;
}
