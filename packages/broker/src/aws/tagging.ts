// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The generic "find everything a poppy created" engine, via the Resource Groups
 * Tagging API. Because every poppy MUST tag every resource it creates with
 * `agentspoppy:app = <app id>` (the broker rejects a permission set that doesn't
 * require the attribution tags), this sweep can enumerate a poppy's entire footprint
 * across services — even resources outside any CloudFormation stack — without knowing
 * anything about the poppy.
 *
 * This is what makes the teardown promise real: we can always *find* the remainder
 * by tag and surface it, and certification asserts the post-teardown sweep is empty.
 *
 * The host-maintenance session (the admin/monitoring plane), like the CloudFormation
 * provider — NOT the raw operator key. Template v4 stripped that key to assume-only, so on
 * a v4 account a sweep signed by it is refused in every region and the audit goes blind
 * (found certifying AuditPoppy, 2026-09-10; this file had missed the v4 migration). The
 * session carries `tag:GetResources` in MonitorAndTeardown (maintenance.ts) for exactly
 * this call, and falls back to the operator key on a pre-v4 account.
 */
import { maintenanceCredentials } from "./maintenance";

/** A live resource ARN returned by a tag query, in one region. */
export interface TaggedResource {
  arn: string;
}

/** The tag-query operations the residual scan needs, per region. */
export interface TaggingGateway {
  /** Every live resource ARN in `region` carrying `tagKey = tagValue`. */
  getResourcesByTag(region: string, tagKey: string, tagValue: string): Promise<TaggedResource[]>;
}

/**
 * Derive a friendly "service:type" from an ARN for display, e.g.
 *   arn:aws:lambda:eu-west-1:123:function:Fn      -> "lambda:function"
 *   arn:aws:cognito-idp:eu-west-1:123:userpool/.. -> "cognito-idp:userpool"
 *   arn:aws:s3:::bucket-name                       -> "s3"
 * Falls back to the raw service when there's no distinct type segment.
 */
export function resourceTypeFromArn(arn: string): string {
  const parts = arn.split(":");
  const service = parts[2] ?? "";
  // ARN tail is everything after the account id: "type/id", "type:id", or just "id".
  const tail = parts.slice(5).join(":");
  const hasTypeSep = /[/:]/.test(tail);
  const type = hasTypeSep ? tail.split(/[/:]/)[0] : "";
  return type ? `${service}:${type}` : service;
}

/** Default gateway backed by the AWS SDK. Maintenance-session credentials, lazy SDK import. */
export function sdkTaggingGateway(): TaggingGateway {
  return {
    async getResourcesByTag(region, tagKey, tagValue) {
      const { ResourceGroupsTaggingAPIClient, GetResourcesCommand } = await import(
        "@aws-sdk/client-resource-groups-tagging-api"
      );
      const client = new ResourceGroupsTaggingAPIClient({ region, credentials: await maintenanceCredentials() });
      const out: TaggedResource[] = [];
      let token: string | undefined;
      do {
        const res = await client.send(
          new GetResourcesCommand({
            TagFilters: [{ Key: tagKey, Values: [tagValue] }],
            ResourcesPerPage: 100,
            PaginationToken: token,
          }),
        );
        for (const r of res.ResourceTagMappingList ?? []) {
          if (r.ResourceARN) out.push({ arn: r.ResourceARN });
        }
        token = res.PaginationToken || undefined;
      } while (token);
      return out;
    },
  };
}
