// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The consent model: turn a permission set into plain-language "blast radius"
 * the user can actually approve, and derive the attribution tags that make
 * per-app tracking + teardown possible. All pure and unit-tested.
 *
 * This file is invariant I6's other half (docs/SECURITY_MECHANISM.md): what it shows
 * the user at approval time must match what the compiled session policy actually
 * permits. A rating that flatters a grant is a mechanism-integrity bug even when the
 * policy itself is sound, because consent given against a false description is not
 * consent.
 */
import { TAGGED_AS_SELF } from "./types";
import { grantHasReferencedLeg } from "./birthActions";
import { grantCannotBeNarrowed } from "./awsNarrowing";
import type { ConnectedAccount, Connection, PermissionGrant, PermissionSet } from "./types";

/** The tag keys AgentsPoppy stamps on every brokered resource (for attribution). */
export const ATTRIBUTION_TAG_KEYS = [
  "agentspoppy:account",
  "agentspoppy:app",
  "agentspoppy:connection",
] as const;

// Services where even a pure "create" is a privilege change (creating an IAM role,
// user or policy is escalation), so a create here is never merely additive.
const CONTROL_PLANE = new Set(["iam", "organizations", "account"]);

// --- what an action actually does ------------------------------------------------
//
// Classification is by the action's leading VERB, anchored at the start of the name.
// It used to be an unanchored substring search, which was wrong in both directions:
// `ec2:TerminateInstances` matched no mutating verb and was described to the user as
// "Can read ANY EC2 resource in your account", while `ec2:GetConsoleOutput` — a pure
// read — matched the "put" inside "OutPUT" and rated red. Anchoring at the verb kills
// that whole class of error. See docs/specs/scope-policy-and-rating.md.

/** Verbs that only ever read. Everything here leaves the account exactly as it was. */
const READ_VERBS = [
  "describe", "list", "get", "head", "read", "search", "query", "scan", "lookup",
  "batchget", "view", "preview", "estimate", "simulate", "validate", "check", "test",
  "discover", "detect", "select", "filter", "count", "sample",
];
// NB "export" and "download" are deliberately NOT read verbs. dynamodb:ExportTable-
// ToPointInTime reads nothing the caller could not already read, but it lifts an entire
// table into a bucket of the caller's choosing — and as a "read" it would also be
// vended un-gated on a supervised connection by approvals.ts. They fall through to the
// unknown-verb default instead, which is the cautious side.

/**
 * Verbs that CREATE something new and cannot touch what already exists. This set is
 * deliberately identical to the session-policy compiler's own create filter
 * (`/:(Create|Request)/`, SECURITY_MECHANISM §3), because I6 requires the rating and
 * the compiled policy to agree. A verb the compiler does not birth-tag must not be
 * rated "additive, cannot harm what exists" — that would claim the I3 guarantee the
 * policy is not making. `ec2:RunInstances` is the live example: it creates a billable
 * instance that, under a tagged-as-self grant, is born UNTAGGED and so is invisible
 * to I4's sweep and to teardown. Widening this set is a mechanism change (§3, §5).
 */
const CREATE_VERBS = ["Create", "Request"];

/**
 * The compiler's filter, mirrored character-for-character. It is `/:(Create|Request)/`
 * over the qualified action, i.e. capitalised and anchored at the start of the action
 * name — so it is CASE-SENSITIVE, and a manifest writing `createBucket` is not a create
 * to the compiler. The rating must agree: calling that additive would promise I3
 * birth-tagging for an action the compiler routes into the `rest` statement instead.
 */
const CREATE_RE = new RegExp(`^(${CREATE_VERBS.join("|")})`);

/**
 * Verbs that change, remove, or alter the state of something that ALREADY exists.
 * "Destructive" here means "can harm what is already in the account", which includes
 * stopping or rebooting a running server, not only deleting it. Anything mutating
 * that is not in CREATE_VERBS belongs here — that is what keeps the additive bucket
 * exactly as wide as the compiler's, and no wider.
 */
const DESTRUCTIVE_VERBS = [
  "delete", "remove", "destroy", "terminate", "purge", "empty", "truncate", "erase",
  "update", "put", "write", "modify", "set", "change", "edit", "replace", "patch",
  "attach", "detach", "associate", "disassociate", "add", "move", "rename", "copy",
  "stop", "start", "reboot", "restart", "reset", "restore", "rollback", "cancel",
  "abort", "suspend", "resume", "enable", "disable", "activate", "deactivate",
  "authorize", "revoke", "grant", "deny", "allow", "block", "register", "deregister",
  "tag", "untag", "publish", "send", "post", "invoke", "execute",
  "import", "upload", "apply", "upgrade", "downgrade", "migrate", "rotate", "expire",
  "invalidate", "clear", "release", "assume", "pass", "sign", "accept", "reject",
  "approve", "continue",
];

/**
 * Verbs that bring a NEW resource into existence without the compiler birth-tagging
 * it. `ec2:RunInstances` is the reason this class exists: it is plainly not additive
 * in the I3 sense — the compiler's create filter is `/:(Create|Request)/`, so a
 * launched instance is born UNTAGGED and is invisible to I4's sweep and to teardown —
 * but neither can it change or delete anything that already exists. Calling it
 * destructive would overstate it in exactly the way this whole fix exists to prevent,
 * so it rates high on its own terms, with its own wording.
 */
const LAUNCH_VERBS = ["run", "launch", "provision", "deploy", "reserve"];

/**
 * Actions dangerous for a reason the verb cannot carry, so they are named outright.
 * Each is here because its verb alone reads as harmless:
 *   sts:AssumeRole                     becomes another identity, inheriting its rights
 *   iam:PassRole                       hands a role to a service — classic escalation
 *   lambda:InvokeFunction              runs arbitrary code the poppy may have uploaded
 *   ec2:AuthorizeSecurityGroupIngress  opens a firewall to the internet
 * Matched without the service prefix, so `AssumeRole` and `sts:AssumeRole` both hit.
 */
const DANGEROUS_ACTIONS = new Set([
  "assumerole", "assumerolewithwebidentity", "assumerolewithsaml",
  "passrole", "invokefunction", "invokeasync",
  "authorizesecuritygroupingress", "authorizesecuritygroupegress",
  "revokesecuritygroupingress", "revokesecuritygroupegress",
]);

/**
 * Reads that expose SECRET DATA rather than a resource's shape. They mutate nothing —
 * so `grantCanMutate` correctly stays false — but calling them an ordinary "read"
 * understates them badly, so the rating treats them as their own case.
 */
const SECRET_READ_ACTIONS = new Set([
  "decrypt", "getsecretvalue", "batchgetsecretvalue", "retrievesecretvalue",
  "getparameter", "getparameters", "getparametersbypath", "getpassworddata",
]);

// Longest verb first. Within one list this is only tidiness — the lookups below ask
// "does any verb match?", so nothing can shadow anything. What actually decides an
// ambiguous name is the ORDER THE LISTS ARE CONSULTED in classifyAction: destructive,
// then launch, then create, then read. A verb appearing in two lists resolves to the
// earlier one, which is why "run" was removed from DESTRUCTIVE_VERBS when the launch
// class was added rather than simply being added to LAUNCH_VERBS.
const byLengthDesc = (a: string, b: string) => b.length - a.length;
const READ_SORTED = [...READ_VERBS].sort(byLengthDesc);
const DESTRUCTIVE_SORTED = [...DESTRUCTIVE_VERBS].sort(byLengthDesc);
const LAUNCH_SORTED = [...LAUNCH_VERBS].sort(byLengthDesc);

/** A wildcard action — `"*"` or a service wildcard like `"s3:*"` — is full control. */
function isWildcardAction(action: string): boolean {
  return action === "*" || action.endsWith(":*");
}

/** The action name without its optional `service:` prefix, original case preserved. */
function bareActionRaw(action: string): string {
  const i = action.indexOf(":");
  return i >= 0 ? action.slice(i + 1) : action;
}

/** The action name without its optional `service:` prefix, lower-cased. */
function bareAction(action: string): string {
  return bareActionRaw(action).toLowerCase();
}

/** How an action is classified once its verb is known. */
type ActionClass = "read" | "secret-read" | "create" | "launch" | "destructive";

/**
 * Classify one action. An unrecognised verb classifies as `destructive`, NOT as a
 * read: AWS adds actions constantly, and a rating that defaults to reassuring is
 * worse than one that defaults to asking. That single default is what would have
 * caught every false negative the old substring search produced.
 */
function classifyAction(action: string): ActionClass {
  if (isWildcardAction(action)) return "destructive";
  const bare = bareAction(action);
  if (DANGEROUS_ACTIONS.has(bare)) return "destructive";
  if (SECRET_READ_ACTIONS.has(bare)) return "secret-read";
  if (DESTRUCTIVE_SORTED.some((v) => bare.startsWith(v))) return "destructive";
  if (LAUNCH_SORTED.some((v) => bare.startsWith(v))) return "launch";
  // Case-SENSITIVE, and on the original spelling — this one mirrors the compiler
  // rather than guessing at intent. See CREATE_RE.
  if (CREATE_RE.test(bareActionRaw(action))) return "create";
  if (READ_SORTED.some((v) => bare.startsWith(v))) return "read";
  return "destructive";
}

/**
 * True if a grant can change anything at all (not merely read). A wildcard action —
 * `"*"` or `"iam:*"` — includes every mutating call, so it always counts. (Without
 * that, a full-access grant like `iam: ["*"]` would slip through as "read-only": the
 * most dangerous grant, mis-rated as the safest.)
 */
export function grantCanMutate(grant: PermissionGrant): boolean {
  return grant.actions.some((a) => {
    const c = classifyAction(a);
    return c === "create" || c === "launch" || c === "destructive";
  });
}

/**
 * True if the grant can change or DESTROY resources that already exist (not merely
 * create new ones). This is what separates "can harm the rest of your account" from
 * "can only add new resources".
 */
export function grantCanDestroy(grant: PermissionGrant): boolean {
  return grant.actions.some((a) => classifyAction(a) === "destructive");
}

/** True if the grant can bring new resources into existence that teardown cannot see. */
export function grantCanLaunchUntracked(grant: PermissionGrant): boolean {
  return grant.actions.some((a) => classifyAction(a) === "launch");
}

/** True if the grant can read secret material (not merely a resource's shape). */
export function grantExposesSecrets(grant: PermissionGrant): boolean {
  return grant.actions.some((a) => classifyAction(a) === "secret-read");
}

/** True if the grant is limited to resources tagged as this connection's own. */
export function grantIsTagScoped(grant: PermissionGrant): boolean {
  return grant.resourceScope === TAGGED_AS_SELF;
}

// --- is a resource scope actually a scope? ----------------------------------------

/**
 * The resource portion of an ARN — everything after the fifth colon. A scope that is
 * not an ARN (e.g. `stack/agentspoppy-mailpoppy-*`, or a bare `*`) is returned whole.
 */
function resourcePortion(scope: string): string {
  if (!scope.startsWith("arn:")) return scope;
  const parts = scope.split(":");
  return parts.length > 5 ? parts.slice(5).join(":") : "";
}

/**
 * Services whose ARN resource field is a bare NAME with no `type/` qualifier in front
 * of it. `arn:aws:s3:::my-bucket/*` is a bucket called my-bucket, not a resource of
 * type "my-bucket" — and syntactically that is indistinguishable from
 * `arn:aws:iam::*:role/*`, where `role` genuinely is the type. Nothing in the ARN
 * itself separates the two, so the service has to.
 *
 * Getting this wrong is not cosmetic in either direction. Treating `role/` as a name
 * is the original bug (a grant over every role in the account described as confined to
 * its own). Treating `my-bucket/` as a type is the mirror of it: the most common
 * correct S3 grant there is would be called "any resource", rated high, refused by
 * isFullyAttributable and pushed into supervised mode — a rating that cries wolf about
 * good scoping teaches people to ignore it.
 */
const UNTYPED_RESOURCE_SERVICES = new Set(["s3", "sns", "sqs"]);

/**
 * True if a scope does NOT actually confine the grant to particular resources.
 *
 * The old test was `scope === "*"`, so anything else counted as confined and was
 * described as "it cannot touch any X resource with a different name". That sentence
 * is false for a whole family of patterns: `arn:aws:iam::*:role/*` is not literally
 * `"*"`, yet it matches every role in every account. `isFullyAttributable` used the
 * same test, so such a grant also passed the check that is supposed to guarantee
 * teardown can find everything a poppy made.
 *
 * So: drop the leading resource-TYPE qualifier (`role/`, `userpool/`, `function:`,
 * `log-group:`) — except for the services above, which have no type to drop — and what
 * remains is a real constraint unless every segment of it is a wildcard.
 */
export function scopeIsUnbounded(scope: string, service = ""): boolean {
  if (scope === "*" || scope.length === 0) return true;
  if (scope === TAGGED_AS_SELF) return false;
  let rest = resourcePortion(scope);
  if (!UNTYPED_RESOURCE_SERVICES.has(service.toLowerCase())) {
    rest = rest.replace(/^[a-z0-9-]+[/:]/, "");
  }
  // Only the FIRST segment decides. If the thing being named is a wildcard then the
  // scope is unbounded whatever follows it, because everything after only narrows
  // within an already-unconstrained parent: `log-group:*:log-stream:*` is every stream
  // of every log group, and the literal "log-stream" in the middle is a type qualifier,
  // not a constraint. Conversely a literal first segment IS the constraint, which is
  // why `my-bucket/*` stays scoped. Split on both separators, since AWS uses each
  // (`function:name`, `table/name`), and skip a leading empty segment from a path-style
  // resource like apigateway's `/apis*`.
  const first = rest.split(/[/:]/).find((seg) => seg !== "");
  // A segment made only of WILDCARD CHARACTERS narrows nothing. IAM treats "?" as a
  // single-character wildcard, so `instance/?*` matches every instance in the account
  // while reading, to a literal-string test, like a name pattern. Testing for "*" alone
  // let that through — and it is the kind of thing a hostile manifest reaches for
  // precisely because it looks specific.
  return first === undefined || /^[*?]+$/.test(first);
}

// KNOWN LIMIT, and not solvable syntactically: a pattern can be a genuine name prefix and
// still match everything, because AWS ids have fixed prefixes — `instance/i-*` matches
// every EC2 instance, `userpool/eu-west-1_*` every pool in the region. Nothing in the ARN
// distinguishes that from `table/CrewPoppy*`, which really does narrow. Recognising it
// would need a per-service table of id formats. Documented in docs/specs/tag-adoption.md
// rather than papered over.

/** One plain-language line describing a grant's blast radius. */
export function describeGrant(grant: PermissionGrant): string {
  // Ordered worst-first, and a launch is called out on its own: saying a grant of
  // ec2:RunInstances can "create, change and delete" claims a power the compiled policy
  // does not give it, which is the same I6 divergence this fix exists to remove — only
  // pointing the other way.
  const verb = grantCanDestroy(grant)
    ? "create, change and delete"
    : grantCanLaunchUntracked(grant)
      ? "start up new"
      : grantCanMutate(grant)
        ? "create new"
        : grantExposesSecrets(grant)
          ? "read the contents of"
          : "read";
  const where = grantIsTagScoped(grant)
    ? "only resources tagged as its own"
    : scopeIsUnbounded(grant.resourceScope, grant.service)
      ? // Rule C: the boundary is genuinely "everything", but a reader deserves to know
        // whether that was a choice. It is not, when AWS publishes no way to narrow it.
        grantCannotBeNarrowed(grant)
        ? "any resource (AWS offers no way to narrow this)"
        : "any resource"
      : // Rule 3's register for a name scope: it bounds a namespace without proving
        // ownership, so the line must not read as "its own".
        `anything named ${grant.resourceScope}`;
  return `Can ${verb} ${grant.service.toUpperCase()} — ${where}.`;
}

/** Plain-language summary of an entire permission set, for the consent UI. */
export function describePermissionSet(ps: PermissionSet): string[] {
  return ps.grants.map(describeGrant);
}

/** The exact tag key→value pairs every brokered resource for this connection must carry. */
export function connectionTags(account: ConnectedAccount, connection: Connection): Record<string, string> {
  return {
    "agentspoppy:account": account.accountId,
    "agentspoppy:app": connection.app.id,
    "agentspoppy:connection": connection.id,
  };
}

/** Does the permission set declare every tag needed for attribution + teardown? */
export function hasAttributionTags(ps: PermissionSet): boolean {
  return ATTRIBUTION_TAG_KEYS.every((t) => ps.requiredTags.includes(t));
}

/**
 * True if every mutating grant is constrained (tag-scoped, or a name pattern that
 * genuinely narrows). This is the property that makes "show / wipe what an app made"
 * a guarantee rather than a convention, so it uses {@link scopeIsUnbounded} — a grant
 * on `arn:aws:iam::*:role/*` creates roles teardown cannot distinguish from anyone
 * else's, and must not pass.
 */
export function isFullyAttributable(ps: PermissionSet): boolean {
  if (!hasAttributionTags(ps)) return false;
  return ps.grants
    .filter(grantCanMutate)
    .every((g) => grantIsTagScoped(g) || !scopeIsUnbounded(g.resourceScope, g.service));
}

// --- policy risk: flag grants that reach beyond the app's own resources ---

export type RiskLevel = "low" | "medium" | "high";

/** A grant's risk, with a plain-language reason the user can act on. */
export interface GrantRisk {
  level: RiskLevel;
  /** True when confined to the app's own resources — by tag or by name pattern (cannot reach others). */
  scoped: boolean;
  reason: string;
}

/** A whole permission set's risk: the per-grant findings + set-level warnings. */
export interface PolicyRisk {
  /** The worst level across grants + set-level warnings. */
  level: RiskLevel;
  grants: { grant: PermissionGrant; risk: GrantRisk }[];
  /** Issues that aren't tied to a single grant (e.g. missing teardown tags). */
  warnings: string[];
  /** True if any grant is NOT limited to the app's own (tagged) resources. */
  hasUnscopedGrants: boolean;
}

const LEVEL_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

/** The higher (worse) of two risk levels. */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b;
}

/**
 * Assess a single grant's blast radius. The cardinal sin is an *unscoped* mutating
 * grant — one that can change resources beyond the app's own — because it can
 * compromise unrelated services in the account. Tag-scoped grants are safe;
 * read-only is softer than mutating; a genuine ARN pattern sits between.
 */
export function assessGrant(grant: PermissionGrant): GrantRisk {
  const svc = grant.service.toUpperCase();
  const mutates = grantCanMutate(grant);
  const tag = grantIsTagScoped(grant);
  const controlPlane = CONTROL_PLANE.has(grant.service.toLowerCase());
  const secrets = grantExposesSecrets(grant);
  const unbounded = !tag && scopeIsUnbounded(grant.resourceScope, grant.service);

  // Reaches every resource of the type. The branches below are ordered worst-first,
  // and the secret clause is APPENDED rather than being a branch of its own: a grant
  // of {kms:Decrypt, kms:CreateKey} took the "create" branch and rendered as "can
  // create new KMS resources… cannot change or delete anything that already exists",
  // which is true and which silently omitted that it can also decrypt anything in the
  // account. A single grant can do several of these things at once, so the reason has
  // to be able to say so.
  if (unbounded) {
    const alsoSecrets = secrets ? ` It can also read the contents of any ${svc} secret.` : "";

    // Rule C — say when AWS is the limit. Some actions publish no resource types at
    // all, so `Resource: "*"` is the only grant that authorises them; scoping one
    // DENIES it (proven live — see awsNarrowing.ts). Where that is true of every
    // action in the grant, "not just its own" is an accusation the developer cannot
    // answer, and silence about it reads as negligence.
    //
    // It changes the WORDING ONLY. The level and `scoped` are untouched, so an
    // account-wide read still rates medium and still forces supervision: the reach is
    // the same whoever chose it.
    const awsLimit = grantCannotBeNarrowed(grant);
    const beyondOwn = awsLimit ? "" : " — not just its own";
    const awsNote = awsLimit
      ? ` AWS offers no way to narrow this: ${grant.actions.length === 1 ? "this action accepts" : "these actions accept"} no resource limit at all, so this is the tightest form the grant can take.`
      : "";
    if (mutates && (grantCanDestroy(grant) || controlPlane)) {
      return {
        level: "high",
        scoped: false,
        reason: `Can create, change and delete any ${svc} resource in your account${beyondOwn}.${alsoSecrets}${awsNote}`,
      };
    }
    if (grantCanLaunchUntracked(grant)) {
      return {
        level: "high",
        scoped: false,
        reason: `Can start up new ${svc} resources anywhere in your account — and because they are not tagged as they are created, AgentsPoppy cannot show you or remove them afterwards.${alsoSecrets}${awsNote}`,
      };
    }
    if (mutates) {
      return {
        level: secrets ? "high" : "medium",
        scoped: false,
        reason: `Can create new ${svc} resources in your account, but cannot change or delete anything that already exists.${alsoSecrets}${awsNote}`,
      };
    }
    if (secrets) {
      return {
        level: "high",
        scoped: false,
        reason: `Can read the contents of any ${svc} secret in your account${beyondOwn}.${awsNote}`,
      };
    }
    return { level: "medium", scoped: false, reason: `Can read any ${svc} resource in your account${beyondOwn}.${awsNote}` };
  }

  // Confined to the app's OWN resources — by tag (it created them) or by a name
  // pattern that genuinely narrows. It can never CREATE, change or delete a resource with a
  // different name/tag, so the blast radius is its own footprint.
  const where = tag ? "tagged as its own" : `named ${grant.resourceScope}`;
  const otherwise = tag ? "a different tag" : "a different name";

  // …with one honest exception. A tag-scoped grant containing a multi-resource birth compiles
  // to an extra statement with NO tag condition, because the birth must be able to name the
  // things it merely references — a foreign AMI, the VPC a security group is created in — or
  // AWS denies the whole call. Nothing untagged can be CREATED through that leg (the born
  // legs stay conditioned), but the grant can reference resources it does not own, and the
  // consent line must not say otherwise. I6: the rating may be stricter than the compiled
  // policy, never looser. See birthActions.ts, which both this and the compiler read.
  const referencesForeign = tag && grantHasReferencedLeg(grant);
  const exceptReferenced = referencesForeign
    ? ` It can also use existing ${svc} resources it did not create — such as a network or image — when creating its own, but cannot change or delete them.`
    : "";

  // …except on the control plane, where even a confined grant is privilege
  // management: an IAM role the app may create is a new identity in the account,
  // whatever its name. This used to be checked only for wildcard scopes, so exactly
  // the grants that matter — an `iam:` grant with a name pattern — skipped it.
  if (mutates && controlPlane) {
    return {
      level: "high",
      scoped: true,
      reason: `Can create, change and delete ${svc} identities and permissions ${where} — this controls who can do what in your account.`,
    };
  }
  const alsoSecrets = secrets ? ` It can also read the contents of those ${svc} secrets.` : "";
  return mutates
    ? {
        level: "medium",
        scoped: true,
        reason: `Can create, change and delete only ${svc} resources ${where} — it cannot change or delete any ${svc} resource with ${otherwise}.${exceptReferenced}${alsoSecrets}`,
      }
    : secrets
      ? {
          level: "medium",
          scoped: true,
          reason: `Can read the contents of ${svc} secrets ${where} — not just their names.`,
        }
      : { level: "low", scoped: true, reason: `Can read only ${svc} resources ${where}.` };
}

/**
 * Assess an entire permission set so the UI can warn the user (and nudge poppy
 * developers toward tightly-scoped, tagged policies). The overall {@link PolicyRisk.level}
 * is the worst of the per-grant levels and any set-level warning.
 */
export function assessPermissionSet(ps: PermissionSet): PolicyRisk {
  const grants = ps.grants.map((grant) => ({ grant, risk: assessGrant(grant) }));
  let level: RiskLevel = grants.reduce<RiskLevel>((acc, g) => maxRisk(acc, g.risk.level), "low");

  const warnings: string[] = [];
  if (!hasAttributionTags(ps)) {
    warnings.push(
      "Missing attribution tags — AgentsPoppy can't reliably track or tear down what this app creates.",
    );
    level = maxRisk(level, "medium");
  }

  return { level, grants, warnings, hasUnscopedGrants: grants.some((g) => !g.risk.scoped) };
}
