// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import type { RiskLevel } from "@agentspoppy/core";
import { Icon } from "./Icon";

/**
 * A compact chip for a grant's scope/risk. A grant confined to the app's own
 * resources reads green "Its own" when read-only, and amber "Its own" when it can
 * also create/change/delete them (only its own, but still worth the user's eye).
 * Grants that reach beyond the app's own ("*") are graded so a broad policy stands out.
 */
export function RiskBadge({ level, scoped }: { level: RiskLevel; scoped: boolean }) {
  if (scoped) {
    // Confined to its own resources — but "confined" is not the same as "harmless".
    // A grant on the control plane (iam / organizations / account) rates high even
    // when its name pattern is tight, because creating an identity is creating a new
    // holder of power in the account whatever it is called. Falling through to the
    // green badge here would have shown AgentsPoppy's MOST reassuring badge on
    // precisely the grant the rating had just been fixed to take seriously.
    if (level === "high") {
      return <span className="risk-badge risk-high">Its own — permissions</span>;
    }
    const cls = level === "medium" ? "risk-medium" : "risk-ok";
    return (
      <span className={`risk-badge ${cls}`}>
        <Icon name="check" /> Its own
      </span>
    );
  }
  if (level === "high") return <span className="risk-badge risk-high">Unscoped</span>;
  if (level === "medium") return <span className="risk-badge risk-medium">Broad</span>;
  return <span className="risk-badge risk-bounded">Bounded</span>;
}
