# AgentsPoppy access policy

The one policy an AgentsPoppy user attaches to their IAM user. It covers the whole
lifecycle — the one-time bootstrap **and** day-to-day operation — so a single user can
do everything without switching credentials.

The one-time bootstrap (Connect your AWS → step 3) deploys a small CloudFormation
template that creates two IAM resources in your account:

- **`AgentsPoppyBroker`** — the role AgentsPoppy *assumes* to vend each app scoped,
  short-lived credentials (broad ceiling + a hard guardrail: no IAM-user/account/org
  control, and it can't disable the account's CloudTrail audit logging).
- **`AgentsPoppyOperator`** — a deliberately non-admin IAM user the bootstrap also creates.
  Since this policy now lets your *own* user assume the broker role and read/teardown the
  account, using the operator user is optional (kept for now for activity attribution).

Creating IAM resources needs elevated permissions. **Use this policy instead of signing
in as account root or with full `AdministratorAccess`** — attach it to the IAM user (or
role) you connect AgentsPoppy with.

- [`agentspoppy-access-policy.json`](./agentspoppy-access-policy.json) — the raw policy
  document (attach as a customer-managed policy).

## What it grants (current scope)

Kept **exactly** in step with the template in
[`packages/broker/src/aws/role-template.ts`](../../packages/broker/src/aws/role-template.ts) —
no gaps, no excess.

| Service | Actions | Why |
|---|---|---|
| STS (`Resource: *`) | `GetCallerIdentity` | Step 1 readiness: confirm the identity resolves |
| CloudFormation on `stack/AgentsPoppy/*` | `CreateStack`, `UpdateStack`, `DeleteStack`, `DescribeStacks`, `DescribeStackEvents`, `DescribeStackResources`, `ListStackResources`, `GetTemplate`, `CreateChangeSet`, `DescribeChangeSet`, `ExecuteChangeSet`, `DeleteChangeSet`, `TagResource` | Deploy / update / delete the bootstrap stack and read its progress |
| CloudFormation (`Resource: *`) | `ValidateTemplate`, `GetTemplateSummary` | The console validates the uploaded template (these don't support resource-level ARNs) |
| IAM on `role/AgentsPoppyBroker` | `CreateRole`, `DeleteRole`, `GetRole`, `UpdateRole`, `UpdateAssumeRolePolicy`, `TagRole`, `UntagRole`, `PutRolePolicy`, `DeleteRolePolicy`, `GetRolePolicy`, `ListRolePolicies`, `ListAttachedRolePolicies` | Create / update / tear down **only** the broker role and its inline policy |
| IAM on `user/AgentsPoppyOperator` | `CreateUser`, `DeleteUser`, `GetUser`, `TagUser`, `UntagUser`, `PutUserPolicy`, `DeleteUserPolicy`, `GetUserPolicy`, `ListUserPolicies`, `ListAttachedUserPolicies` | Create / update / tear down **only** the operator user and its inline policy |
| IAM on `user/AgentsPoppyOperator` | `CreateAccessKey`, `ListAccessKeys`, `DeleteAccessKey` | Mint the operator's access key (so the whole bootstrap can be done without admin) |
| STS on `role/AgentsPoppyBroker` | `AssumeRole` | **Operate:** assume the broker role to vend scoped credentials and verify the connection |
| CloudFormation (`Resource: *`) + Tagging + CloudTrail | `ListStacks`, `DescribeStacks`, `DescribeStackResources`, `ListStackResources`, `GetTemplate`, `DeleteStack`, `tag:GetResources`, `cloudtrail:LookupEvents` | **Read + teardown:** draw the infra map, surface account activity, and tear down what apps built |
| S3 + DynamoDB + Cognito + Lambda + Logs + SES (`Resource: *`) | tag reads: `s3:GetBucketTagging`, `dynamodb:ListTagsOfResource`, `cognito-idp:ListTagsForResource`, `lambda:ListTags`, `logs:ListTagsForResource` · deletes: `s3:ListBucketVersions`, `s3:DeleteObject(Version)`, `s3:DeleteBucket`, `dynamodb:Update/DeleteTable`, `cognito-idp:DescribeUserPool`, `DeleteUserPool(Domain)`, `lambda:DeleteFunction`, `logs:DeleteLogGroup`, `ses:DeleteIdentity`, `Describe/SetActiveReceiptRuleSet`, `DeleteReceiptRuleSet` | **Host residual cleanup:** after (or instead of) a poppy's own cleanup, AgentsPoppy itself deletes what the tag sweep still attributes to the poppy — so teardown completes even for a revoked / blocked / uninstalled poppy, and nothing tagged is ever orphaned. The tag-read actions power the **live** pre-delete ownership check |

**Scoping notes.** The IAM *management* actions are locked by **resource** to the two named
bootstrap resources — `role/AgentsPoppyBroker` and `user/AgentsPoppyOperator`. CloudFormation
*management* is locked to the **`AgentsPoppy`** bootstrap stack; the read/teardown actions are
`Resource: *` (they must see every app stack and tagged resource to map/tear down the account,
and the tagging/CloudTrail APIs don't support resource-level ARNs). The bootstrap uses **inline**
policies, so no `iam:CreatePolicy` / `AttachRolePolicy` is needed; it passes the role to no
service, so no `iam:PassRole` is needed.

**Why `HostResidualCleanup` is unconditioned (`Resource: *`, no tag condition).** Ideally these
delete actions would carry an `aws:ResourceTag/agentspoppy:app` condition, but several of them
don't (reliably) support resource-tag conditions across services and regions — and a condition
that silently fails to authorize means the cleanup fails and **orphaned, billable resources are
left in your account**, the exact outcome this statement exists to prevent. Reliability of
cleanup *is* the safety feature here. The tag discipline is enforced in code instead, twice:
the engine only ever targets resources the `tag:GetResources` sweep attributed to a poppy, and
it re-reads each resource's tags immediately before deleting — via the **live per-service tag
APIs** (`GetBucketTagging`, `ListTagsOfResource`, …) rather than the eventually-consistent tag
index, so a just-untagged or re-tagged resource is never touched. Teardown also refuses to run
at all if the operator credentials resolve to a *different AWS account* than the one the poppy
is connected to, and deletion only ever runs inside the teardown flow the user explicitly
confirmed by typing the poppy's name.

> **Honest caveat — read this.** This policy is *far* narrower than `AdministratorAccess`. But
> the `AgentsPoppyBroker` role it creates is broad by design, so connecting AgentsPoppy is
> inherently a high-trust action: whoever holds this policy can create that one admin-capable
> role and assume it. The win is the **blast radius** — it cannot create *arbitrary* roles/users
> or touch *anything else*, and the broker role itself carries hard Deny guardrails (no IAM-user
> / account / org control, no CloudTrail tampering) that no connected app can escape.

## Apply it

Attach the JSON as a customer-managed policy in the IAM console (Policies → Create policy →
JSON → paste `agentspoppy-access-policy.json`), then attach it to the IAM user you connect with.
Creating that user + attaching the policy is the one step that needs an admin (the unavoidable
bootstrap); after that, the same user runs everything — no second credential to switch to.

When AgentsPoppy adds a permission in a future update, it detects the gap in-app and links you
straight back to this file to re-copy onto your user.

> **Changed this policy or the `HostResidualCleanup` grants?** Run the teardown acceptance
> runbook — [`docs/TEARDOWN_TEST_PLAN.md`](../../docs/TEARDOWN_TEST_PLAN.md) — which checks the
> policy twins are in lockstep **and** that host cleanup actually completes against real AWS.
