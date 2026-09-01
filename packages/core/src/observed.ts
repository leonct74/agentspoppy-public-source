// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The observed register (docs/specs/permission-presentation.md): what a poppy has ACTUALLY
 * done, summarised from CloudTrail per service. The third column of a finding — the only one
 * neither the platform nor the developer writes, which is exactly why it carries weight.
 *
 * Pure: events in, summary out. The broker filters events to one app; this module only
 * counts. Classification reuses the rating's own verb classifier (via a single-action grant)
 * so "change" here can never disagree with what the permission screen calls a change — and it
 * inherits that classifier's fail-destructive default: an unknown verb counts as a change,
 * overstating rather than understating what happened.
 *
 * What this module deliberately does NOT do: conclude anything. "No events" is rendered as
 * "nothing recorded", never "it did nothing" — CloudTrail is the user's own account-wide
 * setting, a region with it off contributes nothing, and the gateway swallows per-region
 * failures, so a quiet account and a blind one look identical here. The UI states that
 * caveat; this module just refuses to editorialise.
 */
import { grantCanMutate } from "./permissions";
import type { ActivityEvent } from "./activity";

export interface ObservedServiceRow {
  service: string;
  /** Calls that changed something (or whose verb is unknown — counted as changes). */
  changes: number;
  /** Pure reads. */
  reads: number;
  /** Exact action → count, for the drill-down. */
  actions: Record<string, number>;
  /** ISO time of this service's most recent event. */
  last: string;
}

export interface ObservedSummary {
  total: number;
  changes: number;
  reads: number;
  /** Change-making services first, then by recency — the order a reader should meet them. */
  rows: ObservedServiceRow[];
}

function isChange(service: string, action: string): boolean {
  return grantCanMutate({ service, actions: [action], resourceScope: "*" });
}

export function summarizeObserved(events: ActivityEvent[]): ObservedSummary {
  const byService = new Map<string, ObservedServiceRow>();
  for (const e of events) {
    const key = e.service.toLowerCase();
    let row = byService.get(key);
    if (!row) {
      row = { service: key, changes: 0, reads: 0, actions: {}, last: e.time };
      byService.set(key, row);
    }
    if (isChange(e.service, e.action)) row.changes += 1;
    else row.reads += 1;
    row.actions[e.action] = (row.actions[e.action] ?? 0) + 1;
    if (e.time > row.last) row.last = e.time;
  }
  const rows = [...byService.values()].sort((a, b) => {
    if ((a.changes > 0) !== (b.changes > 0)) return a.changes > 0 ? -1 : 1;
    return b.last.localeCompare(a.last);
  });
  return {
    total: events.length,
    changes: rows.reduce((n, r) => n + r.changes, 0),
    reads: rows.reduce((n, r) => n + r.reads, 0),
    rows,
  };
}
