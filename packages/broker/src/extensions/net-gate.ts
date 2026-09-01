// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The machine gate, backend half (docs/specs/machine-gate.md): a confined node22
 * backend can open connections only to destinations its manifest declared, plus its
 * own loopback plumbing. Armed INSIDE the child process (serve.ts' --poppy-backend
 * path) before the poppy bundle loads — the child is our code first, so no injection
 * tricks are needed.
 *
 * Why an in-runtime gate holds here: strict confinement already denies child
 * processes, native addons and workers — the three ways around a JS-level patch —
 * and arming ends by poisoning the runtime's internal-binding escape hatches.
 * Scope note: DNS patches reach code that requires the builtin (every CJS bundle —
 * the only sanctioned poppy backend form); a frozen ESM namespace binding keeps the
 * original function, but socket connects — the layer every request ultimately
 * crosses — are patched on the PROTOTYPE, which no namespace freezing bypasses.
 * It is HOST-enforced, not physics: screen wording stays "the host refuses
 * undeclared connections" (spec's wording law).
 *
 * Modes (spec decision 1), keyed on `permissionSet.network.machine` — door 3, the
 * poppy's own code on this machine. NOT `network.egress`, which describes the cloud
 * code it deploys: a different population of connections, and enforcing it here would
 * refuse desktop traffic no one ever declared anything about.
 *  - "enforce": manifest declares `network.machine` → undeclared destinations REFUSED.
 *  - "observe": no declaration (an older manifest) → everything allowed, external
 *    destinations LOGGED once each. Blocking would break every pre-declaration
 *    poppy's AWS calls; the catalogue already forces a declaration at next update,
 *    and the log is the evidence to check that declaration against.
 *
 * Fail closed (spec decision 2): a malformed config throws out of armNetGate and the
 * child exits before any poppy code runs.
 */
import { createRequire } from "node:module";
import type { EgressDeclaration, PermissionSet } from "@agentspoppy/core";
import type { ExtensionManifest } from "@agentspoppy/extension-sdk";
import { effectiveIsolation, effectiveRuntime } from "@agentspoppy/extension-sdk";

/** The env var carrying the gate config into the backend child. */
export const NET_GATE_ENV = "AGENTSPOPPY_NET_GATE";

export type GateConfig = { mode: "enforce"; egress: EgressDeclaration } | { mode: "observe" };

/**
 * AWS API host suffixes for `"aws-only"`. Two, not one: SDK v3's dual-stack and
 * newer service endpoints live under `api.aws`, classic ones under `amazonaws.com`.
 */
const AWS_SUFFIXES = ["amazonaws.com", "api.aws"];

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1" || h === "127.0.0.1" || h.startsWith("127.");
}

function underSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith("." + suffix);
}

/**
 * Pure allowlist decision for a non-loopback destination. IP literals are never
 * allowed by a declaration — declarations name hosts, and a raw-IP connect is how a
 * gate gets walked around (net.isIP is checked by the caller, which passes ipLiteral).
 */
export function hostAllowed(host: string, egress: EgressDeclaration): boolean {
  const h = host.toLowerCase();
  if (egress === "none") return false;
  if (egress === "user-directed") return true; // no list exists to refuse against — log-only
  if (egress === "aws-only") return AWS_SUFFIXES.some((s) => underSuffix(h, s));
  return egress.some((d) => d.toLowerCase() === h);
}

/**
 * The gate config for a backend the host is about to spawn, as the env value — or
 * null when the gate cannot hold and must not pretend to: a native backend has no
 * runtime of ours inside it, and an unconfined one keeps the escape routes open.
 */
export function gateEnvFor(manifest: ExtensionManifest): string | null {
  const backend = manifest.backend;
  if (!backend) return null;
  if (effectiveRuntime(backend) !== "node22" || effectiveIsolation(backend) !== "strict") return null;
  // Door 3 (`network.machine`), never door 1: `egress` describes the LAMBDAS a poppy
  // deploys, a different population of connections from the ones this process opens.
  // Enforcing the cloud declaration here would refuse legitimate desktop traffic —
  // MailPoppy's vendor Hub, an IMAP server the user typed — on the strength of a
  // sentence that was never about them.
  const machine = (manifest.permissionSet as PermissionSet | undefined)?.network?.machine;
  const config: GateConfig = machine !== undefined ? { mode: "enforce", egress: machine } : { mode: "observe" };
  return JSON.stringify(config);
}

/**
 * The machine gate's state for one poppy on this host — what the registry reports and
 * the ONLY thing the screen may graduate a declaration on. "enforced" requires that
 * every half that applies here actually holds: the tab's CSP is served for any declared
 * manifest, and a backend, when present, must be one the gate can arm (confined node22).
 */
export function machineGateStateFor(
  manifest: ExtensionManifest,
  opts: {
    /** Whether THIS host's spawn path arms the backend gate — true on the packaged
     *  (SEA) host, false on a dev-path spawn, where the bundle runs directly and the
     *  gate never arms. A dev host must not report a chip the packaged host earns. */
    backendGateAvailable: boolean;
  },
): "enforced" | "observed" | "none" {
  // Door 3 only. A poppy that declares where its CLOUD code connects has said nothing
  // about this machine, so it earns nothing here.
  const machine = (manifest.permissionSet as PermissionSet | undefined)?.network?.machine;
  const backend = manifest.backend;
  if (backend && (effectiveRuntime(backend) !== "node22" || effectiveIsolation(backend) !== "strict")) {
    return "none"; // the backend half cannot hold — a declaration must not read as enforced
  }
  if (backend && !opts.backendGateAvailable) return "none"; // ungated spawn path (dev)
  if (machine !== undefined) {
    // "user-directed" is log-only by nature — reporting it "enforced" would graduate a
    // chip the gate cannot back. The log is real, so "observed" is the honest word.
    return machine === "user-directed" ? "observed" : "enforced";
  }
  // Undeclared: a confined backend logs its connections ("observed"); a frontend-only
  // poppy has nothing observing it, and saying "observed" would claim a log that isn't kept.
  return backend ? "observed" : "none";
}

/**
 * Parse one of the gate's own stderr lines back into an event — the wire format
 * between the child (which can only log) and the broker (which keeps the record).
 * Returns null for anything else. NOTE the trust boundary: the child's stderr is
 * poppy-adjacent, so a poppy could PRINT a forged line and put words in its own
 * record — self-incrimination only, and the registry caps the volume.
 */
export function parseGateLogLine(line: string): { kind: "refused" | "observed"; via: string; host: string } | null {
  let m = /^net-gate: REFUSED (connect|DNS query) to (\S+) /.exec(line);
  if (m) return { kind: "refused", via: m[1] as string, host: m[2] as string };
  m = /^net-gate: observed (connect|DNS query) to (\S+) /.exec(line);
  if (m) return { kind: "observed", via: m[1] as string, host: m[2] as string };
  return null;
}

let seaHost: boolean | null = null;
/**
 * Whether this host's spawn path arms the backend gate: true on the packaged (SEA)
 * host, whose children route through serve.ts's --poppy-backend branch; false under
 * dev (plain node runs the bundle directly — backend-host warns aloud there).
 */
export async function hostArmsBackendGate(): Promise<boolean> {
  if (seaHost === null) {
    seaHost = await import("node:sea").then((m) => m.isSea()).catch(() => false);
  }
  return seaHost;
}
/** Test seam for the cached SEA answer. */
export function setHostArmsBackendGateForTests(v: boolean | null): void {
  seaHost = v;
}

/** What armNetGate patches — injectable so tests never touch the real network. */
export interface GateTargets {
  socketProto: { connect: (...args: unknown[]) => unknown };
  isIP: (host: string) => number;
  dns: Record<string, unknown>;
  dnsPromises: Record<string, unknown>;
  proc: { binding?: unknown; _linkedBinding?: unknown };
  log: (line: string) => void;
}

const DNS_QUERY_FNS = ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveTxt", "resolveMx", "resolveNs", "resolveSrv"];

/** Extract the destination host from net.Socket#connect's argument forms. */
function connectHost(args: unknown[]): { host: string | null; unix: boolean } {
  const first = args[0];
  if (first && typeof first === "object") {
    const o = first as { host?: string; path?: string; port?: number };
    if (o.path) return { host: null, unix: true };
    return { host: o.host ?? "localhost", unix: false };
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) return { host: null, unix: true }; // IPC path form
  return { host: typeof args[1] === "string" ? args[1] : "localhost", unix: false };
}

/**
 * Arm the gate: patch socket connects and DNS queries, then poison the internal
 * bindings. Throws on a malformed config — the caller must treat that as fatal.
 */
export function armNetGate(rawConfig: string, t: GateTargets): void {
  const config = JSON.parse(rawConfig) as GateConfig;
  if (config.mode !== "enforce" && config.mode !== "observe") throw new Error(`net-gate: unknown mode in config`);
  if (config.mode === "enforce") {
    const e = config.egress as EgressDeclaration;
    const valid = e === "none" || e === "aws-only" || e === "user-directed" || (Array.isArray(e) && e.every((d) => typeof d === "string"));
    if (!valid) throw new Error("net-gate: malformed egress declaration");
  }

  const seen = new Set<string>();
  const logOnly = config.mode === "observe" || (config.mode === "enforce" && config.egress === "user-directed");
  const decide = (host: string, via: string): void => {
    if (isLoopbackHost(host)) return;
    if (logOnly) {
      if (!seen.has(host)) {
        seen.add(host);
        const why = config.mode === "observe" ? "declares no network egress" : "declares user-directed egress";
        t.log(`net-gate: observed ${via} to ${host} (this poppy ${why} — allowed, logged)`);
      }
      return;
    }
    const ipLiteral = t.isIP(host) !== 0;
    if (ipLiteral || !hostAllowed(host, config.egress)) {
      if (!seen.has(host)) {
        seen.add(host);
        t.log(`net-gate: REFUSED ${via} to ${host} — not in this poppy's declared network egress`);
      }
      const err = new Error(`net-gate: ${host} is not in this poppy's declared network egress — connection refused`) as Error & { code: string };
      err.code = "APP_NET_GATE_REFUSED";
      throw err;
    }
  };

  const realConnect = t.socketProto.connect;
  t.socketProto.connect = function (this: unknown, ...args: unknown[]) {
    const { host, unix } = connectHost(args);
    if (!unix && host) decide(host, "connect");
    return realConnect.apply(this, args);
  };

  for (const mod of [t.dns, t.dnsPromises]) {
    for (const fn of DNS_QUERY_FNS) {
      const real = mod[fn];
      if (typeof real !== "function") continue;
      mod[fn] = function (this: unknown, ...args: unknown[]) {
        if (typeof args[0] === "string") decide(args[0], "DNS query");
        return (real as (...a: unknown[]) => unknown).apply(this, args);
      };
    }
  }

  // The known internal escape hatches. Poisoned last — nothing above needs them.
  const poisoned = () => {
    throw new Error("net-gate: internal bindings are not available to a confined backend");
  };
  if (t.proc.binding !== undefined) t.proc.binding = poisoned;
  if (t.proc._linkedBinding !== undefined) t.proc._linkedBinding = poisoned;
}

/**
 * The real targets. Via createRequire, NOT `import()`: an ES-module namespace object is
 * FROZEN, so patching `dns.lookup` on one throws "Cannot redefine property" — the gate
 * would crash (closed, but broken) on every backend. `require()` returns the builtin's
 * actual mutable module object, which is also the one a CJS poppy bundle sees. Caught by
 * the real-module test below the fakes.
 */
export function realGateTargets(): GateTargets {
  const req = createRequire(import.meta.url);
  const net = req("node:net") as typeof import("node:net");
  return {
    socketProto: net.Socket.prototype as unknown as GateTargets["socketProto"],
    isIP: net.isIP,
    dns: req("node:dns") as Record<string, unknown>,
    dnsPromises: req("node:dns/promises") as Record<string, unknown>,
    proc: process as unknown as GateTargets["proc"],
    log: (line) => console.error(line),
  };
}
