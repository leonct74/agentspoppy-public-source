// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createBrokerCredentialProvider, type FetchLike, type ScopedCredentials } from "./credentials";

const HOUR = 3_600_000;

function creds(expMs: number): ScopedCredentials {
  return {
    accessKeyId: "ASIA1",
    secretAccessKey: "sk",
    sessionToken: "tok",
    expiration: new Date(expMs).toISOString(),
  };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("createBrokerCredentialProvider", () => {
  it("mints once and caches while the credentials are fresh", async () => {
    let calls = 0;
    let now = Date.parse("2026-01-01T00:00:00Z");
    const fetchFn: FetchLike = async () => {
      calls++;
      return jsonResponse(creds(now + HOUR));
    };
    const provider = createBrokerCredentialProvider({ connectionId: "c1", fetchFn, now: () => now });

    const a = await provider();
    const b = await provider();
    expect(calls).toBe(1);
    expect(a.accessKeyId).toBe("ASIA1");
    expect(a.expiration).toBeInstanceOf(Date);
    expect(b.sessionToken).toBe("tok");
  });

  it("re-mints once the clock is within the refresh buffer of expiry", async () => {
    let calls = 0;
    let now = Date.parse("2026-01-01T00:00:00Z");
    const fetchFn: FetchLike = async () => {
      calls++;
      return jsonResponse(creds(now + HOUR)); // each mint expires an hour after "now"
    };
    const provider = createBrokerCredentialProvider({
      connectionId: "c1",
      fetchFn,
      now: () => now,
      refreshBufferSeconds: 300,
    });

    await provider();
    expect(calls).toBe(1);

    now += HOUR - 100_000; // within the 5-min buffer of the first token's expiry
    await provider();
    expect(calls).toBe(2);
  });

  it("re-mints after the token has fully expired", async () => {
    let calls = 0;
    let now = Date.parse("2026-01-01T00:00:00Z");
    const fetchFn: FetchLike = async () => {
      calls++;
      return jsonResponse(creds(now + HOUR));
    };
    const provider = createBrokerCredentialProvider({ connectionId: "c1", fetchFn, now: () => now });

    await provider();
    now += HOUR + 60_000; // past expiry
    await provider();
    expect(calls).toBe(2);
  });

  it("coalesces concurrent calls into a single mint", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchFn: FetchLike = async () => {
      calls++;
      await gate;
      return jsonResponse(creds(Date.now() + HOUR));
    };
    const provider = createBrokerCredentialProvider({ connectionId: "c1", fetchFn });

    const p1 = provider();
    const p2 = provider();
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    expect(r1.accessKeyId).toBe(r2.accessKeyId);
  });

  it("surfaces a paused/revoked connection as a BrokerCredentialError", async () => {
    const fetchFn: FetchLike = async () =>
      jsonResponse({ error: "invalid_state", message: "cannot issue credentials for a paused connection" }, 409);
    const provider = createBrokerCredentialProvider({ connectionId: "c1", fetchFn });

    await expect(provider()).rejects.toMatchObject({
      name: "BrokerCredentialError",
      status: 409,
      code: "invalid_state",
    });
  });

  it("POSTs to the connection's credentials endpoint with an encoded id", async () => {
    let seen: { url: string; method?: string } | undefined;
    const fetchFn: FetchLike = async (url, init) => {
      seen = { url, method: init?.method };
      return jsonResponse(creds(Date.now() + HOUR));
    };
    const provider = createBrokerCredentialProvider({ connectionId: "conn 1/x", baseUrl: "http://h:9", fetchFn });

    await provider();
    expect(seen?.method).toBe("POST");
    expect(seen?.url).toBe("http://h:9/connections/conn%201%2Fx/credentials");
  });

  const pendingApproval = (status = "pending") => ({
    approvalRequired: true,
    approval: { id: "ap1", connectionId: "c1", requestedAt: "t", operation: { summary: "Delete pool", grants: [] }, status, expiresAt: "t" },
  });

  it("waits for a supervised approval, polling until the user approves, then mints", async () => {
    let call = 0;
    const bodies: string[] = [];
    const fetchFn: FetchLike = async (_url, init) => {
      call++;
      bodies.push(init?.body ?? "");
      if (call <= 2) return jsonResponse(pendingApproval(), 202); // requested, then still pending
      return jsonResponse(creds(Date.now() + HOUR)); // approved → vended
    };
    const pendings: string[] = [];
    const provider = createBrokerCredentialProvider({
      connectionId: "c1",
      fetchFn,
      operation: { summary: "Delete pool", grants: [] },
      approvalPollMs: 1,
      sleep: async () => {},
      onApprovalPending: (a) => pendings.push(a.id),
    });

    const c = await provider();
    expect(c.accessKeyId).toBe("ASIA1");
    expect(call).toBe(3);
    expect(pendings).toEqual(["ap1", "ap1"]);
    expect(bodies[0]).toContain("operation"); // first request carries the intent
    expect(bodies[1]).toContain("approvalId"); // polls echo the approval id
  });

  it("rejects when the user denies a supervised operation", async () => {
    let call = 0;
    const fetchFn: FetchLike = async () => {
      call++;
      if (call === 1) return jsonResponse(pendingApproval(), 202);
      return jsonResponse({ error: "invalid_state", message: "this operation was denied by the user" }, 409);
    };
    const provider = createBrokerCredentialProvider({
      connectionId: "c1",
      fetchFn,
      operation: { summary: "Delete pool", grants: [] },
      approvalPollMs: 1,
      sleep: async () => {},
    });

    await expect(provider()).rejects.toMatchObject({ status: 409, code: "invalid_state" });
  });

  it("times out if approval never comes", async () => {
    let t = 0;
    const fetchFn: FetchLike = async () => jsonResponse(pendingApproval(), 202);
    const provider = createBrokerCredentialProvider({
      connectionId: "c1",
      fetchFn,
      operation: { summary: "Delete pool", grants: [] },
      approvalPollMs: 1,
      approvalTimeoutMs: 50,
      sleep: async () => {
        t += 30; // advance the injected clock by 30ms each poll
      },
      now: () => t,
    });
    await expect(provider()).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("createBrokerCredentialProvider over real HTTP", () => {
  let server: Server;
  let base: string;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method === "POST" && /^\/connections\/.+\/credentials$/.test(req.url ?? "")) {
        hits++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(creds(Date.now() + HOUR)));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("fetches over the wire (default global fetch) and caches", async () => {
    const before = hits;
    const provider = createBrokerCredentialProvider({ connectionId: "c1", baseUrl: base });
    const a = await provider();
    await provider();
    expect(a.accessKeyId).toBe("ASIA1");
    expect(hits - before).toBe(1);
  });

  it("re-mints over the wire when the buffer forces a refresh every call", async () => {
    const before = hits;
    const provider = createBrokerCredentialProvider({
      connectionId: "c2",
      baseUrl: base,
      refreshBufferSeconds: 10_000_000, // always "within buffer" → refresh each call
    });
    await provider();
    await provider();
    expect(hits - before).toBe(2);
  });
});
