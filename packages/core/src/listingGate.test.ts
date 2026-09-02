// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
import { describe, expect, it } from "vitest";
import { assessListing } from "./listingGate";
import { TAGGED_AS_SELF } from "./types";
import type { PermissionGrant, PermissionSet } from "./types";

const ps = (grants: PermissionGrant[]): PermissionSet => ({
  id: "p",
  name: "P",
  description: "",
  grants,
  requiredTags: ["agentspoppy:account", "agentspoppy:app", "agentspoppy:connection"],
  limits: null,
});

const REASON = "Creates the sign-in directory for your site's users; AWS offers no ARN to scope a create to.";

describe("assessListing — the doctrine, mechanized (rating-reconciliation.md fixes 2+3)", () => {
  it("passes the platform's own Cognito recipe: unscoped create-only WITH a reason (the rule the old gates broke)", () => {
    const r = assessListing(
      ps([
        { service: "cognito-idp", actions: ["CreateUserPool"], resourceScope: "*", reason: REASON },
        { service: "cognito-idp", actions: ["DeleteUserPool", "UpdateUserPool"], resourceScope: TAGGED_AS_SELF },
      ]),
    );
    expect(r.problems).toEqual([]);
    expect(r.notes.join(" ")).toContain("unscoped create-only (additive)");
  });

  it("fails an unscoped create-only grant with no substantive reason — required, not suggested", () => {
    const r = assessListing(ps([{ service: "cognito-idp", actions: ["CreateUserPool"], resourceScope: "*" }]));
    expect(r.problems.join(" ")).toContain("ONLY with a substantive `reason`");
    const short = assessListing(ps([{ service: "cognito-idp", actions: ["CreateUserPool"], resourceScope: "*", reason: "needed" }]));
    expect(short.problems.length).toBe(1);
  });

  it("fails an unscoped grant that can change or delete what exists — the cardinal sin stays fatal", () => {
    const r = assessListing(ps([{ service: "route53", actions: ["ChangeResourceRecordSets"], resourceScope: "*", reason: REASON }]));
    expect(r.problems.join(" ")).toContain("change or delete resources beyond the poppy's own");
  });

  it("fails an unscoped launch — compute teardown cannot see", () => {
    const r = assessListing(ps([{ service: "ec2", actions: ["RunInstances"], resourceScope: "*", reason: REASON }]));
    expect(r.problems.join(" ")).toContain("launch compute teardown cannot see");
  });

  it("notes unscoped reads loudly, never fatally", () => {
    const r = assessListing(ps([{ service: "amplify", actions: ["ListApps"], resourceScope: "*" }]));
    expect(r.problems).toEqual([]);
    expect(r.notes.join(" ")).toContain("read-only grant AWS gives no way to scope");
  });

  it("passes scoped destroy grants without comment — confinement is the point", () => {
    const r = assessListing(ps([{ service: "dynamodb", actions: ["DeleteTable"], resourceScope: TAGGED_AS_SELF }]));
    expect(r.problems).toEqual([]);
  });

  it("never fails on rating colour: a tightly-scoped IAM create rates red and still lists", () => {
    const r = assessListing(
      ps([{ service: "iam", actions: ["CreateRole"], resourceScope: "arn:aws:iam::*:role/DemoPoppy*", reason: REASON }]),
    );
    expect(r.problems).toEqual([]);
  });
});

describe("id-prefix scopes (fix 5a): blessed only with machine-checked disclosure", () => {
  const DISCLOSURE =
    "Attaches the domain you typed to your own app; in practice this scope reaches any Amplify app in the account.";

  it("requires a substantive reason on apps/d* and hostedzone/Z*, and always emits the reach note", () => {
    const bare = assessListing(ps([{ service: "amplify", actions: ["StartJob"], resourceScope: "arn:aws:amplify:*:*:apps/d*" }]));
    expect(bare.problems.join(" ")).toContain("must own up");
    expect(bare.notes.join(" ")).toContain("practically reaches any Amplify app in the account");

    const good = assessListing(
      ps([{ service: "amplify", actions: ["StartJob"], resourceScope: "arn:aws:amplify:*:*:apps/d*", reason: DISCLOSURE }]),
    );
    expect(good.problems).toEqual([]);
    expect(good.notes.join(" ")).toContain("practically reaches any Amplify app in the account");

    const zone = assessListing(
      ps([{ service: "route53", actions: ["ChangeResourceRecordSets"], resourceScope: "arn:aws:route53:::hostedzone/Z*" }]),
    );
    expect(zone.notes.join(" ")).toContain("any DNS zone in the account");
    expect(zone.problems.join(" ")).toContain("must own up");
  });

  it("a genuinely narrow name pattern is not an id-prefix scope", () => {
    const r = assessListing(
      ps([{ service: "route53", actions: ["ChangeResourceRecordSets"], resourceScope: "arn:aws:route53:::hostedzone/Z0450NOLLY" }]),
    );
    expect(r.problems).toEqual([]);
    expect(r.notes.join(" ")).not.toContain("practically reaches");
  });
});
