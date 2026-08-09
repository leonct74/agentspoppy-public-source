// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Pure IAM-policy generation — the security-critical core of credential vending,
 * deliberately kept free of any AWS SDK so it can be exhaustively unit-tested.
 *
 * ⚠️ MECHANISM-CRITICAL: this file is an enforcement point of the patented delegation
 * mechanism. Before changing ANYTHING here, read docs/SECURITY_MECHANISM.md (the single
 * source of truth) and walk its §5 checklist — invariants I1–I6 must provably survive
 * your change, and that document must be updated in the same commit if they move.
 *
 * When AgentsPoppy assumes the account's role to vend a connection its
 * credentials, it passes an inline **session policy**. The effective permissions
 * are the *intersection* of the role's own policy and this session policy, so
 * this document can only ever narrow access — never widen it.
 *
 * The guarantee that makes "show / wipe exactly what an app made" real:
 * every tag-scoped grant is pinned with a condition requiring the resource to
 * carry this *app's* tag, and the connection's attribution tags are attached as
 * transitive session tags so anything the app creates is stamped.
 *
 * Ownership is scoped to the **app** (`agentspoppy:app`), NOT the connection id.
 * A connection is ephemeral — it is superseded (revoked + recreated with a fresh
 * id) whenever the app's declared scope drifts — but the AWS resources it created
 * outlive it. Pinning ownership to the stable app identity means any live
 * connection of the same app can still read/teardown that app's footprint after a
 * supersede, instead of orphaning it. Cross-app isolation is preserved: the broker
 * controls what app id a session is tagged with (the connection's verified
 * `app.id`), so an app can only ever match resources tagged as its own.
 */
import { connectionTags, TAGGED_AS_SELF } from "@agentspoppy/core";
import type { ConnectedAccount, Connection, PermissionGrant } from "@agentspoppy/core";

/** Audit tag recording which connection created a resource (NOT used for ownership). */
export const CONNECTION_TAG_KEY = "agentspoppy:connection";

/** The resource tag that determines ownership — stable across connection churn. */
export const APP_TAG_KEY = "agentspoppy:app";

export interface PolicyStatement {
  Sid: string;
  Effect: "Allow" | "Deny";
  Action: string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}

export interface PolicyDocument {
  Version: "2012-10-17";
  Statement: PolicyStatement[];
}

/** Session tag, in the shape STS AssumeRole expects. */
export interface SessionTag {
  Key: string;
  Value: string;
}

/** Prefix bare action names with the grant's service ("CreateBucket" → "s3:CreateBucket"). */
export function qualifyActions(grant: PermissionGrant): string[] {
  const svc = grant.service.toLowerCase();
  return grant.actions.map((a) => (a.includes(":") ? a : `${svc}:${a}`));
}

/**
 * Build the Allow statement(s) for one grant. Exported for focused testing.
 *
 * A tagged-as-self grant compiles to TWO statements, because one condition cannot
 * cover both halves of a resource's life:
 *
 *  - **Create/Request actions** — the resource does not exist yet, so an
 *    `aws:ResourceTag` condition can never match (this denied every create until
 *    TrafficPoppy's edge stack found it live, 2026-07). They are conditioned on
 *    `aws:RequestTag` instead: the resource is BORN carrying this app's tag, or it
 *    is not born at all. This turns AGENTS.md's "every create carries the
 *    attribution tags" from a rule apps follow into one IAM enforces — an untagged
 *    create is refused, so nothing an app makes can ever hide from the tag sweep.
 *    Corollary: a service whose create API cannot take tags at creation cannot sit
 *    in a tagged-as-self grant — use a name-scoped grant for it instead.
 *
 *  - **Everything else** (read / change / delete) keeps the `aws:ResourceTag`
 *    condition: only resources already carrying this app's tag.
 */
export function statementForGrant(grant: PermissionGrant, appId: string, index: number): PolicyStatement[] {
  const Action = qualifyActions(grant);

  if (grant.resourceScope === TAGGED_AS_SELF) {
    // Scoping to the app (not the connection id) keeps the grant valid across
    // connection supersedes, so teardown can still reach resources an earlier
    // connection made.
    const isCreate = (a: string) => /:(Create|Request)/.test(a);
    const creates = Action.filter(isCreate);
    const rest = Action.filter((a) => !isCreate(a));
    const statements: PolicyStatement[] = [];
    if (creates.length > 0) {
      statements.push({
        Sid: `Grant${index}CreateBirthTagged`,
        Effect: "Allow",
        Action: creates,
        Resource: "*",
        Condition: { StringEquals: { [`aws:RequestTag/${APP_TAG_KEY}`]: appId } },
      });
    }
    if (rest.length > 0) {
      statements.push({
        Sid: `Grant${index}TagScoped`,
        Effect: "Allow",
        Action: rest,
        Resource: "*",
        Condition: { StringEquals: { [`aws:ResourceTag/${APP_TAG_KEY}`]: appId } },
      });
    }
    return statements;
  }

  // A concrete ARN/ARN-pattern, or the (discouraged, non-attributable) "*".
  return [
    {
      Sid: `Grant${index}`,
      Effect: "Allow",
      Action,
      Resource: grant.resourceScope,
    },
  ];
}

/**
 * The inline session policy for a connection: one Allow statement per grant.
 * A grant-less permission set yields an explicit deny-all so the assumed session
 * is inert rather than inheriting the role's full breadth.
 */
export function sessionPolicyForConnection(connection: Connection): PolicyDocument {
  const grants = connection.permissionSet.grants;
  const Statement: PolicyStatement[] =
    grants.length > 0
      ? grants.flatMap((g, i) => statementForGrant(g, connection.app.id, i))
      : [{ Sid: "NoGrants", Effect: "Deny", Action: ["*"], Resource: "*" }];
  return { Version: "2012-10-17", Statement };
}

/**
 * The connection's attribution tags as STS session tags. Marked transitive by
 * the caller so they propagate to anything the app creates during the session
 * (which is what lets a tag-condition scope, and later teardown, find them).
 */
export function sessionTags(account: ConnectedAccount, connection: Connection): SessionTag[] {
  return Object.entries(connectionTags(account, connection)).map(([Key, Value]) => ({ Key, Value }));
}
