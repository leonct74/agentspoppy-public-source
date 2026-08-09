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
    // Confined to its own resources — amber if it can change them, green if read-only.
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
