// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

// Tag adoption — a poppy must not be able to claim what it did not create.
//
// A poppy is authorised to act on resources carrying its own `agentspoppy:app` tag (I2).
// Six of the seven shipped poppies ALSO held an unconditioned power to write tags on every
// resource of some type, which made the tag that decides ownership a tag the poppy could
// write. CrewPoppy could stamp itself onto MailPoppy's mailbox pool and then reset a
// password in it; VM-Poppy could list every instance in the account, claim one, and
// terminate it.
//
// WHAT THESE TESTS CAN AND CANNOT PROVE. They assert the SHAPE of the compiled policy,
// which is the part AgentsPoppy controls. Whether AWS then evaluates those conditions the
// way we expect is AWS's behaviour, not ours — that needs a canary deploy per affected
// service before rollout (see docs/specs/tag-adoption.md). What these DO prove is that the
// conditions are present, correct, and applied to the right actions, and that the two
// mistakes which would break a real deploy cannot be made silently.

import { describe, it, expect } from "vitest";
import { sessionPolicyForConnection, statementForGrant } from "./policy";
import { TAGGED_AS_SELF, type Connection, type PermissionGrant } from "@agentspoppy/core";

const APP = "com.crewpoppy.desktop";
const stmts = (grant: PermissionGrant) => statementForGrant(grant, APP, 0);
const byId = (grant: PermissionGrant, suffix: string) =>
  stmts(grant).find((s) => s.Sid === `Grant0${suffix}`);

const cognitoUnbounded: PermissionGrant = {
  service: "cognito-idp",
  actions: ["CreateUserPool", "TagResource", "UntagResource", "ListUsers"],
  resourceScope: "arn:aws:cognito-idp:*:*:userpool/*",
};

describe("a tag write on an unnarrowed scope is conditioned, not blanket", () => {
  it("no longer emits an unconditioned tag write", () => {
    for (const s of stmts(cognitoUnbounded)) {
      const actions = ([] as string[]).concat(s.Action);
      if (actions.some((a) => /TagResource/.test(a))) {
        expect(s.Condition, `${s.Sid} tags without a condition`).toBeDefined();
      }
    }
  });

  // PROVEN LIVE (canary, 26 Aug 2026) that cognito needs NO claim statement: AWS populates
  // aws:ResourceTag with the SUBMITTED tags during a tag-on-create, so the re-tag-your-own
  // statement authorises the create by itself. A claim statement would add exactly one
  // thing — the ability to take over an UNTAGGED resource — which the same run confirmed
  // was possible. Emitting one here would re-open a gap for no gain.
  it("emits NO claim statement for a service proven not to need one", () => {
    expect(byId(cognitoUnbounded, "TagOnCreate")).toBeUndefined();
    expect(byId(cognitoUnbounded, "TagOwn")).toBeDefined();
  });

  // Every service in the table has now been proven live, so NONE of them emits a claim
  // statement any more. If a future service is added on the unproven `request-tag` shape,
  // this is the test that should be extended rather than deleted — the shape still exists
  // in the compiler precisely so an unproven service has somewhere safe to sit.
  it("emits no claim statement for any service currently in the table", () => {
    for (const [service, actions] of [
      ["cognito-idp", ["CreateUserPool", "TagResource"]],
      ["guardduty", ["CreateMalwareProtectionPlan", "TagResource"]],
      ["amplify", ["CreateApp", "TagResource"]],
    ] as [string, string[]][]) {
      const out = stmts({ service, actions, resourceScope: "*" });
      expect(out.find((s) => s.Sid === "Grant0TagOnCreate"), service).toBeUndefined();
      expect(out.find((s) => s.Sid === "Grant0TagOwn"), service).toBeDefined();
    }
  });

  // THE REGRESSION THAT WOULD BREAK EVERY RELEASE. CloudFormation issues tag updates as
  // DELTAS containing only the changed keys, so a release-day stack update carries
  // {crewpoppy:sourceCommit, …} and NOT agentspoppy:app. It fails the claim statement's
  // StringEquals and is authorised only by this one. Established from 90 days of
  // CloudTrail on a real account, not from reading CloudFormation's behaviour.
  it("keeps a separate allow for re-tagging what is already yours", () => {
    const own = byId(cognitoUnbounded, "TagOwn")!;
    expect(own.Condition).toEqual({ StringEquals: { "aws:ResourceTag/agentspoppy:app": APP } });
    expect(([] as string[]).concat(own.Action)).toContain("cognito-idp:TagResource");
  });

  // No tags ride along on a removal, so aws:RequestTag is unpopulated there and a
  // condition on it is a permanent deny. Cognito, GuardDuty, Amplify and EC2's DeleteTags
  // all agree — it is the same reasoning as SECURITY_MECHANISM §3's create/mutate split.
  it("never puts a request-tag condition on an untag action", () => {
    for (const s of stmts(cognitoUnbounded)) {
      const actions = ([] as string[]).concat(s.Action);
      if (actions.some((a) => /Untag|DeleteTags/.test(a))) {
        expect(JSON.stringify(s.Condition ?? {}), `${s.Sid}`).not.toMatch(/RequestTag/);
      }
    }
  });

  it("leaves the grant's non-tag actions exactly as they were", () => {
    const rest = byId(cognitoUnbounded, "")!;
    expect(([] as string[]).concat(rest.Action).sort()).toEqual(
      ["cognito-idp:CreateUserPool", "cognito-idp:ListUsers"].sort(),
    );
    expect(rest.Condition).toBeUndefined();
    expect(rest.Resource).toBe(cognitoUnbounded.resourceScope);
  });
});

describe("EC2 closes the claim path entirely", () => {
  const ec2: PermissionGrant = {
    service: "ec2",
    actions: ["RunInstances", "CreateSecurityGroup", "CreateTags"],
    resourceScope: "*",
  };

  // ec2:CreateAction is populated only when CreateTags is evaluated as the tagging half of
  // a create call, and is absent when CreateTags is called directly. So unlike the
  // request-tag shape, there is NO residual "claim an unclaimed resource" path — which
  // matters most here, because untagged instances are the normal case in a real account
  // and VM-Poppy can enumerate every one of them.
  it("authorises tagging only as part of a create the poppy itself is making", () => {
    const claim = byId(ec2, "TagOnCreate")!;
    expect(claim.Condition!.StringEquals!["ec2:CreateAction"]).toEqual([
      "RunInstances",
      "CreateSecurityGroup",
    ]);
    expect(claim.Condition!.StringEquals!["aws:RequestTag/agentspoppy:app"]).toBe(APP);
  });

  it("never emits the weaker claim-anything-unclaimed shape for EC2", () => {
    for (const s of stmts(ec2)) expect(s.Condition?.Null, s.Sid).toBeUndefined();
  });

  // AWS's own documented example permits ANY tag during a create. That is not what we
  // want — the tag has to be self-attesting, or a poppy could birth a resource under
  // another poppy's tag.
  it("still requires the tag being applied to be its own", () => {
    expect(JSON.stringify(byId(ec2, "TagOnCreate")!.Condition)).toMatch(/aws:RequestTag/);
  });

  it("never puts CreateAction on the untag side", () => {
    const withDelete = { ...ec2, actions: [...ec2.actions, "DeleteTags"] };
    const own = byId(withDelete, "TagOwn")!;
    expect(JSON.stringify(own.Condition)).not.toMatch(/CreateAction/);
    expect(([] as string[]).concat(own.Action)).toContain("ec2:DeleteTags");
  });

  // A grant that can tag but cannot create anything would get a statement authorising
  // nothing. Emitting it would be dead policy that reads as a permission.
  it("omits the create statement when the grant creates nothing", () => {
    const tagOnly: PermissionGrant = { service: "ec2", actions: ["CreateTags"], resourceScope: "*" };
    expect(byId(tagOnly, "TagOnCreate")).toBeUndefined();
    expect(byId(tagOnly, "TagOwn")).toBeDefined();
  });
});

describe("services that cannot be confined this way are REFUSED, not guessed at", () => {
  // s3:PutBucketTagging supports neither aws:RequestTag nor aws:ResourceTag, so both
  // shapes above would deny every bucket tag write forever — including the very delta
  // updates the second allow exists to protect. S3 tag writes must be name-scoped, which
  // every shipped poppy already does.
  it("refuses an unnarrowed S3 tag write rather than emitting a permanent deny", () => {
    expect(() =>
      stmts({ service: "s3", actions: ["PutBucketTagging"], resourceScope: "arn:aws:s3:::*" }),
    ).toThrow(/no verified way to confine tag writes/i);
  });

  it("refuses a service nobody has checked yet", () => {
    expect(() =>
      stmts({ service: "sagemaker", actions: ["AddTags"], resourceScope: "*" }),
    ).toThrow(/sagemaker/);
  });

  it("names the fix in the error, so it is actionable", () => {
    let msg = "";
    try {
      stmts({ service: "s3", actions: ["PutBucketTagging"], resourceScope: "*" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/name pattern/i);
    expect(msg).toMatch(/tag-adoption\.md/);
  });

  // A known service can still grow an action we have not classified. Guessing whether a
  // request-tag condition would confine it or deny it is exactly what must not happen.
  it("refuses an unclassified tag action on a known service", () => {
    expect(() =>
      stmts({ service: "ec2", actions: ["RunInstances", "TagSomethingNew"], resourceScope: "*" }),
    ).toThrow(/not classified/i);
  });
});

describe("what the rule must NOT touch", () => {
  // The name already confines it — every DynamoDB, Lambda, log-group and event-rule tag
  // write in every shipped poppy is of this shape, and none of them was ever exposed.
  it("leaves a name-scoped tag write exactly as it was", () => {
    const named: PermissionGrant = {
      service: "dynamodb",
      actions: ["CreateTable", "TagResource"],
      resourceScope: "arn:aws:dynamodb:*:*:table/CrewPoppy*",
    };
    const out = stmts(named);
    expect(out).toHaveLength(1);
    expect(out[0]!.Condition).toBeUndefined();
    expect(out[0]!.Sid).toBe("Grant0");
  });

  // Already conditioned on aws:ResourceTag by the tagged-as-self path, so it can only tag
  // what is already its own.
  it("leaves a tagged-as-self grant on its existing path", () => {
    const out = stmts({ service: "cognito-idp", actions: ["TagResource"], resourceScope: TAGGED_AS_SELF });
    expect(out).toHaveLength(1);
    expect(out[0]!.Sid).toBe("Grant0TagScoped");
  });

  it("leaves a grant with no tag actions alone", () => {
    const out = stmts({ service: "ec2", actions: ["DescribeInstances"], resourceScope: "*" });
    expect(out).toHaveLength(1);
    expect(out[0]!.Condition).toBeUndefined();
  });

  // Tag READS are not tag writes.
  it("does not treat ListTagsForResource as a tag write", () => {
    const out = stmts({ service: "guardduty", actions: ["ListTagsForResource"], resourceScope: "*" });
    expect(out).toHaveLength(1);
    expect(out[0]!.Condition).toBeUndefined();
  });
});

describe("every shipped poppy still compiles", () => {
  // The whole fleet, so a rule that is correct in isolation but refuses a real manifest
  // fails here rather than in a user's account.
  const FLEET: [string, string, PermissionGrant[]][] = [
    ["MailPoppy", "com.mailpoppy.desktop", [
      { service: "cognito-idp", actions: ["CreateUserPool", "TagResource", "UntagResource"], resourceScope: "*" },
      { service: "guardduty", actions: ["CreateMalwareProtectionPlan", "TagResource", "UntagResource", "ListTagsForResource"], resourceScope: "*" },
    ]],
    ["CrewPoppy", "com.crewpoppy.desktop", [cognitoUnbounded]],
    ["HostingPoppy", "com.hostingpoppy.desktop", [
      { service: "amplify", actions: ["TagResource", "CreateDeployment"], resourceScope: "arn:aws:amplify:*:*:apps/*" },
    ]],
    ["VM-Poppy", "com.vmpoppy.desktop", [
      { service: "ec2", actions: ["RunInstances", "CreateSecurityGroup", "CreateKeyPair", "CreateTags"], resourceScope: "*" },
    ]],
  ];

  for (const [name, appId, grants] of FLEET) {
    it(`${name} compiles, and every tag write it gets is conditioned`, () => {
      const conn = {
        id: "c1", accountId: "a", app: { id: appId, name },
        status: "active", supervised: false,
        permissionSet: { id: "p", name: "p", description: "", grants, requiredTags: [], limits: null },
        createdAt: "", updatedAt: "",
      } as unknown as Connection;
      const doc = sessionPolicyForConnection(conn);
      for (const s of doc.Statement) {
        const actions = ([] as string[]).concat(s.Action);
        if (actions.some((a) => /:(Tag|Untag|CreateTags|DeleteTags)/.test(a))) {
          expect(s.Condition, `${name} ${s.Sid} tags unconditioned`).toBeDefined();
        }
      }
    });
  }
});

// From the adversarial review of this fix (26 August). All three are the detector failing
// OPEN — the direction that matters, because a name it misses compiles unconditioned and
// the fail-closed refusal never fires either. None was reachable by any shipped manifest;
// all three were reachable by a hostile or careless one.
describe("the detector must not fail open", () => {
  // IAM matches the Action element case-insensitively, so cognito-idp:tagresource grants
  // exactly what cognito-idp:TagResource grants. A capitalised detector did not see it.
  it("catches a tag write whatever its casing", () => {
    for (const spelling of ["TagResource", "tagresource", "TAGRESOURCE", "tagRESOURCE"]) {
      const out = stmts({ service: "cognito-idp", actions: ["CreateUserPool", spelling], resourceScope: "*" });
      const unconditionedTagWrite = out.some(
        (st) => !st.Condition && ([] as string[]).concat(st.Action).some((a) => /tag/i.test(a)),
      );
      expect(unconditionedTagWrite, `"${spelling}" compiled unconditioned`).toBe(false);
    }
  });

  // The same miss defeated the fail-closed refusal: an unchecked service spelling its tag
  // action in lower case was emitted unconditioned instead of throwing.
  it("still refuses an unchecked service when it is spelled in lower case", () => {
    expect(() =>
      stmts({ service: "redshift", actions: ["createcluster", "createtags"], resourceScope: "*" }),
    ).toThrow(/no verified way to confine tag writes/i);
  });

  // A wildcard action IS the tag write, spelled in one character — and it cannot be split
  // into a conditionable half and an unconditionable one.
  it("refuses a wildcard action on a scope that does not narrow", () => {
    for (const actions of [["*"], ["cognito-idp:*"], ["DescribeUserPool", "*"]]) {
      expect(() => stmts({ service: "cognito-idp", actions, resourceScope: "*" }), actions.join()).toThrow(
        /wildcard action/i,
      );
    }
  });

  // …but a wildcard action is fine where the NAME still confines it. Refusing here would
  // break legitimate grants for no gain.
  it("leaves a wildcard action alone when the name confines it", () => {
    const out = stmts({
      service: "dynamodb",
      actions: ["dynamodb:*"],
      resourceScope: "arn:aws:dynamodb:*:*:table/CrewPoppy*",
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.Condition).toBeUndefined();
  });

  // "?" is an IAM single-character wildcard, so instance/?* reaches every instance while
  // looking like a name pattern to a literal-string test — which is exactly why a hostile
  // manifest would reach for it.
  it("treats a question-mark wildcard scope as unnarrowed", () => {
    const out = stmts({
      service: "ec2",
      actions: ["RunInstances", "CreateTags"],
      resourceScope: "arn:aws:ec2:*:*:instance/?*",
    });
    expect(out.some((st) => st.Sid === "Grant0TagOnCreate")).toBe(true);
    expect(out.every((st) => !(!st.Condition && ([] as string[]).concat(st.Action).some((a) => /tag/i.test(a))))).toBe(true);
  });
});

