// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The certification harness — the engine behind the "leaves-no-trace" guarantee.
 *
 * It exercises a poppy's REAL lifecycle against a connection the developer has already
 * deployed and used, then asserts the cloud is clean afterwards:
 *
 *   1. snapshot the tagged footprint BEFORE teardown (proof there was something to remove);
 *   2. run the poppy's declared teardown hook (out-of-stack cleanup), if any;
 *   3. tear the connection down for real (delete stacks, empty buckets, deactivate SES);
 *   4. sweep by the `agentspoppy:app` tag again — and PASS only if nothing remains.
 *
 * The result binds to `{appId, version, manifestHash}`, so a passing report identifies an
 * exact build. A developer self-runs this locally (the `scripts/certify.ts` CLI) while
 * iterating; the platform re-runs this SAME harness at submission and signs the result —
 * which is why the harness logic lives here, decoupled from the CLI and from signing.
 *
 * Pure of process/arg/IO concerns: it composes a {@link BrokerService} (+ an optional
 * {@link ExtensionRegistry} for the teardown hook), so it's unit-testable with stub
 * providers. The CLI wires the real AWS-backed providers and does the printing/signing.
 */
import { createHash } from "node:crypto";
import type { CertificationReport, CertificationSubject, LeaveNoTraceCertificate, ResidualResource } from "@agentspoppy/core";
import type { ExtensionManifest } from "@agentspoppy/extension-sdk";
import type { BrokerService } from "./service";
import type { ExtensionRegistry } from "./extensions";
import type { ExistenceVerifier } from "./aws";

/**
 * Deterministic JSON of a value with object keys sorted recursively — so the manifest
 * hash depends on content, not key ordering or formatting. Arrays keep their order
 * (grant order is significant; see `grantsSignature`).
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The canonical manifest hash a certificate's subject pins. SHA-256 hex over the whole manifest. */
export function manifestHash(manifest: ExtensionManifest): string {
  return createHash("sha256").update(stableStringify(manifest)).digest("hex");
}

/** The subject a certificate binds to, derived from a manifest. */
export function subjectFor(manifest: ExtensionManifest): CertificationSubject {
  return { appId: manifest.id, version: manifest.version, manifestHash: manifestHash(manifest) };
}

export interface CertifyDeps {
  service: BrokerService;
  /** Optional — present so the poppy's declared teardown hook runs before the stack delete. */
  registry?: ExtensionRegistry;
  /**
   * Optional existence verifier. When supplied, each post-teardown tag hit is confirmed before
   * it counts as a leftover — so a lagging tag index (which can list a resource for a long time
   * AFTER it's deleted) can't fail a clean teardown. Confirmed-present → leftover; confirmed-gone
   * → dropped; can't-tell → a warning, never a failure.
   */
  verifier?: ExistenceVerifier;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
  /**
   * How long to wait for a lagging tag index BEFORE teardown, when CloudFormation says stacks
   * stand but the sweep sees nothing: re-sweep `attempts` times, `delayMs` apart. Defaults to
   * six tries twenty seconds apart (about two minutes). Injectable for tests.
   */
  warmUp?: { attempts: number; delayMs: number };
  /** Injectable sleep, so the warm-up is instant under test. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each warm-up wait — the CLI prints progress with it, since a wait can be long. */
  onWarmUp?: (attempt: number, attempts: number) => void;
}

export interface CertifyOptions {
  /** The connection to certify — must already be deployed + exercised against real AWS. */
  connectionId: string;
  /** The manifest of the build under test; its id MUST match the connection's app. */
  manifest: ExtensionManifest;
}

/**
 * Run the leaves-no-trace lifecycle against an already-deployed connection and produce a
 * {@link CertificationReport}. This performs a REAL teardown — callers gate it behind the
 * developer's explicit confirmation. Throws only on a setup error (unknown connection, or a
 * manifest whose id doesn't match the connection's app); a dirty teardown is a *failed
 * report*, not a throw, so the leftovers can be surfaced.
 */
export async function runCertification(deps: CertifyDeps, opts: CertifyOptions): Promise<CertificationReport> {
  const { service, registry } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const { manifest } = opts;

  const conn = await service.getConnection(opts.connectionId); // throws BrokerError("not_found") if missing
  if (conn.app.id !== manifest.id) {
    throw new Error(
      `manifest id "${manifest.id}" does not match the connection's app "${conn.app.id}" — ` +
        `certify the build that owns this connection`,
    );
  }

  // 1. Footprint BEFORE — what this poppy currently has tagged. A teardown that removes
  //    nothing proves nothing, so an empty footprint is recorded as a warning (not a pass-blocker).
  //
  //    But the sweep can also be BLIND: the Resource Groups Tagging index is eventually
  //    consistent, and on 2026-09-10 it answered "0" for AuditPoppy while a live, fully tagged
  //    stack stood — and the run still certified, because `residualsAfter` comes from the SAME
  //    sweep and a sweep that answers 0 for a standing stack answers 0 for anything. So the
  //    harness asks CloudFormation what stands (a different system, not the index): stacks up
  //    but nothing tagged means the index has not caught up. It waits for it, re-sweeping a few
  //    times; if the sweep never sees the stack, the run is UNVERIFIED — not a failure of the
  //    poppy, not a pass either, and no certificate.
  const unverified: string[] = [];
  let sweepBeforeFailed = false;
  const sweepBefore = () =>
    service.getResiduals(conn.id).catch(() => {
      sweepBeforeFailed = true;
      return [] as ResidualResource[];
    });
  let footprintBefore = await sweepBefore();
  // What CloudFormation says stands — asked whenever the sweep is empty, so the report shows
  // both systems side by side. `null` = the question itself could not be answered.
  let stacksStanding: string[] | null | undefined;
  let blindBefore = false;
  if (footprintBefore.length === 0) {
    try {
      stacksStanding = (await service.getInventory(conn.id)).stacks
        .filter((s) => s.stackExists)
        .map((s) => s.stackName);
    } catch (e) {
      // FAIL CLOSED. Three AuditPoppy runs certified through this branch (2026-09-10/11): the
      // read failed, was caught into "nothing stands", the warm-up was skipped, and the blind
      // sweep certified — the very shape this block exists to eliminate. "I could not tell what
      // stands" is grounds for unverified, never for a pass.
      stacksStanding = null;
      blindBefore = true;
      unverified.push(
        `Could not read what stands from CloudFormation (${e instanceof Error ? e.message : String(e)}) while the ` +
          `tag sweep saw nothing before teardown — so this run cannot tell whether the sweep was blind, and ` +
          `"0 residual" after teardown is not evidence. Fix the read, then run certify again.`,
      );
    }
    if (stacksStanding && stacksStanding.length > 0) {
      const warmUp = deps.warmUp ?? { attempts: 6, delayMs: 20_000 };
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      for (let i = 0; i < warmUp.attempts && footprintBefore.length === 0; i++) {
        deps.onWarmUp?.(i + 1, warmUp.attempts);
        await sleep(warmUp.delayMs);
        footprintBefore = await sweepBefore();
      }
      if (footprintBefore.length === 0) {
        blindBefore = true;
        unverified.push(
          `The tag sweep saw nothing before teardown while ${stacksStanding.length} stack(s) stood (${stacksStanding.join(", ")}) — ` +
            (sweepBeforeFailed ? "it could not be read, or " : "") +
            `the tag index had not caught up. A sweep that answers 0 for a standing stack answers 0 for anything, ` +
            `so "0 residual" after teardown is not evidence this run. Run certify again once the index is warm ` +
            `(--wait-for-index lets it wait longer).`,
        );
      }
    }
  }

  // 2+3. The real teardown: run the declared out-of-stack cleanup hook (if any) then delete
  //    stacks (emptying buckets / deactivating SES as needed). The hook runs INSIDE
  //    service.teardown's window, so a supervised poppy's cleanup creds vend without an
  //    interactive approval — essential for a headless certification run.
  const teardownHookRun = !!(registry && manifest.teardown?.endpoint);
  const runHook =
    teardownHookRun && registry ? (cid: string) => registry.runTeardownHook(cid) : undefined;
  // 4. After teardown, the generic tag sweep — anything still tagged is a leftover candidate.
  //    hostCleanup is OFF: certification measures the POPPY's own leaves-no-trace compliance,
  //    and the host's deletion backstop must not paper over a non-compliant poppy.
  const {
    deletedStacks,
    residuals: rawResiduals,
    cleanupAuthProblem,
  } = await service.teardown(conn.id, { runHook, hostCleanup: false });
  // The twin of the blind sweep above: a sweep AFTER teardown that could not be read comes
  // back as an empty list with `cleanupAuthProblem` set (service.teardown never lets a denied
  // sweep read as "clean" in the UI); the certificate must not either.
  if (cleanupAuthProblem) {
    unverified.push(
      `The sweep after teardown could not be read in at least one region (denied or failed), so "0 residual" ` +
        `is not evidence this run. Fix the account's read access, then run certify again.`,
    );
  }
  // First-hand proof, independent of every read above: if the harness itself deleted stacks,
  // something stood — and a sweep that saw nothing before was blind, whatever CloudFormation
  // said or failed to say. This is the rule that holds when everything else lies.
  if (!blindBefore && footprintBefore.length === 0 && deletedStacks.length > 0) {
    unverified.push(
      `The tag sweep saw nothing before teardown, yet teardown deleted ${deletedStacks.length} stack(s) ` +
        `(${deletedStacks.join(", ")}) — first-hand proof the sweep was blind, so "0 residual" after teardown is ` +
        `not evidence this run. Run certify again once the tag index is warm (--wait-for-index lets it wait longer).`,
    );
  }

  // Confirm each candidate exists before it counts against the poppy: the tag index is
  // eventually consistent and can list a resource long after it's deleted, so a raw hit is
  // not proof of a leftover. Confirmed-present fails; confirmed-gone is dropped; can't-tell warns.
  const problems: string[] = [];
  const warnings: string[] = [];
  let residualsAfter = rawResiduals;
  if (deps.verifier && rawResiduals.length > 0) {
    const verifier = deps.verifier;
    const classified = await Promise.all(
      rawResiduals.map(async (r) => ({ r, status: await verifier.verify(r.region, r.arn).catch(() => "unverified" as const) })),
    );
    residualsAfter = classified.filter((c) => c.status === "present").map((c) => c.r);
    const unverified = classified.filter((c) => c.status === "unverified").length;
    if (unverified > 0) {
      warnings.push(
        `${unverified} tagged resource(s) couldn't be confirmed present — most likely a lagging tag index for ` +
          `something already deleted. They're not counted as leftovers; re-run to confirm they've dropped out.`,
      );
    }
  }

  const account = (await service.listAccounts()).find((a) => a.id === conn.accountId);

  if (residualsAfter.length > 0) {
    const byType = summarizeByType(residualsAfter);
    problems.push(
      `${residualsAfter.length} resource(s) still tagged agentspoppy:app=${manifest.id} after teardown: ${byType}. ` +
        `Put every resource in your tagged CloudFormation stack, or remove out-of-stack ones in a teardown hook.`,
    );
  }
  if (footprintBefore.length === 0 && deletedStacks.length === 0) {
    warnings.push(
      "Nothing tagged with your app id was found before teardown — deploy and USE the poppy first so " +
        "certification exercises a real cleanup (e.g. with objects in your buckets), not an empty no-op.",
    );
  }

  return {
    subject: subjectFor(manifest),
    accountId: account?.accountId ?? "unknown",
    regions: account?.regions ?? [],
    footprintBefore,
    deletedStacks,
    residualsAfter,
    teardownHookRun,
    // Clean AND testable. An unverified run is not a pass: nothing was proven either way.
    passed: residualsAfter.length === 0 && unverified.length === 0,
    problems,
    warnings,
    unverified,
    ...(stacksStanding !== undefined ? { stacksStanding } : {}),
    ranAt: now(),
  };
}

export interface IssueOptions {
  /** Who is issuing: a local dev self-run, or the platform. Defaults to "self". */
  issuer?: LeaveNoTraceCertificate["issuer"];
  /**
   * Signing function over the canonical subject, supplied by the platform at submission.
   * Omitted for a local self-run, which yields an unsigned certificate. The curated
   * directory only honours certificates whose signature verifies — see MARKETPLACE M7.
   */
  sign?: (canonicalSubject: string) => string;
  /** Injectable clock for deterministic tests. */
  now?: () => string;
}

/**
 * Wrap a PASSED report as an issued certificate. Refuses to issue for a failed report —
 * you cannot certify a teardown that left a mess. The canonical subject string passed to
 * `sign` is stable, so the platform's signature is reproducible/verifiable.
 */
export function issueCertificate(report: CertificationReport, opts: IssueOptions = {}): LeaveNoTraceCertificate {
  if (report.unverified.length > 0) {
    throw new Error(
      "cannot issue a leaves-no-trace certificate for an unverified report — the run could not tell " +
        `whether anything was left: ${report.unverified.join(" ")}`,
    );
  }
  if (!report.passed) {
    throw new Error(
      "cannot issue a leaves-no-trace certificate for a failed report — " +
        `${report.residualsAfter.length} resource(s) remained after teardown`,
    );
  }
  const now = opts.now ?? (() => new Date().toISOString());
  const issuer = opts.issuer ?? "self";
  const signature = opts.sign ? opts.sign(stableStringify(report.subject)) : undefined;
  return {
    schema: "agentspoppy.leaves-no-trace/1",
    subject: report.subject,
    issuer,
    issuedAt: now(),
    report,
    ...(signature ? { signature } : {}),
  };
}

/** Compact "n×type" summary for a residual list, most-common first — for the failure message. */
function summarizeByType(residuals: { resourceType: string }[]): string {
  const counts = new Map<string, number>();
  for (const r of residuals) counts.set(r.resourceType, (counts.get(r.resourceType) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${n}×${type}`)
    .join(", ");
}
