// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

// Invariant I6 (docs/SECURITY_MECHANISM.md): what the consent screen shows the user must
// match what the compiled session policy actually permits.
//
// One specific half of that is mechanical and therefore testable. The rating has an
// ADDITIVE bucket whose promise to the user is "can create new things, but cannot change
// or delete anything that already exists". That promise is only true because of I3: the
// compiler puts create-class actions into a birth-tagged statement conditioned on
// aws:RequestTag, so an untagged create is refused by IAM outright.
//
// The compiler decides what is create-class with /:(Create|Request)/ over the QUALIFIED
// action (packages/broker/src/aws/policy.ts). The rating decides it with CREATE_VERBS
// (packages/core/src/permissions.ts). The two live in different packages and nothing
// links them, so they can silently drift — and a drift in the direction of the rating
// being MORE generous than the compiler is exactly an I6 violation: the user would be
// promised birth-tagging for an action the policy never birth-tags.
//
// ec2:RunInstances is the live example of why this matters. It is a create in plain
// English but not to the compiler, so it lands in the "rest" statement and, under a
// tagged-as-self grant, is born UNTAGGED — invisible to I4's sweep and to teardown. The
// rating gives it its own "launch" class for that reason; this test is what stops someone
// later "tidying up" by folding it back into the additive bucket.

import { describe, it, expect } from "vitest";
import { grantCanDestroy, grantCanMutate, assessGrant, compilerTreatsAsBirth } from "@agentspoppy/core";
import type { PermissionGrant } from "@agentspoppy/core";
import { qualifyActions, statementForGrant } from "./policy";

/**
 * The compiler's own birth classifier — IMPORTED, not re-implemented. This function used to
 * keep a private copy of the compiler's verb regex, so when the compiler learned that
 * `ec2:RunInstances` is a birth, the guard went on asserting the opposite and went on passing:
 * a drift detector that had itself drifted.
 */
function compilerTreatsAsCreate(service: string, action: string): boolean {
  const [qualified] = qualifyActions({ service, actions: [action], resourceScope: "*" });
  return compilerTreatsAsBirth(qualified!);
}

/**
 * True when the RATING puts this action in the additive bucket — i.e. it tells the user
 * the action "cannot change or delete anything that already exists".
 */
function ratingTreatsAsAdditive(service: string, action: string): boolean {
  const grant = { service, actions: [action], resourceScope: "*" };
  if (!grantCanMutate(grant) || grantCanDestroy(grant)) return false;
  return /cannot change or delete anything that already exists/i.test(assessGrant(grant).reason);
}

// Real action names, deliberately mixing qualified and unqualified forms because both
// occur in shipped manifests, and spanning the awkward cases: verbs that merely start
// with the same letters as a create, and creates that are not spelled "Create".
const ACTIONS: [string, string][] = [
  ["s3", "CreateBucket"],
  ["s3", "s3:CreateBucket"],
  ["s3", "DeleteBucket"],
  ["s3", "PutObject"],
  ["s3", "GetObject"],
  ["acm", "RequestCertificate"],
  ["acm", "acm:RequestCertificate"],
  ["acm", "DeleteCertificate"],
  ["ec2", "CreateSecurityGroup"],
  ["ec2", "CreateTags"],
  ["ec2", "CreateSnapshot"],
  ["ec2", "RunInstances"],
  ["ec2", "TerminateInstances"],
  ["ec2", "DescribeInstances"],
  ["iam", "CreateRole"],
  ["iam", "PassRole"],
  ["cognito-idp", "CreateUserPool"],
  ["cognito-idp", "DeleteUserPool"],
  ["cloudformation", "CreateStack"],
  ["cloudformation", "ContinueUpdateRollback"],
  ["route53", "ChangeResourceRecordSets"],
  ["lambda", "CreateFunction"],
  ["lambda", "InvokeFunction"],
  ["logs", "CreateLogGroup"],
  ["dynamodb", "CreateTable"],
  ["events", "PutRule"],
  ["amplify", "CreateApp"],
  ["amplify", "StartDeployment"],
];

describe("I6 — the rating's additive bucket never outruns the compiler's birth-tagging", () => {
  for (const [service, action] of ACTIONS) {
    it(`${service}:${action.replace(/^.*:/, "")}`, () => {
      // The rating may be STRICTER than the compiler (harmless: it under-promises).
      // It must never be more generous, because that promises the user a guarantee
      // (I3 birth-tagging) that the compiled policy does not make.
      if (ratingTreatsAsAdditive(service, action)) {
        expect(
          compilerTreatsAsCreate(service, action),
          `the rating calls ${service}:${action} additive ("cannot change or delete anything that ` +
            `already exists"), but the compiler does NOT birth-tag it, so a tagged-as-self grant ` +
            `would create it UNTAGGED and teardown would never find it`,
        ).toBe(true);
      }
    });
  }

  // The compiler now DOES birth-tag RunInstances (that fix is why launches work at all), while
  // the rating still withholds the additive reassurance. The rating being STRICTER than the
  // policy is the safe direction — I6 forbids the rating promising more than the policy gives,
  // not less.
  it("ec2:RunInstances is a birth to the compiler, and still not additive to the rating", () => {
    expect(compilerTreatsAsCreate("ec2", "RunInstances")).toBe(true);
    expect(ratingTreatsAsAdditive("ec2", "RunInstances")).toBe(false);
    expect(grantCanMutate({ service: "ec2", actions: ["RunInstances"], resourceScope: "*" })).toBe(true);
  });

  // …while an ordinary create still gets the reassurance, so the test above is not
  // passing merely because the additive bucket has been emptied.
  it("an ordinary create still reaches the additive bucket", () => {
    expect(ratingTreatsAsAdditive("cognito-idp", "CreateUserPool")).toBe(true);
    expect(compilerTreatsAsCreate("cognito-idp", "CreateUserPool")).toBe(true);
  });
});

// The SECOND mechanical half of I6 (rating-reconciliation.md fix 4): tag writes. The
// compiler conditions every unnarrowed tag write on a covered service — a poppy provably
// cannot claim or strip a foreign resource's label — and refuses to vend one on a service
// the shared table has not cleared. The rating must agree in BOTH directions: covered ⇒
// not destroy-class (a red for the impossible is the false-green bug, pointing the other
// way); uncovered ⇒ still destroy-class (the compiler refuses it, and red is the honest
// description of a manifest shape that cannot ship).
describe("tag writes: the rating and the compiler read ONE table (fix 4)", () => {
  const covered: PermissionGrant = {
    service: "cognito-idp",
    actions: ["CreateUserPool", "DescribeUserPool", "TagResource", "UntagResource"],
    resourceScope: "arn:aws:cognito-idp:*:*:userpool/*",
  };

  it("a covered tag write is NOT destroy-class, and the reason says why", () => {
    // The compiler vends this grant (conditioned statements, no throw)…
    expect(() => statementForGrant(covered, "com.example.app", 0)).not.toThrow();
    // …so the rating must not claim it can change what exists.
    expect(grantCanDestroy(covered)).toBe(false);
    expect(grantCanMutate(covered)).toBe(true); // it still writes — supervision logic unchanged
    const risk = assessGrant(covered);
    expect(risk.level).toBe("medium");
    expect(risk.reason).toContain("claim or release its own label");
  });

  it("an UNCOVERED service's tag write stays destroy-class — and the compiler refuses it, so both sides say no", () => {
    const uncovered: PermissionGrant = { service: "s3", actions: ["PutBucketTagging"], resourceScope: "*" };
    expect(grantCanDestroy(uncovered)).toBe(true);
    expect(() => statementForGrant(uncovered, "com.example.app", 0)).toThrow(/TAG_WRITE_RULES|tag/i);
  });

  it("a wildcard action never earns the tag-write exemption", () => {
    expect(grantCanDestroy({ service: "cognito-idp", actions: ["*"], resourceScope: "*" })).toBe(true);
  });

  it("the two sides literally share the table — identity, not resemblance", async () => {
    const core = await import("@agentspoppy/core");
    const policyModule = await import("./policy");
    // policy.ts re-exports nothing of the table; the import above compiles only if the
    // module resolves — the real assertion is that policy.ts has NO local table left.
    const src = (await import("node:fs")).readFileSync(
      new URL("./policy.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/const TAG_WRITE_RULES/);
    expect(src).not.toMatch(/const TAG_WRITE_ACTION\s*=/);
    expect(core.TAG_WRITE_RULES["cognito-idp"]).toBeDefined();
    void policyModule;
  });
});
