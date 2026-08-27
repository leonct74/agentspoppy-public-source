// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { guardrailStatements, roleCloudFormationTemplate, TEMPLATE_VERSION, roleTemplateJson, trustPolicy } from "./role-template";

describe("trustPolicy", () => {
  it("lets the operator's account assume the role and tag the session", () => {
    const tp = trustPolicy("123456789012") as {
      Statement: { Principal: { AWS: string }; Action: string[] }[];
    };
    expect(tp.Statement[0]?.Principal.AWS).toBe("arn:aws:iam::123456789012:root");
    expect(tp.Statement[0]?.Action).toContain("sts:AssumeRole");
    expect(tp.Statement[0]?.Action).toContain("sts:TagSession");
  });
});

describe("guardrailStatements", () => {
  it("denies the IAM-user / account lockout + escalation surface", () => {
    const [lockout] = guardrailStatements("AgentsPoppyBroker", "AgentsPoppyOperator");
    expect(lockout?.Effect).toBe("Deny");
    expect(lockout?.Action).toContain("iam:DeleteUser");
    expect(lockout?.Action).toContain("iam:CreateAccessKey");
    expect(lockout?.Action).toContain("iam:DetachUserPolicy");
    expect(lockout?.Action).toContain("organizations:*");
  });

  it("denies tampering with AgentsPoppy's own role + operator", () => {
    const [, tamper] = guardrailStatements("AgentsPoppyBroker", "AgentsPoppyOperator");
    expect(tamper?.Effect).toBe("Deny");
    expect(tamper?.Action).toEqual(["iam:*"]);
    expect(JSON.stringify(tamper?.Resource)).toContain("role/AgentsPoppyBroker");
    expect(JSON.stringify(tamper?.Resource)).toContain("user/AgentsPoppyOperator");
  });

  it("denies attaching account-admin policies to any role/group an app controls (escalation)", () => {
    const escalation = guardrailStatements("AgentsPoppyBroker", "AgentsPoppyOperator")[2];
    expect(escalation?.Sid).toBe("CannotAttachAdminPolicies");
    expect(escalation?.Effect).toBe("Deny");
    expect(escalation?.Action).toContain("iam:AttachRolePolicy");
    expect(escalation?.Action).toContain("iam:AttachGroupPolicy");
    // Conditioned on the policy ARN, so ordinary least-privilege managed policies still attach.
    const cond = JSON.stringify(escalation?.Condition);
    expect(cond).toContain("iam:PolicyARN");
    expect(cond).toContain("policy/AdministratorAccess");
    expect(cond).toContain("policy/IAMFullAccess");
    expect(cond).toContain("policy/PowerUserAccess");
  });

  it("denies disabling CloudTrail audit logging (so a poppy can't blind the activity log)", () => {
    // Found BY Sid, not by position: indexing broke the moment a guardrail was inserted
    // ahead of it, and a positional test on a security guardrail fails for a reason that
    // has nothing to do with the guardrail.
    const audit = guardrailStatements("AgentsPoppyBroker", "AgentsPoppyOperator").find(
      (s) => s.Sid === "CannotDisableAuditLogging",
    );
    expect(audit?.Sid).toBe("CannotDisableAuditLogging");
    expect(audit?.Effect).toBe("Deny");
    expect(audit?.Action).toContain("cloudtrail:StopLogging");
    expect(audit?.Action).toContain("cloudtrail:DeleteTrail");
    expect(audit?.Action).toContain("cloudtrail:UpdateTrail");
    expect(audit?.Action).toContain("cloudtrail:PutEventSelectors");
  });
});

describe("roleCloudFormationTemplate", () => {
  it("provisions a broker role (wide + guardrail) and a minimal operator, with outputs", () => {
    const tpl = roleCloudFormationTemplate({ operatorAccountId: "123456789012" }) as Record<string, unknown>;
    const resources = tpl.Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>;

    expect(resources.AgentsPoppyRole?.Type).toBe("AWS::IAM::Role");
    expect(resources.AgentsPoppyRole?.Properties.RoleName).toBe("AgentsPoppyBroker");
    expect(resources.AgentsPoppyOperator?.Type).toBe("AWS::IAM::User");

    const outputs = tpl.Outputs as { BrokerRoleArn: { Value: unknown }; OperatorUserName: { Value: unknown } };
    expect(outputs.BrokerRoleArn.Value).toEqual({ "Fn::GetAtt": ["AgentsPoppyRole", "Arn"] });
    expect(outputs.OperatorUserName.Value).toEqual({ Ref: "AgentsPoppyOperator" });
  });

  it("serialises to valid JSON that carries the wide allow + the guardrail", () => {
    const json = roleTemplateJson({ operatorAccountId: "123456789012" });
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json).toContain('"BrokeredAccess"');
    expect(json).toContain('"CannotManageIamUsersOrAccount"');
    expect(json).toContain('"CannotAttachAdminPolicies"');
    expect(json).toContain('"CannotDisableAuditLogging"');
    // The operator can only assume + monitor, never act as admin.
    expect(json).toContain("sts:AssumeRole");
    expect(json).toContain("cloudformation:DeleteStack");
  });

  it("keeps the operator minimal — it never gains any iam:* permission of its own", () => {
    const tpl = roleCloudFormationTemplate({ operatorAccountId: "123456789012" }) as Record<string, unknown>;
    const resources = tpl.Resources as Record<string, { Properties: Record<string, unknown> }>;
    const op = resources.AgentsPoppyOperator?.Properties as {
      Policies: { PolicyDocument: { Statement: { Action: string | string[] }[] } }[];
    };
    const actions = op.Policies[0]!.PolicyDocument.Statement.flatMap((s) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    );
    // Per-connection scope policies are created within a bounded broker-role session,
    // not by the operator — so the operator stays powerless (assume + monitor only).
    expect(actions.some((a) => a.startsWith("iam:"))).toBe(false);
  });
});

// Fault A, step 1 (docs/specs/broker-role-v2.md). A poppy that may create IAM roles can
// write `*:*` onto one, pass it to a Lambda and invoke it — that Lambda runs as a NEW
// principal, so none of the broker role's Denies reach it, and the role carries no
// attribution tag so teardown never sees it. It outlives revoking the connection.
describe("broker role v2 — the escalation groundwork", () => {
  const tpl = () => roleCloudFormationTemplate({ operatorAccountId: "111122223333" }) as any;

  it("ships the permissions boundary, so a poppy template can reference it", () => {
    const b = tpl().Resources.AgentsPoppyBoundary;
    expect(b.Type).toBe("AWS::IAM::ManagedPolicy");
    expect(b.Properties.ManagedPolicyName).toBe("AgentsPoppyBoundary");
  });

  // A boundary is evaluated independently of the role that created the role, so a Deny
  // written on the broker role does NOT reach a role the broker made. If the boundary did
  // not repeat them, a created role could do the very things the guardrails exist to stop.
  it("repeats the guardrails inside the boundary, not just the wide allow", () => {
    const sids = tpl().Resources.AgentsPoppyBoundary.Properties.PolicyDocument.Statement.map(
      (s: any) => s.Sid,
    );
    for (const guard of ["CannotManageIamUsersOrAccount", "CannotTamperWithAgentsPoppy", "CannotDisableAuditLogging"]) {
      expect(sids, guard).toContain(guard);
    }
  });

  // Step 1 must break nothing. A Deny on unbounded CreateRole would stop three shipping
  // poppies deploying; the boundary only becomes mandatory once every poppy references it.
  it("does NOT yet require the boundary — nothing may depend on it in this step", () => {
    const json = JSON.stringify(tpl());
    expect(json).not.toContain("iam:PermissionsBoundary");
  });

  it("surfaces a template version, so the app can tell a user theirs is stale", () => {
    expect(tpl().Outputs.TemplateVersion.Value).toBe(String(TEMPLATE_VERSION));
    expect(TEMPLATE_VERSION).toBeGreaterThanOrEqual(2);
  });

  // The broker's OWN vend is a two-hop chain whose second hop re-assumes this very role, so
  // an unconditioned Deny here would break every credential AgentsPoppy issues. Hop 1
  // arrives untagged; every poppy session carries agentspoppy:app transitively and so can
  // never step outside the condition.
  it("stops a poppy session re-assuming the broker role, without breaking hop 2", () => {
    const deny = guardrailStatements("AgentsPoppyBroker", "AgentsPoppyOperator").find(
      (s) => s.Sid === "PoppySessionCannotReAssumeTheBrokerRole",
    )!;
    expect(deny.Effect).toBe("Deny");
    expect(deny.Action).toBe("sts:AssumeRole");
    // "the tag is NOT null" — i.e. only a session already carrying it is denied.
    expect(deny.Condition).toEqual({ Null: { "aws:PrincipalTag/agentspoppy:app": "false" } });
  });
});
