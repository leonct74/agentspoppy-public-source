// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { TAGGED_AS_SELF } from "@agentspoppy/core";
import type { ConnectedAccount, Connection } from "@agentspoppy/core";
import { StsCredentialVendor, splitPolicyDocument, type AssumeRoleParams } from "./sts";
import { APP_TAG_KEY, type PolicyDocument } from "./policy";

const account: ConnectedAccount = {
  id: "acc-1",
  accountId: "123456789012",
  regions: ["eu-west-1"],
  roleArn: "arn:aws:iam::123456789012:role/AgentsPoppy",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const connection: Connection = {
  id: "conn-abc",
  accountId: account.id,
  app: { id: "com.mailpoppy.desktop", name: "MailPoppy" },
  status: "active",
  permissionSet: {
    id: "ps",
    name: "PS",
    description: "",
    grants: [{ service: "s3", actions: ["CreateBucket"], resourceScope: TAGGED_AS_SELF }],
    requiredTags: [],
    limits: null,
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const FAKE_CREDS = {
  accessKeyId: "ASIAFAKE",
  secretAccessKey: "secret",
  sessionToken: "token",
  expiration: "2026-01-01T01:00:00.000Z",
};

describe("StsCredentialVendor", () => {
  it("assumes the account role with a scoped session policy + transitive tags", async () => {
    let captured: AssumeRoleParams | undefined;
    const vendor = new StsCredentialVendor(async (p) => {
      captured = p;
      return FAKE_CREDS;
    });

    const creds = await vendor.vend(connection, account);
    expect(creds).toEqual(FAKE_CREDS);

    expect(captured).toBeDefined();
    const p = captured as AssumeRoleParams;
    expect(p.roleArn).toBe(account.roleArn);
    expect(p.sessionName).toBe("agentspoppy-conn-abc");
    expect(p.region).toBe("eu-west-1");
    expect(p.durationSeconds).toBeGreaterThan(0);

    // the inline policy pins to this app's stable tag (not the ephemeral connection id) —
    // via ResourceTag (touch-existing) or RequestTag (born-tagged creates), per statement
    const doc = JSON.parse(p.policy) as PolicyDocument;
    const eq = doc.Statement[0]?.Condition?.StringEquals ?? {};
    expect(eq[`aws:ResourceTag/${APP_TAG_KEY}`] ?? eq[`aws:RequestTag/${APP_TAG_KEY}`]).toBe(
      "com.mailpoppy.desktop",
    );

    // attribution tags are present and all marked transitive
    expect(p.tags).toContainEqual({ Key: "agentspoppy:connection", Value: "conn-abc" });
    expect(p.transitiveTagKeys.sort()).toEqual(["agentspoppy:account", "agentspoppy:app", "agentspoppy:connection"]);
  });

  it("refuses to vend when the account has no role to assume", async () => {
    const vendor = new StsCredentialVendor(async () => FAKE_CREDS);
    await expect(vendor.vend(connection, { ...account, roleArn: undefined })).rejects.toThrow(/roleArn/);
  });

  it("sanitises the role session name to the allowed charset and length", async () => {
    let captured: AssumeRoleParams | undefined;
    const vendor = new StsCredentialVendor(async (p) => {
      captured = p;
      return FAKE_CREDS;
    });
    const weird: Connection = { ...connection, id: "abc/def ghi:" + "x".repeat(80) };
    await vendor.vend(weird, account);
    const name = (captured as AssumeRoleParams).sessionName;
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^[\w+=,.@-]+$/);
    expect(name.startsWith("agentspoppy-abc-def-ghi-")).toBe(true);
  });
});

describe("splitPolicyDocument", () => {
  const mkDoc = (n: number) => {
    const Statement = Array.from({ length: n }, (_, i) => ({
      Sid: `Grant${i}`,
      Effect: "Allow",
      Action: [`svc:Action${i}`, `svc:Other${i}`],
      Resource: `arn:aws:svc:*:*:resource/MailpoppyMailStack-${i}-${"x".repeat(40)}`,
    }));
    return JSON.stringify({ Version: "2012-10-17", Statement });
  };

  it("returns a single chunk when the document already fits", () => {
    const docs = splitPolicyDocument(mkDoc(2), 6000);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.length).toBeLessThanOrEqual(6000);
  });

  it("splits a large document into chunks each under budget, losing no statement", () => {
    const original = mkDoc(60);
    const docs = splitPolicyDocument(original, 600);
    expect(docs.length).toBeGreaterThan(1);
    for (const d of docs) expect(d.length).toBeLessThanOrEqual(600);

    // The union of chunk statements is exactly the original set, in order.
    const all = docs.flatMap((d) => (JSON.parse(d) as PolicyDocument).Statement);
    const want = (JSON.parse(original) as PolicyDocument).Statement;
    expect(all).toEqual(want);
    // every chunk is a valid policy document
    for (const d of docs) expect((JSON.parse(d) as PolicyDocument).Version).toBe("2012-10-17");
  });
});
