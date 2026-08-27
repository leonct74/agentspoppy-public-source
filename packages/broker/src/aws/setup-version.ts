// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * "Is the broker role the user has deployed the one this host expects?"
 *
 * The guardrails that protect an account live in the user's OWN AWS, written there
 * once by the bootstrap stack. Shipping a tightened guardrail therefore changes
 * nothing until that user re-applies setup — and until this module existed, nothing
 * recorded what was deployed, so "re-apply setup" was a button nobody knew to press
 * (docs/specs/broker-role-v2.md).
 *
 * The carrier is the stack's `TemplateVersion` Output. Outputs travel INSIDE the
 * template, so the value is present whether the stack was deployed by the app or
 * pasted into the CloudFormation console by hand — unlike a stack tag, which only
 * the app's own deploy path would set.
 *
 * Pure and unit-tested; the AWS read lives in bootstrap.ts.
 */
import { TEMPLATE_VERSION } from "./role-template";

/**
 * - `current`  — deployed version is the one we ship (or newer, e.g. a downgraded app).
 * - `outdated` — provably older. Includes a stack with NO version output at all: that
 *   absence is exactly the signature of every stack deployed before versioning existed.
 * - `unknown`  — we could not read it. Never treated as up-to-date, but phrased
 *   honestly: "couldn't check", not "is out of date".
 * - `absent`   — there is no setup stack. Not a staleness problem; the user has a
 *   different, louder path for that ("Connect your AWS"), so this must NOT nag.
 * - `pending`  — the stack is mid-deploy, so its outputs are whatever the previous
 *   version left behind. Reading those as "outdated" would nag a user *while they
 *   are in the middle of fixing it*, which is the fastest way to teach someone to
 *   ignore the banner. Silent, and correct again on the next check.
 */
export type SetupVersionState = "current" | "outdated" | "unknown" | "absent" | "pending";

export interface SetupVersionStatus {
  state: SetupVersionState;
  /** What is deployed, when we could tell. `1` for a pre-versioning stack. */
  deployed: number | null;
  /** What this host ships. */
  expected: number;
  /** Why we can't tell — surfaced to the user verbatim, so keep it plain. */
  reason?: string;
}

/** The outcome of trying to read the bootstrap stack, so the reasons stay honest. */
export type SetupStackRead =
  | { ok: true; outputs: Record<string, string> }
  /** The stack genuinely is not there. */
  | { ok: false; kind: "absent" }
  /** The stack exists but is mid-deploy; its outputs are not yet meaningful. */
  | { ok: false; kind: "pending" }
  /** We could not read it — denied, throttled, region unreachable, anything. */
  | { ok: false; kind: "unreadable"; reason: string };

/**
 * The version a stack is running when it carries no `TemplateVersion` output.
 * Not a guess: the output was added in v2, so its absence IS v1.
 */
const PRE_VERSIONING = 1;

export function setupVersionStatus(read: SetupStackRead, expected: number = TEMPLATE_VERSION): SetupVersionStatus {
  if (!read.ok) {
    if (read.kind === "absent") return { state: "absent", deployed: null, expected };
    if (read.kind === "pending") return { state: "pending", deployed: null, expected };
    return { state: "unknown", deployed: null, expected, reason: read.reason };
  }

  const raw = read.outputs.TemplateVersion;
  if (raw === undefined || raw.trim() === "") {
    return { state: "outdated", deployed: PRE_VERSIONING, expected };
  }

  // A value we can't parse is NOT a reason to relax. Anything other than a plain
  // positive integer means we're reading something we don't understand, and the
  // safe reading of "I don't understand this" is never "you're fine".
  const parsed = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return {
      state: "unknown",
      deployed: null,
      expected,
      reason: `the setup stack reports an unrecognised version ("${raw}")`,
    };
  }

  // A version NEWER than we ship is current, not stale: it means the app was
  // downgraded, and telling that user to "update" would roll their guardrails BACK.
  return { state: parsed >= expected ? "current" : "outdated", deployed: parsed, expected };
}

/** Whether the user should be told. `absent`, `pending` and `current` stay silent. */
export function needsSetupUpdate(status: SetupVersionStatus): boolean {
  return status.state === "outdated" || status.state === "unknown";
}
