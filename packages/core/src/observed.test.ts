// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, expect, it } from "vitest";
import { summarizeObserved } from "./observed";
import type { ActivityEvent } from "./activity";

const ev = (service: string, action: string, time: string): ActivityEvent => ({
  id: `${service}:${action}:${time}`,
  time,
  service,
  action,
  actor: { kind: "poppy", label: "P" },
});

describe("summarizeObserved", () => {
  it("splits changes from reads with the same classifier the rating uses", () => {
    const s = summarizeObserved([
      ev("route53", "ChangeResourceRecordSets", "2026-08-30T10:00:00Z"),
      ev("route53", "ListResourceRecordSets", "2026-08-30T09:00:00Z"),
      ev("route53", "ListResourceRecordSets", "2026-08-29T09:00:00Z"),
    ]);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ service: "route53", changes: 1, reads: 2 });
    expect(s.rows[0].actions).toEqual({ ChangeResourceRecordSets: 1, ListResourceRecordSets: 2 });
    expect(s.changes).toBe(1);
    expect(s.total).toBe(3);
  });

  it("orders change-making services before read-only ones, whatever their recency", () => {
    const s = summarizeObserved([
      ev("ec2", "DescribeInstances", "2026-08-31T10:00:00Z"), // newest, read-only
      ev("ses", "SendEmail", "2026-08-01T10:00:00Z"), // old, but a change
    ]);
    expect(s.rows.map((r) => r.service)).toEqual(["ses", "ec2"]);
  });

  it("counts an unknown verb as a change — overstate, never understate", () => {
    const s = summarizeObserved([ev("ses", "FrobnicateMailbox", "2026-08-30T10:00:00Z")]);
    expect(s.rows[0].changes).toBe(1);
    expect(s.rows[0].reads).toBe(0);
  });

  it("keeps the most recent time per service", () => {
    const s = summarizeObserved([
      ev("s3", "ListAllMyBuckets", "2026-08-01T00:00:00Z"),
      ev("s3", "ListAllMyBuckets", "2026-08-20T00:00:00Z"),
    ]);
    expect(s.rows[0].last).toBe("2026-08-20T00:00:00Z");
  });

  it("summarises an empty window as zero — the caller decides what silence means", () => {
    expect(summarizeObserved([])).toEqual({ total: 0, changes: 0, reads: 0, rows: [] });
  });
});
