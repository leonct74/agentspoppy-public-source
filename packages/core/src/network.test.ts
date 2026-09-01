// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
import { describe, expect, it } from "vitest";
import {
  canDeployCloudCompute,
  declaredEgressTitle,
  declaredMachineTitle,
  INFRASTRUCTURE_CONTEXT,
  infrastructureTitle,
  MACHINE_EGRESS_CONTEXT,
  validateNetworkDeclaration,
} from "./network";
import type { PermissionGrant } from "./types";

const ps = (...grants: PermissionGrant[]) => ({ grants });
const grant = (service: string, actions: string[]): PermissionGrant => ({ service, actions, resourceScope: "*" });

describe("canDeployCloudCompute", () => {
  it("true for lambda function creation, cloudformation stacks, ec2 instances", () => {
    expect(canDeployCloudCompute(ps(grant("lambda", ["lambda:CreateFunction"])))).toBe(true);
    expect(canDeployCloudCompute(ps(grant("cloudformation", ["cloudformation:CreateStack"])))).toBe(true);
    expect(canDeployCloudCompute(ps(grant("ec2", ["ec2:RunInstances"])))).toBe(true);
  });

  it("false for a poppy with no compute-deploying grant", () => {
    expect(canDeployCloudCompute(ps(grant("s3", ["s3:PutObject", "s3:GetObject"]), grant("dynamodb", ["dynamodb:PutItem"])))).toBe(false);
  });

  it("matches exact action names, never substrings (the GetConsoleOutput trap)", () => {
    // ec2:GetConsoleOutput contains no compute deployment; a substring matcher on
    // "RunInstances"/"put" classes of mistakes must not fire here.
    expect(canDeployCloudCompute(ps(grant("ec2", ["ec2:GetConsoleOutput", "ec2:DescribeInstances"])))).toBe(false);
    // Invoking an existing function is not deploying code either.
    expect(canDeployCloudCompute(ps(grant("lambda", ["lambda:InvokeFunction"])))).toBe(false);
  });

  it("is case-insensitive on the exact name and tolerant of bare action names", () => {
    expect(canDeployCloudCompute(ps(grant("Lambda", ["CreateFunction"])))).toBe(true);
  });
});

describe("validateNetworkDeclaration", () => {
  it("accepts the two keywords and a plain domain list", () => {
    expect(validateNetworkDeclaration({ egress: "none" })).toEqual([]);
    expect(validateNetworkDeclaration({ egress: "aws-only" })).toEqual([]);
    expect(validateNetworkDeclaration({ egress: ["api.stripe.com", "hooks.slack.com"] })).toEqual([]);
  });

  it("rejects empty lists, schemes, paths, wildcards, and unknown keywords", () => {
    expect(validateNetworkDeclaration({ egress: [] })).not.toEqual([]);
    expect(validateNetworkDeclaration({ egress: ["https://api.stripe.com"] })).not.toEqual([]);
    expect(validateNetworkDeclaration({ egress: ["api.stripe.com/v1"] })).not.toEqual([]);
    expect(validateNetworkDeclaration({ egress: ["*.stripe.com"] })).not.toEqual([]);
    expect(validateNetworkDeclaration({ egress: "everywhere" })).not.toEqual([]);
    expect(validateNetworkDeclaration({})).not.toEqual([]);
    expect(validateNetworkDeclaration(null)).not.toEqual([]);
  });

  it("caps the list length", () => {
    const many = Array.from({ length: 21 }, (_, i) => `host${i}.example.com`);
    expect(validateNetworkDeclaration({ egress: many }).join(" ")).toMatch(/at most/);
  });
});

describe("declaredEgressTitle", () => {
  it("keeps the developer's voice — every form begins with 'Declares'", () => {
    expect(declaredEgressTitle("none")).toBe("Declares its cloud code makes no internet connections");
    expect(declaredEgressTitle("aws-only")).toBe("Declares its cloud code connects only to AWS");
    expect(declaredEgressTitle(["api.stripe.com"])).toBe("Declares its cloud code connects only to api.stripe.com");
  });

  it("names a few domains, then counts the rest", () => {
    const t = declaredEgressTitle(["a.example.com", "b.example.com", "c.example.com", "d.example.com", "e.example.com"]);
    expect(t).toContain("a.example.com, b.example.com, c.example.com");
    expect(t).toContain("and 2 more");
    expect(t).not.toContain("d.example.com");
  });
});

describe("infrastructure egress (door 2 — what the poppy creates for the user)", () => {
  it("validator accepts the kinds and rejects an invented one", () => {
    expect(validateNetworkDeclaration({ egress: "none", infrastructure: "servers" })).toEqual([]);
    expect(validateNetworkDeclaration({ egress: "aws-only", infrastructure: "email" })).toEqual([]);
    expect(validateNetworkDeclaration({ egress: "none", infrastructure: "vpn" }).join(" ")).toMatch(/infrastructure must be/);
  });

  it("user-directed: accepted by the validator, titled in the founder's words", () => {
    expect(validateNetworkDeclaration({ egress: "user-directed" })).toEqual([]);
    expect(declaredEgressTitle("user-directed")).toBe("Declares its cloud code reaches the internet only under your request");
  });

  it("titles state purpose in platform words; none/absent yields no row", () => {
    expect(infrastructureTitle("servers")).toBe("The servers it creates for you can reach the internet");
    expect(infrastructureTitle("websites")).toBe("The websites it creates serve the public internet");
    expect(infrastructureTitle("email")).toBe("The mail system it builds exchanges email with the outside world");
    expect(infrastructureTitle("none")).toBeNull();
    expect(infrastructureTitle(undefined)).toBeNull();
  });

  it("the context cites the standing catalogue rule, without alarm", () => {
    expect(INFRASTRUCTURE_CONTEXT).toContain("what you put on them");
    expect(INFRASTRUCTURE_CONTEXT).toContain("Catalogue rules forbid");
    expect(INFRASTRUCTURE_CONTEXT).not.toMatch(/steal|leak|malicious/i);
  });
});

describe("machine egress (door 3 — the poppy's own code on this machine)", () => {
  it("optional: a manifest written before the machine gate stays valid", () => {
    expect(validateNetworkDeclaration({ egress: "aws-only" })).toEqual([]);
  });

  it("same vocabulary as door 1, validated under its own name", () => {
    expect(validateNetworkDeclaration({ egress: "aws-only", machine: "none" })).toEqual([]);
    expect(validateNetworkDeclaration({ egress: "aws-only", machine: "user-directed" })).toEqual([]);
    expect(validateNetworkDeclaration({ egress: "none", machine: ["agentspoppy.com"] })).toEqual([]);
    expect(validateNetworkDeclaration({ egress: "none", machine: "everywhere" }).join(" ")).toMatch(/network\.machine must be/);
    expect(validateNetworkDeclaration({ egress: "none", machine: ["https://x.example.com"] }).join(" ")).toMatch(/network\.machine entry/);
  });

  // A typo must not buy the quiet mode: "malformed" has to fail the manifest, never
  // fall through to the undeclared/observe path that refuses nothing.
  it("a malformed value is an error, not a silent downgrade to observe", () => {
    expect(validateNetworkDeclaration({ egress: "none", machine: [] }).length).toBeGreaterThan(0);
  });

  it("titles name the plane, so a reader can tell which door a sentence is about", () => {
    expect(declaredMachineTitle("none")).toBe("Declares it makes no internet connections from your machine");
    expect(declaredMachineTitle("aws-only")).toBe("Declares it connects only to AWS from your machine");
    expect(declaredMachineTitle("user-directed")).toContain("only under your request");
    expect(declaredMachineTitle(["a.example.com"])).toBe("Declares it connects only to a.example.com from your machine");
    expect(declaredMachineTitle(["a.example.com", "b.example.com", "c.example.com", "d.example.com"])).toContain("and 1 more");
    // Never confusable with door 1's sentence about deployed code.
    expect(declaredMachineTitle("aws-only")).not.toContain("cloud code");
  });

  it("the context says which plane can be held, and defers the armed question to the card", () => {
    expect(MACHINE_EGRESS_CONTEXT).toContain("refuses the rest");
    expect(MACHINE_EGRESS_CONTEXT).toContain("card above");
    expect(MACHINE_EGRESS_CONTEXT).not.toMatch(/cannot connect|physically/i);
  });
});
