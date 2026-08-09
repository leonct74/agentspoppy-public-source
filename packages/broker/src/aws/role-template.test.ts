// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { guardrailStatements, roleCloudFormationTemplate, roleTemplateJson, trustPolicy } from "./role-template";

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
    const audit = guardrailStatements("AgentsPoppyBroker", "AgentsPoppyOperator")[3];
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
