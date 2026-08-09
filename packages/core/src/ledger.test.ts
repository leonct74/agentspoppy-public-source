// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { readLedger, record, ledgerForConnection } from "./ledger";
import type { LedgerEntry } from "./types";

describe("ledgerForConnection (pure)", () => {
  it("filters entries to one connection", () => {
    const entries: LedgerEntry[] = [
      { ts: "t1", connectionId: "a", action: "created", service: "SES", resourceType: "Identity", name: "x", region: "eu-west-1" },
      { ts: "t2", connectionId: "b", action: "created", service: "S3", resourceType: "Bucket", name: "y", region: "eu-west-1" },
      { ts: "t3", connectionId: "a", action: "deleted", service: "SES", resourceType: "Identity", name: "x", region: "eu-west-1" },
    ];
    expect(ledgerForConnection(entries, "a")).toHaveLength(2);
    expect(ledgerForConnection(entries, "b")).toHaveLength(1);
    expect(ledgerForConnection(entries, "c")).toHaveLength(0);
  });
});

describe("record / readLedger (fs round-trip)", () => {
  let path: string;
  beforeEach(() => {
    path = join(tmpdir(), `agentspoppy-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    process.env.AGENTSPOPPY_LEDGER = path;
  });
  afterEach(async () => {
    delete process.env.AGENTSPOPPY_LEDGER;
    await fs.rm(path, { force: true });
  });

  it("reads an empty array when the file is missing", async () => {
    expect(await readLedger()).toEqual([]);
  });

  it("appends and reads back, attributed per connection", async () => {
    await record([{ connectionId: "a", action: "created", service: "SES", resourceType: "Identity", name: "example.com", region: "eu-west-1" }]);
    await record([{ connectionId: "b", action: "created", service: "S3", resourceType: "Bucket", name: "b-1", region: "eu-west-1" }]);

    const all = await readLedger();
    expect(all).toHaveLength(2);
    expect(all.every((e) => typeof e.ts === "string" && e.ts.length > 0)).toBe(true);
    expect(ledgerForConnection(all, "a")).toHaveLength(1);
  });

  it("is a no-op for an empty batch", async () => {
    await record([]);
    expect(await readLedger()).toEqual([]);
  });
});
