// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The AWS-touching seams, behind interfaces so the broker logic stays pure and
 * testable. The real, AWS-backed implementations live under ./aws (STS scoped
 * credentials, CloudFormation inventory + teardown); the stubs below are kept
 * for the test suite and the demo/seed dev experience.
 *
 * Both seams take the connection AND its {@link ConnectedAccount}: vending needs
 * the account's role ARN + region, and inventory/teardown need the region(s).
 */
import type { ActivityEvent, ConnectedAccount, Connection, InfraGraph, ResidualResource, StackInventory } from "@agentspoppy/core";
import type { DeletionReport } from "./aws/deletion";

export interface ScopedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** ISO 8601 expiry. */
  expiration: string;
}

/** Vends short-lived, scope-limited credentials for a connection. */
export interface CredentialVendor {
  vend(connection: Connection, account: ConnectedAccount): Promise<ScopedCredentials>;
}

/** Reads and destroys the cloud footprint a connection created. */
export interface CloudProvider {
  listStacks(connection: Connection, account: ConnectedAccount): Promise<StackInventory[]>;
  deleteStack(connection: Connection, account: ConnectedAccount, stackName: string): Promise<void>;
  /**
   * Every live resource still carrying the connection's app-attribution tag, across
   * regions — the generic footprint sweep used to verify a teardown left nothing behind.
   */
  findResiduals(connection: Connection, account: ConnectedAccount): Promise<ResidualResource[]>;
  /**
   * The poppy's footprint as a graph — services as nodes, stack-template references as
   * edges, each node's existence verified. A live infra map, and (post-teardown) a report
   * of what's actually gone vs. still present.
   */
  buildInfraGraph(connection: Connection, account: ConnectedAccount): Promise<InfraGraph>;
  /**
   * HOST-side deletion of residuals the sweep attributed to this connection's app —
   * the backstop that completes a teardown when the poppy itself can't run its own
   * cleanup (revoked, blocked, or uninstalled). Type-aware, tag-double-checked, and
   * honest: everything not removed comes back in the report, never silently dropped.
   */
  deleteResiduals(connection: Connection, account: ConnectedAccount, residuals: ResidualResource[]): Promise<DeletionReport>;
}

/** Stub: returns obviously-fake credentials. Wiring + tests only — never AWS. */
export class StubCredentialVendor implements CredentialVendor {
  async vend(connection: Connection): Promise<ScopedCredentials> {
    return {
      accessKeyId: `STUB-${connection.id}`,
      secretAccessKey: "stub-secret",
      sessionToken: "stub-session",
      expiration: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
  }
}

/** Stub: reports no stacks and no-ops teardown. */
export class StubCloudProvider implements CloudProvider {
  async listStacks(): Promise<StackInventory[]> {
    return [];
  }
  async deleteStack(): Promise<void> {
    /* no-op */
  }
  async findResiduals(): Promise<ResidualResource[]> {
    return [];
  }
  async buildInfraGraph(connection: Connection): Promise<InfraGraph> {
    return { connectionId: connection.id, appId: connection.app.id, nodes: [], edges: [], generatedAt: new Date().toISOString() };
  }
  async deleteResiduals(): Promise<DeletionReport> {
    return { removed: [], failed: [], unsupported: [] };
  }
}

/** What the activity feed needs to attribute recent management events. */
export interface ActivityQuery {
  /** The broker role AgentsPoppy assumes (sessions of it are "through a poppy"). */
  brokerRoleName: string;
  /** The operator IAM user (its calls are "AgentsPoppy itself"). */
  operatorName: string;
  /** The operator's exact caller ARN (live identity) — users connect with their own
   * IAM user, not the canonical name, so name alone would misattribute the broker's
   * own calls as external. */
  operatorArn?: string;
  /** Regions to read CloudTrail in (management events are per-region; IAM/STS land in us-east-1). */
  regions: string[];
  /** How far back to look. */
  sinceMinutes: number;
  /** Cap on returned events. */
  limit: number;
}

/**
 * Reads recent account activity (CloudTrail management events), already
 * attributed to a poppy / AgentsPoppy / external. Read-only; operator creds.
 */
export interface ActivityProvider {
  recentActivity(query: ActivityQuery): Promise<ActivityEvent[]>;
}

/** Stub: reports no activity. Wiring + tests only. */
export class StubActivityProvider implements ActivityProvider {
  async recentActivity(): Promise<ActivityEvent[]> {
    return [];
  }
}
