// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { assembleInfraGraph } from "./infra-graph";
import type { StackGraphInput, VerifiedResidual } from "./infra-graph";

const app = { connectionId: "conn-1", appId: "com.mailpoppy.desktop" };
const now = () => "2026-06-27T00:00:00.000Z";

const stack: StackGraphInput = {
  region: "eu-west-1",
  resources: [
    { logicalId: "MailBucket", physicalId: "mailpoppy-mail-7f3a", type: "AWS::S3::Bucket", status: "CREATE_COMPLETE" },
    { logicalId: "InboundFn", physicalId: "mailpoppy-inbound", type: "AWS::Lambda::Function", status: "CREATE_COMPLETE" },
  ],
  edges: [{ from: "InboundFn", to: "MailBucket" }],
};

describe("assembleInfraGraph", () => {
  it("turns stack resources into nodes (keyed by logical id) and keeps the template edges", () => {
    const g = assembleInfraGraph(app, [stack], [], now);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["InboundFn", "MailBucket"]);
    const bucket = g.nodes.find((n) => n.id === "MailBucket")!;
    expect(bucket).toMatchObject({ service: "s3", resourceType: "AWS::S3::Bucket", name: "mailpoppy-mail-7f3a", inStack: true, status: "present" });
    expect(g.edges).toEqual([{ from: "InboundFn", to: "MailBucket" }]);
    expect(g.connectionId).toBe("conn-1");
  });

  it("enriches a stack node (ARN + console link) when a tag hit matches its physical id, not duplicating it", () => {
    const residuals: VerifiedResidual[] = [{ arn: "arn:aws:s3:::mailpoppy-mail-7f3a", region: "eu-west-1", status: "present" }];
    const g = assembleInfraGraph(app, [stack], residuals, now);
    expect(g.nodes).toHaveLength(2); // not 3 — matched the existing MailBucket node
    const bucket = g.nodes.find((n) => n.id === "MailBucket")!;
    expect(bucket.arn).toBe("arn:aws:s3:::mailpoppy-mail-7f3a");
    expect(bucket.consoleUrl).toContain("s3/buckets/mailpoppy-mail-7f3a");
  });

  it("adds out-of-stack tag hits as their own nodes carrying the verified status", () => {
    const residuals: VerifiedResidual[] = [
      { arn: "arn:aws:cognito-idp:eu-west-1:1:userpool/eu-west-1_GONE", region: "eu-west-1", status: "removed" },
      { arn: "arn:aws:route53:::hostedzone/Z1", region: "eu-west-1", status: "present" },
    ];
    const g = assembleInfraGraph(app, [], residuals, now);
    expect(g.nodes).toHaveLength(2);
    const pool = g.nodes.find((n) => n.id.includes("userpool"))!;
    expect(pool).toMatchObject({ inStack: false, status: "removed", name: "eu-west-1_GONE" });
    expect(pool.consoleUrl).toContain("user-pools/eu-west-1_GONE");
  });

  it("prunes edges whose endpoints aren't both present", () => {
    const orphanEdge: StackGraphInput = { region: "eu-west-1", resources: [{ logicalId: "A", physicalId: "a", type: "AWS::S3::Bucket", status: "CREATE_COMPLETE" }], edges: [{ from: "A", to: "Missing" }] };
    const g = assembleInfraGraph(app, [orphanEdge], [], now);
    expect(g.edges).toEqual([]);
  });
});

import { buildInfraGraph } from "./infra-graph";
import { AccountUnreadableError } from "./errors";
import type { CfnGateway } from "./cloudformation";
import type { TaggingGateway } from "./tagging";
import type { ExistenceVerifier } from "./existence";
import type { ConnectedAccount, Connection } from "@agentspoppy/core";

const conn = {
  id: "conn-1", accountId: "acct", app: { id: "com.mailpoppy.desktop", name: "MailPoppy" },
  status: "active", permissionSet: { id: "p", name: "p", description: "", grants: [], requiredTags: [], limits: null },
  createdAt: "t", updatedAt: "t",
} as Connection;
// One region keeps the scan small + deterministic (regionsFor still adds the standard set, but the
// stubs answer identically for every region).
const account = { id: "acct", accountId: "111122223333", regions: ["eu-west-1"], createdAt: "t" } as ConnectedAccount;
const awsErr = (name: string, message = "") => Object.assign(new Error(message), { name });
const verifier: ExistenceVerifier = { verify: async () => "present" };
const cfn = (over: Partial<CfnGateway>): CfnGateway =>
  ({ listStacks: async () => [], listResources: async () => [], getTemplate: async () => undefined, ...over }) as CfnGateway;
const tag = (getResourcesByTag: TaggingGateway["getResourcesByTag"]): TaggingGateway => ({ getResourcesByTag });

describe("buildInfraGraph — account readability", () => {
  it("raises AccountUnreadableError when every region fails on bad credentials", async () => {
    const gateway = cfn({ listStacks: async () => { throw awsErr("InvalidClientTokenId", "The security token included in the request is invalid"); } });
    const tagging = tag(async () => { throw awsErr("UnrecognizedClientException", "invalid token"); });
    await expect(buildInfraGraph(conn, account, { gateway, tagging, verifier })).rejects.toBeInstanceOf(AccountUnreadableError);
  });

  it("marks a missing read permission as unreadable (kind=denied)", async () => {
    const gateway = cfn({ listStacks: async () => { throw awsErr("AccessDenied", "not authorized to perform: cloudformation:ListStacks"); } });
    const tagging = tag(async () => { throw awsErr("AccessDeniedException", "not authorized to perform: tag:GetResources"); });
    await expect(buildInfraGraph(conn, account, { gateway, tagging, verifier })).rejects.toMatchObject({ kind: "denied" });
  });

  it("does NOT raise when at least one region reads cleanly (account is just empty)", async () => {
    const g = await buildInfraGraph(conn, account, { gateway: cfn({}), tagging: tag(async () => []), verifier });
    expect(g.nodes).toEqual([]);
  });

  it("does NOT cry wolf on a non-auth failure (region disabled / network)", async () => {
    const gateway = cfn({ listStacks: async () => { throw awsErr("EndpointConnectionError", "Could not connect to the endpoint URL"); } });
    const tagging = tag(async () => { throw awsErr("EndpointConnectionError", "Could not connect to the endpoint URL"); });
    const g = await buildInfraGraph(conn, account, { gateway, tagging, verifier });
    expect(g.nodes).toEqual([]);
  });
});
