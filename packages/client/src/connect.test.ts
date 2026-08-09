// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi } from "vitest";
import {
  connect,
  getConnection,
  requestConnection,
  waitForApproval,
  type Connection,
  type PermissionSet,
} from "./connect";
import type { FetchLike } from "./credentials";

const PERMS: PermissionSet = {
  id: "demo.default",
  name: "DemoPoppy",
  description: "Demo",
  grants: [{ service: "s3", actions: ["PutObject"], resourceScope: "tagged-as-self" }],
  requiredTags: ["agentspoppy:connection"],
  limits: null,
};

function conn(status: Connection["status"], id = "c1"): Connection {
  return {
    id,
    accountId: "a1",
    app: { id: "com.demo.poppy", name: "DemoPoppy" },
    status,
    permissionSet: PERMS,
    createdAt: "t",
    updatedAt: "t",
  };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const noSleep = () => Promise.resolve();

describe("requestConnection", () => {
  it("POSTs the app + permission set and returns the pending connection", async () => {
    let seen: { url: string; method?: string; body?: string } | undefined;
    const fetchFn: FetchLike = async (url, init) => {
      seen = { url, method: init?.method, body: init?.body };
      return jsonResponse(conn("pending"), 201);
    };

    const c = await requestConnection(
      { accountId: "a1", app: { id: "com.demo.poppy", name: "DemoPoppy" }, permissionSet: PERMS },
      { baseUrl: "http://h:9", fetchFn },
    );

    expect(c.status).toBe("pending");
    expect(seen?.method).toBe("POST");
    expect(seen?.url).toBe("http://h:9/connections");
    expect(JSON.parse(seen?.body ?? "{}").app.id).toBe("com.demo.poppy");
  });

  it("rejects missing app.id / accountId before hitting the network", async () => {
    const fetchFn = vi.fn();
    await expect(
      requestConnection({ accountId: "a1", app: { id: "", name: "x" }, permissionSet: PERMS }, { fetchFn }),
    ).rejects.toMatchObject({ name: "BrokerRequestError" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("waitForApproval", () => {
  it("polls until the connection becomes active", async () => {
    const statuses: Connection["status"][] = ["pending", "pending", "active"];
    let i = 0;
    const fetchFn: FetchLike = async () => jsonResponse(conn(statuses[i++] ?? "active"));
    const onPending = vi.fn();

    const c = await waitForApproval("c1", { fetchFn, sleep: noSleep, onPending });
    expect(c.status).toBe("active");
    expect(onPending).toHaveBeenCalledTimes(2); // two pending polls before active
  });

  it("rejects when the connection is denied/revoked", async () => {
    const fetchFn: FetchLike = async () => jsonResponse(conn("revoked"));
    await expect(waitForApproval("c1", { fetchFn, sleep: noSleep })).rejects.toMatchObject({ code: "revoked" });
  });

  it("times out if approval never comes", async () => {
    const fetchFn: FetchLike = async () => jsonResponse(conn("pending"));
    let t = 0;
    const now = () => (t += 1000); // each check advances the clock 1s
    await expect(
      waitForApproval("c1", { fetchFn, sleep: noSleep, now, timeoutMs: 2000 }),
    ).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("getConnection", () => {
  it("GETs the encoded connection id", async () => {
    let seen: string | undefined;
    const fetchFn: FetchLike = async (url) => {
      seen = url;
      return jsonResponse(conn("active", "x/y"));
    };
    await getConnection("x/y", { baseUrl: "http://h:9", fetchFn });
    expect(seen).toBe("http://h:9/connections/x%2Fy");
  });
});

describe("connect", () => {
  it("reuses an existing non-revoked connection for the same app+account", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/connections")) return jsonResponse([conn("active")]);
      throw new Error(`unexpected ${url}`);
    });

    const { connection, credentials } = await connect(
      { accountId: "a1", app: { id: "com.demo.poppy", name: "DemoPoppy" }, permissionSet: PERMS },
      { fetchFn },
    );

    expect(connection.status).toBe("active");
    expect(typeof credentials).toBe("function");
    // Only the list call — no POST /connections, no approval polling.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("requests a new connection and waits for approval when none exists", async () => {
    const seq: Array<{ ok: boolean; status: number; json(): Promise<unknown> }> = [
      jsonResponse([]), // list: none to reuse
      jsonResponse(conn("pending"), 201), // requestConnection
      jsonResponse(conn("pending")), // waitForApproval poll 1
      jsonResponse(conn("active")), // waitForApproval poll 2
    ];
    let i = 0;
    const fetchFn: FetchLike = async () => seq[i++]!;

    const { connection } = await connect(
      { accountId: "a1", app: { id: "com.demo.poppy", name: "DemoPoppy" }, permissionSet: PERMS },
      { fetchFn, sleep: noSleep },
    );

    expect(connection.status).toBe("active");
    expect(i).toBe(4);
  });
});
