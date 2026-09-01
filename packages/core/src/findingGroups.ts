// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Panel 3 — "What to weigh before you say yes" (docs/specs/permission-presentation.md).
 *
 * Turns a permission set into findings a person can act on: grouped by what they MEAN,
 * worst first, each opening to the exact actions behind it. This replaces the single
 * verdict — a user can disagree with any one line, which is the point.
 *
 * Pure and computed here, not in the view, so the screen, the catalogue and any preview
 * render the same findings from the same code. Wording rules: name the resource in the
 * user's terms (serviceNoun), state each fact once, no meta-commentary — the screen
 * describes the account, never the design (rule 6, and the founder's 2026-09-01 review:
 * "you made statements without meaning").
 */
import {
  assessGrant,
  grantCanDestroy,
  grantCanMutate,
  grantExposesSecrets,
  grantIsTagScoped,
  hasAttributionTags,
  scopeIsUnbounded,
} from "./permissions";
import { awsCannotNarrowAction, grantCannotBeNarrowed, narrowableActions } from "./awsNarrowing";
import { serviceStake } from "./serviceStakes";
import type { PermissionGrant, PermissionSet } from "./types";

/** What a service's resources are, in the user's words. Fallback: the service name. */
const SERVICE_NOUNS: Record<string, string> = {
  ses: "email settings",
  route53: "DNS records",
  "cognito-idp": "sign-in directories",
  guardduty: "malware-scanning plans",
  ec2: "servers and networks",
  s3: "storage buckets",
  iam: "roles and permissions",
  cloudformation: "deployment stacks",
  amplify: "hosted websites",
  cloudwatch: "metrics",
  dynamodb: "database tables",
  lambda: "functions",
  logs: "logs",
  sns: "notification topics",
  events: "schedules",
  apigateway: "APIs",
  ssm: "stored settings and secrets",
  sts: "its own identity",
  pricing: "the AWS price list",
  bedrock: "AI model availability",
};

export function serviceNoun(service: string): string {
  return SERVICE_NOUNS[service.toLowerCase()] ?? `${service.toUpperCase()} resources`;
}

/** The exact actions behind a finding, bucketed the way a person reads them. */
export interface ActionBuckets {
  changes: string[];
  creates: string[];
  sends: string[];
  labels: string[];
  reads: string[];
  secrets: string[];
}

/**
 * Bucket actions for the drill-down. Uses the same classifier as the rating (via
 * single-action probes) so a bucket can never disagree with the risk level, with two
 * presentation refinements: tag writes are "labels" and Send* is "sends" — both classify
 * as changes for RISK, but a reader scanning "Changes:" should not find SendEmail there.
 */
export function bucketActions(service: string, actions: string[]): ActionBuckets {
  const b: ActionBuckets = { changes: [], creates: [], sends: [], labels: [], reads: [], secrets: [] };
  for (const a of actions) {
    const bare = a.includes(":") ? a.slice(a.indexOf(":") + 1) : a;
    const probe: PermissionGrant = { service, actions: [a], resourceScope: "*" };
    if (grantExposesSecrets(probe)) b.secrets.push(bare);
    else if (/^(tag|untag)/i.test(bare) || /^(add|remove|list)tags/i.test(bare)) b.labels.push(bare);
    else if (/^send/i.test(bare)) b.sends.push(bare);
    else if (!grantCanMutate(probe)) b.reads.push(bare);
    else if (!grantCanDestroy(probe)) b.creates.push(bare);
    else b.changes.push(bare);
  }
  return b;
}

/** How urgently a reader should look at a finding. */
export type Triage = "weigh" | "know" | "forced" | "confined";

export interface Finding {
  /** Stable key for tests and rendering. */
  id: string;
  triage: Triage;
  /** The headline, in the user's terms: "Can change and delete DNS records you did not create". */
  title: string;
  /** Services involved, lower-case. */
  services: string[];
  /** What this part of AWS controls (platform-authored; may be absent). */
  context?: string;
  /** The scope line: `scope * · 13 of 19 actions accept no resource limit from AWS`. */
  scopeLine: string;
  /** The developer's stated purpose, verbatim — a claim, to be labelled as one. */
  reason?: string;
  /** The exact actions, bucketed. */
  actions: ActionBuckets;
  /** True when supervision holds this for approval (unscoped only — never a confined grant). */
  gated: boolean;
}

const TRIAGE_ORDER: Record<Triage, number> = { weigh: 0, know: 1, forced: 2, confined: 3 };

function mergeBuckets(a: ActionBuckets, b: ActionBuckets): ActionBuckets {
  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    changes: uniq([...a.changes, ...b.changes]),
    creates: uniq([...a.creates, ...b.creates]),
    sends: uniq([...a.sends, ...b.sends]),
    labels: uniq([...a.labels, ...b.labels]),
    reads: uniq([...a.reads, ...b.reads]),
    secrets: uniq([...a.secrets, ...b.secrets]),
  };
}

function scopeLineFor(grant: PermissionGrant): string {
  const forcedCount = grant.actions.filter((a) => awsCannotNarrowAction(grant.service, a)).length;
  const n = grant.actions.length;
  if (grantCannotBeNarrowed(grant)) {
    return `scope ${grant.resourceScope} · ${n === 1 ? "this action accepts" : `all ${n} actions accept`} no resource limit from AWS`;
  }
  if (forcedCount > 0) {
    const narrowable = n - forcedCount;
    return `scope ${grant.resourceScope} · ${forcedCount} of ${n} actions accept no resource limit from AWS; ${narrowable} could be narrowed`;
  }
  return `scope ${grant.resourceScope}`;
}

/**
 * The findings, worst first. Grouping:
 *  - weigh:    each unscoped grant that can change or delete (one row per service), and
 *              each confined-but-high grant (the control plane), and a missing-labels
 *              warning when the manifest declares no attribution tags.
 *  - know:     unscoped reads that AWS could narrow (wholly or partly), and secret reads.
 *  - forced:   unscoped reads where every action is one AWS offers no way to narrow —
 *              merged into ONE row, because there is nothing per-service to decide.
 *  - confined: everything scoped and unremarkable, merged into one row a reader can skip.
 */
export function buildFindings(ps: PermissionSet): Finding[] {
  const out: Finding[] = [];
  const forcedReads: PermissionGrant[] = [];
  const confined: PermissionGrant[] = [];

  for (const grant of ps.grants) {
    const risk = assessGrant(grant);
    const svc = grant.service.toLowerCase();
    const noun = serviceNoun(svc);
    const wide = !grantIsTagScoped(grant) && scopeIsUnbounded(grant.resourceScope, grant.service);
    const base = {
      services: [svc],
      context: serviceStake(svc),
      scopeLine: scopeLineFor(grant),
      reason: grant.reason,
      actions: bucketActions(svc, grant.actions),
      gated: !risk.scoped,
    };

    if (wide && grantCanDestroy(grant)) {
      // Title from the actual buckets, not the risk class: TagResource classifies as
      // destructive (labelling someone else's directory IS changing it), but "delete"
      // in the headline when nothing here deletes would overstate — the founder's rule:
      // no statement the drill-down does not back.
      const canDelete = base.actions.changes.length > 0;
      out.push({
        ...base,
        id: `change-${svc}`,
        triage: "weigh",
        title: canDelete ? `Can change and delete ${noun} you did not create` : `Can change ${noun} you did not create`,
      });
    } else if (wide && grantCanMutate(grant)) {
      out.push({ ...base, id: `create-${svc}`, triage: "weigh", title: `Can create new ${noun} in your account` });
    } else if (!wide && risk.level === "high") {
      out.push({ ...base, id: `own-${svc}`, triage: "weigh", title: `Creates and manages its own ${noun}` });
    } else if (wide && grantExposesSecrets(grant)) {
      out.push({ ...base, id: `secrets-${svc}`, triage: "know", title: `Can read the contents of ${noun} you did not create` });
    } else if (wide && grantCannotBeNarrowed(grant)) {
      forcedReads.push(grant);
    } else if (wide) {
      const nar = narrowableActions(grant).length;
      out.push({
        ...base,
        id: `see-${svc}`,
        triage: "know",
        title: `Can look at ${noun} you did not create`,
        scopeLine: nar < grant.actions.length ? base.scopeLine : `scope ${grant.resourceScope} · could be narrowed`,
      });
    } else {
      confined.push(grant);
    }
  }

  if (forcedReads.length > 0) {
    out.push({
      id: "forced-reads",
      triage: "forced",
      title: `Reads ${forcedReads.map((g) => serviceNoun(g.service)).join(", ")}`,
      services: forcedReads.map((g) => g.service.toLowerCase()),
      context: "AWS offers no narrower form of these permissions — they accept no resource limit at all, so this is the tightest grant that works.",
      scopeLine: `scope * · ${forcedReads.reduce((n, g) => n + g.actions.length, 0)} read actions, none narrowable`,
      reason: forcedReads.map((g) => g.reason).filter(Boolean).join(" ") || undefined,
      actions: forcedReads.reduce((acc, g) => mergeBuckets(acc, bucketActions(g.service, g.actions)), bucketActions("", [])),
      gated: true,
    });
  }

  if (confined.length > 0) {
    const services = [...new Set(confined.map((g) => g.service.toLowerCase()))].sort();
    // "else" only when there IS anything else — for a fully-confined poppy this row is
    // the whole story, and "everything else" with nothing above it reads as a mistake.
    const onlyRow = out.length === 0 && forcedReads.length === 0;
    out.push({
      id: "confined",
      triage: "confined",
      title: onlyRow ? "Everything is confined to its own resources" : "Everything else is confined to its own resources",
      services,
      context: `${confined.length} permission${confined.length === 1 ? "" : "s"} across ${services.length} service${services.length === 1 ? "" : "s"}, each limited to resources carrying this poppy's name or label.`,
      scopeLine: confined.map((g) => g.resourceScope).filter((v, i, a) => a.indexOf(v) === i).slice(0, 4).join(" · "),
      actions: confined.reduce((acc, g) => mergeBuckets(acc, bucketActions(g.service, g.actions)), bucketActions("", [])),
      gated: false,
    });
  }

  if (!hasAttributionTags(ps)) {
    out.push({
      id: "no-labels",
      triage: "weigh",
      title: "Doesn’t label what it makes, so its footprint can’t be fully tracked",
      services: [],
      context: "AgentsPoppy finds a poppy's resources by the labels they carry. Without them, the map of what it built and the final sweep of “remove everything” cannot be complete.",
      scopeLine: "manifest declares no attribution labels",
      actions: bucketActions("", []),
      gated: false,
    });
  }

  return out.sort((a, b) => TRIAGE_ORDER[a.triage] - TRIAGE_ORDER[b.triage]);
}
