// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { serviceFor, awsConsoleUrl, ledgerConsoleUrl, groupByService } from "./resources";
import type { ResourceEntry, LedgerEntry } from "./types";

describe("serviceFor", () => {
  it("maps known CloudFormation namespaces to friendly names", () => {
    expect(serviceFor("AWS::Lambda::Function")).toBe("Lambda");
    expect(serviceFor("AWS::DynamoDB::Table")).toBe("DynamoDB");
    expect(serviceFor("AWS::ApiGatewayV2::Api")).toBe("API Gateway");
    expect(serviceFor("AWS::Route53::RecordSet")).toBe("Route 53");
  });

  it("passes unknown namespaces through", () => {
    expect(serviceFor("AWS::Batch::JobQueue")).toBe("Batch");
    expect(serviceFor("weird")).toBe("weird");
  });
});

describe("awsConsoleUrl", () => {
  it("builds region-aware deep-links for known types", () => {
    expect(awsConsoleUrl("AWS::S3::Bucket", "my-bucket", "eu-west-1")).toContain("/s3/buckets/my-bucket");
    expect(awsConsoleUrl("AWS::Lambda::Function", "fn", "us-east-1")).toContain("us-east-1.console.aws.amazon.com/lambda");
  });

  it("returns undefined for unknown types or empty id", () => {
    expect(awsConsoleUrl("AWS::Unknown::Thing", "x", "eu-west-1")).toBeUndefined();
    expect(awsConsoleUrl("AWS::S3::Bucket", "", "eu-west-1")).toBeUndefined();
  });
});

describe("ledgerConsoleUrl", () => {
  it("links out-of-stack entries by service", () => {
    const route53: LedgerEntry = {
      ts: "2026-06-18T00:00:00Z", connectionId: "c1", action: "created",
      service: "Route 53", resourceType: "MX", name: "example.com", region: "eu-west-1",
    };
    expect(ledgerConsoleUrl(route53)).toContain("route53");
    expect(ledgerConsoleUrl({ ...route53, service: "Lambda" })).toBeUndefined();
  });
});

describe("groupByService", () => {
  it("groups by friendly service, sorted, preserving input order within a group", () => {
    const resources: ResourceEntry[] = [
      { logicalId: "Fn1", physicalId: "fn-1", type: "AWS::Lambda::Function", status: "CREATE_COMPLETE" },
      { logicalId: "Bucket", physicalId: "b", type: "AWS::S3::Bucket", status: "CREATE_COMPLETE" },
      { logicalId: "Fn2", physicalId: "fn-2", type: "AWS::Lambda::Function", status: "CREATE_COMPLETE" },
    ];
    const grouped = groupByService(resources);
    expect(grouped.map((g) => g.service)).toEqual(["Lambda", "S3"]); // sorted
    expect(grouped[0]?.items.map((i) => i.logicalId)).toEqual(["Fn1", "Fn2"]); // order preserved
  });
});
