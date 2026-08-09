// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ConnectionsView } from "./ConnectionsView";
import type { AccountGroup } from "../lib/format";

const groups: AccountGroup[] = [
  {
    account: { id: "a1", accountId: "123456789012", alias: "Personal", regions: ["eu-west-1"], createdAt: "t" },
    poppies: [
      {
        id: "c1", accountId: "a1", app: { id: "mp", name: "MailPoppy" }, status: "pending",
        permissionSet: { id: "p", name: "P", description: "", grants: [], requiredTags: [], limits: null },
        createdAt: "t", updatedAt: "t",
      },
      {
        id: "c2", accountId: "a1", app: { id: "x", name: "OtherPoppy" }, status: "active",
        permissionSet: { id: "p", name: "P", description: "", grants: [], requiredTags: [], limits: null },
        createdAt: "t", updatedAt: "t",
      },
    ],
  },
];

afterEach(cleanup);

describe("ConnectionsView", () => {
  it("frames AgentsPoppy as the guardian over the connected apps, and wires Approve", () => {
    const onApprove = vi.fn();
    render(
      <ConnectionsView
        groups={groups}
        onSelect={() => {}}
        onApprove={onApprove}
        onDeny={() => {}}
        onConnect={() => {}}
        onViewActivity={() => {}}
      />,
    );

    expect(screen.getByText("Protection active")).toBeTruthy();
    expect(screen.getByText("Apps under AgentsPoppy's watch")).toBeTruthy();
    expect(screen.getByText("2 poppies")).toBeTruthy();
    expect(screen.getByText("MailPoppy")).toBeTruthy();

    fireEvent.click(screen.getByText("Approve"));
    expect(onApprove).toHaveBeenCalledWith("c1");
  });

  it("flags a poppy whose policy reaches beyond its own resources", () => {
    const broad: AccountGroup[] = [
      {
        account: { id: "a1", accountId: "123456789012", alias: "Personal", regions: ["eu-west-1"], createdAt: "t" },
        poppies: [
          {
            id: "w1", accountId: "a1", app: { id: "wide", name: "WidePoppy" }, status: "pending",
            permissionSet: {
              id: "p", name: "P", description: "",
              grants: [{ service: "s3", actions: ["DeleteObject"], resourceScope: "*" }],
              requiredTags: [], limits: null,
            },
            createdAt: "t", updatedAt: "t",
          },
        ],
      },
    ];
    const onSelect = vi.fn();
    render(
      <ConnectionsView
        groups={broad}
        onSelect={onSelect}
        onApprove={() => {}}
        onDeny={() => {}}
        onConnect={() => {}}
        onViewActivity={() => {}}
      />,
    );
    expect(screen.getByText("Broad access")).toBeTruthy();
    // A broad-access request makes REVIEW the primary path — approving broad
    // access must never be the biggest button on the card.
    const review = screen.getByText("Review first");
    expect(review.className).toContain("btn-primary");
    expect(screen.getByText("Approve").className).not.toContain("btn-primary");
    fireEvent.click(review);
    expect(onSelect).toHaveBeenCalledWith("w1");
  });

  it("surfaces activity that happened outside AgentsPoppy and previews a capped list", () => {
    const onViewActivity = vi.fn();
    // 6 external events — more than the dashboard preview (4) — so it must cap and
    // offer "See all" with the remaining count, never dumping the whole list inline.
    const external = Array.from({ length: 6 }, (_, i) => ({
      id: `e${i}`,
      time: new Date().toISOString(),
      service: "s3",
      action: "CreateBucket",
      actor: { kind: "external" as const, label: `IAM user deploy-bot-${i}` },
    }));
    render(
      <ConnectionsView
        groups={groups}
        activity={{
          summary: { total: 8, external: 6, throughPoppies: 1, byAgentsPoppy: 1 },
          events: external,
        }}
        onSelect={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
        onConnect={() => {}}
        onViewActivity={onViewActivity}
      />,
    );
    expect(screen.getByText("6 changes happened outside AgentsPoppy")).toBeTruthy();
    // Only the first 4 are previewed inline; the rest live behind "See all".
    expect(screen.getByText("IAM user deploy-bot-0")).toBeTruthy();
    expect(screen.getByText("IAM user deploy-bot-3")).toBeTruthy();
    expect(screen.queryByText("IAM user deploy-bot-4")).toBeNull();

    fireEvent.click(screen.getByText("See all activity (2 more) →"));
    expect(onViewActivity).toHaveBeenCalled();
  });

  it("reassures when all recent activity went through AgentsPoppy, still linking to the full timeline", () => {
    const onViewActivity = vi.fn();
    render(
      <ConnectionsView
        groups={groups}
        activity={{ summary: { total: 2, external: 0, throughPoppies: 2, byAgentsPoppy: 0 }, events: [] }}
        onSelect={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
        onConnect={() => {}}
        onViewActivity={onViewActivity}
      />,
    );
    expect(screen.getByText("Every recent change went through AgentsPoppy")).toBeTruthy();
    fireEvent.click(screen.getByText("See all activity →"));
    expect(onViewActivity).toHaveBeenCalled();
  });

  it("shows the quiet-state reassurance when there were NO changes at all (the mutations-only steady state)", () => {
    // With the changes-only feed, an empty 24h window is the normal good-news state
    // for an idle account — it must render as reassurance, not as a missing section.
    render(
      <ConnectionsView
        groups={groups}
        activity={{ summary: { total: 0, external: 0, throughPoppies: 0, byAgentsPoppy: 0 }, events: [] }}
        onSelect={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
        onConnect={() => {}}
        onViewActivity={() => {}}
      />,
    );
    expect(screen.getByText("No changes in your cloud in the last 24 hours")).toBeTruthy();
    expect(screen.getByText("See all activity →")).toBeTruthy();
  });

  it("shows a prominent Manage AWS connection panel with change/re-apply/disconnect (confirm-gated)", () => {
    const onManageAws = vi.fn();
    const onDisconnect = vi.fn();
    render(
      <ConnectionsView
        groups={groups}
        onSelect={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
        onConnect={() => {}}
        onViewActivity={() => {}}
        onManageAws={onManageAws}
        onDisconnect={onDisconnect}
      />,
    );

    expect(screen.getByText("Your AWS connection")).toBeTruthy();
    fireEvent.click(screen.getByText("Change credentials"));
    expect(onManageAws).toHaveBeenCalledWith("change-creds");
    fireEvent.click(screen.getByText("Re-apply setup"));
    expect(onManageAws).toHaveBeenCalledWith("redeploy");

    // Disconnect is confirm-gated, not one-click.
    fireEvent.click(screen.getByText("Disconnect"));
    expect(onDisconnect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Yes, disconnect"));
    expect(onDisconnect).toHaveBeenCalledWith("a1");
  });

  it("hides the Manage AWS panel when no management handlers are provided", () => {
    render(
      <ConnectionsView
        groups={groups}
        onSelect={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
        onConnect={() => {}}
        onViewActivity={() => {}}
      />,
    );
    expect(screen.queryByText("Your AWS connection")).toBeNull();
  });

  it("shows a pulsing Supervised pill and a session countdown for a supervised, active poppy", () => {
    const supervised: AccountGroup[] = [
      {
        account: { id: "a1", accountId: "123456789012", alias: "Personal", regions: ["eu-west-1"], createdAt: "t" },
        poppies: [
          {
            id: "s1", accountId: "a1", app: { id: "mp", name: "MailPoppy" }, status: "active",
            supervised: true,
            credentialsExpireAt: new Date(Date.now() + 30 * 60_000).toISOString(),
            permissionSet: { id: "p", name: "P", description: "", grants: [], requiredTags: [], limits: null },
            createdAt: "t", updatedAt: "t",
          },
        ],
      },
    ];
    render(
      <ConnectionsView
        groups={supervised}
        onSelect={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
        onConnect={() => {}}
        onViewActivity={() => {}}
      />,
    );
    expect(screen.getByText("Supervised")).toBeTruthy();
    // Live session countdown (mm:ss) is rendered next to the capabilities.
    expect(screen.getByText(/^\d+:\d{2}$/)).toBeTruthy();
  });

  it("lets the user remove a revoked connection from the list", () => {
    const revoked: AccountGroup[] = [
      {
        account: { id: "a1", accountId: "123456789012", alias: "Personal", regions: ["eu-west-1"], createdAt: "t" },
        poppies: [
          {
            id: "r1", accountId: "a1", app: { id: "mp", name: "MailPoppy" }, status: "revoked",
            permissionSet: { id: "p", name: "P", description: "", grants: [], requiredTags: [], limits: null },
            createdAt: "t", updatedAt: "t",
          },
        ],
      },
    ];
    const onForget = vi.fn();
    render(
      <ConnectionsView
        groups={revoked}
        onSelect={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
        onConnect={() => {}}
        onViewActivity={() => {}}
        onForget={onForget}
      />,
    );
    fireEvent.click(screen.getByText("Remove"));
    expect(onForget).toHaveBeenCalledWith("r1");
  });

  it("does not offer Remove for a revoked connection when no handler is provided", () => {
    const revoked: AccountGroup[] = [
      {
        account: { id: "a1", accountId: "123456789012", alias: "Personal", regions: ["eu-west-1"], createdAt: "t" },
        poppies: [
          {
            id: "r1", accountId: "a1", app: { id: "mp", name: "MailPoppy" }, status: "revoked",
            permissionSet: { id: "p", name: "P", description: "", grants: [], requiredTags: [], limits: null },
            createdAt: "t", updatedAt: "t",
          },
        ],
      },
    ];
    render(
      <ConnectionsView
        groups={revoked}
        onSelect={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
        onConnect={() => {}}
        onViewActivity={() => {}}
      />,
    );
    expect(screen.queryByText("Remove")).toBeNull();
  });

  it("shows an idle empty state with a Connect action when no AWS is linked", () => {
    const onConnect = vi.fn();
    render(
      <ConnectionsView
        groups={[]}
        onSelect={() => {}}
        onApprove={() => {}}
        onDeny={() => {}}
        onConnect={onConnect}
        onViewActivity={() => {}}
      />,
    );

    expect(screen.getByText("No AWS connected yet")).toBeTruthy();
    fireEvent.click(screen.getByText("Connect your AWS"));
    expect(onConnect).toHaveBeenCalled();
  });
});
