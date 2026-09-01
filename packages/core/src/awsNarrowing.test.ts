// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Rule C — "AWS offers no way to narrow this" (docs/specs/tag-scoping-and-ratings.md §3).
 *
 * The danger this file guards is one-directional. Claiming AWS forced a wide grant when
 * it did not tells the user an avoidable grant was unavoidable — it launders laziness.
 * The opposite mistake (staying silent about a genuinely forced action) only leaves the
 * screen as it was. So every test below is written to catch the flattering direction.
 */
import { describe, expect, it } from "vitest";
import { awsCannotNarrowAction, grantCannotBeNarrowed, narrowableActions } from "./awsNarrowing";
import { assessGrant, describeGrant } from "./permissions";
import type { PermissionGrant } from "./types";

const grant = (service: string, actions: string[], resourceScope = "*"): PermissionGrant =>
  ({ service, actions, resourceScope }) as PermissionGrant;

describe("which actions AWS genuinely cannot narrow", () => {
  // These exact pairs were simulated against real IAM with a positive and a negative
  // control (awsNarrowing.ts header). They are the anchor: if the generated table ever
  // stops agreeing with them, it has drifted from measured reality.
  it.each([
    ["ec2", "DescribeInstances"],
    ["ses", "CreateReceiptRule"],
    ["ses", "SetActiveReceiptRuleSet"],
    ["pricing", "GetProducts"],
    ["sts", "GetCallerIdentity"],
    ["s3", "ListAllMyBuckets"],
  ])("%s:%s is forced — scoping it to an ARN denies it outright", (svc, action) => {
    expect(awsCannotNarrowAction(svc, action)).toBe(true);
  });

  it.each([
    ["ec2", "StopInstances"],
    ["ec2", "RunInstances"],
    ["ses", "SendEmail"],
    ["ses", "CreateEmailIdentity"],
    ["route53", "ChangeResourceRecordSets"],
    ["cognito-idp", "ListUsers"],
  ])("%s:%s is NOT forced — AWS can narrow it, so no excuse is offered", (svc, action) => {
    expect(awsCannotNarrowAction(svc, action)).toBe(false);
  });

  it("matches case-insensitively and with or without the service prefix", () => {
    expect(awsCannotNarrowAction("ec2", "ec2:DescribeInstances")).toBe(true);
    expect(awsCannotNarrowAction("EC2", "describeinstances")).toBe(true);
  });

  it("fails closed on anything it cannot speak to", () => {
    expect(awsCannotNarrowAction("ec2", "*")).toBe(false);
    expect(awsCannotNarrowAction("ec2", "ec2:*")).toBe(false);
    expect(awsCannotNarrowAction("not-a-service", "DescribeThings")).toBe(false);
    expect(awsCannotNarrowAction("ec2", "DescribeSomethingAwsHasNotShippedYet")).toBe(false);
    expect(awsCannotNarrowAction("", "DescribeInstances")).toBe(false);
    // A qualified action naming another service is not this grant's policy to explain.
    expect(awsCannotNarrowAction("ec2", "sts:GetCallerIdentity")).toBe(false);
  });
});

describe("a grant only earns the excuse when EVERY action is forced", () => {
  it("fires when all of them are (both VM poppies' read grant)", () => {
    const g = grant("ec2", ["DescribeInstances", "DescribeImages", "DescribeVpcs", "DescribeSubnets"]);
    expect(grantCannotBeNarrowed(g)).toBe(true);
    expect(narrowableActions(g)).toEqual([]);
  });

  // THE case that decides the rule's shape. MailPoppy's SES grant mixes 13 actions AWS
  // cannot narrow with 6 it can — SendEmail among them, which is scopeable to a single
  // identity. Excusing the grant wholesale would launder those six.
  it("stays silent on a MIXED grant, and can name the part that could be narrowed", () => {
    const g = grant("ses", ["CreateReceiptRule", "SetActiveReceiptRuleSet", "SendEmail"]);
    expect(grantCannotBeNarrowed(g)).toBe(false);
    expect(narrowableActions(g)).toEqual(["SendEmail"]);
  });

  it("stays silent on a single narrowable action", () => {
    expect(grantCannotBeNarrowed(grant("cloudwatch", ["GetMetricData"]))).toBe(false);
  });

  it("stays silent on an empty grant rather than vacuously excusing it", () => {
    expect(grantCannotBeNarrowed(grant("ec2", []))).toBe(false);
  });
});

describe("Rule C changes the wording and NOTHING else", () => {
  const forced = grant("ec2", ["DescribeInstances", "DescribeImages"]);

  it("says AWS is the limit instead of accusing the poppy", () => {
    const r = assessGrant(forced);
    expect(r.reason).toContain("AWS offers no way to narrow this");
    expect(r.reason).not.toContain("not just its own");
    expect(describeGrant(forced)).toContain("AWS offers no way to narrow this");
  });

  // The whole point of Rule C is that it costs no security. An account-wide read is an
  // account-wide read however it came about: the level must not move, and `scoped` must
  // stay false or the broker (service.ts, hasUnscopedGrants) would stop supervising it.
  it("does not lower the level or claim the grant is scoped", () => {
    const r = assessGrant(forced);
    expect(r.level).toBe("medium");
    expect(r.scoped).toBe(false);
  });

  it("leaves a narrowable wide grant reading exactly as before", () => {
    const r = assessGrant(grant("cloudwatch", ["GetMetricData"]));
    expect(r.reason).toContain("not just its own");
    expect(r.reason).not.toContain("AWS offers no way to narrow");
  });

  it("never excuses a SCOPED grant — there is nothing to explain", () => {
    const g = grant("ec2", ["DescribeInstances"], "arn:aws:ec2:*:*:instance/i-abc");
    expect(assessGrant(g).reason).not.toContain("AWS offers no way to narrow");
  });

  it("uses singular wording for a single action", () => {
    expect(assessGrant(grant("sts", ["GetCallerIdentity"])).reason).toContain("this action accepts");
    expect(assessGrant(forced).reason).toContain("these actions accept");
  });
});

describe("the generated table is AWS's data, not a hand-written list", () => {
  it("covers the whole service reference, not just the services poppies happen to use", async () => {
    const { AWS_FORCED_ACTIONS } = await import("./generated/awsForcedActions");
    // Curating this by hand is how birthActions.ts's NAMED_BIRTHS went wrong, in both
    // directions at once. A table this size cannot have been typed from memory.
    expect(Object.keys(AWS_FORCED_ACTIONS).length).toBeGreaterThan(300);
    const actions = Object.values(AWS_FORCED_ACTIONS).reduce((n, v) => n + v.split(",").length, 0);
    expect(actions).toBeGreaterThan(5000);
  });
});
