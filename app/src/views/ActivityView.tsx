// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { useState } from "react";
import type { ActorKind } from "@agentspoppy/core";
import type { ActivityReport } from "../api/broker";
import { collapseActivity } from "../lib/collapseActivity";
import { formatDateTime, timeAgo } from "../lib/format";
import { Icon } from "../components/Icon";

export interface ActivityViewProps {
  /** The attributed feed; null when CloudTrail history isn't available. */
  report: ActivityReport | null;
  onBack: () => void;
}

type Filter = "all" | ActorKind;

const KIND_LABEL: Record<ActorKind, string> = {
  external: "Outside AgentsPoppy",
  poppy: "Through a poppy",
  agentspoppy: "By AgentsPoppy",
};

function kindIcon(kind: ActorKind) {
  return kind === "external" ? "external" : kind === "poppy" ? "cloud" : "shield";
}

/**
 * The full activity timeline — where the "very long" list lives. Filterable by
 * where the activity came from, and free to scroll. The dashboard shows only a
 * short preview and links here.
 */
export function ActivityView({ report, onBack }: ActivityViewProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const events = report?.events ?? [];
  const summary = report?.summary ?? { total: 0, external: 0, throughPoppies: 0, byAgentsPoppy: 0 };

  const tabs: { key: Filter; label: string; count: number }[] = [
    { key: "all", label: "All", count: summary.total },
    { key: "external", label: "Outside AgentsPoppy", count: summary.external },
    { key: "poppy", label: "Through poppies", count: summary.throughPoppies },
    { key: "agentspoppy", label: "By AgentsPoppy", count: summary.byAgentsPoppy },
  ];

  // Collapse AFTER filtering: consecutive repeats of one background action (a
  // Lambda role writing log streams every minute) become one row with a ×N badge
  // instead of monopolising the timeline. Tab counts above stay raw.
  const shown = collapseActivity(filter === "all" ? events : events.filter((e) => e.actor.kind === filter));

  return (
    <section className="activity-view">
      <button className="btn link" onClick={onBack}>
        ← Dashboard
      </button>

      <div className="detail-head">
        <h2>Cloud activity</h2>
      </div>
      <p className="muted activity-lede">
        Recent <strong>changes</strong> in your AWS, attributed to where they came from — read-only
        activity is filtered out so real changes stand out. “Outside AgentsPoppy” is any change that
        reached the cloud without going through an app you approved. New events can take a few
        minutes to appear (CloudTrail ingestion).
      </p>

      <div className="activity-tabs" role="tablist" aria-label="Filter activity">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={filter === t.key}
            className={`activity-tab${filter === t.key ? " is-active" : ""}${
              t.key === "external" && t.count > 0 ? " has-alert" : ""
            }`}
            onClick={() => setFilter(t.key)}
          >
            {t.label} <span className="activity-tab-count">{t.count}</span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="activity-empty muted">
          {report === null
            ? "Activity history isn’t available right now."
            : "Nothing to show for this filter."}
        </div>
      ) : (
        <ul className="activity-feed">
          {shown.map(({ event: e, count, firstTime }) => (
            <li key={e.id} className="activity-feed-row">
              <span className={`actor-chip actor-chip--${e.actor.kind}`}>
                <Icon name={kindIcon(e.actor.kind)} /> {KIND_LABEL[e.actor.kind]}
              </span>
              <span className="activity-feed-actor">{e.actor.label}</span>
              <span className="activity-feed-action">
                {e.service}:{e.action}
              </span>
              {count > 1 && (
                <span
                  className="repeat-badge"
                  title={`repeated ${count} times, ${formatDateTime(firstTime)} – ${formatDateTime(e.time)}`}
                >
                  ×{count}
                </span>
              )}
              {e.region && <span className="activity-feed-region muted">{e.region}</span>}
              <span className="activity-feed-time muted" title={timeAgo(e.time)}>
                {formatDateTime(e.time)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
