// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { grantCanMutate, grantCanDestroy, grantIsTagScoped, describeGrant, describePermissionSet, connectionTags, hasAttributionTags, isFullyAttributable, assessGrant, assessPermissionSet, maxRisk, ATTRIBUTION_TAG_KEYS, grantIsRoleOnly, scopeIsIdPrefix, scopeIsUnbounded } from "./permissions";
import { TAGGED_AS_SELF } from "./types";
import type { ConnectedAccount, Connection, PermissionSet } from "./types";

const account: ConnectedAccount = {
  id: "acc-local", accountId: "123456789012", alias: "Personal", regions: ["eu-west-1"], createdAt: "2026-06-18T00:00:00Z",
};

function connectionWith(ps: PermissionSet): Connection {
  return {
    id: "conn-1", accountId: account.id,
    app: { id: "com.mailpoppy.desktop", name: "MailPoppy" },
    status: "active", permissionSet: ps,
    createdAt: "2026-06-18T00:00:00Z", updatedAt: "2026-06-18T00:00:00Z",
  };
}

const fullyAttributable: PermissionSet = {
  id: "mailpoppy.default",
  name: "MailPoppy — host email in your AWS",
  description: "Deploy and run a mail backend in your account.",
  grants: [
    { service: "cloudformation", actions: ["CreateStack", "DeleteStack", "DescribeStacks"], resourceScope: "stack/agentspoppy-mailpoppy-*" },
    { service: "ses", actions: ["SendEmail", "GetAccount"], resourceScope: TAGGED_AS_SELF },
    { service: "s3", actions: ["ListBucket"], resourceScope: TAGGED_AS_SELF },
  ],
  requiredTags: [...ATTRIBUTION_TAG_KEYS],
  limits: null,
};

describe("grant predicates", () => {
  it("detects mutating vs read-only grants", () => {
    expect(grantCanMutate({ service: "s3", actions: ["CreateBucket"], resourceScope: "*" })).toBe(true);
    expect(grantCanMutate({ service: "ses", actions: ["GetAccount", "ListIdentities"], resourceScope: "*" })).toBe(false);
    // A wildcard action is full control — it must count as mutating, not read-only.
    expect(grantCanMutate({ service: "iam", actions: ["*"], resourceScope: "*" })).toBe(true);
    expect(grantCanMutate({ service: "s3", actions: ["s3:*"], resourceScope: "*" })).toBe(true);
    // A "Change…" verb edits an existing resource — mutating AND destructive.
    expect(grantCanMutate({ service: "route53", actions: ["ChangeResourceRecordSets"], resourceScope: "*" })).toBe(true);
    expect(grantCanDestroy({ service: "cognito-idp", actions: ["ChangePassword"], resourceScope: "*" })).toBe(true);
  });

  it("detects tag-scoped grants", () => {
    expect(grantIsTagScoped({ service: "s3", actions: ["x"], resourceScope: TAGGED_AS_SELF })).toBe(true);
    expect(grantIsTagScoped({ service: "s3", actions: ["x"], resourceScope: "*" })).toBe(false);
  });
});

describe("describeGrant / describePermissionSet", () => {
  it("renders plain-language blast radius", () => {
    expect(describeGrant({ service: "s3", actions: ["CreateBucket", "DeleteBucket"], resourceScope: TAGGED_AS_SELF }))
      .toBe("Can create, change and delete S3 — only resources tagged as its own.");
    // ses:GetAccount publishes no resource type, so "*" is the only Resource that can
    // authorise it — Rule C, and this fixture happened to pick a forced action.
    expect(describeGrant({ service: "ses", actions: ["GetAccount"], resourceScope: "*" }))
      .toBe("Can read SES — any resource (AWS offers no way to narrow this).");
    // …whereas this one AWS can narrow to a single identity, so no excuse is offered.
    expect(describeGrant({ service: "ses", actions: ["GetEmailIdentity"], resourceScope: "*" }))
      .toBe("Can read SES — any resource.");
  });

  it("summarises a whole set, one line per grant", () => {
    expect(describePermissionSet(fullyAttributable)).toHaveLength(3);
  });
});

describe("attribution", () => {
  it("derives the three attribution tags from account + connection", () => {
    expect(connectionTags(account, connectionWith(fullyAttributable))).toEqual({
      "agentspoppy:account": "123456789012",
      "agentspoppy:app": "com.mailpoppy.desktop",
      "agentspoppy:connection": "conn-1",
    });
  });

  it("requires all attribution tags to be declared", () => {
    expect(hasAttributionTags(fullyAttributable)).toBe(true);
    expect(hasAttributionTags({ ...fullyAttributable, requiredTags: ["agentspoppy:app"] })).toBe(false);
  });

  it("isFullyAttributable: every mutating grant must be scoped, never '*'", () => {
    expect(isFullyAttributable(fullyAttributable)).toBe(true);

    const wildcardMutate: PermissionSet = {
      ...fullyAttributable,
      grants: [{ service: "iam", actions: ["CreateRole"], resourceScope: "*" }],
    };
    expect(isFullyAttributable(wildcardMutate)).toBe(false);

    // a wildcard READ grant is fine — it can't create anything to attribute
    const wildcardRead: PermissionSet = {
      ...fullyAttributable,
      grants: [{ service: "ses", actions: ["GetAccount"], resourceScope: "*" }],
    };
    expect(isFullyAttributable(wildcardRead)).toBe(true);
  });
});

describe("policy risk", () => {
  it("maxRisk returns the worse level", () => {
    expect(maxRisk("low", "high")).toBe("high");
    expect(maxRisk("medium", "low")).toBe("medium");
  });

  it("assessGrant: confined-to-its-own is amber when it can change, green when read-only", () => {
    const mutate = assessGrant({ service: "s3", actions: ["PutObject", "DeleteObject"], resourceScope: TAGGED_AS_SELF });
    expect(mutate).toMatchObject({ level: "medium", scoped: true });
    const read = assessGrant({ service: "s3", actions: ["ListBucket"], resourceScope: TAGGED_AS_SELF });
    expect(read).toMatchObject({ level: "low", scoped: true });
  });

  it("assessGrant: unscoped mutating wildcard is HIGH", () => {
    const r = assessGrant({ service: "iam", actions: ["CreateRole"], resourceScope: "*" });
    expect(r.level).toBe("high");
    expect(r.scoped).toBe(false);
    expect(r.reason).toMatch(/any IAM resource/);
  });

  it("assessGrant: wildcard read is amber; a concrete name pattern is confined (amber to change, green to read)", () => {
    expect(assessGrant({ service: "ses", actions: ["GetAccount"], resourceScope: "*" }).level).toBe("medium");
    const concreteMutate = assessGrant({ service: "s3", actions: ["PutObject"], resourceScope: "arn:aws:s3:::x-*" });
    expect(concreteMutate).toMatchObject({ level: "medium", scoped: true });
    expect(concreteMutate.reason).toMatch(/different name/);
    expect(assessGrant({ service: "s3", actions: ["ListBucket"], resourceScope: "arn:aws:s3:::x-*" })).toMatchObject({
      level: "low",
      scoped: true,
    });
  });

  it("assessGrant: creating new resources on * is amber (additive); deleting existing or IAM identities is red", () => {
    // CreateUserPool has no ARN to scope to, but creating one can't harm existing pools → amber, not red.
    const create = assessGrant({ service: "cognito-idp", actions: ["CreateUserPool", "CreateUserPoolClient"], resourceScope: "*" });
    expect(create).toMatchObject({ level: "medium", scoped: false });
    expect(create.reason).toMatch(/create new/i);
    // Deleting an existing resource on * → red.
    expect(assessGrant({ service: "cognito-idp", actions: ["DeleteUserPool"], resourceScope: "*" }).level).toBe("high");
    // Creating an IAM identity is privilege escalation → red even though it's a "create".
    expect(assessGrant({ service: "iam", actions: ["CreateRole"], resourceScope: "*" }).level).toBe("high");
  });

  it("assessPermissionSet: a bounded, tagged set that can change its own is amber, not red", () => {
    const a = assessPermissionSet(fullyAttributable);
    // every grant is confined to its own (tag or name pattern) and can create/delete
    // its own → amber, never red, and nothing is flagged as reaching beyond its own.
    expect(a.level).toBe("medium");
    expect(a.hasUnscopedGrants).toBe(false);
    expect(a.warnings).toHaveLength(0);
  });

  it("assessPermissionSet: an unscoped mutating grant makes the whole set HIGH", () => {
    const broad: PermissionSet = {
      ...fullyAttributable,
      grants: [{ service: "s3", actions: ["DeleteObject"], resourceScope: "*" }],
    };
    expect(assessPermissionSet(broad).level).toBe("high");
  });

  it("assessPermissionSet: missing attribution tags is at least a medium warning", () => {
    const noTags: PermissionSet = {
      ...fullyAttributable,
      grants: [{ service: "s3", actions: ["ListBucket"], resourceScope: TAGGED_AS_SELF }],
      requiredTags: [],
    };
    const a = assessPermissionSet(noTags);
    expect(a.level).toBe("medium");
    expect(a.warnings[0]).toMatch(/attribution tags/);
  });
});


// boundary-capped-rating.md — the graduation law applied to IAM: a role-only grant rates
// medium ONLY under a live report that the deployed broker role refuses unbounded creates.
describe("boundary-capped identity creates (graduates only on the live report)", () => {
  const roleGrant = { service: "iam", actions: ["CreateRole", "DeleteRole", "PassRole", "PutRolePolicy", "TagRole", "PutRolePermissionsBoundary"], resourceScope: "arn:aws:iam::*:role/DemoPoppy*" };

  it("without the report — or with it false — a confined role grant stays high, as today", () => {
    expect(assessGrant(roleGrant).level).toBe("high");
    expect(assessGrant(roleGrant, { boundaryEnforced: false }).level).toBe("high");
  });

  it("with the report, a role-only grant is capped: medium, still scoped, and says AWS enforces it", () => {
    const r = assessGrant(roleGrant, { boundaryEnforced: true });
    expect(r).toMatchObject({ level: "medium", scoped: true });
    expect(r.reason).toMatch(/capped by your AgentsPoppyBoundary, enforced by AWS/);
  });

  it("never graduates a grant that reaches users, groups or policies — a boundary caps roles only", () => {
    const users = { service: "iam", actions: ["CreateRole", "CreateUser"], resourceScope: "arn:aws:iam::*:role/DemoPoppy*" };
    expect(assessGrant(users, { boundaryEnforced: true }).level).toBe("high");
    const policies = { service: "iam", actions: ["CreateRole", "CreatePolicyVersion"], resourceScope: "arn:aws:iam::*:role/DemoPoppy*" };
    expect(assessGrant(policies, { boundaryEnforced: true }).level).toBe("high");
  });

  it("never graduates a wide role grant — a boundary caps power, not reach", () => {
    expect(assessGrant({ service: "iam", actions: ["CreateRole"], resourceScope: "*" }, { boundaryEnforced: true }).level).toBe("high");
  });

  it("grantIsRoleOnly: every action names a role AND the scope is a role ARN", () => {
    expect(grantIsRoleOnly(roleGrant)).toBe(true);
    expect(grantIsRoleOnly({ service: "iam", actions: ["CreateRole"], resourceScope: "arn:aws:iam::*:user/x*" })).toBe(false);
    expect(grantIsRoleOnly({ service: "iam", actions: ["*"], resourceScope: "arn:aws:iam::*:role/x*" })).toBe(false);
    expect(grantIsRoleOnly({ service: "lambda", actions: ["CreateFunction"], resourceScope: "arn:aws:lambda:*:*:function:x*" })).toBe(false);
  });

  it("assessPermissionSet threads the context to every grant", () => {
    const ps = { id: "p", name: "P", description: "", grants: [roleGrant], requiredTags: ["agentspoppy:account", "agentspoppy:app", "agentspoppy:connection"], limits: null };
    expect(assessPermissionSet(ps).level).toBe("high");
    expect(assessPermissionSet(ps, { boundaryEnforced: true }).level).toBe("medium");
  });
});

// rating-reconciliation.md fix 5b — id-format prefixes rate as what they are.
describe("id-prefix scopes (fix 5b)", () => {
  it("recognises AWS id formats as unbounded — apps/d*, hostedzone/Z*, instance/i-*", () => {
    expect(scopeIsIdPrefix("arn:aws:amplify:*:*:apps/d*", "amplify")).toBe(true);
    expect(scopeIsUnbounded("arn:aws:amplify:*:*:apps/d*", "amplify")).toBe(true);
    expect(scopeIsUnbounded("arn:aws:route53:::hostedzone/Z*", "route53")).toBe(true);
    expect(scopeIsUnbounded("arn:aws:ec2:*:*:instance/i-*", "ec2")).toBe(true);
  });

  it("a genuine name prefix is still a name — the table adds, it never guesses", () => {
    expect(scopeIsIdPrefix("arn:aws:route53:::hostedzone/Z0450NOLLY", "route53")).toBe(false);
    expect(scopeIsUnbounded("arn:aws:dynamodb:*:*:table/CrewPoppy*", "dynamodb")).toBe(false);
    expect(scopeIsUnbounded("arn:aws:amplify:*:*:apps/d1abc2def3*", "amplify")).toBe(false);
  });

  it("a DISCLOSED id-prefix scope rates medium in its own honest register; undisclosed rates as the unbounded grant it is", () => {
    const disclosed = assessGrant({
      service: "amplify", actions: ["StartJob", "DeleteApp"], resourceScope: "arn:aws:amplify:*:*:apps/d*",
      reason: "Attaches the domain you typed to your app; in practice this scope reaches any Amplify app in the account.",
    });
    expect(disclosed).toMatchObject({ level: "medium", scoped: false });
    expect(disclosed.reason).toMatch(/in practice any of them/);
    expect(disclosed.reason).toMatch(/nothing narrower to hold/);
    const bare = assessGrant({ service: "amplify", actions: ["StartJob", "DeleteApp"], resourceScope: "arn:aws:amplify:*:*:apps/d*" });
    expect(bare.level).toBe("high");
    expect(bare.scoped).toBe(false);
  });
});
