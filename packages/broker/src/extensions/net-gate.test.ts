// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The machine gate (docs/specs/machine-gate.md). Everything runs against injected
 * fakes — a unit test must never touch the real network layer it is patching.
 */
import { describe, expect, it } from "vitest";
import type { GateTargets } from "./net-gate";
import { armNetGate, gateEnvFor, hostAllowed, isLoopbackHost, machineGateStateFor, NET_GATE_ENV, parseGateLogLine } from "./net-gate";
import type { ExtensionManifest } from "@agentspoppy/extension-sdk";

describe("hostAllowed — the pure decision", () => {
  it("'none' allows nothing external", () => {
    expect(hostAllowed("api.example.com", "none")).toBe(false);
    expect(hostAllowed("sts.amazonaws.com", "none")).toBe(false);
  });
  it("'aws-only' allows both AWS endpoint families, nothing else", () => {
    expect(hostAllowed("sts.eu-west-1.amazonaws.com", "aws-only")).toBe(true);
    expect(hostAllowed("lambda.eu-west-1.api.aws", "aws-only")).toBe(true);
    expect(hostAllowed("evil.example", "aws-only")).toBe(false);
    // suffix means suffix — not substring: a lookalike domain must not pass
    expect(hostAllowed("amazonaws.com.evil.example", "aws-only")).toBe(false);
    expect(hostAllowed("notamazonaws.com", "aws-only")).toBe(false);
  });
  it("a domain list is exact hosts, case-insensitive, no subdomain inheritance", () => {
    expect(hostAllowed("API.Stripe.com", ["api.stripe.com"])).toBe(true);
    expect(hostAllowed("sub.api.stripe.com", ["api.stripe.com"])).toBe(false);
  });
  it("loopback is recognized in its spellings", () => {
    for (const h of ["localhost", "127.0.0.1", "127.5.5.5", "::1"]) expect(isLoopbackHost(h)).toBe(true);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
  });
});

function fakeTargets() {
  const connects: string[] = [];
  const logs: string[] = [];
  const socketProto = {
    connect: (...args: unknown[]) => {
      connects.push(JSON.stringify(args[0]));
      return "connected";
    },
  };
  const dns: Record<string, unknown> = { resolve: (_h: string) => "resolved", lookup: (_h: string) => "looked-up" };
  const dnsPromises: Record<string, unknown> = { resolve4: (_h: string) => "resolved4" };
  const proc: { binding?: unknown; _linkedBinding?: unknown } = { binding: () => "raw", _linkedBinding: () => "raw" };
  const t: GateTargets = {
    socketProto,
    isIP: (h) => (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? 4 : 0),
    dns,
    dnsPromises,
    proc,
    log: (l) => logs.push(l),
  };
  return { t, connects, logs, socketProto, dns, dnsPromises, proc };
}

const enforce = (egress: unknown) => JSON.stringify({ mode: "enforce", egress });

describe("armNetGate — enforce mode", () => {
  it("refuses an undeclared host with a coded error, allows declared and loopback", () => {
    const { t, socketProto, connects } = fakeTargets();
    armNetGate(enforce(["api.stripe.com"]), t);
    expect(() => socketProto.connect({ host: "evil.example", port: 443 })).toThrowError(/declared network egress/);
    try {
      socketProto.connect({ host: "evil.example", port: 443 });
    } catch (e) {
      expect((e as { code?: string }).code).toBe("APP_NET_GATE_REFUSED");
    }
    expect(socketProto.connect({ host: "api.stripe.com", port: 443 })).toBe("connected");
    expect(socketProto.connect({ host: "127.0.0.1", port: 8799 })).toBe("connected");
    expect(socketProto.connect(8799)).toBe("connected"); // port-only form defaults to localhost
    expect(socketProto.connect({ path: "/tmp/sock" })).toBe("connected"); // unix path is local
    expect(connects.length).toBe(4);
  });

  it("refuses raw IP literals — declarations name hosts", () => {
    const { t, socketProto } = fakeTargets();
    armNetGate(enforce(["api.stripe.com"])!, t);
    expect(() => socketProto.connect({ host: "93.184.216.34", port: 443 })).toThrowError(/refused/);
  });

  it("gates DNS queries the same way — the quiet exit", () => {
    const { t, dns, dnsPromises } = fakeTargets();
    armNetGate(enforce("aws-only"), t);
    expect(() => (dns.resolve as (h: string) => unknown)("secrets.evil.example")).toThrowError(/declared network egress/);
    expect((dns.lookup as (h: string) => unknown)("sts.amazonaws.com")).toBe("looked-up");
    expect(() => (dnsPromises.resolve4 as (h: string) => unknown)("evil.example")).toThrowError(/declared network egress/);
  });

  it("poisons the internal binding escape hatches", () => {
    const { t, proc } = fakeTargets();
    armNetGate(enforce("none"), t);
    expect(() => (proc.binding as () => unknown)()).toThrowError(/not available/);
    expect(() => (proc._linkedBinding as () => unknown)()).toThrowError(/not available/);
  });

  it("fails closed on malformed config — the caller must not start the backend", () => {
    const { t } = fakeTargets();
    expect(() => armNetGate("not json", t)).toThrow();
    expect(() => armNetGate(JSON.stringify({ mode: "whatever" }), t)).toThrowError(/unknown mode/);
    expect(() => armNetGate(enforce("everywhere"), t)).toThrowError(/malformed egress/);
  });
});

describe("armNetGate — observe mode (undeclared poppies: never break, always log)", () => {
  it("allows everything external and logs each destination once", () => {
    const { t, socketProto, logs } = fakeTargets();
    armNetGate(JSON.stringify({ mode: "observe" }), t);
    expect(socketProto.connect({ host: "telemetry.example", port: 443 })).toBe("connected");
    expect(socketProto.connect({ host: "telemetry.example", port: 443 })).toBe("connected");
    expect(socketProto.connect({ host: "127.0.0.1", port: 1 })).toBe("connected");
    expect(logs.filter((l) => l.includes("telemetry.example"))).toHaveLength(1);
    expect(logs.some((l) => l.includes("127.0.0.1"))).toBe(false); // loopback is not egress
  });
});

describe("armNetGate — user-directed (log-only by nature)", () => {
  it("allows external destinations, logs each once, refuses nothing", () => {
    const { t, socketProto, logs } = fakeTargets();
    armNetGate(enforce("user-directed"), t);
    expect(socketProto.connect({ host: "anywhere.example", port: 443 })).toBe("connected");
    expect(socketProto.connect({ host: "anywhere.example", port: 443 })).toBe("connected");
    expect(logs.filter((l) => l.includes("anywhere.example") && l.includes("user-directed"))).toHaveLength(1);
  });
});

describe("gateEnvFor — where the gate can hold", () => {
  const manifest = (over: Partial<ExtensionManifest["backend"]> | null, network?: unknown): ExtensionManifest =>
    ({
      id: "com.example.p", name: "P", version: "1.0.0",
      permissionSet: { id: "p", name: "P", description: "", grants: [], requiredTags: [], limits: null, ...(network ? { network } : {}) },
      frontend: { entry: "ui/index.html" },
      ...(over === null ? {} : { backend: { entry: "backend/index.cjs", ...over } }),
      capabilities: [],
    }) as unknown as ExtensionManifest;

  it("enforce for a declared, confined node22 backend; observe for an undeclared one", () => {
    expect(JSON.parse(gateEnvFor(manifest({}, { egress: "none", machine: "aws-only" }))!)).toEqual({ mode: "enforce", egress: "aws-only" });
    expect(JSON.parse(gateEnvFor(manifest({}))!)).toEqual({ mode: "observe" });
  });

  // The plane law: `egress` is about the Lambdas a poppy deploys. Enforcing it on this
  // process would refuse desktop traffic nobody declared anything about — the vendor
  // Hub a poppy's own UI calls, an IMAP server the user typed.
  it("a cloud-only declaration leaves the machine gate observing — it said nothing about here", () => {
    expect(JSON.parse(gateEnvFor(manifest({}, { egress: "aws-only" }))!)).toEqual({ mode: "observe" });
  });

  it("declaring 'none' for the machine is enforcement, not absence — the distinction the env must carry", () => {
    expect(JSON.parse(gateEnvFor(manifest({}, { egress: "aws-only", machine: "none" }))!)).toEqual({ mode: "enforce", egress: "none" });
  });

  it("null where the gate cannot hold — native runtime, unconfined, or no backend at all", () => {
    expect(gateEnvFor(manifest({ runtime: "native", isolation: "none" }))).toBeNull();
    expect(gateEnvFor(manifest({ isolation: "none" }))).toBeNull();
    expect(gateEnvFor(manifest(null))).toBeNull();
  });

  it("the env var name is the stable contract with serve.ts", () => {
    expect(NET_GATE_ENV).toBe("AGENTSPOPPY_NET_GATE");
  });
});

describe("armNetGate — against the REAL runtime modules (saved and restored)", () => {
  it("arms on the actual net/dns prototypes and refuses before any I/O happens", async () => {
    const { realGateTargets } = await import("./net-gate");
    const net = await import("node:net");
    const dns = await import("node:dns");
    const dnsPromises = await import("node:dns/promises");
    const savedConnect = net.Socket.prototype.connect;
    const savedDns: Record<string, unknown> = {};
    const savedDnsP: Record<string, unknown> = {};
    for (const k of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveTxt", "resolveMx", "resolveNs", "resolveSrv"]) {
      savedDns[k] = (dns as unknown as Record<string, unknown>)[k];
      savedDnsP[k] = (dnsPromises as unknown as Record<string, unknown>)[k];
    }
    const savedBinding = (process as unknown as { binding?: unknown }).binding;
    const savedLinked = (process as unknown as { _linkedBinding?: unknown })._linkedBinding;
    try {
      const targets = realGateTargets();
      targets.log = () => {}; // keep the runner's stderr clean
      armNetGate(JSON.stringify({ mode: "enforce", egress: "none" }), targets);
      // The refusal throws synchronously — no packet leaves the machine in this test.
      const s = new net.Socket();
      expect(() => s.connect({ host: "example.com", port: 443 })).toThrowError(/declared network egress/);
      s.destroy();
      // Read dns the way a CJS poppy bundle does (require), not through the frozen
      // ESM namespace — reassigned properties do not propagate to namespace bindings.
      const { createRequire } = await import("node:module");
      const cjsDns = createRequire(import.meta.url)("node:dns") as { resolve: (h: string, cb: () => void) => void };
      expect(() => cjsDns.resolve("example.com", () => {})).toThrowError(/declared network egress/);
    } finally {
      net.Socket.prototype.connect = savedConnect;
      for (const [k, v] of Object.entries(savedDns)) ((dns as unknown as Record<string, unknown>)[k] = v);
      for (const [k, v] of Object.entries(savedDnsP)) ((dnsPromises as unknown as Record<string, unknown>)[k] = v);
      (process as unknown as { binding?: unknown }).binding = savedBinding;
      (process as unknown as { _linkedBinding?: unknown })._linkedBinding = savedLinked;
    }
  });
});

describe("frontendCsp — the tab's half of the gate", () => {
  it("null for an undeclared manifest — observe mode never breaks an older poppy", async () => {
    const { frontendCsp } = await import("./frontend-csp");
    expect(frontendCsp(undefined)).toBeNull();
    // Door 1 alone restricts nothing here: it describes the cloud code, not this tab.
    expect(frontendCsp({ egress: "aws-only" })).toBeNull();
    // user-directed: no list exists — restricting the tab would break the declared behaviour
    expect(frontendCsp({ egress: "none", machine: "user-directed" })).toBeNull();
  });

  it("'none' keeps the tab to itself and loopback; declared hosts appear verbatim; aws-only maps to the AWS families", async () => {
    const { frontendCsp } = await import("./frontend-csp");
    const none = frontendCsp({ egress: "none", machine: "none" })!;
    expect(none).toContain("default-src 'self'");
    expect(none).toContain("connect-src 'self' http://127.0.0.1:*");
    expect(none).not.toContain("https://*"); // no external family beyond the platform's own API
    const listed = frontendCsp({ egress: "none", machine: ["api.stripe.com"] })!;
    expect(listed).toContain("https://api.stripe.com");
    expect(listed).toContain("form-action 'self' https://api.stripe.com");
    const aws = frontendCsp({ egress: "none", machine: "aws-only" })!;
    expect(aws).toContain("https://*.amazonaws.com https://*.api.aws");
  });

  // AGENTS.md §9a makes the Feedback tab mandatory, and it posts to the platform's API
  // from the poppy's own frontend. A gate that refused it would break a tab the platform
  // itself requires — the host contradicting its own contract.
  it("the platform's own API is never collateral — even for a poppy declaring 'none'", async () => {
    const { frontendCsp, PLATFORM_API_ORIGIN } = await import("./frontend-csp");
    for (const machine of ["none", "aws-only", ["api.stripe.com"]] as const) {
      const csp = frontendCsp({ egress: "none", machine })!;
      expect(csp).toContain(`connect-src`);
      expect(csp.split("; ").find((d) => d.startsWith("connect-src"))).toContain(PLATFORM_API_ORIGIN);
    }
    // connect-src ONLY: the tab may talk to the platform, not post forms or beacon images at it.
    const csp = frontendCsp({ egress: "none", machine: "none" })!;
    expect(csp.split("; ").find((d) => d.startsWith("img-src"))).not.toContain(PLATFORM_API_ORIGIN);
    expect(csp.split("; ").find((d) => d.startsWith("form-action"))).not.toContain(PLATFORM_API_ORIGIN);
  });
});

describe("machineGateStateFor — what the registry reports, what the screen may trust", () => {
  const m = (backend: object | null, network?: unknown): ExtensionManifest =>
    ({
      id: "com.example.p", name: "P", version: "1.0.0",
      permissionSet: { id: "p", name: "P", description: "", grants: [], requiredTags: [], limits: null, ...(network ? { network } : {}) },
      frontend: { entry: "ui/index.html" },
      ...(backend === null ? {} : { backend: { entry: "backend/index.cjs", ...backend } }),
      capabilities: [],
    }) as unknown as ExtensionManifest;

  it("enforced for declared poppies whose halves all hold; observed for undeclared confined backends", () => {
    expect(machineGateStateFor(m({}, { egress: "none", machine: "aws-only" }), { backendGateAvailable: true })).toBe("enforced");
    expect(machineGateStateFor(m(null, { egress: "none", machine: "none" }), { backendGateAvailable: false })).toBe("enforced"); // frontend-only: CSP is the whole gate
    expect(machineGateStateFor(m({}), { backendGateAvailable: true })).toBe("observed");
  });

  it("a cloud declaration earns nothing here — it said nothing about this machine", () => {
    expect(machineGateStateFor(m({}, { egress: "aws-only" }), { backendGateAvailable: true })).toBe("observed");
    expect(machineGateStateFor(m(null, { egress: "aws-only" }), { backendGateAvailable: true })).toBe("none");
  });

  it("user-directed reports observed, never enforced — the log is real, the refusal is not", () => {
    expect(machineGateStateFor(m({}, { egress: "none", machine: "user-directed" }), { backendGateAvailable: true })).toBe("observed");
  });

  it("a dev-path host must not report the chip a packaged host earns", () => {
    expect(machineGateStateFor(m({}, { egress: "none", machine: "aws-only" }), { backendGateAvailable: false })).toBe("none");
  });

  it("none where a half cannot hold, or where nothing observes", () => {
    expect(machineGateStateFor(m({ runtime: "native", isolation: "none" }, { egress: "none", machine: "none" }), { backendGateAvailable: true })).toBe("none");
    expect(machineGateStateFor(m({ isolation: "none" }, { egress: "none", machine: "none" }), { backendGateAvailable: true })).toBe("none");
    expect(machineGateStateFor(m(null), { backendGateAvailable: true })).toBe("none"); // frontend-only undeclared: no log is kept, say so
  });
});

describe("parseGateLogLine — the child-to-broker wire format", () => {
  it("round-trips the gate's own refusal and observation lines", () => {
    expect(parseGateLogLine("net-gate: REFUSED connect to evil.example — not in this poppy's declared network egress"))
      .toEqual({ kind: "refused", via: "connect", host: "evil.example" });
    expect(parseGateLogLine("net-gate: REFUSED DNS query to evil.example — not in this poppy's declared network egress"))
      .toEqual({ kind: "refused", via: "DNS query", host: "evil.example" });
    expect(parseGateLogLine("net-gate: observed connect to telemetry.example (this poppy declares no network egress — allowed, logged)"))
      .toEqual({ kind: "observed", via: "connect", host: "telemetry.example" });
  });

  it("returns null for everything else — a poppy's ordinary stderr is not an event", () => {
    expect(parseGateLogLine("Error: something exploded")).toBeNull();
    expect(parseGateLogLine("net-gate: failed to arm — refusing to start the backend: x")).toBeNull();
  });

  it("the emitted log lines and the parser agree — mutation check via a real armed gate", () => {
    const logs: string[] = [];
    const { t } = (() => {
      const socketProto = { connect: () => "connected" };
      return { t: { socketProto, isIP: () => 0, dns: {}, dnsPromises: {}, proc: {}, log: (l: string) => logs.push(l) } as GateTargets };
    })();
    armNetGate(JSON.stringify({ mode: "enforce", egress: "none" }), t);
    try { t.socketProto.connect({ host: "evil.example", port: 443 }); } catch { /* expected */ }
    expect(logs).toHaveLength(1);
    expect(parseGateLogLine(logs[0]!)).toEqual({ kind: "refused", via: "connect", host: "evil.example" });
  });
});
