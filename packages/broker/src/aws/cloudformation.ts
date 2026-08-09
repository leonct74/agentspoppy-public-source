// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Real per-app cloud footprint via CloudFormation.
 *
 * This is the admin/monitoring plane, so it runs with the *operator's* own
 * credentials (the local provider chain) rather than a connection's scoped
 * session — AgentsPoppy reads and tears down on the user's behalf.
 *
 * Attribution is by stack tag: a stack belongs to a connection's app iff it carries
 * `agentspoppy:app = <connection.app.id>`. Ownership is keyed to the stable *app*
 * identity, not the ephemeral connection id, so a stack created by an earlier
 * connection (since superseded) is still found and torn down rather than orphaned.
 * Teardown re-verifies that tag immediately before deleting, so a stale/forged name
 * can never trick the broker into deleting a stack it doesn't own.
 *
 * The raw AWS calls sit behind {@link CfnGateway} so the filtering + safety logic
 * is unit-tested without AWS.
 */
import type { ConnectedAccount, Connection, InfraGraph, ResidualResource, ResourceEntry, StackInventory } from "@agentspoppy/core";
import type { CloudProvider } from "../providers";
import { operatorCredentials } from "./credentials";
import { AccountUnreadableError, isAwsAuthError } from "./errors";
import { APP_TAG_KEY } from "./policy";
import { regionsFor } from "./regions";
import { type TaggingGateway, sdkTaggingGateway, resourceTypeFromArn } from "./tagging";
import { type ExistenceVerifier, ec2AwareExistenceVerifier } from "./existence";
import { buildInfraGraph } from "./infra-graph";
import { type DeletionGateway, type DeletionReport, deleteResiduals, sdkDeletionGateway } from "./deletion";

export interface CfnStackSummary {
  stackName: string;
  region: string;
  /** Stack-level tags, flattened to key→value. */
  tags: Record<string, string>;
}

/** The CloudFormation operations the provider needs, per region. */
export interface CfnGateway {
  /** All live (non-DELETE_COMPLETE) stacks in a region, with their tags. */
  listStacks(region: string): Promise<CfnStackSummary[]>;
  listResources(region: string, stackName: string): Promise<ResourceEntry[]>;
  /** The stack's template body (JSON/YAML text), for deriving the graph's edges. */
  getTemplate(region: string, stackName: string): Promise<string | undefined>;
  deleteStack(region: string, stackName: string): Promise<void>;
  /**
   * Empty an S3 bucket (every object version + delete marker) so CloudFormation can
   * delete it. A poppy that stores data (e.g. mail in S3) otherwise leaves a non-empty
   * bucket that stalls the whole stack delete in DELETE_FAILED. No-op if it's gone.
   */
  emptyBucket(region: string, bucket: string): Promise<void>;
  /**
   * Clear the active SES receipt rule set if it's one of these (the rule sets the stack
   * owns). CloudFormation can't delete an ACTIVE receipt rule set — the classic blocker
   * for an inbound-mail poppy — so it must be deactivated first.
   */
  deactivateReceiptRuleSets(region: string, ruleSetNames: string[]): Promise<void>;
  /**
   * Block until the stack reaches a terminal delete state, returning the final
   * CloudFormation status ("DELETE_COMPLETE" once the stack no longer exists).
   */
  waitForDelete(region: string, stackName: string): Promise<string>;
  /** A short human-readable summary of which resources failed to delete + why. */
  describeDeleteFailure(region: string, stackName: string): Promise<string>;
}

export class CloudFormationProvider implements CloudProvider {
  constructor(
    private readonly gateway: CfnGateway = sdkCfnGateway(),
    private readonly tagging: TaggingGateway = sdkTaggingGateway(),
    // EC2-aware: reads live instance state (a self-terminated VM must show as removed, not
    // linger green on the map); non-instance ARNs fall through to CloudTrail.
    private readonly verifier: ExistenceVerifier = ec2AwareExistenceVerifier(),
    private readonly deletion: DeletionGateway = sdkDeletionGateway(),
  ) {}

  /**
   * Host-side deletion of residuals attributed to this connection's app — the teardown
   * backstop for poppies that can't run their own cleanup (revoked/blocked/uninstalled).
   * The engine re-verifies each resource's live `agentspoppy:app` tag before destroying.
   */
  deleteResiduals(connection: Connection, _account: ConnectedAccount, residuals: ResidualResource[]): Promise<DeletionReport> {
    return deleteResiduals(residuals, connection.app.id, this.deletion);
  }

  /** The poppy's footprint as a graph (services + their template wiring), with verified status. */
  buildInfraGraph(connection: Connection, account: ConnectedAccount): Promise<InfraGraph> {
    return buildInfraGraph(connection, account, { gateway: this.gateway, tagging: this.tagging, verifier: this.verifier });
  }

  /**
   * Every live resource still tagged `agentspoppy:app = <app id>`, across regions —
   * the generic "what did this poppy leave behind" sweep. Independent of any stack, so
   * it catches out-of-stack resources and partial-delete leftovers alike. After a
   * teardown this MUST be empty; certification asserts exactly that.
   *
   * Per-region failures are skipped (disabled regions are normal) — but if EVERY region
   * fails and at least one failure is a credentials/permission problem, this throws
   * {@link AccountUnreadableError} instead of returning []. An empty result here reads
   * as "your account is clean"; a denied sweep must never masquerade as that.
   */
  async findResiduals(connection: Connection, account: ConnectedAccount): Promise<ResidualResource[]> {
    const perRegion = await Promise.all(
      regionsFor(account).map(async (region) => {
        try {
          const tagged = await this.tagging.getResourcesByTag(region, APP_TAG_KEY, connection.app.id);
          return { ok: true as const, residuals: tagged.map((t) => ({ arn: t.arn, resourceType: resourceTypeFromArn(t.arn), region })) };
        } catch (err) {
          return { ok: false as const, err }; // region disabled / not authorised → skip
        }
      }),
    );
    const failures = perRegion.filter((r) => !r.ok);
    if (failures.length === perRegion.length && failures.some((f) => isAwsAuthError(f.err))) {
      throw new AccountUnreadableError(
        `couldn't read the tag index in any region for account ${account.accountId} — the sweep result would be meaningless`,
        "denied",
      );
    }
    return perRegion.flatMap((r) => (r.ok ? r.residuals : []));
  }

  async listStacks(connection: Connection, account: ConnectedAccount): Promise<StackInventory[]> {
    const perRegion = await Promise.all(
      regionsFor(account).map(async (region) => {
        let summaries: CfnStackSummary[];
        try {
          summaries = await this.gateway.listStacks(region);
        } catch {
          return []; // region disabled / not authorised → skip, don't fail the whole scan
        }
        const owned = summaries.filter((s) => ownedBy(s, connection));
        return Promise.all(
          owned.map(async (summary) => ({
            stackName: summary.stackName,
            region,
            stackExists: true,
            resources: await this.gateway.listResources(region, summary.stackName).catch(() => []),
          })),
        );
      }),
    );
    return perRegion.flat();
  }

  async deleteStack(connection: Connection, account: ConnectedAccount, stackName: string): Promise<void> {
    for (const region of regionsFor(account)) {
      let summaries: CfnStackSummary[];
      try {
        summaries = await this.gateway.listStacks(region);
      } catch {
        continue; // region disabled / not authorised → not here
      }
      const match = summaries.find((s) => s.stackName === stackName);
      if (!match) continue;
      // Defence in depth: confirm ownership at delete time, not just at list time.
      if (!ownedBy(match, connection)) {
        throw new Error(
          `refusing to delete stack "${stackName}": it is not attributed to connection ${connection.id}`,
        );
      }
      // CloudFormation can't delete a non-empty S3 bucket, so a poppy that stores data
      // (e.g. mail) would otherwise stall the whole teardown in DELETE_FAILED. Empty its
      // buckets first (best-effort), then delete and wait for the real terminal status —
      // so "tear down everything" actually completes rather than reporting an async start.
      const resources = await this.gateway.listResources(region, stackName).catch(() => []);
      for (const r of resources) {
        if (r.type === "AWS::S3::Bucket" && r.physicalId) {
          await this.gateway.emptyBucket(region, r.physicalId).catch(() => {});
        }
      }
      // SES can't delete an ACTIVE receipt rule set, so deactivate any the stack owns —
      // the inbound-mail rule set is the classic blocker for a mail poppy.
      const ruleSets = resources
        .filter((r) => r.type === "AWS::SES::ReceiptRuleSet" && r.physicalId)
        .map((r) => r.physicalId);
      if (ruleSets.length > 0) {
        await this.gateway.deactivateReceiptRuleSets(region, ruleSets).catch(() => {});
      }
      await this.gateway.deleteStack(region, stackName);
      const status = await this.gateway.waitForDelete(region, stackName);
      if (status !== "DELETE_COMPLETE") {
        const detail = await this.gateway.describeDeleteFailure(region, stackName).catch(() => "");
        throw new Error(
          `stack "${stackName}" did not delete cleanly (CloudFormation status: ${status}). ` +
            (detail || "Some resources may need manual removal in the AWS console."),
        );
      }
      return;
    }
    throw new Error(`stack "${stackName}" not found in any region for account ${account.accountId}`);
  }
}

function ownedBy(summary: CfnStackSummary, connection: Connection): boolean {
  return summary.tags[APP_TAG_KEY] === connection.app.id;
}

/** Default gateway backed by the AWS SDK. Operator credentials, lazy SDK import. */
export function sdkCfnGateway(): CfnGateway {
  async function client(region: string) {
    const { CloudFormationClient } = await import("@aws-sdk/client-cloudformation");
    return new CloudFormationClient({ region, credentials: await operatorCredentials() });
  }

  return {
    async listStacks(region) {
      const { DescribeStacksCommand } = await import("@aws-sdk/client-cloudformation");
      const cfn = await client(region);
      const out: CfnStackSummary[] = [];
      let token: string | undefined;
      do {
        const res = await cfn.send(new DescribeStacksCommand({ NextToken: token }));
        for (const s of res.Stacks ?? []) {
          if (!s.StackName || s.StackStatus === "DELETE_COMPLETE") continue;
          const tags: Record<string, string> = {};
          for (const t of s.Tags ?? []) if (t.Key) tags[t.Key] = t.Value ?? "";
          out.push({ stackName: s.StackName, region, tags });
        }
        token = res.NextToken;
      } while (token);
      return out;
    },

    async listResources(region, stackName) {
      // Use DescribeStackResources, NOT ListStackResources: the operator role grants
      // `cloudformation:DescribeStackResources` (see role-template.ts) but not the List form.
      // Reading the stack's own resources is what lets the map mark them authoritatively
      // "present" — otherwise it falls back to a tag sweep + CloudTrail cross-check, which
      // can't confirm every service by name and leaves some stuck on "verifying". Describe
      // returns up to 100 resources (no pagination), which comfortably covers a poppy's stack.
      const { DescribeStackResourcesCommand } = await import("@aws-sdk/client-cloudformation");
      const cfn = await client(region);
      const res = await cfn.send(new DescribeStackResourcesCommand({ StackName: stackName }));
      return (res.StackResources ?? []).map((r) => ({
        logicalId: r.LogicalResourceId ?? "",
        physicalId: r.PhysicalResourceId ?? "",
        type: r.ResourceType ?? "",
        status: r.ResourceStatus ?? "",
      }));
    },

    async getTemplate(region, stackName) {
      const { GetTemplateCommand } = await import("@aws-sdk/client-cloudformation");
      const cfn = await client(region);
      const res = await cfn.send(new GetTemplateCommand({ StackName: stackName }));
      return res.TemplateBody ?? undefined;
    },

    async deleteStack(region, stackName) {
      const { DeleteStackCommand } = await import("@aws-sdk/client-cloudformation");
      const cfn = await client(region);
      await cfn.send(new DeleteStackCommand({ StackName: stackName }));
    },

    async emptyBucket(region, bucket) {
      const { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } = await import("@aws-sdk/client-s3");
      const s3 = new S3Client({ region, credentials: await operatorCredentials() });
      // ListObjectVersions covers both versioned and unversioned buckets (the latter
      // reports a single "null" version per key), so a fresh list + batch delete loop
      // drains either kind. We re-list from the start each pass since we're deleting.
      // Bounded: DeleteObjects reports per-key failures in a 200 (the SDK doesn't
      // throw), so an undeletable version would otherwise re-list forever and HANG the
      // whole teardown. This helper is best-effort — on a stuck pass we stop and let
      // the stack delete surface the real failure in its status/events.
      for (let pass = 0; pass < 5000; pass++) {
        let page;
        try {
          page = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, MaxKeys: 1000 }));
        } catch {
          return; // bucket already gone / not accessible — let the stack delete surface real issues
        }
        const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
          .filter((o) => o.Key)
          .map((o) => ({ Key: o.Key as string, VersionId: o.VersionId }));
        if (objects.length === 0) return;
        const res = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
        if (res.Errors && res.Errors.length > 0) return; // stuck keys — stop, don't hot-loop
      }
    },

    async deactivateReceiptRuleSets(region, ruleSetNames) {
      if (ruleSetNames.length === 0) return;
      const { SESClient, DescribeActiveReceiptRuleSetCommand, SetActiveReceiptRuleSetCommand } = await import(
        "@aws-sdk/client-ses"
      );
      const ses = new SESClient({ region, credentials: await operatorCredentials() });
      let activeName: string | undefined;
      try {
        const active = await ses.send(new DescribeActiveReceiptRuleSetCommand({}));
        activeName = active.Metadata?.Name;
      } catch {
        return; // no active set / not authorised — nothing to clear
      }
      if (activeName && ruleSetNames.includes(activeName)) {
        // Omitting RuleSetName clears the active set so CloudFormation can delete it.
        await ses.send(new SetActiveReceiptRuleSetCommand({}));
      }
    },

    async waitForDelete(region, stackName) {
      const { DescribeStacksCommand } = await import("@aws-sdk/client-cloudformation");
      const cfn = await client(region);
      const deadline = Date.now() + 4 * 60_000; // generous cap; a mail stack drains in 1–2 min
      for (;;) {
        let status: string;
        try {
          const res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
          status = res.Stacks?.[0]?.StackStatus ?? "DELETE_COMPLETE";
        } catch {
          return "DELETE_COMPLETE"; // DescribeStacks by name 404s once the stack is fully gone
        }
        if (status === "DELETE_COMPLETE" || status.endsWith("_FAILED")) return status;
        if (Date.now() >= deadline) return status; // still in progress after the cap
        await new Promise((r) => setTimeout(r, 3000));
      }
    },

    async describeDeleteFailure(region, stackName) {
      const { DescribeStackEventsCommand } = await import("@aws-sdk/client-cloudformation");
      const cfn = await client(region);
      try {
        const res = await cfn.send(new DescribeStackEventsCommand({ StackName: stackName }));
        const seen = new Set<string>();
        const failures: string[] = [];
        // Events come newest-first, so the first _FAILED we see per resource is the latest.
        for (const e of res.StackEvents ?? []) {
          if (!e.ResourceStatus?.endsWith("_FAILED")) continue;
          const key = e.LogicalResourceId ?? "";
          if (seen.has(key)) continue;
          seen.add(key);
          const reason = e.ResourceStatusReason ? `: ${e.ResourceStatusReason}` : "";
          failures.push(`${e.LogicalResourceId} (${e.ResourceType})${reason}`);
        }
        return failures.length ? `Blocked by — ${failures.slice(0, 3).join("; ")}` : "";
      } catch {
        return "";
      }
    },
  };
}
