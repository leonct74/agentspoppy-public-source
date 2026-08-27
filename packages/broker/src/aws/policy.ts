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
import { connectionTags, scopeIsUnbounded, TAGGED_AS_SELF } from "@agentspoppy/core";
import type { ConnectedAccount, Connection, PermissionGrant } from "@agentspoppy/core";

/** Audit tag recording which connection created a resource (NOT used for ownership). */
export const CONNECTION_TAG_KEY = "agentspoppy:connection";

/** The resource tag that determines ownership — stable across connection churn. */
export const APP_TAG_KEY = "agentspoppy:app";

// --- tag adoption: a poppy must not claim what it did not create --------------------
//
// A poppy is authorised to act on resources carrying its own `agentspoppy:app` tag (I2).
// Where a grant ALSO carries an unconditioned power to WRITE tags on every resource of a
// type, the tag that decides ownership is a tag the poppy may write — the lock and the key
// in the same hand. It could stamp itself onto another poppy's user pool, or onto the
// user's own server, and then act on it. See docs/specs/tag-adoption.md.
//
// This applies ONLY where the resource scope does not narrow. A tag write confined by name
// (`table/CrewPoppy*`) is already confined by that name, and is left exactly as it was.
// A tagged-as-self grant is already conditioned on `aws:ResourceTag`, so it can only tag
// what is already its own.

/** Tag-WRITE actions, generically. Tag READS (List…, Get…, Describe…) never match. */
// Deliberately BROAD. A name this misses compiles unconditioned, which is the hole; a name
// it over-matches is refused, which is loud and fixable. AWS spells the same idea at least
// six ways — TagResource, CreateTags, AddTags (sagemaker, es, elasticmapreduce),
// AddTagsToResource, PutBucketTagging, TagRole — and a detector written to the two or three
// that came to mind first would have let sagemaker:AddTags through silently.
// CASE-INSENSITIVE, and that is load-bearing rather than cosmetic. IAM matches the Action
// element case-insensitively, so `cognito-idp:tagresource` grants exactly what
// `cognito-idp:TagResource` grants — but a capitalised, anchored detector does not see it,
// and the grant falls through to the unconditioned path. A security detector reading
// attacker-supplied text must not fail open on a one-letter change. (Contrast
// permissions.ts's create filter, which is deliberately case-SENSITIVE because it mirrors
// this compiler character-for-character; that one is descriptive, this one is enforcement.)
const TAG_WRITE_ACTION =
  /^(Tag|Untag|AddTags|RemoveTags|CreateTags|DeleteTags|SetTags|PutTags|ChangeTags|PutBucketTagging|DeleteBucketTagging)/i;

/**
 * How a service's tag writes are allowed to be conditioned.
 *
 * This table is per-service and MUST stay that way. A condition key a service does not
 * populate can never be satisfied, so emitting one turns an Allow into a permanent Deny —
 * a deploy that breaks in the user's own account, discovered by them. Every entry here was
 * checked against the AWS Service Authorization Reference for the exact action.
 *
 * NOT LISTED = REFUSED. s3 is the worked example: `s3:PutBucketTagging` supports neither
 * `aws:RequestTag` nor `aws:ResourceTag`, so both shapes below would deny every bucket tag
 * write forever. S3 tag writes must be name-scoped, which every shipped poppy already does.
 */
interface TagWriteRules {
  /** Bare action names that add or overwrite tags. */
  add: string[];
  /** Bare action names that remove tags. These NEVER get a request-tag condition: no tags
   *  ride along on a removal, so the key is unpopulated and the condition is a deny. */
  remove: string[];
  /**
   * `create-action` — the service can prove the tag write is part of a create call, so the
   *                   standalone claim path is removed entirely. No residual gap.
   * `none`          — PROVEN, per service, that AWS populates `aws:ResourceTag` with the
   *                   SUBMITTED tags during a tag-on-create. The re-tag-your-own statement
   *                   therefore authorises creates on its own, and a claim statement would
   *                   add nothing except the ability to claim an untagged resource. Also
   *                   no residual gap.
   * `request-tag`   — not yet proven for this service. Claim only something not already
   *                   claimed. Works, but LEAVES A RESIDUAL: a resource the user created
   *                   by hand carries no attribution tag and so counts as unclaimed.
   */
  claim: "create-action" | "request-tag" | "none";
}

const TAG_WRITE_RULES: Record<string, TagWriteRules> = {
  // ec2:CreateAction is populated ONLY when CreateTags is evaluated as the tagging half of
  // a create call, and is absent when CreateTags is called directly — AWS: "users are not
  // permitted to tag any existing resources". It is NOT listed on DeleteTags (a delete is
  // never part of a create), so it must never be applied there.
  ec2: { add: ["CreateTags"], remove: ["DeleteTags"], claim: "create-action" },
  // PROVEN live (canary, 26 Aug 2026): a pool created WITH tags succeeds under a policy
  // carrying NO claim statement, so aws:ResourceTag really is populated with the submitted
  // tags during the dependent TagResource check. The claim statement was therefore doing
  // nothing for creates — its only remaining effect was to permit claiming an UNTAGGED
  // pool, which the same run confirmed was possible. Dropping it closes that gap at no
  // cost. See docs/specs/tag-adoption-canary.md.
  "cognito-idp": { add: ["TagResource"], remove: ["UntagResource"], claim: "none" },
  // NOT proven, so left on the weaker shape deliberately. Testing guardduty means creating
  // a detector, which ENABLES GuardDuty on the account — a paid service and a change to the
  // user's security posture, not something to switch on for a test. The shape below works
  // and blocks the attack; it only keeps the residual, and an untagged GuardDuty resource
  // is unlikely to exist since they are made by tooling, not by hand.
  guardduty: { add: ["TagResource"], remove: ["UntagResource"], claim: "request-tag" },
  // PROVEN live (canary, 26 Aug 2026), BOTH halves — which is the only kind of proof that
  // counts here. Creating an app with its own tag succeeded under a policy carrying no
  // claim statement; and claiming an UNTAGGED app it did not create was DENIED without the
  // statement and ALLOWED with it, with the app's real tags confirming both. So the
  // statement was not authorising creates, only enabling the takeover.
  amplify: { add: ["TagResource"], remove: ["UntagResource"], claim: "none" },
};

/** Bare action name, without the optional `service:` prefix. */
function bareName(action: string): string {
  const i = action.indexOf(":");
  return i >= 0 ? action.slice(i + 1) : action;
}

/**
 * The create-class actions in this grant, as `ec2:CreateAction` expects them: the API
 * action NAME with no service prefix ("RunInstances", not "ec2:RunInstances"). Derived
 * from the grant itself rather than hardcoded, so a poppy can only ever tag alongside a
 * create it was actually granted. The tag actions are excluded — `CreateTags` starts with
 * "Create" but creates no resource.
 */
function createActionsIn(actions: string[], rules: TagWriteRules): string[] {
  const tagActions = new Set([...rules.add, ...rules.remove].map((a) => a.toLowerCase()));
  return actions
    .map(bareName)
    .filter((a) => !tagActions.has(a.toLowerCase()) && /^(Create|Run|Allocate|Request|Import|Copy)/i.test(a));
}

/** Case-insensitive membership, for the same reason TAG_WRITE_ACTION is. */
function listedIn(names: string[], action: string): boolean {
  const bare = bareName(action).toLowerCase();
  return names.some((n) => n.toLowerCase() === bare);
}

/** A wildcard action — `"*"` or a service wildcard like `"cognito-idp:*"`. */
function isWildcardAction(action: string): boolean {
  return action === "*" || action.endsWith(":*");
}

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
  const unbounded = scopeIsUnbounded(grant.resourceScope, grant.service);

  // A wildcard action INCLUDES the service's tag writes — `cognito-idp:*` is
  // `cognito-idp:TagResource` and everything else — and there is no way to split it into a
  // tag half that can be conditioned and a rest half that cannot. Combined with a scope
  // that does not narrow, it is the unconditioned tag write this rule exists to remove,
  // just spelled in one character. Refused rather than emitted. (A wildcard action on a
  // NAME-SCOPED resource is untouched: the name still confines it.)
  if (unbounded && Action.some(isWildcardAction)) {
    throw new Error(
      `refusing to compile a session policy: "${grant.service}" grants a wildcard action ` +
        `(${Action.filter(isWildcardAction).join(", ")}) on a scope that does not narrow ` +
        `("${grant.resourceScope}"). That includes the service's tag-write actions, which ` +
        `would let this app stamp its own ownership tag onto resources it did not create. ` +
        `Name the actions it needs, or scope the grant to a name pattern. ` +
        `See docs/specs/tag-adoption.md.`,
    );
  }

  const tagWrites = Action.filter((a) => TAG_WRITE_ACTION.test(bareName(a)));

  // Tag writes on a scope that genuinely narrows are already confined BY that scope, so
  // they are left alone. Only an unnarrowed scope can reach someone else's resource.
  if (tagWrites.length === 0 || !unbounded) {
    return [{ Sid: `Grant${index}`, Effect: "Allow", Action, Resource: grant.resourceScope }];
  }

  const rules = TAG_WRITE_RULES[grant.service.toLowerCase()];
  if (!rules) {
    // Fail CLOSED. Emitting the grant unconditioned would be the hole; emitting a
    // condition the service does not populate would deny it forever. Neither is ours to
    // guess at — the grant is refused until the service has been checked and added.
    throw new Error(
      `refusing to compile a session policy: "${grant.service}" grants tag-write actions ` +
        `(${tagWrites.map(bareName).join(", ")}) on a scope that does not narrow ` +
        `("${grant.resourceScope}"), and AgentsPoppy has no verified way to confine tag ` +
        `writes for that service. Scope the grant to a name pattern instead, or add ` +
        `"${grant.service.toLowerCase()}" to TAG_WRITE_RULES once its condition-key ` +
        `support has been confirmed. See docs/specs/tag-adoption.md.`,
    );
  }

  const adds = tagWrites.filter((a) => listedIn(rules.add, a));
  const removes = tagWrites.filter((a) => listedIn(rules.remove, a));
  const unknown = tagWrites.filter((a) => !adds.includes(a) && !removes.includes(a));
  if (unknown.length > 0) {
    throw new Error(
      `refusing to compile a session policy: ${unknown.join(", ")} writes tags on ` +
        `"${grant.service}" but is not classified in TAG_WRITE_RULES, so AgentsPoppy ` +
        `cannot tell whether a request-tag condition would confine it or deny it.`,
    );
  }

  const rest = Action.filter((a) => !tagWrites.includes(a));
  const statements: PolicyStatement[] = [];
  if (rest.length > 0) {
    statements.push({ Sid: `Grant${index}`, Effect: "Allow", Action: rest, Resource: grant.resourceScope });
  }

  // Claiming. Three shapes, and the difference is how much each leaves open.
  // `none` emits nothing here at all: the re-tag-your-own statement below already
  // authorises tag-on-create for these services, so a claim statement would only add the
  // ability to take over something untagged.
  if (adds.length > 0 && rules.claim !== "none") {
    if (rules.claim === "create-action") {
      // The strong one: the tag write is authorised only as the tagging half of a create
      // the poppy is making itself, so a pre-existing resource can never be claimed at
      // all. The request-tag half is ours, not AWS's — AWS's own example permits ANY tag
      // during a create, and the tag must be self-attesting.
      const creates = createActionsIn(Action, rules);
      if (creates.length > 0) {
        statements.push({
          Sid: `Grant${index}TagOnCreate`,
          Effect: "Allow",
          Action: adds,
          Resource: grant.resourceScope,
          Condition: {
            StringEquals: {
              "ec2:CreateAction": creates,
              [`aws:RequestTag/${APP_TAG_KEY}`]: appId,
            },
          },
        });
      }
      // No creates in this grant → the tag-on-create statement would authorise nothing,
      // so it is omitted rather than emitted as dead policy.
    } else {
      // The best available where the service cannot prove a create is in progress: claim
      // only something NOT already claimed. Residual, stated in the spec: a resource the
      // user made by hand carries no attribution tag and so still counts as unclaimed.
      statements.push({
        Sid: `Grant${index}TagOnCreate`,
        Effect: "Allow",
        Action: adds,
        Resource: grant.resourceScope,
        Condition: {
          StringEquals: { [`aws:RequestTag/${APP_TAG_KEY}`]: appId },
          Null: { [`aws:ResourceTag/${APP_TAG_KEY}`]: "true" },
        },
      });
    }
  }

  // Re-tagging and untagging what is ALREADY yours. Load-bearing, and easy to leave out:
  // CloudFormation issues tag updates as DELTAS carrying only the changed keys, so a
  // release-day stack update does not restate agentspoppy:app and fails the claim
  // statement above. Without this, every such update breaks.
  if (adds.length > 0 || removes.length > 0) {
    statements.push({
      Sid: `Grant${index}TagOwn`,
      Effect: "Allow",
      Action: [...adds, ...removes],
      Resource: grant.resourceScope,
      Condition: { StringEquals: { [`aws:ResourceTag/${APP_TAG_KEY}`]: appId } },
    });
  }
  return statements;
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
