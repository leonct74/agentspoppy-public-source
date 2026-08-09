// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Pure generator for the one-time bootstrap CloudFormation template.
 *
 * It provisions two things in the user's account, and **requires admin only to
 * deploy it once, in the AWS console** — AgentsPoppy itself never has, asks for,
 * or can use admin:
 *
 *  1. **AgentsPoppyBroker** — the role AgentsPoppy assumes to vend each app
 *     scoped, short-lived credentials. It is broad enough that apps "just work"
 *     without re-deploying, but carries a hard **guardrail**: it can never manage
 *     IAM users, account/org settings, disable the account's CloudTrail audit
 *     logging, or tamper with AgentsPoppy itself — so no connected app (or bug)
 *     can ever lock the owner out, escalate to admin, or blind the activity log.
 *     Each app is still narrowed to exactly what it requested via a per-session
 *     policy at vend time (see policy.ts) — the role is only the ceiling.
 *
 *  2. **AgentsPoppyOperator** — a deliberately powerless IAM user whose only
 *     abilities are: assume the broker role, read its own identity, and
 *     list/describe/delete the CloudFormation stacks apps create (for the
 *     inventory + teardown views). This is the identity that lives on the user's
 *     machine; it is NOT admin and cannot do anything beyond brokering.
 *
 * Pure and unit-tested; no AWS SDK.
 */

export const DEFAULT_ROLE_NAME = "AgentsPoppyBroker";
export const DEFAULT_OPERATOR_NAME = "AgentsPoppyOperator";

/** A CloudFormation policy statement — looser than the runtime one (allows intrinsics). */
interface CfnStatement {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Action: string | string[];
  Resource: string | string[] | object;
  Condition?: object;
}

export interface RoleTemplateInput {
  /** AWS account the bootstrap is for (the operator's own account). */
  operatorAccountId: string;
  roleName?: string;
  operatorName?: string;
}

/**
 * The lockout/escalation guardrail: IAM-identity and account/org control that no
 * brokered app may ever exercise, however wide its other access. An explicit
 * Deny always wins, so this holds even against a bug in the per-app scoping.
 */
const GUARDRAIL_ACTIONS = [
  // Managing IAM users or their sign-in/credentials — the lockout + escalation surface.
  "iam:CreateUser",
  "iam:DeleteUser",
  "iam:UpdateUser",
  "iam:CreateLoginProfile",
  "iam:UpdateLoginProfile",
  "iam:DeleteLoginProfile",
  "iam:CreateAccessKey",
  "iam:UpdateAccessKey",
  "iam:DeleteAccessKey",
  "iam:AttachUserPolicy",
  "iam:DetachUserPolicy",
  "iam:PutUserPolicy",
  "iam:DeleteUserPolicy",
  "iam:AddUserToGroup",
  "iam:RemoveUserFromGroup",
  // MFA tampering.
  "iam:CreateVirtualMFADevice",
  "iam:DeleteVirtualMFADevice",
  "iam:EnableMFADevice",
  "iam:DeactivateMFADevice",
  "iam:ResyncMFADevice",
  // Account-wide controls.
  "iam:UpdateAccountPasswordPolicy",
  "iam:CreateAccountAlias",
  "iam:DeleteAccountAlias",
  "account:*",
  "organizations:*",
];

/**
 * The "keys to the kingdom" AWS-managed policies. Attaching any of these to a
 * principal an app controls (a role or group it created) would let it escape its
 * brokered ceiling and act as admin — classic privilege escalation. The lockout
 * set above already forbids attaching policies to IAM *users*; this closes the
 * equivalent path via roles and groups.
 */
const ESCALATION_ADMIN_POLICY_ARNS = [
  "arn:aws:iam::aws:policy/AdministratorAccess",
  "arn:aws:iam::aws:policy/IAMFullAccess",
  "arn:aws:iam::aws:policy/PowerUserAccess",
];

/** Attach actions that, paired with an admin policy ARN, would escalate privileges. */
const ESCALATION_ATTACH_ACTIONS = [
  "iam:AttachRolePolicy",
  "iam:AttachGroupPolicy",
  // Also covered wholesale by the lockout set, but listed here for defence in depth.
  "iam:AttachUserPolicy",
];

/**
 * The audit-logging tamper surface: actions that could stop, delete, or
 * reconfigure CloudTrail (or its Lake event data stores) and thereby blind
 * AgentsPoppy's "activity that did NOT go through AgentsPoppy" detection. No
 * brokered app may ever exercise these, however wide its other access — otherwise
 * a connected poppy could simply turn off the logging that would expose it.
 */
const AUDIT_GUARDRAIL_ACTIONS = [
  "cloudtrail:StopLogging",
  "cloudtrail:DeleteTrail",
  "cloudtrail:UpdateTrail",
  "cloudtrail:PutEventSelectors",
  "cloudtrail:DeleteEventDataStore",
  "cloudtrail:UpdateEventDataStore",
];

/** Trust policy: the operator's own account may assume the role and tag the session. */
export function trustPolicy(operatorAccountId: string): object {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${operatorAccountId}:root` },
        Action: ["sts:AssumeRole", "sts:TagSession"],
      },
    ],
  };
}

/** Sub helper for an ARN inside the user's account. */
function sub(value: string): object {
  return { "Fn::Sub": value };
}

/** The broker role's deny guardrail (lockout-proof + tamper-proof). */
export function guardrailStatements(roleName: string, operatorName: string): CfnStatement[] {
  return [
    {
      Sid: "CannotManageIamUsersOrAccount",
      Effect: "Deny",
      Action: GUARDRAIL_ACTIONS,
      Resource: "*",
    },
    {
      Sid: "CannotTamperWithAgentsPoppy",
      Effect: "Deny",
      Action: ["iam:*"],
      Resource: [
        sub(`arn:aws:iam::\${AWS::AccountId}:role/${roleName}`),
        sub(`arn:aws:iam::\${AWS::AccountId}:user/${operatorName}`),
      ],
    },
    {
      // Privilege-escalation guardrail: even an app that legitimately creates its
      // own roles can never attach an account-admin policy to one. Conditioned on
      // the policy ARN, so attaching ordinary least-privilege managed policies
      // still works — only the three "keys to the kingdom" are blocked.
      Sid: "CannotAttachAdminPolicies",
      Effect: "Deny",
      Action: ESCALATION_ATTACH_ACTIONS,
      Resource: "*",
      Condition: { ArnEquals: { "iam:PolicyARN": ESCALATION_ADMIN_POLICY_ARNS } },
    },
    {
      Sid: "CannotDisableAuditLogging",
      Effect: "Deny",
      Action: AUDIT_GUARDRAIL_ACTIONS,
      Resource: "*",
    },
  ];
}

/** The full CloudFormation template (as an object): broker role + minimal operator. */
export function roleCloudFormationTemplate(input: RoleTemplateInput): object {
  const roleName = input.roleName ?? DEFAULT_ROLE_NAME;
  const operatorName = input.operatorName ?? DEFAULT_OPERATOR_NAME;
  const brokerRoleArn = sub(`arn:aws:iam::\${AWS::AccountId}:role/${roleName}`);

  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description:
      "AgentsPoppy bootstrap — a broker role (assumed locally to vend scoped, short-lived credentials to your apps) plus a minimal, NON-admin operator. AgentsPoppy never uses admin: deploy this once, create an access key for the operator, and point AgentsPoppy at it.",
    Resources: {
      AgentsPoppyOperator: {
        Type: "AWS::IAM::User",
        Properties: {
          UserName: operatorName,
          Policies: [
            {
              PolicyName: "AgentsPoppyOperatorAccess",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  { Sid: "AssumeBrokerRole", Effect: "Allow", Action: "sts:AssumeRole", Resource: brokerRoleArn },
                  { Sid: "WhoAmI", Effect: "Allow", Action: "sts:GetCallerIdentity", Resource: "*" },
                  {
                    Sid: "MonitorAndTeardown",
                    Effect: "Allow",
                    Action: [
                      "cloudformation:ListStacks",
                      "cloudformation:DescribeStacks",
                      "cloudformation:DescribeStackResources",
                      // Read-only: lets the infra map read a stack's resources (so they
                      // read authoritatively "present", not a CloudTrail "verifying") and
                      // its template (so it can draw the dependency edges between services).
                      "cloudformation:ListStackResources",
                      "cloudformation:GetTemplate",
                      "cloudformation:DeleteStack",
                      "tag:GetResources",
                      // Read recent management events to surface account activity that
                      // did NOT go through AgentsPoppy (free CloudTrail Event history).
                      "cloudtrail:LookupEvents",
                    ],
                    Resource: "*",
                  },
                  {
                    // The host-side residual deletion engine: after (or instead of) a poppy's
                    // own cleanup, the HOST deletes what the tag sweep still attributes to it —
                    // the guarantee that teardown completes even for a revoked/blocked poppy.
                    // Unconditioned by design: several of these actions don't (reliably)
                    // support aws:ResourceTag conditions, and a condition that silently fails
                    // to authorize means orphaned, billable resources — the exact failure this
                    // engine exists to prevent. The real safety control is in code: the engine
                    // only ever targets resources the tag sweep attributed to a poppy, and
                    // re-reads the live tag immediately before every deletion.
                    Sid: "HostResidualCleanup",
                    Effect: "Allow",
                    Action: [
                      // The *TagResource-read actions are the engine's LIVE pre-delete tag
                      // check — fresher than the eventually-consistent tag index the sweep
                      // uses, so a just-untagged/retagged resource is never deleted.
                      "s3:GetBucketTagging",
                      "s3:ListBucketVersions",
                      "s3:DeleteObject",
                      "s3:DeleteObjectVersion",
                      "s3:DeleteBucket",
                      "dynamodb:ListTagsOfResource",
                      "dynamodb:UpdateTable",
                      "dynamodb:DeleteTable",
                      "cognito-idp:ListTagsForResource",
                      "cognito-idp:DescribeUserPool",
                      "cognito-idp:DeleteUserPoolDomain",
                      "cognito-idp:DeleteUserPool",
                      "lambda:ListTags",
                      "lambda:DeleteFunction",
                      "logs:ListTagsForResource",
                      "logs:DeleteLogGroup",
                      "ses:DeleteIdentity",
                      "ses:DescribeActiveReceiptRuleSet",
                      "ses:SetActiveReceiptRuleSet",
                      "ses:DeleteReceiptRuleSet",
                      // EventBridge rules (first needed by CrewPoppy's schedule ticker,
                      // 2026-07-29: its certify teardown DELETE_FAILED on the rule).
                      // Same shape as every service above: the tag/describe reads are the
                      // live pre-delete check, targets must be removed before a rule can go.
                      "events:ListTagsForResource",
                      "events:DescribeRule",
                      "events:ListTargetsByRule",
                      "events:RemoveTargets",
                      "events:DeleteRule",
                    ],
                    Resource: "*",
                  },
                ],
              },
            },
          ],
        },
      },
      AgentsPoppyRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          RoleName: roleName,
          MaxSessionDuration: 3600,
          AssumeRolePolicyDocument: trustPolicy(input.operatorAccountId),
          Policies: [
            {
              PolicyName: "AgentsPoppyBrokeredAccess",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  // Broad ceiling so apps work without re-deploying; each app is
                  // narrowed to its own request at vend time via a session policy.
                  { Sid: "BrokeredAccess", Effect: "Allow", Action: "*", Resource: "*" },
                  ...guardrailStatements(roleName, operatorName),
                ],
              },
            },
          ],
        },
      },
    },
    Outputs: {
      BrokerRoleArn: {
        Description: "Paste this value into AgentsPoppy to finish connecting the account.",
        Value: { "Fn::GetAtt": ["AgentsPoppyRole", "Arn"] },
      },
      OperatorUserName: {
        Description:
          "The NON-admin operator. In IAM, create an access key for this user and run `aws configure` with it — never your admin keys.",
        Value: { Ref: "AgentsPoppyOperator" },
      },
    },
  };
}

/** The CloudFormation template, pretty-printed JSON ready to copy/deploy. */
export function roleTemplateJson(input: RoleTemplateInput): string {
  return JSON.stringify(roleCloudFormationTemplate(input), null, 2);
}
