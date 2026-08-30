// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Typed client for the local broker API. The base URL is injected at runtime
 * (the desktop shell will set window.__AGENTSPOPPY_BROKER__ with the bound port);
 * defaults to a local port for browser dev.
 */
import type { ActivityEvent, ActivitySummary, ApprovalRequest, AuditEntry, ConnectedAccount, Connection, ConnectionStatus, InfraGraph, Inventory, ResidualResource } from "@agentspoppy/core";
import type { Capability } from "@agentspoppy/extension-sdk";

/** Runtime state of one installed extension (container model). Mirrors the broker's. */
export interface ExtensionRuntimeState {
  extensionId: string;
  /** The manifest's display name — the UI's fallback before a connection exists. */
  name?: string;
  connectionId?: string;
  connectionStatus?: ConnectionStatus;
  /** "none" = a frontend-only extension; "awaiting-approval" = its connection isn't active yet;
   *  "blocked" = the host is refusing to load/run it (rung-1 local ban); "paused" = the user
   *  hard-paused it (backend stopped, one click to resume); "revoked" = access withdrawn
   *  (re-approve to bring it back). */
  backend: "running" | "stopped" | "awaiting-approval" | "none" | "blocked" | "paused" | "revoked";
  port?: number;
  /** The host-bridge capabilities the manifest declares — the gate for its frontend's calls. */
  capabilities: Capability[];
  /** Loopback URL the broker serves this extension's installed frontend from (when present). */
  frontendUrl?: string;
  /** Loopback URL of the poppy's app icon (when its manifest declares one that exists). */
  iconUrl?: string;
}

/** Whether the setup deployed in the user's AWS matches this build. Mirrors the broker's. */
export interface SetupVersionStatus {
  /** `absent`/`pending` are deliberately silent — see the broker's setup-version.ts. */
  state: "current" | "outdated" | "unknown" | "absent" | "pending";
  deployed: number | null;
  expected: number;
  /** Plain-language why-we-can't-tell, shown to the user verbatim. */
  reason?: string;
}

/** Recent account activity, attributed (external = did not go through AgentsPoppy). */
export interface ActivityReport {
  events: ActivityEvent[];
  summary: ActivitySummary;
}

/** One curated-directory listing, enriched by the broker with local install/platform state. */
export interface DirectoryPoppy {
  /** Reverse-DNS extension id (becomes the installed extension's id). */
  id: string;
  name: string;
  tagline?: string;
  description?: string;
  publisher?: string;
  website?: string;
  /** The open repository — every listing carries one, so the user (or their agent) can audit it. */
  repo: string;
  /** The poppy's app icon as a small PNG data URI (broker-validated), for the listing card. */
  icon?: string;
  featured?: boolean;
  version: string;
  /** Per-platform package (url + sha256), keyed by `${platform}-${arch}` e.g. "darwin-arm64". */
  packages?: Record<string, { url: string; sha256: string }>;
  /** Set when the poppy is sold through the platform (5% commission); absent = free. Display-only. */
  pricing?: { kind: "subscription" | "one_time"; amountMinor: number; currency: string; interval?: "month" | "year" };
  /** Average stars (1–5) + how many installs rated — from the Feedback tab. Absent = unrated. */
  rating?: number;
  ratingCount?: number;
  installed: boolean;
  /** The version installed on THIS machine (undefined when not installed) — may trail `version`. */
  installedVersion?: string;
  /** installed AND the catalog lists a different version: an update is waiting.
   *  Always false while {@link hostTooOld}. */
  updateAvailable: boolean;
  /** The listing needs a newer AgentsPoppy (catalog minHost) — show "update AgentsPoppy",
   *  never Install/Update. */
  hostTooOld?: boolean;
  blocked: boolean;
  /** This machine's platform key + whether the listing has a package for it. */
  platform: { key: string; available: boolean };
}

/** The curated directory as the broker fetched it (catalog + local enrichment). */
export interface DirectoryCatalogView {
  sourceUrl: string;
  fetchedAt: string;
  poppies: DirectoryPoppy[];
}

/** Facts to AUDIT an update before downloading anything (previewUpdate reads the repo, not bytes). */
export interface UpdatePreview {
  id: string;
  name: string;
  repo: string;
  installedVersion: string;
  version: string;
  sha256: string;
  /** The AWS access + host powers the CURRENTLY-installed version has — the agent compares the
   *  new version's declared scope (in the repo) against these. */
  installedGrants: string[];
  installedCapabilities: string[];
  /** Confinement of the installed version's backend — "strict" | "none" | "no-backend". */
  installedIsolation: "strict" | "none" | "no-backend";
}

/** The outcome of an applied update, including what its declared scope actually changed. */
export interface UpdateResult {
  ok: true;
  extensionId: string;
  version: string;
  scopeChanged: boolean;
  grantsAdded: string[];
  grantsRemoved: string[];
  capabilitiesAdded: string[];
  capabilitiesRemoved: string[];
}

export interface ScopedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
}

/** The operator's AWS identity (from STS GetCallerIdentity). */
export interface CallerIdentity {
  accountId: string;
  arn: string;
  userId: string;
}

/** Result of probing whether an account's role is assumable. */
export type RoleProbeResult = { ok: true; assumedArn: string } | { ok: false; reason: string };

export interface RoleTemplate {
  operator: CallerIdentity;
  /** CloudFormation JSON the user deploys to create the role. */
  templateJson: string;
}

// AgentsPoppy's default broker port — deliberately distinct from MailPoppy's sidecar (8787).
const DEFAULT_BASE = "http://127.0.0.1:8799";

let baseUrl: string =
  (globalThis as { __AGENTSPOPPY_BROKER__?: string }).__AGENTSPOPPY_BROKER__ ?? DEFAULT_BASE;

export function setBrokerBaseUrl(url: string): void {
  baseUrl = url;
}
export function brokerBaseUrl(): string {
  return baseUrl;
}

// The host token proves we're the desktop UI (not a poppy backend) so the broker
// lets us drive the management plane. Delivered by the Tauri host, which read it off
// the broker's stdout — a channel a spawned poppy can't reach. Null until fetched
// (or in the browser dev harness, where the broker runs DEV-OPEN and ignores it).
let hostToken: string | null =
  (globalThis as { __AGENTSPOPPY_BROKER_TOKEN__?: string }).__AGENTSPOPPY_BROKER_TOKEN__ ?? null;

export function setBrokerHostToken(token: string | null): void {
  hostToken = token;
}

const inTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Poll the Tauri host for the token. Resolves true once armed, false if the whole
 *  window elapsed without one. The window is generous (~12s): the broker is a large
 *  self-contained binary and, right after a rebuild, macOS's first-run security scan
 *  can delay its startup well past a second. */
async function fetchHostToken(): Promise<boolean> {
  if (!inTauri()) return true; // browser dev harness: broker runs DEV-OPEN, no token needed
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    for (let attempt = 0; attempt < 60; attempt++) {
      const token = await invoke<string>("broker_host_token").catch(() => "");
      if (token) {
        setBrokerHostToken(token);
        return true;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    console.warn("[broker] host token not available yet — will re-arm on the next 401");
  } catch (e) {
    console.warn("[broker] could not initialise host auth:", e);
  }
  return false;
}

// Shared, idempotent — main.tsx primes it at startup, and the first request awaits
// the same promise so no management call ever races ahead of the token. Crucially a
// FAILED fetch is NOT memoized: authInit is cleared so the next call retries, rather
// than the client giving up on the token for the whole session (the old bug that made
// a slow broker cold-start 401 every management call until the app was restarted).
let authInit: Promise<void> | null = null;

/**
 * Fetch the management-plane host token from the Tauri host (which captured it off
 * the broker's stdout) and arm the client with it. Safe to call repeatedly; retries
 * on a later call if it hasn't landed yet.
 */
export function initBrokerAuth(): Promise<void> {
  if (!authInit) {
    authInit = fetchHostToken().then((ok) => {
      if (!ok) authInit = null; // don't cache a miss — let the next attempt try again
    });
  }
  return authInit;
}

/** Merge the host-token Authorization header into a request's headers. When no token
 *  is armed the init is passed through untouched (so callers/tests see it verbatim). */
export function withAuth(init?: RequestInit): RequestInit | undefined {
  if (!hostToken) return init;
  return { ...(init ?? {}), headers: { ...(init?.headers ?? {}), authorization: `Bearer ${hostToken}` } };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// A fetch that can't even reach the broker means the local helper process is gone
// (crashed, killed, or never started) — a completely different failure from anything
// AWS said. Surface it as its own ApiError so every view's error text tells the user
// the truth instead of falling back to context-specific guesses like "bad keys"
// (exactly how the v0.2.0 broker crash masqueraded as an AWS credential problem).
async function fetchOrBrokerDown(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${baseUrl}${path}`, withAuth(init));
  } catch {
    throw new ApiError(
      0,
      "broker_unreachable",
      "AgentsPoppy's local helper isn't responding. Quit and reopen the app; if this keeps happening, reinstall from agentspoppy.com/download.",
    );
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // Make sure the host token is armed before the first management call (no-op once set).
  if (!hostToken && inTauri()) await initBrokerAuth();
  let res = await fetchOrBrokerDown(path, init);
  // Recovery: a management route answers 401 only when the host token is missing/wrong.
  // If the token simply hadn't landed yet (slow broker cold-start), re-arm it now and
  // retry ONCE — so a startup race self-heals instead of surfacing as a scary error.
  if (res.status === 401 && inTauri()) {
    setBrokerHostToken(null);
    authInit = null; // force a fresh fetch
    await initBrokerAuth();
    if (hostToken) res = await fetchOrBrokerDown(path, init);
  }
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const obj = (data ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, obj.error ?? "error", obj.message ?? res.statusText);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const broker = {
  listAccounts: () => req<ConnectedAccount[]>("/accounts"),
  listConnections: () => req<Connection[]>("/connections"),
  activity: () => req<ActivityReport>("/activity"),
  // --- bootstrap ---
  awsIdentity: () => req<CallerIdentity>("/aws/identity"),
  /** In-app key entry: save pasted keys to the `agentspoppy` profile, get back the resolved identity. */
  setAwsCredentials: (input: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }) =>
    req<CallerIdentity>("/aws/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  /**
   * Is the broker role deployed in the user's AWS the one this app expects? The guardrails
   * live in THEIR account, so a tightened one changes nothing until they re-apply setup.
   * Read-only, and the broker never throws from it — an unreadable answer comes back as
   * `unknown`, which prompts but says "couldn't check" rather than crying wolf.
   */
  setupStatus: () => req<SetupVersionStatus>("/aws/setup-status"),
  /** This machine's operator-key id + mint time (never secrets) — the key-age nudge. */
  operatorKeyInfo: () => req<{ profileKeyId: string | null; mintedAt: string | null }>("/aws/key-info"),
  /**
   * The kill switch: delete THIS machine's operator access key in AWS, then forget it
   * locally. 409 not_operator → route to the key switch; 409 setup_outdated → re-apply
   * setup first. A failed delete never touches the stored profile.
   */
  revokeOperatorKey: () =>
    req<{ deletedKeyId: string; alreadyGone: boolean }>("/aws/revoke-key", { method: "POST" }),
  createAccount: (input: { accountId: string; alias?: string; regions?: string[]; roleArn?: string }) =>
    req<ConnectedAccount>("/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  /** Forget a linked account locally (e.g. the wrong one was linked). */
  unlinkAccount: (accountId: string) => req<{ ok: true }>(`/accounts/${enc(accountId)}`, { method: "DELETE" }),
  roleTemplate: (accountId: string) => req<RoleTemplate>(`/accounts/${enc(accountId)}/role-template`),
  /**
   * AUTOMATED setup: deploy the broker role + non-admin operator using elevated
   * setup credentials (used once, never saved). Idempotent/resumable — safe to
   * call again after any interruption. Returns the Broker Role ARN it recorded.
   */
  deployBootstrap: (
    accountId: string | null,
    input?: {
      /** Omit both keys to reuse the credentials already connected on this machine. */
      accessKeyId?: string;
      secretAccessKey?: string;
      sessionToken?: string;
      /** Fresh-machine (accountId null) only: where the setup should live. */
      region?: string;
      /** Re-apply: touch the stack only — never rotate the stored credential. */
      updateOnly?: boolean;
      /** Step 0: switch this machine onto the operator key BEFORE touching the template
       *  (docs/specs/operator-key-least-privilege.md). */
      keysFirst?: boolean;
      /** Consent to retire the oldest other operator key at IAM's two-key limit —
       *  only send after showing the user which key (the eviction_required error names it). */
      allowEviction?: boolean;
    },
  ) =>
    req<{
      brokerRoleArn: string;
      account: ConnectedAccount;
      /** Present when this machine reused a setup living in another region (nothing was created). */
      joinedExistingSetupIn?: string;
      /** Present when the machine was connected but the setup template could NOT be re-applied. */
      setupNotUpdated?: boolean;
      /** When `setupNotUpdated` came from a thrown failure (keys-first mode): the reason. */
      setupUpdateError?: string;
      /** Present when the oldest operator key was retired to stay within IAM's 2-key limit. */
      evictedAccessKeyId?: string;
    }>(
      accountId ? `/accounts/${enc(accountId)}/bootstrap` : "/aws/bootstrap",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input ?? {}),
      },
    ),
  verifyAccount: (accountId: string) =>
    req<RoleProbeResult>(`/accounts/${enc(accountId)}/verify`, { method: "POST" }),
  setAccountRole: (accountId: string, roleArn: string) =>
    req<ConnectedAccount>(`/accounts/${enc(accountId)}/role`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roleArn }),
    }),
  /** Re-point the account to a new AWS region; the broker restarts this account's poppy backends. */
  setAccountRegion: (accountId: string, region: string) =>
    req<ConnectedAccount>(`/accounts/${enc(accountId)}/region`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ region }),
    }),
  getConnection: (id: string) => req<Connection>(`/connections/${enc(id)}`),
  approve: (id: string) => req<Connection>(`/connections/${enc(id)}/approve`, { method: "POST" }),
  deny: (id: string) => req<Connection>(`/connections/${enc(id)}/deny`, { method: "POST" }),
  pause: (id: string) => req<Connection>(`/connections/${enc(id)}/pause`, { method: "POST" }),
  resume: (id: string) => req<Connection>(`/connections/${enc(id)}/resume`, { method: "POST" }),
  revoke: (id: string) => req<Connection>(`/connections/${enc(id)}`, { method: "DELETE" }),
  /** Forget a revoked connection — clears its local record so it leaves the list. No cloud change. */
  forget: (id: string) => req<{ ok: true }>(`/connections/${enc(id)}/forget`, { method: "POST" }),
  teardown: (id: string) =>
    req<{
      deletedStacks: string[];
      /** What the broker's host-cleanup pass removed beyond the stacks (older brokers omit it). */
      removedResiduals?: ResidualResource[];
      residuals: ResidualResource[];
      /** Host cleanup hit AccessDenied — the access policy predates the cleanup grants. */
      cleanupAuthProblem?: boolean;
    }>(`/connections/${enc(id)}/teardown`, { method: "POST" }),
  inventory: (id: string) => req<Inventory>(`/connections/${enc(id)}/inventory`),
  /** The poppy's footprint as a verified graph (services + their wiring) — the infra map. */
  infra: (id: string) => req<InfraGraph>(`/connections/${enc(id)}/infra`),
  audit: (id: string) => req<AuditEntry[]>(`/connections/${enc(id)}/audit`),
  issueCredentials: (id: string) =>
    req<ScopedCredentials>(`/connections/${enc(id)}/credentials`, { method: "POST" }),
  // --- supervised mode (per-action approval) ---
  /** Turn supervised mode on/off for a connection (require approval before it can change anything). */
  setSupervised: (id: string, supervised: boolean) =>
    req<Connection>(`/connections/${enc(id)}/supervise`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ supervised }),
    }),
  /** Operations awaiting the user's decision, across all supervised connections. */
  pendingApprovals: () => req<ApprovalRequest[]>("/approvals"),
  // --- curated directory ---
  /** The curated directory: catalog listings enriched with local install/platform state. */
  directoryCatalog: () => req<DirectoryCatalogView>("/directory/catalog"),
  /** Download, verify and install a directory poppy by its catalog id. */
  directoryInstall: (id: string) =>
    req<{ ok: true; extensionId: string }>("/directory/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }),
  /** Update an already-installed poppy to the catalog's current version (atomic swap;
   *  the approved AWS connection is preserved unless the poppy's scope changed). */
  directoryUpdate: (id: string) =>
    req<{ ok: true; extensionId: string; version: string }>("/directory/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }),
  /** Facts to review an update WITHOUT downloading it — version delta, repo, pinned sha256, and
   *  the currently-installed scope — so the user can audit the open source before consenting. */
  directoryPreviewUpdate: (id: string) =>
    req<UpdatePreview>("/directory/preview-update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }),
  /** The consent step: NOW download, verify and install the reviewed update. Returns what its
   *  declared AWS access / host powers actually changed. */
  directoryApplyUpdate: (id: string) =>
    req<UpdateResult>("/directory/apply-update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }),
  /** Remove a poppy from THIS computer (files + registration). Cloud + approval untouched. */
  uninstallExtension: (extensionId: string) =>
    req<{ ok: true; extensionId: string }>(`/extensions/${enc(extensionId)}/uninstall`, { method: "POST" }),
  // --- extensions (container model) ---
  /** Installed extensions + their runtime state (backend running / awaiting approval / …). */
  listExtensions: () => req<ExtensionRuntimeState[]>("/extensions"),
  /** Bring an extension up: reconcile its connection, then spawn its backend once active. */
  startExtension: (extensionId: string, accountId?: string) =>
    req<ExtensionRuntimeState>(`/extensions/${enc(extensionId)}/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(accountId ? { accountId } : {}),
    }),
  /** Stop an extension's backend. */
  stopExtension: (extensionId: string) =>
    req<{ ok: true }>(`/extensions/${enc(extensionId)}/stop`, { method: "POST" }),
  /**
   * Stop + respawn an extension's backend — recovery for a stuck poppy. Re-runs its
   * bootstrap, so a lost approval request gets re-filed and the banner reappears.
   */
  restartExtension: (extensionId: string) =>
    req<ExtensionRuntimeState>(`/extensions/${enc(extensionId)}/restart`, { method: "POST" }),
  /** Block an extension from loading/running (rung-1 local ban; kills it if running). */
  blockExtension: (extensionId: string) =>
    req<{ ok: true }>(`/extensions/${enc(extensionId)}/block`, { method: "POST" }),
  /** Lift a block so the extension can run again. */
  unblockExtension: (extensionId: string) =>
    req<{ ok: true }>(`/extensions/${enc(extensionId)}/unblock`, { method: "POST" }),
  /**
   * Proxy a call to an extension's own backend THROUGH the broker (the webview can't
   * reach the backend's port directly — CORS). Returns the backend's parsed JSON, or
   * throws `backend <status>: <body>` on a non-2xx so the extension can map it to its
   * own error contract.
   */
  invokeExtensionBackend: async <T = unknown>(
    extensionId: string,
    invoke: { method: string; path: string; body?: unknown },
  ): Promise<T> => {
    const res = await fetchOrBrokerDown(
      `/extensions/${enc(extensionId)}/backend`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invoke),
      },
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`backend ${res.status}: ${text}`);
    return (text ? JSON.parse(text) : undefined) as T;
  },
  approveOperation: (approvalId: string) =>
    req<ApprovalRequest>(`/approvals/${enc(approvalId)}/approve`, { method: "POST" }),
  denyOperation: (approvalId: string) =>
    req<ApprovalRequest>(`/approvals/${enc(approvalId)}/deny`, { method: "POST" }),
};
