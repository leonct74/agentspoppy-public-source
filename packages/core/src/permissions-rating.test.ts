// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

// Fault E (adversarial review, 16 August 2026) — the consent screen must describe what a
// grant can actually DO.
//
// The rating decided "can this change things?" with an unanchored substring search over
// the action name, and "is this confined?" by testing the resource scope against the
// literal string "*". Both are wrong in ways a user cannot see:
//
//   - ec2:TerminateInstances matched no mutating verb, so a grant that can delete every
//     server in the account was described as "Can read ANY EC2 resource in your account";
//   - ec2:GetConsoleOutput matched "put" inside "OutPUT" and rated destructive — a pure
//     read shown as red;
//   - arn:aws:iam::*:role/* is not literally "*", so it was rated amber and described as
//     "it cannot touch any IAM resource with a different name", while matching every role
//     in every account — and it passed isFullyAttributable, the check that is supposed to
//     guarantee teardown can find everything a poppy made.
//
// The table below is real AWS action names asserted against what they really do. It is
// the tripwire for the whole rating: if a future refactor reintroduces substring matching,
// these rows fail.
//
// See docs/specs/scope-policy-and-rating.md.

import { describe, it, expect } from "vitest";
import {
  grantCanMutate,
  grantCanDestroy,
  describeGrant,
  assessGrant,
  isFullyAttributable,
  ATTRIBUTION_TAG_KEYS,
} from "./permissions";
import type { PermissionGrant, PermissionSet } from "./types";

function grant(service: string, action: string, resourceScope = "*"): PermissionGrant {
  return { service, actions: [action], resourceScope };
}

/** [action, canMutate, canDestroy] — the truth, not the substring. */
const ACTIONS: [string, boolean, boolean][] = [
  // False negatives that mattered most: destructive actions rated as reads.
  ["ec2:TerminateInstances", true, true],
  ["ec2:StopInstances", true, true],
  ["ec2:RebootInstances", true, true],
  ["rds:RebootDBInstance", true, true],
  ["ec2:AuthorizeSecurityGroupIngress", true, true],
  ["ec2:RevokeSecurityGroupIngress", true, true],

  // Dangerous for reasons the verb does not carry.
  ["sts:AssumeRole", true, true],
  ["iam:PassRole", true, true],
  ["lambda:InvokeFunction", true, true],

  // Reads, but of data — they must not be described as harmless "reads" of a resource.
  // They mutate nothing, so canDestroy stays false; the rating handles them separately.
  ["kms:Decrypt", false, false],
  ["secretsmanager:GetSecretValue", false, false],

  // Creates: mutating, but not destructive — nothing that already exists is harmed.
  // ec2:RunInstances is absent from this table on purpose: it needs more than a
  // two-way split, and is asserted on its own below.
  ["ec2:CreateSnapshot", true, false],
  ["iam:CreatePolicy", true, false],

  // The false positive: a pure read that matched "put" inside "Output".
  ["ec2:GetConsoleOutput", false, false],

  // Ordinary reads, which must stay reads.
  ["s3:GetObject", false, false],
  ["s3:ListBucket", false, false],
  ["ec2:DescribeInstances", false, false],
  ["cloudformation:DescribeStacks", false, false],

  // Ordinary writes, which must stay writes.
  ["s3:PutObject", true, true],
  ["s3:DeleteBucket", true, true],
  ["dynamodb:UpdateItem", true, true],
];

describe("action classification is by verb, not by substring", () => {
  for (const [action, mutates, destroys] of ACTIONS) {
    const service = action.split(":")[0]!;
    it(`${action} → mutating=${mutates} destructive=${destroys}`, () => {
      expect(grantCanMutate(grant(service, action))).toBe(mutates);
      expect(grantCanDestroy(grant(service, action))).toBe(destroys);
    });
  }

  // ec2:RunInstances creates billable resources, so rating it a "read" was the bug —
  // but it does not fit the two-way split either. The compiler's create filter is
  // /:(Create|Request)/, which RunInstances does not match, so it compiles into the
  // "rest" statement rather than the birth-tagged one: under a tagged-as-self grant
  // that means an instance born UNTAGGED, invisible to I4's sweep and to teardown.
  // Rating it "additive, cannot harm what exists" would claim an I3 guarantee the
  // compiled policy is not making.
  // Resolved as option (a) in the spec: the additive bucket stays exactly as wide as
  // the compiler's own create filter, so RunInstances is not additive — but it is not
  // destructive either, and saying it can "delete ANY EC2 resource" would be the same
  // class of lie in the opposite direction. It gets its own class and its own wording.
  it("treats ec2:RunInstances as mutating but NOT destructive", () => {
    expect(grantCanMutate(grant("ec2", "ec2:RunInstances"))).toBe(true);
    expect(grantCanDestroy(grant("ec2", "ec2:RunInstances"))).toBe(false);
  });

  it("rates an untracked launch on * as high, for the reason that is actually true", () => {
    const risk = assessGrant(grant("ec2", "ec2:RunInstances", "*"));
    expect(risk.level).toBe("high");
    // It must not claim a power the compiled policy does not grant…
    expect(risk.reason).not.toMatch(/delete/i);
    // …and must not use the additive bucket's reassurance either.
    expect(risk.reason).not.toMatch(/cannot change or delete anything/i);
    expect(risk.reason).toMatch(/cannot show you or remove them/i);
  });

  // The mixed grant every VM-style poppy actually ships: one launch action alongside
  // ordinary creates. The launch must dominate the rating.
  it("lets a single launch action dominate a grant of otherwise-additive creates", () => {
    const mixed = {
      service: "ec2",
      actions: ["RunInstances", "CreateSecurityGroup", "CreateKeyPair", "CreateTags"],
      resourceScope: "*",
    };
    expect(assessGrant(mixed).level).toBe("high");
    expect(assessGrant(mixed).reason).toMatch(/cannot show you or remove them/i);
  });

  // AWS adds actions constantly. An unrecognised verb must read as mutating, because a
  // rating that defaults to reassuring is worse than one that defaults to asking.
  it("treats an unrecognised verb as mutating, not as a read", () => {
    expect(grantCanMutate(grant("newservice", "newservice:FrobnicateWidget"))).toBe(true);
  });

  it("still treats wildcard actions as mutating", () => {
    expect(grantCanMutate({ service: "iam", actions: ["*"], resourceScope: "*" })).toBe(true);
    expect(grantCanMutate({ service: "iam", actions: ["iam:*"], resourceScope: "*" })).toBe(true);
  });
});

describe("a scope whose resource part is a bare wildcard is NOT scoped", () => {
  // It is not the literal string "*", but it reaches every role in every account.
  it("rates arn:aws:iam::*:role/* as unscoped and high", () => {
    const risk = assessGrant(grant("iam", "iam:CreateRole", "arn:aws:iam::*:role/*"));
    expect(risk.scoped).toBe(false);
    expect(risk.level).toBe("high");
  });

  it("does not describe it as confined to its own name", () => {
    const risk = assessGrant(grant("iam", "iam:CreateRole", "arn:aws:iam::*:role/*"));
    expect(risk.reason).not.toMatch(/cannot touch/i);
  });

  it("rejects it from isFullyAttributable — teardown cannot rely on it", () => {
    const ps: PermissionSet = {
      id: "x", name: "x", description: "x",
      grants: [grant("iam", "iam:CreateRole", "arn:aws:iam::*:role/*")],
      requiredTags: [...ATTRIBUTION_TAG_KEYS],
      limits: null,
    };
    expect(isFullyAttributable(ps)).toBe(false);
  });

  it("catches the same shape for other services", () => {
    expect(assessGrant(grant("s3", "s3:DeleteBucket", "arn:aws:s3:::*")).scoped).toBe(false);
    expect(assessGrant(grant("kms", "kms:Decrypt", "arn:aws:kms:*:*:key/*")).scoped).toBe(false);
  });

  // The mirror of the bug, and just as damaging. An S3 ARN has NO resource type, so a
  // bucket name sits exactly where `role` sits in arn:aws:iam::*:role/* — the two are
  // syntactically identical and only the service tells them apart. Reading the bucket
  // name as a type would call the most common correct S3 grant "any resource", rate it
  // high, fail isFullyAttributable and force supervision on. A rating that cries wolf
  // about good scoping teaches people to ignore it.
  it("keeps a concrete S3 bucket scoped, type qualifier or not", () => {
    for (const scope of [
      "arn:aws:s3:::my-bucket/*",
      "arn:aws:s3:::my-bucket",
      "arn:aws:s3:::crewpoppy-deploy-x/*",
      "arn:aws:s3:::mailpoppy-*/*",
    ]) {
      expect(assessGrant(grant("s3", "s3:PutObject", scope)).scoped, scope).toBe(true);
    }
  });

  it("still catches an S3 grant that really does reach every bucket", () => {
    expect(assessGrant(grant("s3", "s3:PutObject", "arn:aws:s3:::*")).scoped).toBe(false);
    expect(assessGrant(grant("s3", "s3:PutObject", "arn:aws:s3:::*/*")).scoped).toBe(false);
  });

  it("treats the other type-less services the same way", () => {
    expect(assessGrant(grant("sns", "sns:Publish", "arn:aws:sns:*:*:MailpoppyMailStack-*")).scoped).toBe(true);
    expect(assessGrant(grant("sqs", "sqs:SendMessage", "arn:aws:sqs:*:*:my-queue")).scoped).toBe(true);
  });

  // The fix must not swallow legitimate name patterns — this is MailPoppy's real grant,
  // and it genuinely IS confined.
  it("keeps a real name pattern scoped", () => {
    const risk = assessGrant(grant("iam", "iam:CreateRole", "arn:aws:iam::*:role/MailpoppyMailStack-*"));
    expect(risk.scoped).toBe(true);
  });
});

describe("control-plane services are judged on every grant, not only wildcards", () => {
  // CONTROL_PLANE existed so that creating an identity counts as escalation rather than a
  // harmless addition — but it was consulted only inside the wildcard branch, so exactly
  // the grants that matter skipped it.
  it("bumps an IAM grant with a name pattern above plain amber", () => {
    const risk = assessGrant(grant("iam", "iam:CreatePolicy", "arn:aws:iam::*:policy/AgentsPoppyScope-*"));
    expect(risk.level).toBe("high");
  });

  it("leaves a non-control-plane name pattern alone", () => {
    const risk = assessGrant(grant("s3", "s3:PutObject", "arn:aws:s3:::mailpoppy-*/*"));
    expect(risk.level).toBe("medium");
  });
});

describe("the description matches the rating", () => {
  // The specific sentence a user was shown over the ability to delete every server.
  it("never calls a destructive wildcard grant a read", () => {
    const risk = assessGrant(grant("ec2", "ec2:TerminateInstances", "*"));
    expect(risk.reason).not.toMatch(/can read/i);
    expect(risk.level).toBe("high");
  });
});

describe("describeGrant uses the same classes as the rating", () => {
  it("does not claim a launch grant can delete things", () => {
    const line = describeGrant({ service: "ec2", actions: ["RunInstances"], resourceScope: "*" });
    expect(line).not.toMatch(/delete/i);
    expect(line).toMatch(/start up new/i);
  });

  it("keeps calling a genuinely destructive grant destructive", () => {
    expect(describeGrant({ service: "s3", actions: ["DeleteBucket"], resourceScope: "*" }))
      .toMatch(/create, change and delete/i);
  });

  it("says a secret read reads CONTENTS, not just a resource", () => {
    expect(describeGrant({ service: "secretsmanager", actions: ["GetSecretValue"], resourceScope: "*" }))
      .toMatch(/read the contents of/i);
  });
});

// Findings from the adversarial review of this fix (26 August). Each is a real way the
// first cut of the classifier still described a grant wrongly.
describe("adversarial review follow-ups", () => {
  // A wildcard first segment means the parent is already unconstrained; a literal type
  // qualifier further along the ARN is not a constraint on anything.
  it("sees through a colon-separated wildcard tail", () => {
    expect(assessGrant(grant("lambda", "lambda:InvokeFunction", "arn:aws:lambda:*:*:function:*:*")).scoped).toBe(false);
    expect(assessGrant(grant("logs", "logs:GetLogEvents", "arn:aws:logs:*:*:log-group:*:log-stream:*")).scoped).toBe(false);
  });

  it("still treats a named resource with a wildcard tail as scoped", () => {
    expect(assessGrant(grant("logs", "logs:PutRetentionPolicy", "arn:aws:logs:*:*:log-group:/aws/lambda/App-*")).scoped).toBe(true);
    expect(assessGrant(grant("lambda", "lambda:GetFunction", "arn:aws:lambda:*:*:function:App-*")).scoped).toBe(true);
  });

  // A grant can do several things at once. The create branch used to win and print
  // "cannot change or delete anything that already exists" over a Decrypt.
  it("never lets a create hide a secret read in the same grant", () => {
    const risk = assessGrant({ service: "kms", actions: ["kms:Decrypt", "kms:CreateKey"], resourceScope: "*" });
    expect(risk.level).toBe("high");
    expect(risk.reason).toMatch(/read the CONTENTS of any KMS secret/i);
  });

  it("says so on a scoped grant too", () => {
    const risk = assessGrant({
      service: "secretsmanager",
      actions: ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"],
      resourceScope: "arn:aws:secretsmanager:*:*:secret:app-*",
    });
    expect(risk.reason).toMatch(/read the CONTENTS of those SECRETSMANAGER secrets/i);
  });

  // Exporting a table reads nothing new, but it lifts the whole thing into a bucket of
  // the caller's choosing — and as a "read" it would be vended un-gated under
  // supervision by approvals.ts.
  it("does not treat bulk data extraction as a harmless read", () => {
    expect(grantCanMutate(grant("dynamodb", "dynamodb:ExportTableToPointInTime"))).toBe(true);
    expect(grantCanMutate(grant("rds", "rds:ExportSnapshot"))).toBe(true);
  });

  // The compiler's filter is /:(Create|Request)/ — capitalised. A lower-case spelling
  // is not a create to the compiler, so the rating must not call it additive either.
  it("matches the compiler's case-sensitivity on creates", () => {
    const risk = assessGrant(grant("s3", "createBucket", "*"));
    expect(risk.reason).not.toMatch(/cannot change or delete anything that already exists/i);
    expect(assessGrant(grant("s3", "CreateBucket", "*")).reason)
      .toMatch(/cannot change or delete anything that already exists/i);
  });
});

// From the adversarial review of the tag-adoption fix: "?" is an IAM single-character
// wildcard, so a scope ending "/?*" reaches everything while a literal test for "*" reads
// it as a name pattern — rating it amber and describing it as confined.
describe("wildcard characters other than * also mean 'not narrowed'", () => {
  it("does not call a question-mark wildcard scoped", () => {
    for (const scope of ["arn:aws:iam::*:role/?*", "arn:aws:ec2:*:*:instance/?*", "arn:aws:s3:::?*"]) {
      expect(assessGrant(grant("iam", "iam:CreateRole", scope)).scoped, scope).toBe(false);
    }
  });

  // The former KNOWN LIMIT, fixed by rating-reconciliation.md 5b (2026-09-02): AWS ids have
  // fixed prefixes, so "instance/i-*" matches every instance while reading like a name. The
  // per-service id-format table now reads it as what it is — and "table/CrewPoppy*", which
  // really does narrow, stays a name.
  it("reads an id-prefix pattern as UNBOUNDED — the limit is fixed, not documented", () => {
    const r = assessGrant(grant("ec2", "ec2:TerminateInstances", "arn:aws:ec2:*:*:instance/i-*"));
    expect(r.scoped).toBe(false);
    expect(r.level).toBe("high");
    expect(assessGrant(grant("dynamodb", "dynamodb:DeleteTable", "arn:aws:dynamodb:*:*:table/CrewPoppy*")).scoped).toBe(true);
  });
});

