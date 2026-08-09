// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { lifecycleVerdict, ec2InstanceIdFromArn, ec2StateToStatus } from "./existence";

describe("lifecycleVerdict", () => {
  it("reads a successful delete as removed and a successful create as present", () => {
    expect(lifecycleVerdict("DeleteUserPool", '{"eventName":"DeleteUserPool"}')).toBe("removed");
    expect(lifecycleVerdict("CreateBucket", '{"eventName":"CreateBucket"}')).toBe("present");
  });

  it("understands EC2's non-Create/Delete verbs (RunInstances / TerminateInstances)", () => {
    expect(lifecycleVerdict("TerminateInstances", '{"eventName":"TerminateInstances"}')).toBe("removed");
    expect(lifecycleVerdict("RunInstances", '{"eventName":"RunInstances"}')).toBe("present");
    // still gated on success
    expect(lifecycleVerdict("TerminateInstances", '{"errorCode":"UnauthorizedOperation"}')).toBeNull();
  });

  it("ignores a Create/Delete that errored (it didn't change existence)", () => {
    expect(lifecycleVerdict("DeleteUserPool", '{"errorCode":"AccessDenied"}')).toBeNull();
  });

  it("ignores non-lifecycle events", () => {
    expect(lifecycleVerdict("DescribeUserPool", "{}")).toBeNull();
    expect(lifecycleVerdict("TagResource", "{}")).toBeNull();
    expect(lifecycleVerdict("StopInstances", "{}")).toBeNull(); // stop ≠ gone
    expect(lifecycleVerdict(undefined, undefined)).toBeNull();
  });
});

describe("ec2InstanceIdFromArn", () => {
  it("extracts the instance id from an EC2 instance ARN", () => {
    expect(ec2InstanceIdFromArn("arn:aws:ec2:eu-west-1:123456789012:instance/i-0abc123def456")).toBe("i-0abc123def456");
  });
  it("returns null for non-instance EC2 ARNs and other services", () => {
    expect(ec2InstanceIdFromArn("arn:aws:ec2:eu-west-1:123456789012:security-group/sg-0abc")).toBeNull();
    expect(ec2InstanceIdFromArn("arn:aws:ec2:eu-west-1:123456789012:key-pair/vmpoppy-abc")).toBeNull();
    expect(ec2InstanceIdFromArn("arn:aws:s3:::my-bucket")).toBeNull();
  });
});

describe("ec2StateToStatus", () => {
  it("maps terminated / shutting-down / vanished to removed", () => {
    expect(ec2StateToStatus("terminated")).toBe("removed");
    expect(ec2StateToStatus("shutting-down")).toBe("removed");
    expect(ec2StateToStatus(undefined)).toBe("removed");
  });
  it("maps live states to present", () => {
    for (const s of ["running", "pending", "stopping", "stopped"]) expect(ec2StateToStatus(s)).toBe("present");
  });
});
