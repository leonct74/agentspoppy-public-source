// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Confirm whether a tagged resource actually still exists.
 *
 * Why this is needed: the Resource Groups Tagging API is eventually consistent and can keep
 * listing a resource for a long time AFTER it's deleted (observed: ~days for a Cognito user
 * pool). So a raw tag hit is a *candidate*, not a fact — and treating candidates as leftovers
 * makes teardown / certification cry wolf on a clean account.
 *
 * The verifier resolves a candidate to {@link InfraNodeStatus}. The default reads CloudTrail
 * Event history — which the operator can already query and AWS retains for 90 days with no
 * trail required — looking for the most recent Create / Delete for the resource. It is
 * deliberately fail-open: any uncertainty (no events, CloudTrail off, an unparseable record)
 * returns `unverified` rather than guessing, so we never invent a leftover OR hide one.
 */
import type { InfraNodeStatus } from "@agentspoppy/core";
import { maintenanceCredentials } from "./maintenance";

/** Resolves a tagged ARN to whether it still exists. */
export interface ExistenceVerifier {
  verify(region: string, arn: string): Promise<InfraNodeStatus>;
}

/** Stub: everything is unverified. Wiring + tests only (never AWS). */
export class StubExistenceVerifier implements ExistenceVerifier {
  async verify(): Promise<InfraNodeStatus> {
    return "unverified";
  }
}

/** The bare resource id CloudTrail indexes as a ResourceName (last path/colon segment of the ARN). */
function resourceName(arn: string): string {
  const tail = arn.split(":").slice(5).join(":");
  return tail.split(/[/:]/).pop() ?? tail;
}

/** The `i-…` id of an EC2 *instance* ARN (arn:aws:ec2:…:instance/i-…), else null. Pure. */
export function ec2InstanceIdFromArn(arn: string): string | null {
  const m = /^arn:aws[^:]*:ec2:[^:]*:[^:]*:instance\/(i-[0-9a-f]+)$/i.exec(arn);
  return m ? m[1]! : null;
}

/**
 * Map an EC2 instance's live state to existence. Pure. `terminated`/`shutting-down` — or an
 * instance AWS no longer returns at all (undefined) — is gone; every other state (running,
 * stopped, pending, stopping) still exists.
 */
export function ec2StateToStatus(state: string | undefined): InfraNodeStatus {
  if (!state) return "removed";
  return state === "terminated" || state === "shutting-down" ? "removed" : "present";
}

function isInstanceNotFound(err: unknown): boolean {
  const code = (err as { name?: string; Code?: string }).name ?? (err as { Code?: string }).Code ?? "";
  return /InvalidInstanceID\.NotFound/i.test(code);
}

/**
 * Authoritative existence for EC2 instances, which the CloudTrail verifier can't resolve
 * (they use RunInstances / TerminateInstances, not the Create / Delete verbs it matches) and
 * which the Tagging API keeps returning as `terminated` for ~1h after they're gone (the
 * tombstone) — the bug where a self-terminated VM kept showing as alive on the map. Reads the
 * live state via DescribeInstances; every non-instance ARN delegates to the fallback verifier.
 */
export function ec2AwareExistenceVerifier(
  fallback: ExistenceVerifier = cloudTrailExistenceVerifier(),
): ExistenceVerifier {
  return {
    async verify(region, arn) {
      const instanceId = ec2InstanceIdFromArn(arn);
      if (!instanceId) return fallback.verify(region, arn);
      try {
        const { EC2Client, DescribeInstancesCommand } = await import("@aws-sdk/client-ec2");
        const client = new EC2Client({ region, credentials: await maintenanceCredentials() });
        const res = await client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
        return ec2StateToStatus(res.Reservations?.[0]?.Instances?.[0]?.State?.Name);
      } catch (err) {
        // Past the tombstone AWS forgets the id entirely → definitively gone. Any other error
        // (transient / missing permission) → don't guess; let the fallback decide.
        if (isInstanceNotFound(err)) return "removed";
        return fallback.verify(region, arn);
      }
    },
  };
}

/**
 * CloudTrail-backed verifier. Looks up management events for the resource name and returns
 * the verdict implied by the most recent successful Create / Delete: a delete on top → gone,
 * a create with no later delete → present. No relevant events (or any error) → unverified.
 */
export function cloudTrailExistenceVerifier(): ExistenceVerifier {
  return {
    async verify(region, arn) {
      const name = resourceName(arn);
      if (!name) return "unverified";
      try {
        const { CloudTrailClient, LookupEventsCommand } = await import("@aws-sdk/client-cloudtrail");
        const client = new CloudTrailClient({ region, credentials: await maintenanceCredentials() });
        const res = await client.send(
          new LookupEventsCommand({
            LookupAttributes: [{ AttributeKey: "ResourceName", AttributeValue: name }],
            MaxResults: 50,
          }),
        );
        // Events arrive newest-first. The first Create / Delete with no error code is the
        // latest lifecycle event that succeeded, and decides existence.
        for (const e of res.Events ?? []) {
          const verdict = lifecycleVerdict(e.EventName, e.CloudTrailEvent);
          if (verdict) return verdict;
        }
        return "unverified";
      } catch {
        return "unverified";
      }
    },
  };
}

/** "removed" for a successful Delete*, "present" for a successful Create*, null otherwise. */
export function lifecycleVerdict(eventName: string | undefined, rawEvent: string | undefined): InfraNodeStatus | null {
  if (!eventName) return null;
  // EC2 instances use RunInstances / TerminateInstances instead of Create* / Delete*.
  const isDelete = /^Delete/.test(eventName) || eventName === "TerminateInstances";
  const isCreate = /^Create/.test(eventName) || eventName === "RunInstances";
  if (!isDelete && !isCreate) return null;
  if (failed(rawEvent)) return null; // a Create/Delete that errored didn't change existence
  return isDelete ? "removed" : "present";
}

function failed(rawEvent: string | undefined): boolean {
  if (!rawEvent) return false;
  try {
    return Boolean((JSON.parse(rawEvent) as { errorCode?: string }).errorCode);
  } catch {
    return false;
  }
}
