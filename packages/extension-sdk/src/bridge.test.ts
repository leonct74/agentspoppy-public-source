// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi } from "vitest";
import type { AuditEntry, Connection } from "@agentspoppy/core";
import type { Capability } from "./capabilities";
import type { BridgeTransport, HostBridge } from "./index";
import { createHostBridgeClient, handleHostRequest } from "./bridge";
import type { HostRequest, HostResponse } from "./host-api";

const fakeConnection = { id: "c1", status: "active" } as unknown as Connection;
const fakeAudit = [{ ts: "t", type: "requested" }] as AuditEntry[];

/** A host bridge that records calls and returns canned values; getInventory throws. */
function makeBridge() {
  const calls: Array<[string, unknown[]]> = [];
  const bridge: HostBridge = {
    ensureAccess: async (op) => {
      calls.push(["ensureAccess", [op]]);
      return "granted";
    },
    getConnection: async () => {
      calls.push(["getConnection", []]);
      return fakeConnection;
    },
    getAudit: async () => {
      calls.push(["getAudit", []]);
      return fakeAudit;
    },
    getInventory: async () => {
      calls.push(["getInventory", []]);
      throw new Error("inventory unavailable");
    },
    invokeBackend: async (req) => {
      calls.push(["invokeBackend", [req]]);
      return { echoed: req };
    },
    openExternal: async (url) => {
      calls.push(["openExternal", [url]]);
    },
    notify: async (n) => {
      calls.push(["notify", [n]]);
    },
  };
  return { bridge, calls };
}

/**
 * Wire a guest client to a host whose declared capabilities are `caps`. Requests flow
 * client → transport → handleHostRequest → response, exactly as the iframe bridge will.
 */
function wired(caps: readonly Capability[]) {
  const { bridge, calls } = makeBridge();
  let onResponse: ((r: HostResponse) => void) | null = null;
  const transport: BridgeTransport = {
    post(req: HostRequest) {
      // Async hop, like postMessage.
      void handleHostRequest(req, { capabilities: caps, bridge }).then((res) => onResponse?.(res));
    },
    subscribe(handler) {
      onResponse = handler;
      return () => {
        onResponse = null;
      };
    },
  };
  const client = createHostBridgeClient(transport, { timeoutMs: 500 });
  return { client, calls };
}

const ALL: Capability[] = ["aws:credentials", "connection:read", "backend:invoke", "host:openExternal", "host:notify"];

describe("bridge round-trip (client ⇄ handleHostRequest)", () => {
  it("dispatches a granted call and returns the host result", async () => {
    const { client, calls } = wired(ALL);
    await expect(client.ensureAccess()).resolves.toBe("granted");
    const conn = await client.getConnection();
    expect(conn.id).toBe("c1");
    await client.invokeBackend({ method: "POST", path: "/deploy" });
    expect(calls.map((c) => c[0])).toEqual(["ensureAccess", "getConnection", "invokeBackend"]);
  });

  it("rejects a call whose capability the manifest did not declare", async () => {
    // connection:read granted, but NOT aws:credentials → ensureAccess must be refused.
    const { client, calls } = wired(["connection:read"]);
    await expect(client.getConnection()).resolves.toBeTruthy();
    await expect(client.ensureAccess()).rejects.toThrow(/capability "aws:credentials" is not granted/);
    expect(calls.some((c) => c[0] === "ensureAccess")).toBe(false); // never reached the impl
  });

  it("propagates a host implementation error as a rejection", async () => {
    const { client } = wired(ALL);
    await expect(client.getInventory()).rejects.toThrow(/inventory unavailable/);
  });

  it("rejects an unknown method without touching the bridge", async () => {
    const { bridge } = makeBridge();
    const res = await handleHostRequest({ id: "x", method: "evilMethod" as never, params: [] }, { capabilities: ALL, bridge });
    expect(res).toMatchObject({ id: "x", ok: false });
    if (!res.ok) expect(res.error).toMatch(/unknown host method: evilMethod/);
  });

  it("times out if the host never answers", async () => {
    vi.useFakeTimers();
    const transport: BridgeTransport = { post() {}, subscribe: () => () => {} }; // black hole
    const client = createHostBridgeClient(transport, { timeoutMs: 1000 });
    const p = client.getAudit();
    const assertion = expect(p).rejects.toThrow(/timed out after 1000ms/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    vi.useRealTimers();
  });
});
