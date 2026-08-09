// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { ApprovalRequest, Connection } from "@agentspoppy/core";
import { ApprovalsBar } from "./ApprovalsBar";

afterEach(cleanup);

const conn: Connection = {
  id: "c1", accountId: "a1", app: { id: "x", name: "MailPoppy" }, status: "active",
  permissionSet: { id: "p", name: "P", description: "", grants: [], requiredTags: [], limits: null },
  createdAt: "t", updatedAt: "t",
};

const approval = (id: string, summary?: string): ApprovalRequest => ({
  id, connectionId: "c1", requestedAt: "t",
  operation: summary ? { summary, grants: [] } : null,
  status: "pending", expiresAt: "t",
});

describe("ApprovalsBar", () => {
  it("renders nothing when there are no pending approvals", () => {
    const { container } = render(<ApprovalsBar approvals={[]} connections={[conn]} onApprove={vi.fn()} onDeny={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the poppy name + operation summary and wires Approve", () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    render(
      <ApprovalsBar approvals={[approval("ap1", "Delete user pool 'acme-users'")]} connections={[conn]} onApprove={onApprove} onDeny={onDeny} />,
    );
    expect(screen.getByText("MailPoppy")).toBeTruthy();
    expect(screen.getByText("Delete user pool 'acme-users'")).toBeTruthy();
    expect(screen.getByText("1 operation needs your approval")).toBeTruthy();

    fireEvent.click(screen.getByText("Approve"));
    expect(onApprove).toHaveBeenCalledWith("ap1");
  });

  it("locks a card once decided — no double-submit, no cross-decide while it lingers", () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    render(
      <ApprovalsBar approvals={[approval("ap1", "Delete user pool 'acme-users'")]} connections={[conn]} onApprove={onApprove} onDeny={onDeny} />,
    );
    fireEvent.click(screen.getByText("Approve"));
    expect(onApprove).toHaveBeenCalledTimes(1);
    // The card stays until the next approvals poll clears it — its buttons must be dead.
    fireEvent.click(screen.getByText("Deciding…"));
    fireEvent.click(screen.getByText("Deny"));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onDeny).not.toHaveBeenCalled();
  });

  it("wires Deny", () => {
    const onDeny = vi.fn();
    render(<ApprovalsBar approvals={[approval("ap1", "x")]} connections={[conn]} onApprove={vi.fn()} onDeny={onDeny} />);
    fireEvent.click(screen.getByText("Deny"));
    expect(onDeny).toHaveBeenCalledWith("ap1");
  });

  it("falls back to a session-level label when no operation is declared", () => {
    render(<ApprovalsBar approvals={[approval("ap2")]} connections={[conn]} onApprove={vi.fn()} onDeny={vi.fn()} />);
    expect(screen.getByText("wants to use its connection")).toBeTruthy();
  });
});
