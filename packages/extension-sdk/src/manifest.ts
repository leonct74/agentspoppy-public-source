// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The extension manifest (`extension.json`) — the contract an extension ships so
 * the host can run it sandboxed.
 *
 * The manifest is the SINGLE SOURCE OF TRUTH for an extension's declared AWS
 * scope: the host reads `permissionSet` from here on every load and reconciles the
 * connection to it, so a connection's scope can never silently drift from what the
 * extension actually declares (the failure mode that plagued the two-app model,
 * where the broker stored a scope at connect time and never refreshed it).
 *
 * Pure: types + a structural validator. No fs, no AWS — the host does the IO and the
 * broker's risk model (packages/core) judges the permission set separately.
 */
import type { PermissionGrant, PermissionSet } from "@agentspoppy/core";
import { validateNetworkDeclaration } from "@agentspoppy/core";
import { type Capability, isCapability } from "./capabilities";

/** The frontend the host renders in a sandboxed webview tab. */
export interface ExtensionFrontend {
  /** Path, relative to the extension root, to the built entry HTML. */
  entry: string;
}

/** How the host talks to a spawned backend child process. */
export type BackendTransport = "http" | "stdio";

/**
 * The runtime a backend needs (docs/RUNTIMES.md — declare, don't ship).
 *
 * - `"node22"` → `entry` is a plain CJS bundle (e.g. `backend/index.cjs`) the host runs
 *   on its OWN shared Node runtime — the poppy ships ~no runtime bytes at all.
 * - `"native"` → `entry` is a small self-contained executable of the poppy's own code.
 *   Bundling a language runtime inside it (Node SEA, Python, Electron…) fails
 *   certification: runtimes are provided by the platform, never shipped by poppies.
 *   A native backend CANNOT be confined (there is no runtime of ours inside it to
 *   enforce an allowlist), so it must opt out of confinement explicitly — and an
 *   unconfined backend cannot be listed in the catalogue at all (RUNTIMES.md R7).
 *
 * **Defaults to `"node22"`.** It was `"native"` before 0.3.5, when confinement was
 * opt-in; omitting the field now gives you the confinable runtime, not the opaque one.
 */
export type BackendRuntime = "node22" | "native";

/** An optional backend the host spawns as a supervised child process. */
export interface ExtensionBackend {
  /** Path, relative to the extension root, to the backend the host spawns:
   *  an executable for `runtime: "native"`, a CJS bundle for `runtime: "node22"`. */
  entry: string;
  /**
   * Transport between host and backend. "http" → the backend listens on a loopback
   * port the HOST assigns and injects (no fixed-port discovery); "stdio" → framed
   * messages over the child's stdin/stdout. Defaults to "http".
   */
  transport?: BackendTransport;
  /** The runtime this backend needs. Defaults to `"node22"` — see {@link BackendRuntime}. */
  runtime?: BackendRuntime;
  /**
   * How far the host confines this backend's access to the user's machine.
   *
   * - `"strict"` → the host runs it under the runtime's permission model with an
   *   allowlist of exactly three places: its own install directory (read), the data
   *   directory the host assigns it in {@link BackendBootstrap.dataDir} (read/write),
   *   and the OS temp directory (read/write). Everything else on the machine —
   *   `~/.aws/credentials` above all — is denied by the runtime, and spawning child
   *   processes is denied outright. Requires `runtime: "node22"`.
   * - `"none"` → no confinement beyond the OS user's own permissions, which is to say:
   *   it can read whatever you can read, `~/.aws/credentials` included.
   *
   * **`"strict"` IS THE DEFAULT (since 0.3.5). Omitting this field confines the
   * backend.** Running unconfined requires writing `"none"` here deliberately — it can
   * no longer happen by omission or oversight.
   *
   * Opting out is additionally blocked at two independent gates, so an unconfined
   * backend cannot reach a user through the catalogue:
   *  1. **Listing (server-side).** A new listing whose backend is not `"strict"` is
   *     refused by the submissions API, which re-reads the manifest from the uploaded
   *     bytes rather than trusting the form; and the mechanical update review refuses a
   *     `strict` → `none` downgrade on an existing listing.
   *  2. **The host.** The broker logs an explicit unconfined-start warning, and the
   *     manifest validator fails a package that is not confined.
   *
   * The single sanctioned exception is a NAMED, one-release data migration (moving
   * pre-confinement state out of the user's home can only run unconfined), with the
   * confined successor named in the release notes — the VM-Poppy 0.1.11→0.1.12 and
   * MailPoppy 0.1.16→0.1.17 pattern. See docs/CONFINEMENT-MIGRATION.md.
   */
  isolation?: BackendIsolation;
}

/** See {@link ExtensionBackend.isolation}. */
export type BackendIsolation = "strict" | "none";

/**
 * The runtime a backend ACTUALLY runs on, applying the default.
 *
 * Use this rather than reading `backend.runtime` directly: the default changed in 0.3.5
 * (`"native"` → `"node22"`), and every reader must agree on what an omitted field means.
 */
export function effectiveRuntime(backend: Pick<Partial<ExtensionBackend>, "runtime">): BackendRuntime {
  return backend.runtime ?? "node22";
}

/**
 * How the host will ACTUALLY confine a backend, applying the default.
 *
 * `"strict"` unless the manifest deliberately says `"none"`. Before 0.3.5 this defaulted
 * the other way, so a poppy that simply never thought about confinement ran with the
 * user's full file access — including the AWS credentials the whole mechanism exists to
 * never hand over. Omission is now the safe answer; opting out has to be written down.
 */
export function effectiveIsolation(backend: Pick<Partial<ExtensionBackend>, "isolation">): BackendIsolation {
  return backend.isolation ?? "strict";
}

/**
 * An optional cleanup hook for resources a poppy creates OUTSIDE its CloudFormation
 * stack (e.g. Route 53 records, an account-level SES identity) and therefore can't be
 * removed by a stack delete. The host POSTs this backend route at the START of teardown,
 * before deleting the stack(s), so the poppy can remove them. Most poppies don't need it:
 * if everything you create lives in one tagged stack, the stack delete + the host's tag
 * sweep already leave no trace. The hook MUST be idempotent (it may be called more than
 * once, including after a partial teardown). Requires a backend.
 */
export interface ExtensionTeardown {
  /** A backend route (e.g. "/teardown") the host POSTs to begin app-specific cleanup. */
  endpoint: string;
}

/**
 * Everything the host needs to run an extension: identity, the user-approved AWS
 * permission set (same grant shape the broker already enforces), the frontend tab,
 * an optional host-spawned backend, and the host-bridge capabilities the frontend
 * is allowed to call.
 */
/**
 * One third party (or developer-operated service) that user data can reach —
 * an entry in the poppy's compliance dossier (docs/specs/compliance-dossier.md).
 * Rendered in the developer's-own-words register: attributed, reviewed at
 * listing, never in the platform's voice.
 */
export interface ComplianceSubprocessor {
  /** The service, by the name a user could look up — usually its hostname, e.g. "mailpoppy.com". */
  name: string;
  /** Who operates it (company or developer name). */
  operator?: string;
  /** What the service is for, one plain phrase. */
  purpose: string;
  /** Exactly what data reaches it — and, when relevant, what never does. */
  dataShared: string;
}

/**
 * The developer-declared slice of the compliance dossier — three fields, and only
 * three. Everything else in the dossier is platform-generated from the manifest and
 * the platform's own mechanisms, so a manifest cannot write marketing into its own
 * audit package. An EMPTY `subprocessors` array is the strongest label a poppy can
 * carry ("No subprocessors — no user data leaves your cloud") and must be stated
 * deliberately, which is why the field is required rather than defaulted.
 */
export interface ComplianceDeclaration {
  /** What user data the poppy handles and where it lives, one or two sentences. */
  dataHandled: string;
  /** Services user data can reach beyond the user's own cloud. Empty = none. */
  subprocessors: ComplianceSubprocessor[];
  /** Where a security team reports a vulnerability — an email address or https URL. */
  securityContact: string;
}

export interface ExtensionManifest {
  /** Stable reverse-DNS id, e.g. "com.mailpoppy.desktop". */
  id: string;
  /** Display name shown in the host sidebar / tab, e.g. "MailPoppy". */
  name: string;
  /** Semver of the extension build. */
  version: string;
  /** One-line description for the registry + monitoring view. */
  description?: string;
  /** Path (relative to the extension root) to an icon asset. */
  icon?: string;
  /**
   * Where users file bugs — the public issue tracker, e.g.
   * "https://github.com/you/your-poppy/issues". The mandatory Feedback tab's "Report a bug"
   * button opens it in the system browser, so a bug lands somewhere everyone (including an AI
   * reading the repository) can see it, rather than in a private inbox. Must be https.
   */
  bugsUrl?: string;
  /** The AWS access this extension declares — broker-enforced, user-approved. */
  permissionSet: PermissionSet;
  frontend: ExtensionFrontend;
  /** Present only for extensions that need a Node/native backend (e.g. MailPoppy). */
  backend?: ExtensionBackend;
  /** Optional cleanup hook for out-of-stack resources; the host POSTs it before teardown. */
  teardown?: ExtensionTeardown;
  /**
   * The developer-declared slice of the compliance dossier
   * (docs/specs/compliance-dossier.md). Optional today so no existing poppy breaks;
   * the catalogue requires it once the first-party fleet has declared (the
   * network-egress phase-1c pattern, in the corrected order: declare, then require).
   */
  compliance?: ComplianceDeclaration;
  /** The host-bridge capabilities the frontend may call. Every entry must be known. */
  capabilities: Capability[];
}

export interface ManifestValidationResult {
  ok: boolean;
  /** Every problem found (empty when ok). */
  errors: string[];
}

// Reverse-DNS-ish: at least two dot-separated alphanumeric/hyphen labels.
const ID_RE = /^[a-z0-9]+([.-][a-z0-9]+)+$/i;
// Semver core with an optional -prerelease / +build suffix.
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

/**
 * Validate a parsed manifest object structurally. Pure; collects ALL problems and
 * never throws, so a tool can show the author everything wrong at once.
 */
/** Longest a per-grant `reason` may be — long enough to explain a scope, short enough to read. */
export const GRANT_REASON_MAX = 600;

export function validateManifest(value: unknown): ManifestValidationResult {
  const errors: string[] = [];
  if (!value || typeof value !== "object") return { ok: false, errors: ["manifest must be an object"] };
  const m = value as Partial<ExtensionManifest>;

  if (typeof m.id !== "string" || !ID_RE.test(m.id)) {
    errors.push("id must be a reverse-DNS string, e.g. com.example.app");
  }
  if (typeof m.name !== "string" || m.name.trim() === "") errors.push("name is required");
  if (typeof m.version !== "string" || !SEMVER_RE.test(m.version)) errors.push("version must be semver, e.g. 1.2.3");
  if (m.description !== undefined && typeof m.description !== "string") errors.push("description must be a string");
  if (m.icon !== undefined && typeof m.icon !== "string") errors.push("icon must be a path string");
  if (m.bugsUrl !== undefined && (typeof m.bugsUrl !== "string" || !/^https:\/\/\S+$/.test(m.bugsUrl))) {
    errors.push("bugsUrl must be an https URL to your public issue tracker");
  }

  validatePermissionSet(m.permissionSet, errors);

  if (!m.frontend || typeof m.frontend !== "object" || typeof (m.frontend as ExtensionFrontend).entry !== "string" || (m.frontend as ExtensionFrontend).entry.trim() === "") {
    errors.push("frontend.entry (path to the built UI) is required");
  }

  if (m.backend !== undefined) {
    const b = m.backend as Partial<ExtensionBackend>;
    if (typeof b.entry !== "string" || b.entry.trim() === "") errors.push("backend.entry must be a path when backend is present");
    if (b.transport !== undefined && b.transport !== "http" && b.transport !== "stdio") {
      errors.push('backend.transport must be "http" or "stdio"');
    }
    if (b.runtime !== undefined && b.runtime !== "node22" && b.runtime !== "native") {
      errors.push('backend.runtime must be "node22" or "native"');
    }
    if (b.isolation !== undefined && b.isolation !== "strict" && b.isolation !== "none") {
      errors.push('backend.isolation must be "strict" or "none"');
    }
    // A native executable is opaque to us: there is no runtime of ours inside it to
    // enforce an allowlist. Claiming confinement we cannot deliver would be worse than
    // not offering it, so the combination is rejected rather than silently ignored.
    //
    // Checked on the EFFECTIVE values, not the written ones: since 0.3.5 isolation
    // defaults to "strict", so declaring `runtime: "native"` and saying nothing about
    // isolation now asks for the impossible combination. That is deliberate — a native
    // backend must state `"isolation": "none"` out loud, which is exactly the choice the
    // listing gate refuses. It can no longer be arrived at by omission.
    if (effectiveIsolation(b) === "strict" && effectiveRuntime(b) !== "node22") {
      errors.push(
        'backend.isolation "strict" requires backend.runtime "node22" — a native executable cannot be confined by the host. ' +
          'Since 0.3.5 isolation defaults to "strict", so a native backend must declare "isolation": "none" explicitly ' +
          "(and an unconfined backend cannot be listed — RUNTIMES.md R7).",
      );
    }
  }

  if (m.teardown !== undefined) {
    const t = m.teardown as Partial<ExtensionTeardown>;
    if (typeof t.endpoint !== "string" || !t.endpoint.startsWith("/")) {
      errors.push('teardown.endpoint must be a backend path starting with "/", e.g. "/teardown"');
    }
    if (m.backend === undefined) errors.push("teardown requires a backend (the hook is a backend route)");
  }

  if (!Array.isArray(m.capabilities)) {
    errors.push("capabilities must be an array");
  } else {
    const unknown = m.capabilities.filter((c) => !isCapability(c));
    if (unknown.length > 0) errors.push(`unknown capabilities: ${unknown.map(String).join(", ")}`);
  }

  if (m.compliance !== undefined) validateCompliance(m.compliance, errors);

  return { ok: errors.length === 0, errors };
}

/** Longest `compliance.dataHandled` may be — two honest sentences, not a privacy policy. */
export const COMPLIANCE_DATA_HANDLED_MAX = 500;
/** Most subprocessors a manifest may name — more than this is an architecture review, not a list. */
export const COMPLIANCE_SUBPROCESSORS_MAX = 20;
const COMPLIANCE_FIELD_MAX = 300;
// An email address (loose) or an https URL — where a security team files a report.
const SECURITY_CONTACT_RE = /^([^\s@]+@[^\s@]+\.[^\s@]+|https:\/\/\S+)$/;

/**
 * `compliance` is documentation, not scope — but a malformed declaration must be an
 * error, never silently rendered: a dossier built from garbage would be worse than
 * the honest "packaged before the declaration existed" state (the same rule as a
 * malformed `network.machine`: a typo may not buy the quiet mode).
 */
function validateCompliance(value: unknown, errors: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push("compliance must be an object with dataHandled, subprocessors and securityContact");
    return;
  }
  const c = value as Partial<ComplianceDeclaration>;
  if (typeof c.dataHandled !== "string" || c.dataHandled.trim() === "") {
    errors.push("compliance.dataHandled must state, in a sentence or two, what user data the poppy handles and where it lives");
  } else if (c.dataHandled.length > COMPLIANCE_DATA_HANDLED_MAX) {
    errors.push(`compliance.dataHandled must be at most ${COMPLIANCE_DATA_HANDLED_MAX} characters`);
  }
  if (!Array.isArray(c.subprocessors)) {
    errors.push('compliance.subprocessors must be an array — [] declares "no user data leaves your cloud", and it must be stated, not omitted');
  } else {
    if (c.subprocessors.length > COMPLIANCE_SUBPROCESSORS_MAX) {
      errors.push(`compliance.subprocessors may name at most ${COMPLIANCE_SUBPROCESSORS_MAX} services`);
    }
    for (const [i, sub] of c.subprocessors.entries()) {
      if (!sub || typeof sub !== "object") {
        errors.push(`compliance.subprocessors[${i}] must be an object with name, purpose and dataShared`);
        continue;
      }
      const s = sub as Partial<ComplianceSubprocessor>;
      for (const field of ["name", "purpose", "dataShared"] as const) {
        const v = s[field];
        if (typeof v !== "string" || v.trim() === "" || v.length > COMPLIANCE_FIELD_MAX) {
          errors.push(`compliance.subprocessors[${i}].${field} must be a non-empty string of at most ${COMPLIANCE_FIELD_MAX} characters`);
        }
      }
      if (s.operator !== undefined && (typeof s.operator !== "string" || s.operator.trim() === "" || s.operator.length > COMPLIANCE_FIELD_MAX)) {
        errors.push(`compliance.subprocessors[${i}].operator must be a non-empty string of at most ${COMPLIANCE_FIELD_MAX} characters`);
      }
    }
  }
  if (typeof c.securityContact !== "string" || !SECURITY_CONTACT_RE.test(c.securityContact)) {
    errors.push("compliance.securityContact must be an email address or an https URL");
  }
}

function validatePermissionSet(ps: unknown, errors: string[]): void {
  if (!ps || typeof ps !== "object") {
    errors.push("permissionSet is required");
    return;
  }
  const p = ps as Partial<PermissionSet>;
  if (typeof p.id !== "string" || p.id.trim() === "") errors.push("permissionSet.id is required");
  if (typeof p.name !== "string" || p.name.trim() === "") errors.push("permissionSet.name is required");
  if (!Array.isArray(p.requiredTags)) errors.push("permissionSet.requiredTags must be an array");
  // Optional network-egress declaration (docs/specs/network-egress.md phase 1) —
  // structurally checked when present so a typo'd value can't ship as "declared".
  if (p.network !== undefined) {
    errors.push(...validateNetworkDeclaration(p.network).map((e) => `permissionSet.${e}`));
  }
  if (!Array.isArray(p.grants) || p.grants.length === 0) {
    errors.push("permissionSet.grants must be a non-empty array");
    return;
  }
  p.grants.forEach((g, i) => {
    if (!g || typeof g !== "object") {
      errors.push(`permissionSet.grants[${i}] must be an object`);
      return;
    }
    const gr = g as Partial<PermissionGrant>;
    if (typeof gr.service !== "string" || gr.service.trim() === "") errors.push(`permissionSet.grants[${i}].service is required`);
    if (!Array.isArray(gr.actions) || gr.actions.length === 0) errors.push(`permissionSet.grants[${i}].actions must be a non-empty array`);
    if (typeof gr.resourceScope !== "string" || gr.resourceScope.trim() === "") errors.push(`permissionSet.grants[${i}].resourceScope is required`);
    // Optional, but checked when present: this string is shown to the user on the approval
    // screen, so it is length-capped and must be plain text. It carries no authority — the
    // scope line beside it is computed — but an unbounded or markup-bearing string still has
    // no business on a security screen.
    if (gr.reason !== undefined) {
      if (typeof gr.reason !== "string" || gr.reason.trim() === "") {
        errors.push(`permissionSet.grants[${i}].reason must be a non-empty string when present`);
      } else if (gr.reason.length > GRANT_REASON_MAX) {
        errors.push(`permissionSet.grants[${i}].reason must be ${GRANT_REASON_MAX} characters or fewer`);
      } else if (/[<>]/.test(gr.reason)) {
        errors.push(`permissionSet.grants[${i}].reason must be plain text (no angle brackets)`);
      }
    }
  });
}

/** Parse + validate `extension.json` text. Returns the typed manifest, or throws with all problems. */
export function parseManifest(json: string): ExtensionManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`extension.json is not valid JSON: ${(e as Error).message}`);
  }
  const { ok, errors } = validateManifest(parsed);
  if (!ok) throw new Error(`invalid extension.json:\n- ${errors.join("\n- ")}`);
  return parsed as ExtensionManifest;
}
