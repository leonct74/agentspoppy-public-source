// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The host container's left nav (container model): brand + protection status,
 * Dashboard, the installed extensions (each a tab, with a backend-state dot), and
 * Activity. Purely presentational — App owns the view state and passes handlers.
 */
import type { ExtensionRuntimeState } from "../api/broker";
import { Icon, type IconName } from "./Icon";
import { AccountHealth, type AwsHealth, type FixAction } from "./AccountHealth";
import { poppyAccent } from "../lib/poppyAccent";
import logoUrl from "../assets/agentspoppy-logo.png";

export interface SidebarExtension {
  id: string;
  name: string;
  backend: ExtensionRuntimeState["backend"];
  /** The poppy's app icon (broker-served); falls back to a letter avatar. */
  iconUrl?: string;
}

/** Which nav entry is active: a fixed section, or a specific extension tab. */
export type ActiveSection = "dashboard" | "directory" | "activity" | "purchases" | { ext: string };

function backendTitle(backend: ExtensionRuntimeState["backend"]): string {
  switch (backend) {
    case "running":
      return "Running";
    case "awaiting-approval":
      return "Awaiting your approval";
    case "stopped":
      return "Stopped";
    case "blocked":
      return "Blocked — not allowed to run";
    case "paused":
      return "Paused — you stopped it; Resume from Manage";
    case "revoked":
      return "Revoked — access withdrawn; re-approve to bring it back";
    default:
      return "Frontend only";
  }
}

/** The states that get a distinct glyph + pill so a not-running poppy is unmistakable in
 *  the list (you can't pause/revoke/block one and forget). Others use the default key icon. */
const STATE_CHIP: Partial<Record<ExtensionRuntimeState["backend"], { icon: IconName; label: string }>> = {
  paused: { icon: "pause", label: "Paused" },
  revoked: { icon: "revoked", label: "Revoked" },
  blocked: { icon: "ban", label: "Blocked" },
};


export function Sidebar({
  active,
  extensions,
  updatesAvailable = 0,
  health,
  accountId,
  onFixConnection,
  region,
  footprintRegions = [],
  switchingRegion,
  onOpenRegion,
  onSwitchRegion,
  onDashboard,
  onDirectory,
  onActivity,
  onPurchases,
  onExtension,
  collapsed = false,
  onToggleCollapse,
}: {
  active: ActiveSection;
  extensions: SidebarExtension[];
  /** How many installed poppies have an update waiting — badges the Poppies nav item. */
  updatesAvailable?: number;
  /** Live connection + policy health for the always-visible account panel. */
  health: AwsHealth;
  /** The linked AWS account id (shown when healthy). */
  accountId?: string | null;
  /** Start the right fix flow from the panel (connect / re-enter credentials / update policy). */
  onFixConnection: (action: FixAction) => void;
  /** The linked account's AWS region (null when nothing's linked yet). */
  region?: string | null;
  /** Regions where the account's poppies actually have resources (mismatch warning). */
  footprintRegions?: string[];
  switchingRegion?: boolean;
  onOpenRegion?: () => void;
  onSwitchRegion?: (region: string) => void;
  onDashboard: () => void;
  /** Open Poppies — the curated catalog (browse + install poppies). */
  onDirectory: () => void;
  onActivity: () => void;
  /** Open Purchases — everything bought (subscriptions + one-time), with the host-guaranteed cancel path. */
  onPurchases: () => void;
  onExtension: (id: string) => void;
  /** Rail mode: collapse to icons only, giving the poppy's own screen more room. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}): JSX.Element {
  const extActive = (id: string) => typeof active === "object" && active.ext === id;

  return (
    <aside className={`sidebar ${collapsed ? "is-collapsed" : ""}`}>
      <div className="sidebar-brand">
        <img src={logoUrl} alt="" className="sidebar-logo" />
        {!collapsed && <div className="sidebar-name">AgentsPoppy</div>}
        {onToggleCollapse && (
          <button
            type="button"
            className="sidebar-collapse"
            onClick={onToggleCollapse}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={collapsed}
          >
            <Icon name="sidebar" />
          </button>
        )}
      </div>

      {/* Always-visible: am I connected, is my access healthy, what region — with one-click fixes. */}
      <AccountHealth
        health={health}
        accountId={accountId}
        region={region}
        footprintRegions={footprintRegions}
        switchingRegion={switchingRegion}
        onOpenRegion={onOpenRegion}
        onSwitchRegion={onSwitchRegion}
        onFix={onFixConnection}
      />

      <nav className="sidebar-nav">
        {/* Console = the host's own functions (line glyphs). Poppies = the contained apps
            (square avatars). Two sections, two visual languages — container vs. contained. */}
        <div className="sidebar-label">Console</div>
        <button
          type="button"
          className={`sidebar-item ${active === "dashboard" ? "is-active" : ""}`}
          onClick={onDashboard}
          title="Dashboard"
        >
          <Icon name="cloud" />
          <span>Dashboard</span>
        </button>
        <button
          type="button"
          className={`sidebar-item ${active === "directory" ? "is-active" : ""}`}
          onClick={onDirectory}
          title="Poppies"
        >
          <Icon name="grid" />
          <span>Poppies</span>
          {updatesAvailable > 0 && (
            <span
              className="sidebar-badge"
              title={`${updatesAvailable} poppy update${updatesAvailable === 1 ? "" : "s"} available`}
            >
              {updatesAvailable}
            </span>
          )}
        </button>
        <button
          type="button"
          className={`sidebar-item ${active === "activity" ? "is-active" : ""}`}
          onClick={onActivity}
          title="Activity"
        >
          <Icon name="activity" />
          <span>Activity</span>
        </button>
        {/* Host-owned billing: every purchase visible, cancellation guaranteed here — never
            dependent on a poppy's own UI keeping its cancel button findable. */}
        <button
          type="button"
          className={`sidebar-item ${active === "purchases" ? "is-active" : ""}`}
          onClick={onPurchases}
          title="Purchases"
        >
          <Icon name="card" />
          <span>Purchases</span>
        </button>

        <div className="sidebar-label">
          My poppies{extensions.length > 0 ? ` · ${extensions.length}` : ""}
        </div>
        {extensions.length === 0 ? (
          <p className="sidebar-empty">None installed yet</p>
        ) : (
          extensions.map((e) => {
            // A halted poppy (paused/revoked/blocked) gets a labelled pill + its avatar dims,
            // so it's unmistakable at a glance — you can't stop one and forget you did.
            const chip = STATE_CHIP[e.backend];
            const accent = poppyAccent(e.id);
            return (
              <button
                type="button"
                key={e.id}
                className={`sidebar-item ext-item--${e.backend} ${extActive(e.id) ? "is-active" : ""}`}
                onClick={() => onExtension(e.id)}
                title={chip ? `${e.name} — ${chip.label}` : e.name}
              >
                <span className="poppy-avatar" style={{ color: accent, borderColor: accent }} aria-hidden="true">
                  {e.iconUrl ? <img src={e.iconUrl} alt="" /> : (e.name[0] ?? "?").toUpperCase()}
                </span>
                <span className="poppy-label">{e.name}</span>
                {chip && <span className={`ext-tag ext-tag--${e.backend}`}>{chip.label}</span>}
                <span className={`ext-dot ext-${e.backend}`} title={backendTitle(e.backend)} />
              </button>
            );
          })
        )}

      </nav>
    </aside>
  );
}
