// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { TAGGED_AS_SELF } from "@agentspoppy/core";
import type { ConnectedAccount, Connection, PermissionGrant, PermissionSet } from "@agentspoppy/core";
import { APP_TAG_KEY, sessionPolicyForConnection, sessionTags, statementForGrant } from "./policy";

const account: ConnectedAccount = {
  id: "acc-1",
  accountId: "123456789012",
  regions: ["eu-west-1"],
  roleArn: "arn:aws:iam::123456789012:role/AgentsPoppy",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function connection(grants: PermissionGrant[]): Connection {
  const permissionSet: PermissionSet = {
    id: "ps",
    name: "PS",
    description: "",
    grants,
    requiredTags: [],
    limits: null,
  };
  return {
    id: "conn-abc",
    accountId: account.id,
    app: { id: "com.mailpoppy.desktop", name: "MailPoppy" },
    status: "active",
    permissionSet,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("statementForGrant", () => {
  it("splits a tag-scoped grant: creates require BIRTH tagging, the rest the resource's tag", () => {
    // One condition can't cover both halves of a resource's life: a create can never
    // match aws:ResourceTag (nothing exists yet — this silently denied every create
    // until TrafficPoppy's edge stack hit it live), and aws:RequestTag enforces that
    // everything an app makes is born carrying its tag — or is not born at all.
    const [create, rest] = statementForGrant(
      { service: "acm", actions: ["RequestCertificate", "DeleteCertificate"], resourceScope: TAGGED_AS_SELF },
      "com.mailpoppy.desktop",
      0,
    );
    expect(create).toEqual({
      Sid: "Grant0CreateBirthTagged",
      Effect: "Allow",
      Action: ["acm:RequestCertificate"],
      Resource: "*",
      Condition: { StringEquals: { [`aws:RequestTag/${APP_TAG_KEY}`]: "com.mailpoppy.desktop" } },
    });
    expect(rest).toEqual({
      Sid: "Grant0TagScoped",
      Effect: "Allow",
      Action: ["acm:DeleteCertificate"],
      Resource: "*",
      Condition: { StringEquals: { [`aws:ResourceTag/${APP_TAG_KEY}`]: "com.mailpoppy.desktop" } },
    });
  });

  it("emits no create statement when a tag-scoped grant has no create actions (and vice versa)", () => {
    const readOnly = statementForGrant(
      { service: "acm", actions: ["DescribeCertificate"], resourceScope: TAGGED_AS_SELF },
      "com.app",
      0,
    );
    expect(readOnly).toHaveLength(1);
    expect(readOnly[0]!.Sid).toBe("Grant0TagScoped");
    const createOnly = statementForGrant(
      { service: "cloudfront", actions: ["CreateDistributionWithTags"], resourceScope: TAGGED_AS_SELF },
      "com.app",
      0,
    );
    expect(createOnly).toHaveLength(1);
    expect(createOnly[0]!.Sid).toBe("Grant0CreateBirthTagged");
  });

  it("leaves already-qualified action names untouched", () => {
    const [s] = statementForGrant({ service: "s3", actions: ["s3:ListBucket"], resourceScope: TAGGED_AS_SELF }, "com.app", 0);
    expect(s!.Action).toEqual(["s3:ListBucket"]);
  });

  it("passes a concrete ARN scope through as Resource with no tag condition", () => {
    const arn = "arn:aws:cloudformation:eu-west-1:123456789012:stack/agentspoppy-*/*";
    const [s] = statementForGrant({ service: "cloudformation", actions: ["DeleteStack"], resourceScope: arn }, "com.app", 1);
    expect(s!.Resource).toBe(arn);
    expect(s!.Condition).toBeUndefined();
  });
});

describe("sessionPolicyForConnection", () => {
  it("flattens per-grant statements; every tag-scoped one pins to the stable app id", () => {
    const doc = sessionPolicyForConnection(
      connection([
        { service: "s3", actions: ["CreateBucket"], resourceScope: TAGGED_AS_SELF },
        { service: "ses", actions: ["SendEmail"], resourceScope: TAGGED_AS_SELF },
      ]),
    );
    expect(doc.Version).toBe("2012-10-17");
    expect(doc.Statement).toHaveLength(2); // one create-only grant + one rest-only grant
    // every tag-scoped statement carries the stable per-app pin (not the connection id),
    // whichever side of the create/rest split it landed on
    for (const st of doc.Statement) {
      const eq = st.Condition?.StringEquals ?? {};
      const pin = eq[`aws:ResourceTag/${APP_TAG_KEY}`] ?? eq[`aws:RequestTag/${APP_TAG_KEY}`];
      expect(pin).toBe("com.mailpoppy.desktop");
    }
  });

  it("denies everything when a permission set has no grants (inert session)", () => {
    const doc = sessionPolicyForConnection(connection([]));
    expect(doc.Statement).toEqual([{ Sid: "NoGrants", Effect: "Deny", Action: ["*"], Resource: "*" }]);
  });
});

describe("sessionTags", () => {
  it("derives the three attribution tags from account + connection", () => {
    const tags = sessionTags(account, connection([]));
    expect(tags).toEqual([
      { Key: "agentspoppy:account", Value: "123456789012" },
      { Key: "agentspoppy:app", Value: "com.mailpoppy.desktop" },
      { Key: "agentspoppy:connection", Value: "conn-abc" },
    ]);
  });
});
