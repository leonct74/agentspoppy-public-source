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

/**
 * The bootstrap template's version, surfaced as a stack Output so the app can tell a user
 * their broker role is out of date. Nothing else records what is deployed: without this,
 * "re-apply setup" is a button nobody knows to press.
 *
 * Bump on ANY change to the role, the operator, or the guardrails. A version that cannot be
 * read must be treated as UNKNOWN and prompt the same as out-of-date — a re-apply is an
 * idempotent UpdateStack, so a needless one costs nothing while a missed one leaves a user
 * without a guardrail they believe they have.
 */
export const TEMPLATE_VERSION = 5;

/** The permissions boundary that caps any role a poppy creates. */
export const BOUNDARY_POLICY_NAME = "AgentsPoppyBoundary";

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
export function trustPolicy(
  operatorAccountId: string,
  roleName: string = DEFAULT_ROLE_NAME,
  operatorName: string = DEFAULT_OPERATOR_NAME,
): object {
  const operatorArn = `arn:aws:iam::${operatorAccountId}:user/${operatorName}`;
  const roleArn = `arn:aws:iam::${operatorAccountId}:role/${roleName}`;
  return {
    Version: "2012-10-17",
    Statement: [
      {
        // HOP 1 — the operator's LONG-TERM key, and only that.
        //
        // `aws:PrincipalArn` pins the caller to the operator user (Principal stays the
        // account root, because naming a principal directly binds its internal unique-id
        // and a delete+recreate of the user would then brick the trust permanently; a
        // string condition survives that). `Null aws:TokenIssueTime = true` admits ONLY
        // long-term credentials — that key exists solely for temporary sessions — which is
        // what makes the kill switch terminal: a `GetSessionToken` session (which no policy
        // can forbid) is a temporary credential, so it can never satisfy this and can never
        // enter, and once the underlying access key is deleted nothing is left that can.
        // `sts:SetSourceIdentity` is granted here so a later release can stamp per-device
        // identity (Roles Anywhere needs it too); this release does not send one.
        Sid: "HopOne",
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${operatorAccountId}:root` },
        Action: ["sts:AssumeRole", "sts:TagSession", "sts:SetSourceIdentity"],
        Condition: {
          ArnEquals: { "aws:PrincipalArn": operatorArn },
          Null: { "aws:TokenIssueTime": "true" },
        },
      },
      {
        // HOP 2 — the vend's self-re-assume (role chaining). For an assumed-role session
        // `aws:PrincipalArn` evaluates to the ROLE ARN, never the session ARN (AWS docs are
        // explicit). Widening from "this session" to "any session of the broker role" is
        // safe: the tag-conditioned PoppySessionCannotReAssumeTheBrokerRole Deny is what
        // actually stops a tagged poppy session from re-entering to shed its scope.
        Sid: "HopTwo",
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${operatorAccountId}:root` },
        Action: ["sts:AssumeRole", "sts:TagSession", "sts:SetSourceIdentity"],
        Condition: {
          ArnEquals: { "aws:PrincipalArn": roleArn },
        },
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
      // AgentsPoppy's own three resources, which no brokered app may touch.
      //
      // The BOUNDARY belongs here for the same reason the role does, and the omission was a
      // real hole: once poppy-created roles are capped by AgentsPoppyBoundary, whoever can
      // call iam:CreatePolicyVersion on it can raise the ceiling for every one of them at
      // once — and could poison it NOW, while it is still inert and nothing depends on it,
      // so that the trap is already set when the requirement turns on. A ceiling that the
      // thing beneath it can rewrite is not a ceiling.
      //
      // Denying iam:* (rather than an enumerated list of mutations) is deliberate: an
      // allowlist goes stale the moment AWS adds an action, and this is the policy that
      // protects every other protection. It costs nothing legitimate — attaching a boundary
      // is authorised against the ROLE being created, not against the policy, and nothing in
      // AgentsPoppy reads the boundary at runtime. The bootstrap stack itself is deployed
      // with SETUP credentials, never with this role, so re-applying is unaffected.
      Sid: "CannotTamperWithAgentsPoppy",
      Effect: "Deny",
      Action: ["iam:*"],
      Resource: [
        sub(`arn:aws:iam::\${AWS::AccountId}:role/${roleName}`),
        sub(`arn:aws:iam::\${AWS::AccountId}:user/${operatorName}`),
        sub(`arn:aws:iam::\${AWS::AccountId}:policy/${BOUNDARY_POLICY_NAME}`),
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
      // A poppy session that is granted sts:AssumeRole could otherwise re-assume the broker
      // role itself — arriving with NO session tags and NO session policy, shedding both its
      // attribution and its scope in one call, and landing on the role's full ceiling.
      //
      // The condition is what makes this safe to ship rather than an outage. The broker's
      // own vend is a TWO-HOP chain and hop 2 re-assumes this very role, so a blanket Deny
      // would break every credential AgentsPoppy issues. Hop 1 arrives UNTAGGED, so the key
      // is absent and the Deny does not apply; every poppy session carries agentspoppy:app
      // as a TRANSITIVE tag, which cannot be shed by further chaining, so a poppy can never
      // step outside this condition.
      Sid: "PoppySessionCannotReAssumeTheBrokerRole",
      Effect: "Deny",
      Action: "sts:AssumeRole",
      Resource: sub(`arn:aws:iam::\${AWS::AccountId}:role/${roleName}`),
      Condition: { Null: { "aws:PrincipalTag/agentspoppy:app": "false" } },
    },
    {
      Sid: "CannotDisableAuditLogging",
      Effect: "Deny",
      Action: AUDIT_GUARDRAIL_ACTIONS,
      Resource: "*",
    },
    {
      // broker-role-v2 STEP 3 (template v5, docs/specs/boundary-capped-rating.md): every
      // role a vended credential creates MUST carry the AgentsPoppyBoundary. A create (or a
      // boundary swap) that names any other boundary — or none: StringNotEquals is TRUE when
      // the key is absent, which is exactly the "no boundary at all" request — is refused by
      // IAM itself. This is what lets the rating call a poppy's role creates "capped": a
      // fact AWS enforces, not a word the manifest chose. Landed only once every shipping
      // role-creating poppy referenced the boundary parameter (audited 2026-09-02) — the
      // Deny before the fleet would have rolled back every Lambda deploy in updated accounts.
      Sid: "CreatedRolesMustCarryTheBoundary",
      Effect: "Deny",
      Action: ["iam:CreateRole", "iam:PutRolePermissionsBoundary"],
      Resource: "*",
      Condition: {
        StringNotEquals: {
          "iam:PermissionsBoundary": sub(`arn:aws:iam::\${AWS::AccountId}:policy/${BOUNDARY_POLICY_NAME}`),
        },
      },
    },
    {
      // The other half of "must carry": nothing vended may strip a boundary once it is on.
      // (A stack DELETE removes the role itself and never calls this; a stack UPDATE that
      // clears the parameter would call it and now rolls back — the intended refusal.)
      Sid: "CannotStripTheBoundary",
      Effect: "Deny",
      Action: "iam:DeleteRolePermissionsBoundary",
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
      // The ceiling any poppy-CREATED role may ever reach. A poppy that may create roles
      // named MyPoppy* can otherwise write `*:*` onto one, pass it to a Lambda and invoke
      // it — that Lambda runs as a NEW principal, so none of the Denies below apply to it,
      // and the role carries no attribution tag so teardown never sees it. It survives
      // revoking the connection. A permissions boundary is AWS's own answer: it caps the
      // role regardless of what policies are later attached, which is also why no Deny on
      // "attaching a policy that grants *:*" appears below — IAM cannot inspect a policy
      // document's CONTENTS in a condition, only its ARN.
      //
      // REQUIRED since template v5 (broker-role-v2 step 3): the guardrail
      // CreatedRolesMustCarryTheBoundary refuses any vended CreateRole that does not name
      // this policy. It stayed deliberately inert through v3/v4 until every shipping
      // role-creating poppy referenced it (audited 2026-09-02) — the policy had to EXIST
      // before anything referenced it, and nothing could REQUIRE it until everything did.
      // See docs/specs/broker-role-v2.md and docs/specs/boundary-capped-rating.md.
      AgentsPoppyBoundary: {
        Type: "AWS::IAM::ManagedPolicy",
        Properties: {
          ManagedPolicyName: BOUNDARY_POLICY_NAME,
          Description:
            "AgentsPoppy: the ceiling for any IAM role an app creates in this account. Capped at what the broker role itself may do, minus the guardrails.",
          PolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              { Sid: "BoundedAccess", Effect: "Allow", Action: "*", Resource: "*" },
              // The boundary repeats the role's guardrails, because a boundary is evaluated
              // independently: a Deny written on the broker role does NOT apply to a role
              // the broker created. Repeating them here is what stops a created role being
              // used to do the very things the guardrails exist to prevent.
              ...guardrailStatements(roleName, operatorName),
            ],
          },
        },
      },
      AgentsPoppyOperator: {
        Type: "AWS::IAM::User",
        Properties: {
          UserName: operatorName,
          Policies: [
            {
              PolicyName: "AgentsPoppyOperatorAccess",
              PolicyDocument: {
                Version: "2012-10-17",
                // Template v4 (docs/specs/operator-key-least-privilege.md): the operator user
                // is ASSUME-ONLY. Its former account-wide monitoring + cleanup powers
                // (MonitorAndTeardown, HostResidualCleanup) sat OUTSIDE every Deny guardrail —
                // a stolen key could delete stacks and buckets without ever touching the role.
                // Those two statements moved to the broker role's SESSION POLICY
                // (packages/broker/src/aws/maintenance.ts): identical effective permissions for
                // the host, but now every use passes the guarded door. What is left here is the
                // single choke point (assume the broker role), the identity probe, and the
                // self-revoke that powers the kill switch.
                Statement: [
                  {
                    Sid: "AssumeBrokerRole",
                    Effect: "Allow",
                    // SetSourceIdentity is required in the caller's own policy (as well as the
                    // trust policy) for a later release to stamp a source identity on hop 1.
                    Action: ["sts:AssumeRole", "sts:SetSourceIdentity"],
                    Resource: brokerRoleArn,
                  },
                  { Sid: "WhoAmI", Effect: "Allow", Action: "sts:GetCallerIdentity", Resource: "*" },
                  {
                    // The kill switch: the operator may delete its OWN access key — nothing
                    // else. Self-DoS only: no iam:CreateAccessKey is granted anywhere, so a
                    // deleted key can never be replaced except by re-running setup with elevated
                    // credentials. It stays a DIRECT operator call because through the broker
                    // role it would (correctly) be refused by CannotTamperWithAgentsPoppy; the
                    // operator user carries no boundary and no Deny, so this one Allow is enough.
                    Sid: "SelfRevoke",
                    Effect: "Allow",
                    Action: "iam:DeleteAccessKey",
                    Resource: sub(`arn:aws:iam::\${AWS::AccountId}:user/${operatorName}`),
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
          AssumeRolePolicyDocument: trustPolicy(input.operatorAccountId, roleName, operatorName),
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
      TemplateVersion: {
        Description: "AgentsPoppy uses this to tell you when your broker role needs updating.",
        Value: String(TEMPLATE_VERSION),
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
