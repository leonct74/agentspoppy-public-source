// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import type { ActivityEvent } from "@agentspoppy/core";

/**
 * One drawn row: the run's most recent event + how many times it repeated.
 * `firstTime` is the OLDEST event in the run (the feed is newest-first), so the
 * UI can show the span a run covers.
 */
export interface CollapsedActivity {
  event: ActivityEvent;
  count: number;
  firstTime: string;
}

/**
 * Collapse CONSECUTIVE runs of "the same thing by the same actor" into one row.
 *
 * A busy account can emit long streaks of one background action (e.g. a Lambda
 * role's logs:CreateLogStream every minute) that monopolise the timeline while
 * carrying one bit of information. Only ADJACENT repeats merge — an interleaved
 * different event breaks the run — so the timeline's ordering story stays
 * truthful, and summary counts elsewhere keep counting raw events.
 *
 * Identity is the visible row identity (actor kind/label/connection + action +
 * region), NOT the principal ARN: assumed-role sessions get a fresh session name
 * per invocation, which would defeat the collapse for exactly the noisiest case.
 */
export function collapseActivity(events: ActivityEvent[]): CollapsedActivity[] {
  const out: CollapsedActivity[] = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    if (prev && sameRun(prev.event, e)) {
      prev.count += 1;
      prev.firstTime = e.time; // newest-first input → each merge extends the run backwards
    } else {
      out.push({ event: e, count: 1, firstTime: e.time });
    }
  }
  return out;
}

function sameRun(a: ActivityEvent, b: ActivityEvent): boolean {
  return (
    a.actor.kind === b.actor.kind &&
    a.actor.label === b.actor.label &&
    (a.actor.connectionId ?? "") === (b.actor.connectionId ?? "") &&
    a.service === b.service &&
    a.action === b.action &&
    (a.region ?? "") === (b.region ?? "")
  );
}
