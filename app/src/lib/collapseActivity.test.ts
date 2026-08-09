// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import type { ActivityEvent } from "@agentspoppy/core";
import { collapseActivity } from "./collapseActivity";

let seq = 0;
function ev(over: Partial<ActivityEvent> & { label?: string } = {}): ActivityEvent {
  const { label, ...rest } = over;
  return {
    id: `e${seq++}`,
    time: `2026-07-04T10:${String(59 - seq).padStart(2, "0")}:00Z`,
    service: "logs",
    action: "CreateLogStream",
    region: "eu-west-1",
    actor: { kind: "external", label: label ?? "Role boxord-lambdaRole" },
    ...rest,
  };
}

describe("collapseActivity", () => {
  it("merges a consecutive run into one row with the count and the run's span", () => {
    const run = [ev(), ev(), ev(), ev()];
    const out = collapseActivity(run);
    expect(out).toHaveLength(1);
    expect(out[0]?.count).toBe(4);
    expect(out[0]?.event.id).toBe(run[0]?.id); // the newest event fronts the row
    expect(out[0]?.firstTime).toBe(run[3]?.time); // span reaches back to the oldest
  });

  it("does NOT merge across an interleaved different event — the timeline stays truthful", () => {
    const out = collapseActivity([
      ev(),
      ev(),
      ev({ action: "StartExecution", service: "states" }),
      ev(),
    ]);
    expect(out.map((r) => r.count)).toEqual([2, 1, 1]);
  });

  it("splits runs on actor, region, and connection differences", () => {
    const out = collapseActivity([
      ev({ label: "Role a" }),
      ev({ label: "Role b" }),
      ev({ label: "Role b", region: "us-east-1" }),
      ev({ actor: { kind: "poppy", label: "MailPoppy", connectionId: "c1" } }),
      ev({ actor: { kind: "poppy", label: "MailPoppy", connectionId: "c2" } }),
    ]);
    expect(out).toHaveLength(5);
    expect(out.every((r) => r.count === 1)).toBe(true);
  });

  it("ignores per-session principal ARNs — the noisiest case must still collapse", () => {
    // Assumed-role sessions carry a fresh session name per invocation; identity
    // for collapsing is the VISIBLE row (label+action), not the raw principal.
    const out = collapseActivity([
      ev({ actor: { kind: "external", label: "Role x", arn: "arn:...:assumed-role/x/session-1" } }),
      ev({ actor: { kind: "external", label: "Role x", arn: "arn:...:assumed-role/x/session-2" } }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.count).toBe(2);
  });

  it("passes an empty feed through", () => {
    expect(collapseActivity([])).toEqual([]);
  });
});
