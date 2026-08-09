// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ActivityView } from "./ActivityView";
import type { ActivityReport } from "../api/broker";

const report: ActivityReport = {
  summary: { total: 4, external: 2, throughPoppies: 1, byAgentsPoppy: 1 },
  events: [
    { id: "x1", time: new Date().toISOString(), service: "s3", action: "CreateBucket", region: "eu-west-1",
      actor: { kind: "external", label: "IAM user deploy-bot" } },
    { id: "x2", time: new Date().toISOString(), service: "ec2", action: "RunInstances", region: "eu-west-1",
      actor: { kind: "external", label: "Role terraform-ci" } },
    { id: "p1", time: new Date().toISOString(), service: "cloudformation", action: "CreateStack", region: "eu-west-1",
      actor: { kind: "poppy", label: "MailPoppy" } },
    { id: "o1", time: new Date().toISOString(), service: "sts", action: "AssumeRole", region: "us-east-1",
      actor: { kind: "agentspoppy", label: "AgentsPoppy" } },
  ],
};

afterEach(cleanup);

describe("ActivityView", () => {
  it("lists every attributed event and can filter to what happened outside AgentsPoppy", () => {
    render(<ActivityView report={report} onBack={() => {}} />);

    // All four are shown initially.
    expect(screen.getByText("IAM user deploy-bot")).toBeTruthy();
    expect(screen.getByText("MailPoppy")).toBeTruthy();
    expect(screen.getByText("AgentsPoppy")).toBeTruthy();

    // Filtering to "Outside AgentsPoppy" hides the brokered events.
    fireEvent.click(screen.getByRole("tab", { name: /Outside AgentsPoppy/ }));
    expect(screen.getByText("IAM user deploy-bot")).toBeTruthy();
    expect(screen.getByText("Role terraform-ci")).toBeTruthy();
    expect(screen.queryByText("MailPoppy")).toBeNull();
    expect(screen.queryByText("AgentsPoppy")).toBeNull();
  });

  it("wires Back and degrades gracefully when no history is available", () => {
    const onBack = vi.fn();
    render(<ActivityView report={null} onBack={onBack} />);
    expect(screen.getByText("Activity history isn’t available right now.")).toBeTruthy();
    fireEvent.click(screen.getByText("← Dashboard"));
    expect(onBack).toHaveBeenCalled();
  });

  it("collapses a consecutive run of the same background action into one row with a ×N badge", () => {
    // The real-world case: a Lambda role writing a log stream every minute would
    // otherwise monopolise the feed. Tab counts stay raw; only the drawing collapses.
    const noisy: ActivityReport = {
      summary: { total: 4, external: 4, throughPoppies: 0, byAgentsPoppy: 0 },
      events: [0, 1, 2].map((i) => ({
        id: `n${i}`,
        time: new Date(Date.now() - i * 60_000).toISOString(),
        service: "logs",
        action: "CreateLogStream",
        region: "eu-west-1",
        actor: { kind: "external" as const, label: "Role boxord-admin-prod-eu-west-1-lambdaRole" },
      })).concat([{
        id: "d1",
        time: new Date(Date.now() - 4 * 60_000).toISOString(),
        service: "s3",
        action: "CreateBucket",
        region: "eu-west-1",
        actor: { kind: "external" as const, label: "IAM user deploy-bot" },
      }]),
    };
    render(<ActivityView report={noisy} onBack={() => {}} />);

    // One drawn row for the run — not three — carrying the repeat badge.
    expect(screen.getAllByText("Role boxord-admin-prod-eu-west-1-lambdaRole")).toHaveLength(1);
    expect(screen.getByText("×3")).toBeTruthy();
    // The distinct event still gets its own unbadged row.
    expect(screen.getByText("IAM user deploy-bot")).toBeTruthy();
    // The raw count survives in the tab counter.
    expect(screen.getByRole("tab", { name: /Outside AgentsPoppy/ }).textContent).toContain("4");
  });
});
