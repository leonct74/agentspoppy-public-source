// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Build a poppy's infrastructure graph — services as nodes, stack-template references as
 * edges — from the live stack plus the generic tag sweep.
 *
 * Two sources, reconciled:
 *  - the CloudFormation stack(s) the app owns give the in-stack nodes (resource type +
 *    status) and, from the template, the edges between them;
 *  - the `agentspoppy:app` tag sweep gives the full footprint, including out-of-stack
 *    resources the stack can't see. Each swept ARN is existence-checked, so a stale tag
 *    shows as "removed"/"unverified" rather than a phantom leftover.
 *
 * The same graph is both a live infrastructure map (stack present) and — after teardown —
 * a report of what was removed vs. what's still present. The assembly is pure and unit-
 * tested; the orchestrator just fetches and feeds it.
 */
import type { ConnectedAccount, Connection, InfraEdge, InfraGraph, InfraNode, InfraNodeStatus, ResourceEntry } from "@agentspoppy/core";
import { APP_TAG_KEY } from "./policy";
import { regionsFor } from "./regions";
import { type TaggingGateway, resourceTypeFromArn } from "./tagging";
import type { CfnGateway } from "./cloudformation";
import { parseTemplateEdges } from "./infra-template";
import { consoleUrlForArn } from "./console-url";
import type { ExistenceVerifier } from "./existence";
import { AccountUnreadableError, isAwsAuthError } from "./errors";

/** One owned stack's resources + the edges parsed from its template. */
export interface StackGraphInput {
  region: string;
  resources: ResourceEntry[];
  edges: InfraEdge[];
}

/** A swept resource with its existence already resolved. */
export interface VerifiedResidual {
  arn: string;
  region: string;
  status: InfraNodeStatus;
}

/** The CFN service segment, lowercased: "AWS::S3::Bucket" → "s3", "AWS::Cognito::UserPool" → "cognito". */
function serviceFromCfnType(type: string): string {
  return (type.split("::")[1] ?? type).toLowerCase();
}

/** In-stack resources exist unless the stack already deleted them. */
function statusFromCfn(resourceStatus: string): InfraNodeStatus {
  return /^DELETE_COMPLETE$/.test(resourceStatus) ? "removed" : "present";
}

/** The bare resource id at the end of an ARN, for matching against a stack's physical ids. */
function arnTailId(arn: string): string {
  const tail = arn.split(":").slice(5).join(":");
  return tail.split(/[/:]/).pop() ?? tail;
}

/**
 * Assemble the graph from already-fetched data. Pure. In-stack resources become nodes keyed
 * by logical id (so template edges line up); a swept ARN that matches a stack resource's
 * physical id enriches that node (ARN + console link) instead of duplicating it; the rest
 * become out-of-stack nodes carrying their verified status.
 */
export function assembleInfraGraph(
  app: { connectionId: string; appId: string },
  stacks: StackGraphInput[],
  residuals: VerifiedResidual[],
  now: () => string = () => new Date().toISOString(),
): InfraGraph {
  const nodes: InfraNode[] = [];
  const edges: InfraEdge[] = [];
  const byPhysicalId = new Map<string, InfraNode>();

  for (const stack of stacks) {
    for (const r of stack.resources) {
      const node: InfraNode = {
        id: r.logicalId,
        service: serviceFromCfnType(r.type),
        resourceType: r.type,
        name: r.physicalId || r.logicalId,
        region: stack.region,
        status: statusFromCfn(r.status),
        inStack: true,
      };
      nodes.push(node);
      if (r.physicalId) byPhysicalId.set(r.physicalId, node);
    }
    edges.push(...stack.edges);
  }

  for (const res of residuals) {
    const tailId = arnTailId(res.arn);
    const matched = byPhysicalId.get(tailId);
    if (matched) {
      // Same resource the stack already lists — enrich it rather than duplicate.
      matched.arn = res.arn;
      matched.consoleUrl = consoleUrlForArn(res.arn, res.region);
      continue;
    }
    nodes.push({
      id: res.arn,
      service: res.arn.split(":")[2] ?? "",
      resourceType: resourceTypeFromArn(res.arn),
      name: tailId,
      region: res.region,
      status: res.status,
      inStack: false,
      arn: res.arn,
      consoleUrl: consoleUrlForArn(res.arn, res.region),
    });
  }

  // Drop edges whose endpoints aren't both present as nodes (defensive).
  const ids = new Set(nodes.map((n) => n.id));
  const liveEdges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));

  return { connectionId: app.connectionId, appId: app.appId, nodes, edges: liveEdges, generatedAt: now() };
}

export interface InfraGraphDeps {
  gateway: CfnGateway;
  tagging: TaggingGateway;
  verifier: ExistenceVerifier;
  now?: () => string;
}

/** Fetch everything the graph needs (owned stacks + templates + verified tag sweep) and assemble it. */
export async function buildInfraGraph(
  connection: Connection,
  account: ConnectedAccount,
  deps: InfraGraphDeps,
): Promise<InfraGraph> {
  const { gateway, tagging, verifier } = deps;
  const regions = regionsFor(account);

  // Per-region failures are normal (an opt-in region you haven't enabled errors and is skipped).
  // But if EVERY region failed and a failure was a credentials/permission problem — and nothing
  // could be read at all — the account is unreadable, not empty: raise so the user gets a
  // "reconnect" prompt instead of a misleading blank map.
  let anyReadOk = false;
  let authFailure: { kind: "auth" | "denied"; message: string } | null = null;
  const noteFailure = (err: unknown) => {
    if (!isAwsAuthError(err)) return;
    const e = err as { name?: string; Code?: string; message?: string };
    const denied = /denied|not authorized/i.test(`${e.name ?? e.Code ?? ""} ${e.message ?? ""}`);
    // Prefer the most actionable: a hard "auth" (bad/expired key) over a "denied" (missing perm).
    if (!authFailure || (authFailure.kind === "denied" && !denied)) {
      authFailure = { kind: denied ? "denied" : "auth", message: String(e.message ?? "AWS request failed") };
    }
  };

  const stackInputs: StackGraphInput[] = [];
  await Promise.all(
    regions.map(async (region) => {
      let summaries;
      try {
        summaries = await gateway.listStacks(region);
        anyReadOk = true;
      } catch (err) {
        noteFailure(err); // region disabled / not authorised / bad creds → skip, but remember why
        return;
      }
      for (const s of summaries.filter((x) => x.tags[APP_TAG_KEY] === connection.app.id)) {
        const [resources, template] = await Promise.all([
          gateway.listResources(region, s.stackName).catch(() => [] as ResourceEntry[]),
          gateway.getTemplate(region, s.stackName).catch(() => undefined),
        ]);
        stackInputs.push({ region, resources, edges: parseTemplateEdges(template) });
      }
    }),
  );

  const rawResiduals = (
    await Promise.all(
      regions.map(async (region) => {
        try {
          const tagged = await tagging.getResourcesByTag(region, APP_TAG_KEY, connection.app.id);
          anyReadOk = true;
          return tagged.map((t) => ({ arn: t.arn, region }));
        } catch (err) {
          noteFailure(err);
          return [] as { arn: string; region: string }[];
        }
      }),
    )
  ).flat();

  // Nothing read anywhere AND a credentials/permission failure → the account is unreadable.
  if (!anyReadOk && authFailure) {
    const f: { kind: "auth" | "denied"; message: string } = authFailure;
    throw new AccountUnreadableError(
      f.kind === "denied"
        ? "AgentsPoppy connected to AWS but its operator role lacks permission to read this account's footprint (CloudFormation + Resource Groups Tagging). Reconnect the account to refresh its permissions."
        : "AgentsPoppy can't read this AWS account — its operator credentials are invalid or expired. Reconnect your AWS account to restore the map.",
      f.kind,
    );
  }

  const residuals: VerifiedResidual[] = await Promise.all(
    rawResiduals.map(async (r) => ({ arn: r.arn, region: r.region, status: await verifier.verify(r.region, r.arn) })),
  );

  return assembleInfraGraph({ connectionId: connection.id, appId: connection.app.id }, stackInputs, residuals, deps.now);
}
