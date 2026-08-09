// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The host-side residual deletion engine — the backstop that makes teardown complete in
 * EVERY poppy state.
 *
 * A poppy's own teardown hook can only run while the poppy can run: a revoked connection
 * can't mint credentials, and a blocked poppy's backend is never spawned. Before this
 * engine, tearing such a poppy down deleted its CloudFormation stack but orphaned anything
 * it retained outside the stack (RETAIN-marked buckets/tables/user pools survive a stack
 * delete by design). The user's only recourse was to re-approve — or worse, unblock and
 * re-run — the very code they had just cut off.
 *
 * This engine closes that hole from the host side: the generic tag sweep already finds
 * every surviving resource stamped `agentspoppy:app = <app id>` (see ./tagging.ts); here
 * the HOST deletes them itself, with type-aware deleters, on the operator's own
 * credentials — no poppy code involved. The poppy's hook still runs first when it can
 * (only the poppy knows its un-tagged/un-taggable leftovers, e.g. Route53 records); the
 * engine is the guarantee that whatever is *attributed* to the poppy never outlives it.
 *
 * Safety model — deletion is double-keyed to the attribution tag:
 *  1. a resource is only ever a candidate because the tag sweep returned it for this
 *     app's tag, and
 *  2. immediately before destroying, the engine re-reads the resource's tags and
 *     verifies `agentspoppy:app` still matches. For S3 / DynamoDB / Cognito / Lambda /
 *     Logs this is a LIVE per-service tag read (GetBucketTagging, ListTagsOfResource, …)
 *     — strongly fresher than the eventually-consistent tag index the sweep used, so a
 *     just-untagged/retagged resource is skipped, never deleted. SES has no per-resource
 *     tag-read API, so its types fall back to the tagging index (best-effort only).
 * Anything the engine doesn't have a deleter for is reported, never silently dropped.
 *
 * Same seams as the rest of the admin plane: a {@link DeletionGateway} interface so the
 * dispatch/safety logic is unit-tested without AWS, an SDK factory with lazy imports and
 * per-call operator credentials, and best-effort per-resource error capture (one
 * undeletable resource must not strand the rest).
 */
import type { ResidualResource } from "@agentspoppy/core";
import { operatorCredentials } from "./credentials";
import { APP_TAG_KEY } from "./policy";
import { isAwsAuthError } from "./errors";
import { resourceTypeFromArn } from "./tagging";

/** Flatten the SDK's `{Key,Value}[]` tag shape into a record. */
function tagRecord(tags: { Key?: string; Value?: string }[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tags ?? []) if (t.Key) out[t.Key] = t.Value ?? "";
  return out;
}

/** The type-aware delete operations the engine dispatches to, per region. */
export interface DeletionGateway {
  /** Tags on one resource for the pre-delete re-verification — live per-service reads
   *  where the service has one (S3/DynamoDB/Cognito/Lambda/Logs), tag-index otherwise. */
  getTags(region: string, arn: string): Promise<Record<string, string>>;
  /** Empty (all versions + delete markers) then delete an S3 bucket. */
  deleteBucket(region: string, bucket: string): Promise<void>;
  /** Delete a DynamoDB table, disabling deletion protection first if it's on. */
  deleteTable(region: string, tableName: string): Promise<void>;
  /** Delete a Cognito user pool, removing its hosted-UI domain first if one exists. */
  deleteUserPool(region: string, poolId: string): Promise<void>;
  deleteFunction(region: string, functionName: string): Promise<void>;
  deleteLogGroup(region: string, logGroupName: string): Promise<void>;
  /** Delete an SES identity (domain or email address). */
  deleteSesIdentity(region: string, identity: string): Promise<void>;
  /** Delete an SES receipt rule set, deactivating it first if it's the active one. */
  deleteReceiptRuleSet(region: string, ruleSetName: string): Promise<void>;
}

/** One residual the engine failed to delete, with the reason it can be acted on. */
export interface FailedDeletion {
  residual: ResidualResource;
  error: string;
  /** True when the failure was a permissions problem — the operator policy predates the
   *  host-cleanup grants, so the fix is "update the access policy", not "try again". */
  authError: boolean;
}

/** The engine's honest ledger: everything it removed, couldn't remove, or doesn't know how to. */
export interface DeletionReport {
  removed: ResidualResource[];
  failed: FailedDeletion[];
  /** Types the engine has no deleter for — reported so the caller can surface them. */
  unsupported: ResidualResource[];
}

/** The bare resource id from an ARN tail: "type/id" | "type:id" | "id" → "id".
 *  Log groups are the exception — their name ("/aws/lambda/fn") contains "/", so the
 *  tail after the "log-group:" prefix must be kept whole. */
function resourceIdFromArn(arn: string, resourceType: string): string {
  const tail = arn.split(":").slice(5).join(":");
  if (resourceType === "logs:log-group") return tail.replace(/^log-group:/, "");
  const sep = tail.search(/[/:]/);
  return sep >= 0 ? tail.slice(sep + 1) : tail;
}

/**
 * Delete every residual the engine knows how to, in this order per resource:
 * re-verify the attribution tag → dispatch the type-aware deleter → record the outcome.
 * NotFound during deletion counts as removed (the sweep index lags behind reality);
 * anything else is captured per-resource so one failure never aborts the rest.
 */
export async function deleteResiduals(
  residuals: ResidualResource[],
  appId: string,
  gateway: DeletionGateway,
): Promise<DeletionReport> {
  const report: DeletionReport = { removed: [], failed: [], unsupported: [] };

  for (const residual of residuals) {
    const del = deleterFor(residual, gateway);
    if (!del) {
      report.unsupported.push(residual);
      continue;
    }
    try {
      // Double-key the destruction: the sweep attributed this ARN to the app, but the
      // tag index can be stale — confirm the live tag before touching anything.
      const tags = await gateway.getTags(residual.region, residual.arn);
      if (tags[APP_TAG_KEY] !== appId) {
        report.failed.push({
          residual,
          error: `skipped: live tag check did not attribute this resource to ${appId}`,
          authError: false,
        });
        continue;
      }
      await del();
      report.removed.push(residual);
    } catch (err) {
      if (isNotFound(err)) {
        report.removed.push(residual); // already gone — the sweep index was behind
        continue;
      }
      report.failed.push({
        residual,
        error: err instanceof Error ? err.message : String(err),
        authError: isAwsAuthError(err),
      });
    }
  }
  return report;
}

/** Map a residual's "service:type" to its deleter — or null when the engine has none. */
function deleterFor(residual: ResidualResource, gateway: DeletionGateway): (() => Promise<void>) | null {
  const { region, resourceType } = residual;
  const id = resourceIdFromArn(residual.arn, resourceType);
  if (!id) return null;
  switch (resourceType) {
    case "s3": // bucket ARNs have no type segment: arn:aws:s3:::bucket-name
      return () => gateway.deleteBucket(region, id);
    case "dynamodb:table":
      return () => gateway.deleteTable(region, id);
    case "cognito-idp:userpool":
      return () => gateway.deleteUserPool(region, id);
    case "lambda:function":
      return () => gateway.deleteFunction(region, id);
    case "logs:log-group":
      return () => gateway.deleteLogGroup(region, id);
    case "ses:identity":
      return () => gateway.deleteSesIdentity(region, id);
    case "ses:receipt-rule-set":
      return () => gateway.deleteReceiptRuleSet(region, id);
    default:
      return null;
  }
}

/** True for the per-service "it's already gone" errors — success for a deletion engine. */
function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  const name = e.name ?? e.Code ?? "";
  return (
    /NotFound|NoSuchBucket|NoSuchEntity|ResourceNotFoundException|RuleSetDoesNotExist/i.test(name) ||
    e.$metadata?.httpStatusCode === 404
  );
}

/** Upper bound on bucket-drain passes (1000 keys each). Termination is normally the
 *  empty list or a thrown per-key error; this cap only stops a pathological runaway
 *  (e.g. a live writer refilling the bucket faster than we drain it). */
const MAX_DRAIN_PASSES = 5000;

/** Default gateway backed by the AWS SDK. Operator credentials, lazy SDK import. */
export function sdkDeletionGateway(): DeletionGateway {
  return {
    async getTags(region, arn) {
      const credentials = await operatorCredentials();
      const id = resourceIdFromArn(arn, resourceTypeFromArn(arn));
      // Live per-service tag reads — the tagging INDEX (which produced the sweep
      // candidates) is eventually consistent, so re-querying it would mostly re-read
      // the same stale entry. These APIs answer from the service itself.
      switch (resourceTypeFromArn(arn)) {
        case "s3": {
          const { S3Client, GetBucketTaggingCommand } = await import("@aws-sdk/client-s3");
          const s3 = new S3Client({ region, credentials });
          try {
            const res = await s3.send(new GetBucketTaggingCommand({ Bucket: id }));
            return tagRecord(res.TagSet);
          } catch (err) {
            // An existing-but-untagged bucket answers NoSuchTagSet — that's "no tags"
            // (→ the tag check refuses to delete), not an error.
            if ((err as { name?: string }).name === "NoSuchTagSet") return {};
            throw err;
          }
        }
        case "dynamodb:table": {
          const { DynamoDBClient, ListTagsOfResourceCommand } = await import("@aws-sdk/client-dynamodb");
          const ddb = new DynamoDBClient({ region, credentials });
          const res = await ddb.send(new ListTagsOfResourceCommand({ ResourceArn: arn }));
          return tagRecord(res.Tags);
        }
        case "cognito-idp:userpool": {
          const { CognitoIdentityProviderClient, ListTagsForResourceCommand } = await import(
            "@aws-sdk/client-cognito-identity-provider"
          );
          const cognito = new CognitoIdentityProviderClient({ region, credentials });
          const res = await cognito.send(new ListTagsForResourceCommand({ ResourceArn: arn }));
          return res.Tags ?? {};
        }
        case "lambda:function": {
          const { LambdaClient, ListTagsCommand } = await import("@aws-sdk/client-lambda");
          const lambda = new LambdaClient({ region, credentials });
          const res = await lambda.send(new ListTagsCommand({ Resource: arn }));
          return res.Tags ?? {};
        }
        case "logs:log-group": {
          const { CloudWatchLogsClient, ListTagsForResourceCommand } = await import("@aws-sdk/client-cloudwatch-logs");
          const logs = new CloudWatchLogsClient({ region, credentials });
          // Log-group ARNs from the tagging index can carry a trailing ":*" — the
          // tags API wants the bare ARN.
          const res = await logs.send(new ListTagsForResourceCommand({ resourceArn: arn.replace(/:\*$/, "") }));
          return res.tags ?? {};
        }
        default: {
          // SES identities/rule sets have no per-resource tag-read API (v1) — fall back
          // to the tagging index. Best-effort: same store the sweep used.
          const { ResourceGroupsTaggingAPIClient, GetResourcesCommand } = await import(
            "@aws-sdk/client-resource-groups-tagging-api"
          );
          const client = new ResourceGroupsTaggingAPIClient({ region, credentials });
          const res = await client.send(new GetResourcesCommand({ ResourceARNList: [arn] }));
          const tags: Record<string, string> = {};
          for (const t of res.ResourceTagMappingList?.[0]?.Tags ?? []) {
            if (t.Key) tags[t.Key] = t.Value ?? "";
          }
          return tags;
        }
      }
    },

    async deleteBucket(region, bucket) {
      const { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand, DeleteBucketCommand } = await import(
        "@aws-sdk/client-s3"
      );
      const s3 = new S3Client({ region, credentials: await operatorCredentials() });
      // Drain every object version + delete marker (works for unversioned buckets too:
      // they report one "null" version per key), then delete the bucket itself. Unlike
      // the stack-delete path's best-effort emptyBucket, failures here PROPAGATE:
      // this is the last line of cleanup, and a denial must be reported, not swallowed
      // as "already gone" — that's exactly how orphans go unnoticed.
      for (let pass = 0; ; pass++) {
        if (pass >= MAX_DRAIN_PASSES) {
          throw new Error(
            `bucket "${bucket}" still isn't empty after ${MAX_DRAIN_PASSES} delete passes — ` +
              `something keeps refilling it (a live writer?)`,
          );
        }
        const page = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, MaxKeys: 1000 }));
        const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
          .filter((o) => o.Key)
          .map((o) => ({ Key: o.Key as string, VersionId: o.VersionId }));
        if (objects.length === 0) break;
        const res = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
        // DeleteObjects authorizes and fails PER KEY, reporting failures in a 200 —
        // the SDK does not throw. An undeletable version (Object Lock, a bucket-policy
        // Deny — which a hostile poppy could plant on its own bucket) would otherwise
        // be re-listed and re-"deleted" forever: teardown would HANG instead of
        // reporting. Surface the first failure so the bucket lands in report.failed.
        const firstErr = res.Errors?.find((e) => e.Key);
        if (firstErr) {
          const err = new Error(
            `could not delete "${firstErr.Key}"${firstErr.VersionId ? ` (version ${firstErr.VersionId})` : ""}: ` +
              `${firstErr.Code ?? "Error"}${firstErr.Message ? ` — ${firstErr.Message}` : ""}`,
          );
          err.name = firstErr.Code ?? "DeleteObjectsError";
          throw err;
        }
      }
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    },

    async deleteTable(region, tableName) {
      const { DynamoDBClient, DeleteTableCommand, UpdateTableCommand } = await import("@aws-sdk/client-dynamodb");
      const ddb = new DynamoDBClient({ region, credentials: await operatorCredentials() });
      try {
        await ddb.send(new DeleteTableCommand({ TableName: tableName }));
      } catch (err) {
        // Deletion protection is the one recoverable blocker: disable it and retry once.
        const msg = err instanceof Error ? err.message : "";
        if (!/deletion protection/i.test(msg)) throw err;
        await ddb.send(new UpdateTableCommand({ TableName: tableName, DeletionProtectionEnabled: false }));
        await ddb.send(new DeleteTableCommand({ TableName: tableName }));
      }
    },

    async deleteUserPool(region, poolId) {
      const { CognitoIdentityProviderClient, DescribeUserPoolCommand, DeleteUserPoolDomainCommand, DeleteUserPoolCommand } =
        await import("@aws-sdk/client-cognito-identity-provider");
      const cognito = new CognitoIdentityProviderClient({ region, credentials: await operatorCredentials() });
      // A hosted-UI domain blocks pool deletion — remove it first when present.
      try {
        const pool = await cognito.send(new DescribeUserPoolCommand({ UserPoolId: poolId }));
        const domain = pool.UserPool?.Domain;
        if (domain) await cognito.send(new DeleteUserPoolDomainCommand({ Domain: domain, UserPoolId: poolId }));
      } catch {
        /* describe/domain failures fall through to the delete, which reports the real error */
      }
      await cognito.send(new DeleteUserPoolCommand({ UserPoolId: poolId }));
    },

    async deleteFunction(region, functionName) {
      const { LambdaClient, DeleteFunctionCommand } = await import("@aws-sdk/client-lambda");
      const lambda = new LambdaClient({ region, credentials: await operatorCredentials() });
      await lambda.send(new DeleteFunctionCommand({ FunctionName: functionName }));
    },

    async deleteLogGroup(region, logGroupName) {
      const { CloudWatchLogsClient, DeleteLogGroupCommand } = await import("@aws-sdk/client-cloudwatch-logs");
      const logs = new CloudWatchLogsClient({ region, credentials: await operatorCredentials() });
      await logs.send(new DeleteLogGroupCommand({ logGroupName }));
    },

    async deleteSesIdentity(region, identity) {
      const { SESClient, DeleteIdentityCommand } = await import("@aws-sdk/client-ses");
      const ses = new SESClient({ region, credentials: await operatorCredentials() });
      await ses.send(new DeleteIdentityCommand({ Identity: identity }));
    },

    async deleteReceiptRuleSet(region, ruleSetName) {
      const { SESClient, DescribeActiveReceiptRuleSetCommand, SetActiveReceiptRuleSetCommand, DeleteReceiptRuleSetCommand } =
        await import("@aws-sdk/client-ses");
      const ses = new SESClient({ region, credentials: await operatorCredentials() });
      // SES refuses to delete the ACTIVE rule set — clear the active slot first if it's ours.
      try {
        const active = await ses.send(new DescribeActiveReceiptRuleSetCommand({}));
        if (active.Metadata?.Name === ruleSetName) await ses.send(new SetActiveReceiptRuleSetCommand({}));
      } catch {
        /* no active set / can't read it — the delete below reports the real error if any */
      }
      await ses.send(new DeleteReceiptRuleSetCommand({ RuleSetName: ruleSetName }));
    },
  };
}
