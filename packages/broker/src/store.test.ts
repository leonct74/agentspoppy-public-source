// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { Store } from "./store";
import type { ConnectedAccount, Connection } from "@agentspoppy/core";

function tmpHome(): string {
  return join(tmpdir(), `agentspoppy-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

const conn = (over: Partial<Connection> = {}): Connection => ({
  id: "c1",
  accountId: "a1",
  app: { id: "app", name: "App" },
  status: "pending",
  permissionSet: { id: "p", name: "P", description: "", grants: [], requiredTags: [], limits: null },
  createdAt: "t",
  updatedAt: "t",
  ...over,
});

describe("Store", () => {
  let home: string;
  let store: Store;

  beforeEach(() => {
    home = tmpHome();
    process.env.AGENTSPOPPY_HOME = home;
    store = new Store();
  });
  afterEach(async () => {
    delete process.env.AGENTSPOPPY_HOME;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("starts empty", async () => {
    expect(await store.listAccounts()).toEqual([]);
    expect(await store.listConnections()).toEqual([]);
    expect(await store.getConnection("nope")).toBeUndefined();
  });

  it("persists accounts", async () => {
    const acc: ConnectedAccount = { id: "a1", accountId: "123", regions: ["eu-west-1"], createdAt: "t" };
    await store.addAccount(acc);
    expect(await store.listAccounts()).toEqual([acc]);
  });

  it("upserts a connection by id", async () => {
    await store.putConnection(conn());
    await store.putConnection(conn({ status: "active" }));
    const all = await store.listConnections();
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe("active");
  });

  it("removes a connection, cascading its audit", async () => {
    await store.putConnection(conn({ id: "c1" }));
    await store.putConnection(conn({ id: "c2" }));
    await store.appendAudit("c1", { ts: "t", type: "requested" });

    await store.removeConnection("c1");

    expect((await store.listConnections()).map((c) => c.id)).toEqual(["c2"]);
    expect(await store.getAudit("c1")).toEqual([]);
    // Removing something that isn't there is a no-op, not an error.
    await store.removeConnection("nope");
    expect(await store.listConnections()).toHaveLength(1);
  });

  it("appends and reads audit per connection", async () => {
    await store.appendAudit("c1", { ts: "t1", type: "requested" });
    await store.appendAudit("c1", { ts: "t2", type: "approved" });
    expect((await store.getAudit("c1")).map((e) => e.type)).toEqual(["requested", "approved"]);
    expect(await store.getAudit("other")).toEqual([]);
  });

  // Regression: at app open, several poppy backends mutate the store at once. Before the
  // in-process mutex, interleaved read-modify-writes lost updates — a just-parked supervised
  // approval was erased by a concurrent audit append, and the poppy's poll then answered
  // "approval not found" (the VPN-Poppy red-banner-on-open bug). UNAWAITED concurrent calls
  // are the essence of the repro.
  it("does not lose updates under concurrent mutation", async () => {
    const approval = {
      id: "appr-1",
      connectionId: "c1",
      requestedAt: "t",
      operation: null,
      status: "pending" as const,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await Promise.all([
      store.addApproval(approval),
      store.putConnection(conn()),
      ...Array.from({ length: 10 }, (_, i) => store.appendAudit("c1", { ts: `t${i}`, type: "credentials-issued" })),
      store.addAccount({ id: "a1", accountId: "123", regions: ["eu-west-1"], createdAt: "t" }),
    ]);
    expect(await store.getApproval("appr-1")).toMatchObject({ id: "appr-1", status: "pending" });
    expect(await store.getConnection("c1")).toBeDefined();
    expect((await store.getAudit("c1")).length).toBe(10);
    expect((await store.listAccounts()).length).toBe(1);
  });
});
