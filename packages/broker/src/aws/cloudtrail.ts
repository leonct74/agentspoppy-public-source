// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Recent account **changes** via CloudTrail's free Event history
 * (`LookupEvents`, management events, last 90 days). Operator credentials,
 * read-only — AgentsPoppy never proxies the data plane, so this is how it can
 * *surface* (not block) activity that reached the account outside the broker.
 *
 * The lookup filters to MUTATIONS (`ReadOnly=false`). A working account emits a
 * constant stream of read-only management noise (service-linked role polling,
 * Lambda role assumptions, Describe/List/Get reads — measured ~94% of events on a
 * real account), which would bury the changes the feed exists to surface: with a
 * bounded event budget, an unfiltered feed covered ~25 minutes of history and a
 * poppy's own mailbox deletion never survived long enough to be seen.
 *
 * Raw lookups sit behind {@link CloudTrailGateway} so the attribution logic is
 * unit-tested without AWS; the SDK is imported lazily on first real call.
 */
import type { ActivityEvent } from "@agentspoppy/core";
import { classifyActor, describePrincipal, shortService, type RawPrincipal } from "@agentspoppy/core";
import type { ActivityProvider, ActivityQuery } from "../providers";
import { maintenanceCredentials } from "./maintenance";
import { DEFAULT_OPERATOR_NAME } from "./role-template";

/** A CloudTrail event, normalised to the fields attribution needs. */
export interface CloudTrailEventRecord {
  eventId: string;
  /** ISO 8601. */
  eventTime: string;
  eventName: string;
  eventSource: string;
  region: string;
  userIdentity: {
    type?: string;
    arn?: string;
    userName?: string;
    sessionContext?: { sessionIssuer?: { userName?: string } };
  };
}

export interface CloudTrailGateway {
  lookupManagementEvents(region: string, sinceMinutes: number, limit: number): Promise<CloudTrailEventRecord[]>;
}

export class CloudTrailActivityProvider implements ActivityProvider {
  constructor(private readonly gateway: CloudTrailGateway = sdkCloudTrailGateway()) {}

  async recentActivity(q: ActivityQuery): Promise<ActivityEvent[]> {
    const ctx = {
      brokerRoleName: q.brokerRoleName,
      operatorName: q.operatorName,
      operatorArn: q.operatorArn,
      // The bootstrap-created operator stays recognised as AgentsPoppy even when the
      // live session is a different user (e.g. bootstrap → reconnect-as-yourself
      // inside the lookback window).
      canonicalOperatorName: DEFAULT_OPERATOR_NAME,
    };
    const seen = new Set<string>();
    const out: ActivityEvent[] = [];

    for (const region of dedupe(q.regions)) {
      let records: CloudTrailEventRecord[] = [];
      try {
        records = await this.gateway.lookupManagementEvents(region, q.sinceMinutes, q.limit);
      } catch {
        // One region failing (e.g. CloudTrail not enabled there) shouldn't sink the feed.
        continue;
      }
      for (const r of records) {
        if (seen.has(r.eventId)) continue;
        seen.add(r.eventId);
        const principal = toPrincipal(r.userIdentity);
        const { kind, connectionId } = classifyActor(principal, ctx);
        out.push({
          id: r.eventId,
          time: r.eventTime,
          service: shortService(r.eventSource),
          action: r.eventName,
          region: r.region,
          actor: {
            kind,
            connectionId,
            arn: principal.arn,
            label:
              kind === "external"
                ? describePrincipal(principal)
                : kind === "agentspoppy"
                  ? "AgentsPoppy"
                  : "Connected app",
          },
        });
      }
    }

    out.sort((a, b) => b.time.localeCompare(a.time));
    return out.slice(0, q.limit);
  }
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** Normalise a CloudTrail userIdentity into the {@link RawPrincipal} attribution shape. */
function toPrincipal(u: CloudTrailEventRecord["userIdentity"]): RawPrincipal {
  let sessionName: string | undefined;
  let roleName: string | undefined;
  if (u.type === "AssumedRole" && u.arn) {
    // arn:aws:sts::<acct>:assumed-role/<RoleName>/<SessionName>
    const m = u.arn.match(/assumed-role\/([^/]+)\/(.+)$/);
    if (m) {
      roleName = m[1];
      sessionName = m[2];
    }
  }
  roleName ??= u.sessionContext?.sessionIssuer?.userName;
  return { type: u.type, arn: u.arn, sessionName, roleName, userName: u.userName };
}

/** Default gateway backed by the AWS SDK. Operator credentials, lazy SDK import. */
export function sdkCloudTrailGateway(): CloudTrailGateway {
  return {
    async lookupManagementEvents(region, sinceMinutes, limit) {
      const { CloudTrailClient, LookupEventsCommand } = await import("@aws-sdk/client-cloudtrail");
      const client = new CloudTrailClient({ region, credentials: await maintenanceCredentials() });
      const start = new Date(Date.now() - sinceMinutes * 60_000);
      const out: CloudTrailEventRecord[] = [];
      let token: string | undefined;
      do {
        const res = await client.send(
          new LookupEventsCommand({
            StartTime: start,
            MaxResults: 50,
            NextToken: token,
            // Changes only — see the module doc for why read-only events are excluded.
            LookupAttributes: [{ AttributeKey: "ReadOnly", AttributeValue: "false" }],
          }),
        );
        for (const e of res.Events ?? []) {
          if (!e.EventId) continue;
          let userIdentity: CloudTrailEventRecord["userIdentity"] = {};
          try {
            userIdentity = (JSON.parse(e.CloudTrailEvent ?? "{}") as { userIdentity?: object }).userIdentity ?? {};
          } catch {
            /* malformed record — leave userIdentity empty → classified external */
          }
          out.push({
            eventId: e.EventId,
            eventTime: (e.EventTime ?? new Date()).toISOString(),
            eventName: e.EventName ?? "",
            eventSource: e.EventSource ?? "",
            region,
            userIdentity,
          });
          if (out.length >= limit) break;
        }
        token = res.NextToken;
      } while (token && out.length < limit);
      return out;
    },
  };
}
