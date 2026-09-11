// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAINTENANCE_POLICY_STATEMENTS,
  MAINTENANCE_SESSION_NAME,
  classifyAssumeFailure,
  maintenancePolicyJson,
} from "./maintenance";
import { HOST_SESSION_PREFIX } from "@agentspoppy/core";
import { APP_TAG_KEY } from "./policy";
import { splitPolicyDocument } from "./sts";

describe("maintenance session policy", () => {
  it("carries the two statements template v4 removes from the operator user, plus tagged IAM", () => {
    // Was exactly two, matching v4's removals one for one. The IAM delete sequence could not
    // join either of them: HostResidualCleanup is unconditioned by design and IAM is the one
    // place that argument fails, so it lives in its own tagged statement instead. The effective
    // permissions are still v4's removals plus that, and nothing was widened to get there.
    const sids = MAINTENANCE_POLICY_STATEMENTS.map((s) => s.Sid);
    expect(sids).toEqual([
      "MonitorAndTeardown",
      "HostResidualCleanup",
      "HostRoleTeardown",
      "HostRoleTeardownReads",
      "HostRoleTeardownDetachTarget",
    ]);
  });

  it("names its session with the HOST prefix so the activity feed attributes it to AgentsPoppy", () => {
    expect(MAINTENANCE_SESSION_NAME.startsWith(HOST_SESSION_PREFIX)).toBe(true);
    // Never the poppy prefix — that would make classifyActor read it as a connection.
    expect(MAINTENANCE_SESSION_NAME.startsWith("agentspoppy-")).toBe(false);
  });

  it("is a valid, narrowing-only policy document (every statement Allow-only)", () => {
    const doc = JSON.parse(maintenancePolicyJson()) as { Version: string; Statement: { Effect: string }[] };
    expect(doc.Version).toBe("2012-10-17");
    for (const s of doc.Statement) expect(s.Effect).toBe("Allow");
  });

  it("splits cleanly under the managed-policy budget if it ever overflows the packed one", () => {
    // The packed budget is the real risk (sts.ts). If the inline path is ever rejected, the
    // module falls back to managed session policies via splitPolicyDocument — which must not
    // itself explode past AssumeRole's 10-policy cap for this document.
    const chunks = splitPolicyDocument(maintenancePolicyJson());
    expect(chunks.length).toBeLessThanOrEqual(10);
    for (const c of chunks) expect(() => JSON.parse(c)).not.toThrow();
  });
});

/**
 * The rule: `cloudformation:DeleteStack` (MonitorAndTeardown) runs on the MAINTENANCE
 * session's credentials, so CloudFormation calls each resource type's delete-time APIs as
 * THIS principal — not as the poppy, whose own manifest grants are irrelevant here. For
 * every resource type a poppy stack may contain, the host therefore needs whatever
 * CloudFormation calls while deleting that type. Crucially those are not always named
 * `Delete<Type>`, and the odd-named ones are exactly what a least-privilege tidy-up reads
 * as dead weight and strips.
 *
 * Left: the CFN resource type. Right: what CloudFormation calls to delete it.
 */
const DELETE_TIME_ACTIONS: Record<string, string[]> = {
  "AWS::S3::Bucket": ["s3:DeleteBucket"],
  // Its own resource, and DeleteBucket does not cover it. Present in every poppy that lets an
  // AWS service write into its bucket — an AWS Config delivery channel needs exactly this.
  "AWS::S3::BucketPolicy": ["s3:DeleteBucketPolicy"],
  // DeleteTable is asynchronous. CFN issues it and then polls DescribeTable until the table is
  // gone, so the poll is as load-bearing as the delete — this is the trap in the whole file:
  // holding the Delete* action is not the same as being able to complete the deletion.
  "AWS::DynamoDB::Table": ["dynamodb:DeleteTable", "dynamodb:DescribeTable"],
  "AWS::Cognito::UserPool": ["cognito-idp:DeleteUserPool"],
  "AWS::Cognito::UserPoolDomain": ["cognito-idp:DeleteUserPoolDomain"],
  "AWS::Lambda::Function": ["lambda:DeleteFunction"],
  // NOT DeleteFunction. EventBridge may only invoke a Lambda through a resource-based
  // permission, so every poppy with a SCHEDULED Lambda carries one of these in its stack —
  // a shape the platform actively encourages — and CFN deletes it with RemovePermission.
  "AWS::Lambda::Permission": ["lambda:RemovePermission"],
  // Deleting a role is a SEQUENCE. CFN enumerates inline policies and deletes each, detaches
  // managed ones, then deletes the role. Any poppy that deploys compute deploys one of these,
  // so it is the most common shape in the directory — and this policy carried no iam: action at
  // all until 2026-09-10, which stranded every such stack.
  "AWS::IAM::Role": [
    "iam:ListRolePolicies",
    "iam:DeleteRolePolicy",
    "iam:ListAttachedRolePolicies",
    "iam:DetachRolePolicy",
    "iam:DeleteRole",
  ],
  // NOT COVERED, deliberately and visibly: AWS::IAM::InstanceProfile needs
  // iam:RemoveRoleFromInstanceProfile + iam:DeleteInstanceProfile. No poppy ships one yet. When
  // the first does, this table is where it gets added — before its author loses a cycle to it.
  "AWS::Logs::LogGroup": ["logs:DeleteLogGroup"],
  // A rule's targets belong to the rule resource; DeleteRule fails while targets remain.
  // The same shape as Lambda::Permission, and the reason RemoveTargets is in the policy.
  "AWS::Events::Rule": ["events:RemoveTargets", "events:DeleteRule"],
  "AWS::SES::ReceiptRuleSet": ["ses:DeleteReceiptRuleSet"],
};

type Statement = {
  Sid: string;
  Action: readonly string[];
  Resource: string | readonly string[];
  Condition?: { Null?: Record<string, string> };
};
const statements = (): readonly Statement[] => MAINTENANCE_POLICY_STATEMENTS as readonly Statement[];
const tagPresent = (st: Statement): boolean =>
  st.Condition?.Null?.[`aws:ResourceTag/${APP_TAG_KEY}`] === "false";

const grantedActions = new Set<string>(
  MAINTENANCE_POLICY_STATEMENTS.flatMap((s) => s.Action as readonly string[]),
);

describe("host stack teardown", () => {
  it("grants what CloudFormation calls while deleting every type a poppy stack may contain", () => {
    for (const [type, required] of Object.entries(DELETE_TIME_ACTIONS)) {
      for (const action of required) {
        expect(
          grantedActions.has(action),
          `deleting ${type} calls ${action}, which the maintenance policy does not grant — ` +
            `CloudFormation strands the whole stack in DELETE_FAILED, so \`npm run certify\` ` +
            `fails for every poppy of that shape. Add it back; do not "tidy" it away.`,
        ).toBe(true);
      }
    }
  });

  it("grants lambda:RemovePermission — the AuditPoppy DELETE_FAILED regression", () => {
    // Found certifying com.auditpoppy.desktop against a live account, 2026-09-07. Its stack
    // reached DELETE_FAILED and CloudFormation named the cause:
    //
    //   User: ...assumed-role/AgentsPoppyBroker/AgentsPoppyHost-maintenance is not authorized
    //   to perform: lambda:RemovePermission on resource: ...function:AuditPoppyStack-snapshot
    //   because no session policy allows the lambda:RemovePermission action (403)
    //
    // Note the principal: the HOST maintenance session, not the poppy's. AuditPoppy's own
    // manifest DOES grant lambda:RemovePermission on its function, which is why its in-app
    // teardown succeeded while certification failed — certify deletes stacks with the host's
    // credentials. So a poppy's manifest can never cover this gap; only this policy can.
    expect(grantedActions.has("lambda:RemovePermission")).toBe(true);
  });

  it("grants the OTHER two the same run needed — the fix was three actions, not one", () => {
    // The 09-07 diagnosis named lambda:RemovePermission alone, off a grep that only read the
    // `lambda:` lines of this policy. The retry then stranded on three resources at once, and
    // each mapped to an action this list did not carry. Fixing one third of a gap costs a whole
    // deploy-use-certify cycle to discover, so they are pinned together.
    //
    // Isolated by controlled comparison rather than inference: the same DELETE_FAILED stack was
    // then deleted successfully by AuditPoppy's OWN session, in the same account. Both principals
    // hold dynamodb:DeleteTable and only one holds DescribeTable, which is what singles the poll
    // out — the delete was always authorised; observing it finish was not.
    expect(grantedActions.has("s3:DeleteBucketPolicy")).toBe(true);
    expect(grantedActions.has("dynamodb:DescribeTable")).toBe(true);
  });

  it("can delete an execution role — the shape almost every poppy has", () => {
    // Found certifying com.auditpoppy.desktop, 2026-09-10, one merge after the last two gaps:
    //
    //   User: ...assumed-role/AgentsPoppyBroker/AgentsPoppyHost-maintenance is not authorized to
    //   perform: iam:DeleteRolePolicy on resource: role AuditPoppyStack-snapshot-role because no
    //   session policy allows the iam:DeleteRolePolicy action (403)
    //
    // A poppy's OWN session can do this — AuditPoppy grants itself exactly these on its own role
    // — and it still did not save the run, because service.teardown() issues DeleteStack itself
    // after running the hook, so the host's credentials end up driving the deletion either way.
    // A poppy cannot cover this gap however well-behaved its teardown hook is.
    for (const action of ["iam:DeleteRolePolicy", "iam:DeleteRole"]) {
      expect(grantedActions.has(action), `${action} — every poppy with compute has a role`).toBe(true);
    }
  });

  it("scopes every MUTATING IAM action to a TAGGED role, never account-wide", () => {
    // The review's decision (2026-09-10): I2 — the host acts on what carries the poppy's tag —
    // holds wherever it can, and for IAM it can. These are the only mutating IAM powers the host
    // session has, so an unconditioned version would be the widest thing in the file.
    const mutating = ["iam:DeleteRolePolicy", "iam:DetachRolePolicy", "iam:DeleteRole"];
    for (const st of statements()) {
      const found = st.Action.filter((a) => mutating.includes(a));
      if (found.length === 0) continue;
      if (st.Sid === "HostRoleTeardownDetachTarget") continue; // the policy half, asserted below
      expect(tagPresent(st), `${st.Sid} grants ${found.join(", ")} without requiring the tag`).toBe(true);
      expect(String(st.Resource), `${st.Sid} must be scoped to roles`).toMatch(/^arn:aws:iam::\*:role\/\*$/);
    }
  });

  it("leaves the IAM READS unconditioned — a tagged read of a deleted role is AccessDenied", () => {
    // The subtle one, and it would have cost a whole certify cycle to find. Null "false" needs
    // the tag key present in the REQUEST CONTEXT, which needs a resource to read it from.
    // CloudFormation reads the role back after DeleteRole to confirm it is gone — no role, no
    // tag context, so a tagged condition cannot match and the read-back returns AccessDenied
    // where NoSuchEntity was the success signal. The stack strands on the last step of its own
    // successful deletion. A read widens nothing, so the condition buys nothing and costs that.
    const reads = ["iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies"];
    for (const action of reads) {
      const carriers = statements().filter((st) => st.Action.includes(action));
      expect(carriers.length, `${action} is granted nowhere`).toBeGreaterThan(0);
      for (const st of carriers) {
        expect(tagPresent(st), `${st.Sid} tag-conditions ${action} — it must not`).toBe(false);
        expect(String(st.Resource), `${st.Sid} still scopes ${action} to roles`).toMatch(/^arn:aws:iam::\*:role\/\*$/);
      }
    }
  });

  it("still authorizes the POLICY side of DetachRolePolicy, which can never carry the tag", () => {
    // An execution role's managed policy is normally AWS-managed —
    // arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole and friends — and those
    // carry no agentspoppy:app tag and never will. If the tagged statement were the only grant,
    // the condition would deny the whole call and strand the stack on the commonest shape there
    // is. Removing this statement without checking IAM's resource model re-opens exactly that.
    const detach = (MAINTENANCE_POLICY_STATEMENTS as readonly { Sid: string; Action: readonly string[]; Resource: string | readonly string[] }[])
      .filter((st: { Action: readonly string[] }) => st.Action.includes("iam:DetachRolePolicy"))
      .flatMap((st) => (Array.isArray(st.Resource) ? st.Resource : [st.Resource]));
    expect(detach).toContain("arn:aws:iam::aws:policy/*");
    expect(detach).toContain("arn:aws:iam::*:policy/*");
  });

  it("keeps the read-shaped actions that deletion depends on — do not tidy these away", () => {
    // The recurring failure mode this file exists to prevent: a least-privilege pass reads an
    // action with a non-Delete name as unused and removes it, and teardown breaks for a whole
    // class of poppy months later, in a customer's account, as a DELETE_FAILED nobody can act on.
    for (const action of [
      "events:RemoveTargets",
      "lambda:RemovePermission",
      "dynamodb:DescribeTable",
      // The IAM reads belong here for the same reason: CloudFormation calls them while deleting,
      // and a least-privilege pass reading them as "not a Delete*" removes them.
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
    ]) {
      expect(grantedActions.has(action), `${action} is load-bearing at delete time`).toBe(true);
    }
  });
});

describe("classifyAssumeFailure", () => {
  it("reads a dead/propagating key as dead-key", () => {
    expect(classifyAssumeFailure(new Error("InvalidClientTokenId: The security token included is invalid"))).toBe(
      "dead-key",
    );
    expect(classifyAssumeFailure(new Error("The security token included in the request is expired"))).toBe(
      "dead-key",
    );
  });

  it("reads an authorization refusal as denied", () => {
    expect(classifyAssumeFailure(new Error("User: ... is not authorized to perform: sts:AssumeRole"))).toBe(
      "denied",
    );
    expect(classifyAssumeFailure(new Error("AccessDenied"))).toBe("denied");
  });

  it("reads anything else (throttle, network) as transient", () => {
    expect(classifyAssumeFailure(new Error("Rate exceeded"))).toBe("transient");
    expect(classifyAssumeFailure(new Error("socket hang up"))).toBe("transient");
    expect(classifyAssumeFailure(undefined)).toBe("transient");
  });
});

describe("who signs with the raw operator key", () => {
  // The gap nothing asserted, found 2026-09-10 certifying AuditPoppy: template v4 stripped the
  // operator key to assume-only (docs/specs/operator-key-least-privilege.md), the CloudFormation
  // provider moved to the maintenance session, and tagging.ts and deletion.ts did not — so on
  // every v4 account the leaves-no-trace sweep was refused in every region and the host's
  // residual cleanup silently did nothing, from v4 until this test existed. The spec names the
  // two consumers that MUST stay on the raw key: the vend's own first hop (sts.ts) and the
  // GetCallerIdentity probe (identity.ts). Everything else in the admin plane signs with
  // maintenanceCredentials(), and the next consumer added here fails in CI, not in a customer's
  // account.
  const AWS_DIR = fileURLToPath(new URL(".", import.meta.url));
  const callers = () =>
    readdirSync(AWS_DIR)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      // Call sites only — `function operatorCredentials()` in credentials.ts is the definition.
      .filter((f) => /(?<!function )\boperatorCredentials\(\)/.test(readFileSync(join(AWS_DIR, f), "utf8")))
      .sort();

  it("is exactly the two the spec exempts, plus the key's own module and the session that derives from it", () => {
    expect(callers()).toEqual([
      "bootstrap.ts", // the setup gateway's WRITE side (elevated keys, or the operator key on pre-v4); its read side already takes the session via identity.ts
      "identity.ts", // GetCallerIdentity: the probe that says WHOSE key this is
      "maintenance.ts", // mints the session FROM the key — the one place the key must sign
      "sts.ts", // the vend's hop 1 — it IS the operator's retained v4 power
    ]);
  });

  it("the sweep and the deletion engine sign with the maintenance session", () => {
    for (const f of ["tagging.ts", "deletion.ts", "cloudformation.ts", "existence.ts", "cloudtrail.ts"]) {
      const src = readFileSync(join(AWS_DIR, f), "utf8");
      expect(src, `${f} must not sign with the raw operator key`).not.toMatch(/\boperatorCredentials\(\)/);
      expect(src, `${f} must sign with the maintenance session`).toMatch(/\bmaintenanceCredentials\(\)/);
    }
  });
});
