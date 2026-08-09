// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { useState } from "react";
import type { ApprovalRequest, Connection } from "@agentspoppy/core";
import { Icon } from "./Icon";

/**
 * The supervised-mode inbox: operations a poppy is waiting on the user to approve.
 * Rendered as a floating panel pinned to the viewport (see `.approvals` in theme.css)
 * so a blocked poppy stays visible regardless of scroll position — the user sees
 * exactly what's about to happen and approves or denies, with buttons that always
 * work (unlike native notification actions, which the OS may not render).
 */
export function ApprovalsBar({
  approvals,
  connections,
  onApprove,
  onDeny,
}: {
  approvals: ApprovalRequest[];
  connections: Connection[];
  onApprove: (approvalId: string) => void;
  onDeny: (approvalId: string) => void;
}) {
  // Ids the user has already decided this render-cycle: disable their buttons so a
  // double-click (or a card lingering until the next poll) can't re-submit the decision.
  const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());
  const decide = (id: string, fn: (id: string) => void) => {
    setDecided((s) => new Set(s).add(id));
    fn(id);
  };

  if (approvals.length === 0) return null;
  const nameFor = (connectionId: string) =>
    connections.find((c) => c.id === connectionId)?.app.name ?? "A connected app";

  return (
    <section className="approvals" aria-label="Operations awaiting your approval">
      <div className="approvals-head">
        <Icon name="shield" />
        <strong>
          {approvals.length === 1 ? "1 operation needs your approval" : `${approvals.length} operations need your approval`}
        </strong>
      </div>
      <ul className="approval-list">
        {approvals.map((a) => (
          <li key={a.id} className="approval-card">
            <div className="approval-what">
              <span className="approval-app">{nameFor(a.connectionId)}</span>
              <span className="approval-summary">
                {a.operation ? a.operation.summary : "wants to use its connection"}
              </span>
            </div>
            <div className="approval-actions">
              <button className="btn btn-primary" disabled={decided.has(a.id)} onClick={() => decide(a.id, onApprove)}>
                {decided.has(a.id) ? "Deciding…" : "Approve"}
              </button>
              <button className="btn" disabled={decided.has(a.id)} onClick={() => decide(a.id, onDeny)}>
                Deny
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
