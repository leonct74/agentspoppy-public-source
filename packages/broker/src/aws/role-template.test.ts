// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import {
  BOUNDARY_POLICY_NAME,
  guardrailStatements,
  roleCloudFormationTemplate,
  TEMPLATE_VERSION,
  roleTemplateJson,
  trustPolicy,
} from "./role-template";

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

  it("denies tampering with AgentsPoppy's own role + operator + boundary", () => {
    const [, tamper] = guardrailStatements("AgentsPoppyBroker", "AgentsPoppyOperator");
    expect(tamper?.Effect).toBe("Deny");
    expect(tamper?.Action).toEqual(["iam:*"]);
    expect(JSON.stringify(tamper?.Resource)).toContain("role/AgentsPoppyBroker");
    expect(JSON.stringify(tamper?.Resource)).toContain("user/AgentsPoppyOperator");
    // The boundary is the ceiling on every role a poppy creates. If the thing beneath a
    // ceiling can rewrite it, it is not a ceiling — and it could be poisoned NOW, while
    // still inert, so the trap is already set when step 3 turns the requirement on.
    expect(JSON.stringify(tamper?.Resource)).toContain(`policy/${BOUNDARY_POLICY_NAME}`);
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
    // Template v4: the operator is assume-only — its former direct cloudformation:DeleteStack
    // (and the whole cleanup set) moved to the broker role's session policy
    // (docs/specs/operator-key-least-privilege.md), so it must NO LONGER appear on the user.
    expect(json).toContain("sts:AssumeRole");
    const tpl = roleCloudFormationTemplate({ operatorAccountId: "123456789012" }) as {
      Resources: Record<string, { Type: string; Properties: { Policies?: { PolicyDocument: unknown }[] } }>;
    };
    const opDoc = JSON.stringify(tpl.Resources.AgentsPoppyOperator!.Properties.Policies![0]!.PolicyDocument);
    expect(opDoc).not.toContain("cloudformation:DeleteStack");
    expect(opDoc).not.toContain("s3:DeleteBucket");
  });

  it("keeps the operator ASSUME-ONLY — its only iam power is self-revoke of its own key", () => {
    const tpl = roleCloudFormationTemplate({ operatorAccountId: "123456789012" }) as Record<string, unknown>;
    const resources = tpl.Resources as Record<string, { Properties: Record<string, unknown> }>;
    const op = resources.AgentsPoppyOperator?.Properties as {
      Policies: { PolicyDocument: { Statement: { Sid?: string; Action: string | string[]; Resource: unknown }[] } }[];
    };
    const statements = op.Policies[0]!.PolicyDocument.Statement;
    const actions = statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    // Exactly one iam: action — DeleteAccessKey, the kill switch (self-DoS only). No
    // iam:CreateAccessKey anywhere, so a revoked key can never be replaced except by re-setup.
    const iamActions = actions.filter((a) => a.startsWith("iam:"));
    expect(iamActions).toEqual(["iam:DeleteAccessKey"]);
    // And it is scoped to the operator's OWN user, not "*".
    const selfRevoke = statements.find((s) => s.Sid === "SelfRevoke")!;
    expect(JSON.stringify(selfRevoke.Resource)).toContain("user/AgentsPoppyOperator");
    // The cleanup/monitor set is gone from the user entirely.
    expect(actions.some((a) => a.startsWith("cloudformation:") && a !== "sts:AssumeRole")).toBe(false);
  });

  it("v4 trust policy admits the operator's long-term key (HopOne) and the role's self-re-assume (HopTwo)", () => {
    const tpl = roleCloudFormationTemplate({ operatorAccountId: "123456789012" }) as {
      Resources: Record<string, { Type: string; Properties: { AssumeRolePolicyDocument?: { Statement: any[] } } }>;
    };
    const trust = tpl.Resources.AgentsPoppyRole!.Properties.AssumeRolePolicyDocument!;
    const hop1 = trust.Statement.find((s) => s.Sid === "HopOne")!;
    const hop2 = trust.Statement.find((s) => s.Sid === "HopTwo")!;
    // HopOne: pinned to the operator USER arn + long-term-credential-only (TokenIssueTime null),
    // which is what makes key revocation terminal against a pre-minted GetSessionToken session.
    expect(hop1.Condition.ArnEquals["aws:PrincipalArn"]).toContain("user/AgentsPoppyOperator");
    expect(hop1.Condition.Null["aws:TokenIssueTime"]).toBe("true");
    // HopTwo: the vend's role-chaining re-assume — aws:PrincipalArn is the ROLE arn here.
    expect(hop2.Condition.ArnEquals["aws:PrincipalArn"]).toContain("role/AgentsPoppyBroker");
    // Both keep TagSession (the vend stamps tags) and gain SetSourceIdentity.
    for (const s of [hop1, hop2]) {
      expect(s.Action).toContain("sts:TagSession");
      expect(s.Action).toContain("sts:SetSourceIdentity");
    }
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

  // Step 3 (template v5): the boundary is now REQUIRED. Landed only after an audit showed
  // every shipping role-creating poppy already references the parameter (2026-09-02).
  it("requires the boundary on every vended CreateRole — StringNotEquals, so 'no boundary' is refused too", () => {
    const deny = guardrailStatements("AgentsPoppyBroker", "AgentsPoppyOperator").find(
      (s) => s.Sid === "CreatedRolesMustCarryTheBoundary",
    )!;
    expect(deny.Effect).toBe("Deny");
    expect(deny.Action).toEqual(["iam:CreateRole", "iam:PutRolePermissionsBoundary"]);
    const cond = (deny.Condition as any).StringNotEquals["iam:PermissionsBoundary"];
    expect(JSON.stringify(cond)).toContain(`policy/${BOUNDARY_POLICY_NAME}`);
  });

  it("refuses stripping a boundary once it is on", () => {
    const deny = guardrailStatements("AgentsPoppyBroker", "AgentsPoppyOperator").find(
      (s) => s.Sid === "CannotStripTheBoundary",
    )!;
    expect(deny.Effect).toBe("Deny");
    expect(deny.Action).toBe("iam:DeleteRolePermissionsBoundary");
  });

  // The boundary body repeats the guardrails, so a role created UNDER the boundary cannot
  // mint an unbounded role either — the cap is closed from the inside as well.
  it("carries the boundary requirement inside the boundary body too", () => {
    const sids = tpl().Resources.AgentsPoppyBoundary.Properties.PolicyDocument.Statement.map((s: any) => s.Sid);
    expect(sids).toContain("CreatedRolesMustCarryTheBoundary");
    expect(sids).toContain("CannotStripTheBoundary");
  });

  it("ships at or above the version the rating's boundaryEnforced probe requires", () => {
    expect(TEMPLATE_VERSION).toBeGreaterThanOrEqual(5);
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

  // The boundary REPEATS the guardrails (it is evaluated independently of the role that
  // created the role), so a role created under it must be unable to rewrite the boundary
  // either — otherwise the cap is one CreatePolicyVersion away from being lifted from the
  // inside.
  it("protects the boundary from roles created UNDER the boundary too", () => {
    const b = (roleCloudFormationTemplate({ operatorAccountId: "111122223333" }) as any).Resources
      .AgentsPoppyBoundary.Properties.PolicyDocument.Statement;
    const tamper = b.find((s: any) => s.Sid === "CannotTamperWithAgentsPoppy");
    expect(JSON.stringify(tamper.Resource)).toContain(`policy/${BOUNDARY_POLICY_NAME}`);
  });

  // Any change to the role, the operator or the guardrails must move the version, or a
  // user who already deployed the previous shape is told they are up to date while missing
  // the very protection that was added.
  it("moved the template version when the guardrails changed", () => {
    expect(TEMPLATE_VERSION).toBeGreaterThanOrEqual(3);
  });
});
