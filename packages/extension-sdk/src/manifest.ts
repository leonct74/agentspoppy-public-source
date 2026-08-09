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
 * - `"native"` (the default, and the pre-0.3.0 behavior) → `entry` is a small
 *   self-contained executable of the poppy's own code. Bundling a language runtime
 *   inside it (Node SEA, Python, Electron…) fails certification: runtimes are
 *   provided by the platform, never shipped by poppies.
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
  /** The runtime this backend needs. Defaults to "native". */
  runtime?: BackendRuntime;
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

  return { ok: errors.length === 0, errors };
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
