// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Panel 3's engine. The founder's review that forced this panel into existence
 * (2026-09-01) had one rule at its core: no statement the drill-down does not back.
 * Titles are tested against the buckets, not against the risk class.
 */
import { describe, expect, it } from "vitest";
import { buildFindings, bucketActions, serviceNoun } from "./findingGroups";
import { TAGGED_AS_SELF } from "./types";
import type { PermissionSet } from "./types";

const ps = (grants: PermissionSet["grants"], requiredTags?: string[]): PermissionSet => ({
  id: "p", name: "P", description: "",
  grants,
  requiredTags: requiredTags ?? ["agentspoppy:account", "agentspoppy:app", "agentspoppy:connection"],
  limits: null,
});

describe("bucketActions — the drill-down a reader actually scans", () => {
  it("buckets by what a person means, not by the raw verb class", () => {
    const b = bucketActions("ses", ["DeleteReceiptRule", "CreateEmailIdentity", "SendEmail", "GetAccount"]);
    expect(b.changes).toEqual(["DeleteReceiptRule"]);
    expect(b.creates).toEqual(["CreateEmailIdentity"]);
    // SendEmail classifies destructive for RISK — but a reader scanning "Changes:" must
    // not find sending mail there.
    expect(b.sends).toEqual(["SendEmail"]);
    expect(b.reads).toEqual(["GetAccount"]);
  });

  it("labels are their own bucket, and secret reads never hide among plain reads", () => {
    const b = bucketActions("ssm", ["TagResource", "UntagResource", "GetParameter", "DescribeParameters"]);
    expect(b.labels).toEqual(["TagResource", "UntagResource"]);
    expect(b.secrets).toEqual(["GetParameter"]);
    expect(b.reads).toEqual(["DescribeParameters"]);
  });
});

describe("buildFindings — grouped by meaning, worst first", () => {
  it("titles claim only what the buckets back — no delete in the headline when nothing deletes", () => {
    // Cognito's wide grant creates and labels; it deletes nothing. "change and delete"
    // here was the exact overstatement the founder called out.
    const f = buildFindings(ps([{ service: "cognito-idp", actions: ["CreateUserPool", "TagResource"], resourceScope: "*" }]));
    expect(f[0].title).toBe("Can change sign-in directories you did not create");
    const del = buildFindings(ps([{ service: "route53", actions: ["ChangeResourceRecordSets"], resourceScope: "*" }]));
    expect(del[0].title).toBe("Can change and delete DNS records you did not create");
  });

  it("merges fully-forced reads into ONE row — there is nothing per-service to decide", () => {
    const f = buildFindings(ps([
      { service: "s3", actions: ["ListAllMyBuckets"], resourceScope: "*" },
      { service: "sts", actions: ["GetCallerIdentity"], resourceScope: "*" },
    ]));
    const forced = f.filter((x) => x.triage === "forced");
    expect(forced).toHaveLength(1);
    expect(forced[0].services.sort()).toEqual(["s3", "sts"]);
    expect(forced[0].gated).toBe(true); // still beyond its own — supervision still applies
  });

  it("a confined control-plane grant is still a weigh-this finding", () => {
    const f = buildFindings(ps([{ service: "iam", actions: ["CreateRole", "DeleteRole"], resourceScope: "arn:aws:iam::*:role/X*" }]));
    expect(f[0].triage).toBe("weigh");
    expect(f[0].title).toBe("Creates and manages its own roles and permissions");
    expect(f[0].gated).toBe(false); // confined — never the reason for supervision
  });

  it("collapses the confined remainder into one skippable row, honest about 'else'", () => {
    const both = buildFindings(ps([
      { service: "route53", actions: ["ChangeResourceRecordSets"], resourceScope: "*" },
      { service: "dynamodb", actions: ["CreateTable", "DeleteTable"], resourceScope: "arn:aws:dynamodb:*:*:table/X*" },
    ]));
    expect(both.at(-1)?.title).toBe("Everything else is confined to its own resources");
    const only = buildFindings(ps([{ service: "dynamodb", actions: ["CreateTable"], resourceScope: TAGGED_AS_SELF }]));
    expect(only).toHaveLength(1);
    expect(only[0].title).toBe("Everything is confined to its own resources");
  });

  it("worst first: weigh, then know, then forced, then confined — whatever the manifest order", () => {
    const f = buildFindings(ps([
      { service: "sts", actions: ["GetCallerIdentity"], resourceScope: "*" },
      { service: "dynamodb", actions: ["DeleteTable"], resourceScope: "arn:aws:dynamodb:*:*:table/X*" },
      { service: "cloudformation", actions: ["ValidateTemplate", "GetTemplateSummary"], resourceScope: "*" },
      { service: "route53", actions: ["ChangeResourceRecordSets"], resourceScope: "*" },
    ]));
    expect(f.map((x) => x.triage)).toEqual(["weigh", "know", "forced", "confined"]);
  });

  it("missing attribution labels is a weigh-this finding of its own", () => {
    const f = buildFindings(ps([{ service: "s3", actions: ["CreateBucket"], resourceScope: TAGGED_AS_SELF }], []));
    const warn = f.find((x) => x.id === "no-labels");
    expect(warn?.triage).toBe("weigh");
    expect(warn?.title).toMatch(/can’t be fully tracked/);
  });

  it("the scope line counts what AWS forces vs what could be narrowed", () => {
    const f = buildFindings(ps([{ service: "route53", actions: ["ListHostedZonesByName", "ListResourceRecordSets", "ChangeResourceRecordSets"], resourceScope: "*" }]));
    expect(f[0].scopeLine).toBe("scope * · 1 of 3 actions accept no resource limit from AWS; 2 could be narrowed");
  });

  it("carries the developer's reason through, verbatim, for the row to label as a claim", () => {
    const f = buildFindings(ps([{ service: "route53", actions: ["ChangeResourceRecordSets"], resourceScope: "*", reason: "Writes the one record you asked for." }]));
    expect(f[0].reason).toBe("Writes the one record you asked for.");
  });

  it("serviceNoun falls back without inventing", () => {
    expect(serviceNoun("route53")).toBe("DNS records");
    expect(serviceNoun("workspaces")).toBe("WORKSPACES resources");
  });
});

describe("buildFindings — network egress (spec: network-egress.md phase 1)", () => {
  const compute = { service: "cloudformation", actions: ["CreateStack"], resourceScope: TAGGED_AS_SELF };

  it("states the standing fact once for an undeclared poppy that deploys compute", () => {
    const f = buildFindings(ps([compute]));
    const row = f.find((x) => x.id === "egress-undeclared");
    expect(row).toBeDefined();
    expect(row!.triage).toBe("know");
    expect(row!.title).toBe("Its cloud code can reach the internet");
    expect(row!.context).toContain("does not say where its cloud code connects");
    // The listing rule is real (agentspoppy-web mechanical-review refuses undeclared
    // egress), so the screen may state it — and must, or the fact reads as unpoliced.
    expect(row!.context).toContain("can no longer enter or update in the AgentsPoppy catalogue");
  });

  it("says nothing at all for a poppy with no cloud compute — no fact, no copy", () => {
    const f = buildFindings(ps([{ service: "s3", actions: ["PutObject"], resourceScope: `arn:${TAGGED_AS_SELF}` }]));
    expect(f.find((x) => x.id.startsWith("egress"))).toBeUndefined();
  });

  it("shows a declaration in the developer's voice, never as an enforced fact", () => {
    const f = buildFindings({ ...ps([compute]), network: { egress: "aws-only" as const } });
    const row = f.find((x) => x.id === "egress-declared");
    expect(row).toBeDefined();
    expect(row!.title).toBe("Declares its cloud code connects only to AWS");
    expect(row!.context).toContain("developer's statement");
    expect(f.find((x) => x.id === "egress-undeclared")).toBeUndefined();
  });

  it("a declared domain list names the domains in the scope line", () => {
    const f = buildFindings({ ...ps([compute]), network: { egress: ["api.stripe.com"] } });
    const row = f.find((x) => x.id === "egress-declared")!;
    expect(row.scopeLine).toContain("api.stripe.com");
    expect(row.title).toContain("api.stripe.com");
  });
});

describe("buildFindings — infrastructure egress (door 2)", () => {
  const compute = { service: "ec2", actions: ["RunInstances"], resourceScope: TAGGED_AS_SELF };

  it("a declared infrastructure kind gets its own purpose row beside the code row", () => {
    const f = buildFindings({ ...ps([compute]), network: { egress: "none" as const, infrastructure: "servers" as const } });
    const infra = f.find((x) => x.id === "egress-infrastructure");
    expect(infra).toBeDefined();
    expect(infra!.title).toBe("The servers it creates for you can reach the internet");
    expect(infra!.context).toContain("Catalogue rules forbid");
    expect(f.find((x) => x.id === "egress-declared")).toBeDefined();
  });

  it("no infrastructure row when the kind is none or absent", () => {
    const none = buildFindings({ ...ps([compute]), network: { egress: "none" as const, infrastructure: "none" as const } });
    expect(none.find((x) => x.id === "egress-infrastructure")).toBeUndefined();
    const absent = buildFindings({ ...ps([compute]), network: { egress: "none" as const } });
    expect(absent.find((x) => x.id === "egress-infrastructure")).toBeUndefined();
  });
});

describe("buildFindings — machine egress (door 3)", () => {
  const compute = { service: "lambda", actions: ["CreateFunction"], resourceScope: TAGGED_AS_SELF };

  it("a declared machine plane gets its own row, beside the cloud one", () => {
    const f = buildFindings({ ...ps([compute]), network: { egress: "aws-only" as const, machine: ["agentspoppy.com"] } });
    const row = f.find((x) => x.id === "egress-machine");
    expect(row).toBeDefined();
    expect(row!.title).toContain("from your machine");
    expect(row!.scopeLine).toContain("agentspoppy.com");
    expect(f.find((x) => x.id === "egress-declared")).toBeDefined();
  });

  it("no row when the poppy says nothing about this machine — silence, not an accusation", () => {
    const f = buildFindings({ ...ps([compute]), network: { egress: "aws-only" as const } });
    expect(f.find((x) => x.id === "egress-machine")).toBeUndefined();
  });
});
