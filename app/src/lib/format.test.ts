// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { accountLabel, formatDateTime, groupConnectionsByAccount, poppyCount, statusLabel } from "./format";
import type { ConnectedAccount, Connection } from "@agentspoppy/core";

const acc = (id: string, over: Partial<ConnectedAccount> = {}): ConnectedAccount => ({
  id,
  accountId: `aws-${id}`,
  regions: ["eu-west-1"],
  createdAt: "t",
  ...over,
});

const conn = (id: string, accountId: string): Connection => ({
  id,
  accountId,
  app: { id: `app-${id}`, name: `App ${id}` },
  status: "active",
  permissionSet: { id: "p", name: "P", description: "", grants: [], requiredTags: [], limits: null },
  createdAt: "t",
  updatedAt: "t",
});

describe("groupConnectionsByAccount", () => {
  it("buckets poppies under their account", () => {
    const groups = groupConnectionsByAccount(
      [acc("a"), acc("b")],
      [conn("1", "a"), conn("2", "a"), conn("3", "b")],
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]?.poppies.map((c) => c.id)).toEqual(["1", "2"]);
    expect(groups[1]?.poppies.map((c) => c.id)).toEqual(["3"]);
  });
});

describe("poppyCount", () => {
  it("singular/plural the family-brand noun", () => {
    expect(poppyCount(0)).toBe("0 poppies");
    expect(poppyCount(1)).toBe("1 poppy");
    expect(poppyCount(3)).toBe("3 poppies");
  });
});

describe("formatDateTime", () => {
  it("renders an absolute local date + time for a valid ISO timestamp", () => {
    // Locale/timezone-dependent, so assert structure rather than an exact string:
    // a mid-year date carries the year in every time zone, and there's a clock.
    const out = formatDateTime("2026-06-21T14:32:00Z");
    expect(out).toContain("2026");
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });

  it("returns an empty string for an unparseable timestamp", () => {
    expect(formatDateTime("not-a-date")).toBe("");
    expect(formatDateTime("")).toBe("");
  });
});

describe("statusLabel / accountLabel", () => {
  it("labels statuses", () => {
    expect(statusLabel("pending")).toMatch(/approval/i);
    expect(statusLabel("active")).toBe("Active");
  });
  it("prefers alias when present", () => {
    expect(accountLabel(acc("a", { alias: "Personal", accountId: "123" }))).toBe("Personal (123)");
    expect(accountLabel(acc("a", { accountId: "123" }))).toBe("123");
  });
});
