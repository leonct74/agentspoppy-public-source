// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { useState } from "react";
import type { Connection } from "@agentspoppy/core";
import { assessPermissionSet } from "@agentspoppy/core";
import type { AccountGroup } from "../lib/format";
import type { ActivityReport } from "../api/broker";
import { accountLabel, formatDateTime, poppyCount, timeAgo } from "../lib/format";
import { collapseActivity } from "../lib/collapseActivity";
import { StatusBadge } from "../components/StatusBadge";
import { Countdown } from "../components/Countdown";
import { Icon } from "../components/Icon";

export interface ConnectionsViewProps {
  groups: AccountGroup[];
  /** Recent account activity (CloudTrail); the "around AgentsPoppy" feed. */
  activity?: ActivityReport | null;
  onSelect: (id: string) => void;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  /** Start the one-time "Connect AWS" bootstrap (linking another account). */
  onConnect: () => void;
  /** Open the full, filterable activity timeline. */
  onViewActivity: () => void;
  /** Manage the existing AWS connection: jump into the setup flow at a specific action. */
  onManageAws?: (action: "change-creds" | "redeploy") => void;
  /** Disconnect (unlink) an AWS account locally — does NOT delete any cloud resources. */
  onDisconnect?: (accountId: string) => void;
  /** Forget a revoked connection — clears it from the list (local record only, no cloud change). */
  onForget?: (connectionId: string) => void;
  /** Open the curated directory. When absent the "Add a poppy" card stays a placeholder. */
  onOpenDirectory?: () => void;
}

/** How many external events the dashboard previews before "See all activity". */
const ACTIVITY_PREVIEW = 4;

function monogram(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
}

/** One concise line of what an app can touch, e.g. "cloudformation · s3 · ses". */
function capabilitySummary(c: Connection): string {
  const services = [...new Set(c.permissionSet.grants.map((g) => g.service))];
  return services.length ? services.join(" · ") : "no access yet";
}

/**
 * The home view, framed as a guardian control panel: AgentsPoppy on top, the
 * connected apps ("poppies") listed beneath as entries it watches and governs.
 */
export function ConnectionsView({
  groups,
  activity,
  onSelect,
  onApprove,
  onDeny,
  onConnect,
  onViewActivity,
  onManageAws,
  onDisconnect,
  onForget,
  onOpenDirectory,
}: ConnectionsViewProps) {
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  // Counts speak about poppies under watch — a revoked one isn't guarded anymore,
  // so it never inflates "Protection active" or the group headers.
  const total = groups.reduce((n, g) => n + g.poppies.filter((p) => p.status !== "revoked").length, 0);
  const pending = groups.reduce((n, g) => n + g.poppies.filter((p) => p.status === "pending").length, 0);
  const accountNames = groups.map((g) => accountLabel(g.account)).join(", ");

  // Idle state: no AWS linked yet (what you see once the welcome is dismissed).
  if (groups.length === 0) {
    return (
      <section className="guard">
        <div className="guard-summary guard-summary--idle">
          <span className="guard-shield">
            <Icon name="shield" />
          </span>
          <div className="guard-summary-text">
            <strong>No AWS connected yet</strong>
            <p className="muted">Connect your AWS so AgentsPoppy can guard how your apps access it.</p>
          </div>
          <button className="btn btn-primary header-action" onClick={onConnect}>
            Connect your AWS
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="guard">
      <div className="guard-summary">
        <span className="guard-shield live-pulse">
          <Icon name="shield" />
        </span>
        <div className="guard-summary-text">
          <strong>Protection active</strong>
          <p className="muted">
            Guarding {accountNames} · {poppyCount(total)}
            {pending > 0 ? ` · ${pending} awaiting you` : ""}
          </p>
        </div>
        <button className="btn header-action" onClick={onConnect}>
          Connect another AWS
        </button>
      </div>

      {onManageAws && onDisconnect && (
        <>
          <h3 className="os-section-label">Your AWS connection</h3>
          {groups.map((g) => (
            <div key={`manage-${g.account.id}`} className="activity-panel aws-manage">
              <div className="aws-manage-id">
                <strong>AWS {accountLabel(g.account)}</strong>
                <p className="muted">Manage how AgentsPoppy accesses this account.</p>
              </div>
              {confirmDisconnect === g.account.id ? (
                <div className="aws-manage-actions">
                  <span className="muted">Disconnect? Your AWS resources aren't deleted.</span>
                  <button
                    className="btn btn-danger"
                    onClick={() => {
                      onDisconnect(g.account.id);
                      setConfirmDisconnect(null);
                    }}
                  >
                    Yes, disconnect
                  </button>
                  <button className="btn" onClick={() => setConfirmDisconnect(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="aws-manage-actions">
                  <button className="btn" onClick={() => onManageAws("change-creds")}>
                    Change credentials
                  </button>
                  <button className="btn" onClick={() => onManageAws("redeploy")}>
                    Re-apply setup
                  </button>
                  <button className="btn btn-danger" onClick={() => setConfirmDisconnect(g.account.id)}>
                    Disconnect
                  </button>
                </div>
              )}
            </div>
          ))}
        </>
      )}

      <h3 className="os-section-label">Apps under AgentsPoppy's watch</h3>

      {groups.map((g) => (
        <div key={g.account.id} className="os-group">
          <div className="os-group-head">
            <span>{accountLabel(g.account)}</span>
            <span className="muted">
              {poppyCount(g.poppies.filter((p) => p.status !== "revoked").length)}
              {g.poppies.some((p) => p.status === "revoked")
                ? ` · ${g.poppies.filter((p) => p.status === "revoked").length} revoked`
                : ""}
            </span>
          </div>

          {/* Square-ish cards in a responsive grid, capped off by an "Add a poppy"
              card that opens the curated directory. */}
          <div className="os-grid">
            {g.poppies.map((c) => {
              const level = assessPermissionSet(c.permissionSet).level;
              const showSupervised = !!c.supervised && (c.status === "active" || c.status === "paused");
              return (
                <div key={c.id} className="os-card">
                  <div className="os-card-head">
                    <span className="os-avatar" aria-hidden="true">
                      {monogram(c.app.name)}
                    </span>
                    <StatusBadge status={c.status} />
                  </div>

                  <div className="os-card-main">
                    <span className="os-card-name">{c.app.name}</span>
                    <span className="os-card-sub muted">
                      {capabilitySummary(c)}
                      {c.status === "active" && c.credentialsExpireAt && (
                        <>
                          {" · session "}
                          <Countdown expiresAt={c.credentialsExpireAt} />
                        </>
                      )}
                    </span>

                    {(showSupervised || level !== "low") && (
                      <div className="os-card-chips">
                        {showSupervised && (
                          <span
                            className="supervised-pill"
                            title="Supervised — AgentsPoppy holds this app's AWS credentials for your approval"
                          >
                            <span className="supervised-dot" /> Supervised
                          </span>
                        )}
                        {level !== "low" && (
                          <span
                            className={`risk-chip risk-${level}`}
                            title="This app requests access beyond its own resources"
                          >
                            <Icon name="shield" /> {level === "high" ? "Broad access" : "Review access"}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="os-card-actions">
                    {c.status === "pending" ? (
                      // Broad access never gets Approve as the biggest button: the
                      // primary path for a high-risk request is reading what it can do.
                      <>
                        <button
                          className={level === "high" ? "btn btn-primary" : "btn"}
                          onClick={() => onSelect(c.id)}
                          aria-label={`Review ${c.app.name}`}
                        >
                          {level === "high" ? "Review first" : "Review"}
                        </button>
                        <button
                          className={level === "high" ? "btn" : "btn btn-primary"}
                          onClick={() => onApprove(c.id)}
                        >
                          Approve
                        </button>
                        <button className="btn link" onClick={() => onDeny(c.id)}>
                          Deny
                        </button>
                      </>
                    ) : c.status === "revoked" ? (
                      <>
                        <button className="btn" onClick={() => onSelect(c.id)} aria-label={`Review ${c.app.name}`}>
                          Manage <Icon name="chevron" className="row-chevron" />
                        </button>
                        {onForget && (
                          <button
                            className="btn link"
                            onClick={() => onForget(c.id)}
                            title="Remove this revoked app from the list (local record only)"
                            aria-label={`Remove ${c.app.name} from the list`}
                          >
                            Remove
                          </button>
                        )}
                      </>
                    ) : (
                      <button className="btn" onClick={() => onSelect(c.id)} aria-label={`Manage ${c.app.name}`}>
                        Manage <Icon name="chevron" className="row-chevron" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Routes to the curated directory when App wires it; otherwise it stays the
                old inert placeholder (older hosts / tests without the handler). */}
            {onOpenDirectory ? (
              <button type="button" className="os-card os-card--add" onClick={onOpenDirectory}>
                <span className="os-add-plus" aria-hidden="true">
                  +
                </span>
                <span className="os-add-label">Add a poppy</span>
                <span className="os-add-soon">Browse the directory</span>
              </button>
            ) : (
              <div
                className="os-card os-card--add"
                aria-disabled="true"
                title="An in-app directory of poppies is coming very soon"
              >
                <span className="os-add-plus" aria-hidden="true">
                  +
                </span>
                <span className="os-add-label">Add a poppy</span>
                <span className="os-add-soon">Coming very soon</span>
              </div>
            )}
          </div>
        </div>
      ))}

      {activity && (
        <>
          <h3 className="os-section-label">Changes around AgentsPoppy</h3>
          {activity.summary.external > 0 ? (
            (() => {
              // Collapsed for display (consecutive repeats → one row + ×N badge);
              // the headline count above stays raw.
              const external = collapseActivity(activity.events.filter((e) => e.actor.kind === "external"));
              const hidden = external.length - ACTIVITY_PREVIEW;
              return (
                <div className="activity-panel activity-panel--alert">
                  <div className="activity-head">
                    <Icon name="shield" />
                    <div>
                      <strong>
                        {activity.summary.external} {activity.summary.external === 1 ? "change" : "changes"}{" "}
                        happened outside AgentsPoppy
                      </strong>
                      <p className="muted">
                        Recent changes to your cloud not attributable to any app you approved. Review
                        anything you don't recognise.
                      </p>
                    </div>
                  </div>
                  <ul className="activity-list">
                    {external.slice(0, ACTIVITY_PREVIEW).map(({ event: e, count }) => (
                      <li key={e.id} className="activity-row">
                        <span className="activity-actor">{e.actor.label}</span>
                        <span className="activity-action muted">
                          {e.service}:{e.action}
                        </span>
                        {count > 1 && <span className="repeat-badge">×{count}</span>}
                        <span className="activity-time muted" title={formatDateTime(e.time)}>
                          {timeAgo(e.time)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <button className="btn link activity-more" onClick={onViewActivity}>
                    {hidden > 0 ? `See all activity (${hidden} more) →` : "See all activity →"}
                  </button>
                </div>
              );
            })()
          ) : (
            <div className="activity-panel activity-panel--ok">
              <Icon name="check" />
              <div>
                <strong>
                  {activity.summary.total === 0
                    ? "No changes in your cloud in the last 24 hours"
                    : "Every recent change went through AgentsPoppy"}
                </strong>
                <p className="muted">
                  Nothing changed in your account outside the apps you approved. (Read-only activity
                  isn't tracked here.)
                </p>
              </div>
              <button className="btn link activity-more" onClick={onViewActivity}>
                See all activity →
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
