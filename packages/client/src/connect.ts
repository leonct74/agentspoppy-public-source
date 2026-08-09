// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The poppy-side *connection* helper — the other half of the SDK from
 * {@link ./credentials}. A poppy uses this to introduce itself to the local
 * AgentsPoppy broker: it requests a connection (declaring exactly what it needs),
 * the user approves it in AgentsPoppy, and from then on the connection id is the
 * stable handle the credential provider re-mints against.
 *
 * Zero runtime dependencies: structural types only (no `@agentspoppy/core`
 * import), and the same injectable-`fetch` shape used across the SDK.
 */

import {
  DEFAULT_BASE_URL,
  createBrokerCredentialProvider,
  type AwsCredentialIdentityProvider,
  type FetchLike,
} from "./credentials";

// --- structural mirrors of the broker's request/response shapes ---

export interface AppIdentity {
  /** Stable app id, e.g. "com.mailpoppy.desktop". */
  id: string;
  /** Display name, e.g. "MailPoppy". */
  name: string;
  iconUrl?: string;
}

export interface PermissionGrant {
  service: string;
  actions: string[];
  /** An ARN pattern, "*", or the "tagged-as-self" sentinel. */
  resourceScope: string;
}

export interface PermissionLimits {
  maxSpendPerDayUsd?: number;
  requireApprovalFor?: string[];
}

export interface PermissionSet {
  id: string;
  name: string;
  description: string;
  grants: PermissionGrant[];
  /** Tag keys every brokered resource must carry (enables attribution + teardown). */
  requiredTags: string[];
  limits: PermissionLimits | null;
}

export type ConnectionStatus = "pending" | "active" | "paused" | "revoked";

export interface Connection {
  id: string;
  accountId: string;
  app: AppIdentity;
  status: ConnectionStatus;
  permissionSet: PermissionSet;
  createdAt: string;
  updatedAt: string;
}

/** Minimal account summary as the broker lists it (for picking a target account). */
export interface ConnectedAccountSummary {
  id: string;
  accountId: string;
  alias?: string;
  regions: string[];
}

export interface RequestConnectionInput {
  /** The AgentsPoppy-local account id to connect under (see {@link listAccounts}). */
  accountId: string;
  app: AppIdentity;
  permissionSet: PermissionSet;
}

export interface BrokerRequestOptions {
  /** Broker base URL (default {@link DEFAULT_BASE_URL}). */
  baseUrl?: string;
  /** Injectable fetch (defaults to the runtime global). */
  fetchFn?: FetchLike;
}

export class BrokerRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "BrokerRequestError";
  }
}

function resolveFetch(fetchFn?: FetchLike): FetchLike {
  const f = fetchFn ?? (globalThis as unknown as { fetch?: FetchLike }).fetch;
  if (!f) throw new BrokerRequestError("no fetch available in this runtime — pass fetchFn");
  return f;
}

async function unwrap<T>(res: { ok: boolean; status: number; json(): Promise<unknown> }): Promise<T> {
  if (!res.ok) {
    let message = `broker returned ${res.status}`;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (body?.message) message = body.message;
      code = body?.error;
    } catch {
      /* non-JSON error body — keep the status-based message */
    }
    throw new BrokerRequestError(message, res.status, code);
  }
  return (await res.json()) as T;
}

function apiGet<T>(path: string, opts: BrokerRequestOptions): Promise<T> {
  const base = opts.baseUrl ?? DEFAULT_BASE_URL;
  return resolveFetch(opts.fetchFn)(`${base}${path}`, { method: "GET" }).then((r) => unwrap<T>(r));
}

function apiPost<T>(path: string, body: unknown, opts: BrokerRequestOptions): Promise<T> {
  const base = opts.baseUrl ?? DEFAULT_BASE_URL;
  return resolveFetch(opts.fetchFn)(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => unwrap<T>(r));
}

/** The AWS accounts linked in this AgentsPoppy — a poppy picks which to connect under. */
export function listAccounts(opts: BrokerRequestOptions = {}): Promise<ConnectedAccountSummary[]> {
  return apiGet<ConnectedAccountSummary[]>("/accounts", opts);
}

/** All connections the broker knows about (used to reuse an app's existing connection). */
export function listConnections(opts: BrokerRequestOptions = {}): Promise<Connection[]> {
  return apiGet<Connection[]>("/connections", opts);
}

/** Fetch a single connection (e.g. to read its current status). */
export function getConnection(connectionId: string, opts: BrokerRequestOptions = {}): Promise<Connection> {
  return apiGet<Connection>(`/connections/${encodeURIComponent(connectionId)}`, opts);
}

/**
 * Introduce this poppy to the broker. Returns a `pending` connection — the user
 * must approve it in AgentsPoppy before credentials can be minted.
 */
export async function requestConnection(
  input: RequestConnectionInput,
  opts: BrokerRequestOptions = {},
): Promise<Connection> {
  if (!input.app?.id) throw new BrokerRequestError("app.id is required");
  if (!input.accountId) throw new BrokerRequestError("accountId is required");
  return apiPost<Connection>("/connections", input, opts);
}

export interface WaitForApprovalOptions extends BrokerRequestOptions {
  /** Poll interval in ms (default 1500). */
  pollMs?: number;
  /** Give up after this many ms (default 0 = wait indefinitely). */
  timeoutMs?: number;
  /** Called on each poll while still pending — handy for a "still waiting…" line. */
  onPending?: (connection: Connection) => void;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock in epoch-ms (tests). */
  now?: () => number;
}

/**
 * Poll a connection until the user approves it (→ `active`). Rejects if it's
 * denied/revoked, or on timeout. A poppy calls this right after
 * {@link requestConnection} to block until it's allowed in.
 */
export async function waitForApproval(connectionId: string, opts: WaitForApprovalOptions = {}): Promise<Connection> {
  const pollMs = opts.pollMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 0;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const start = now();

  for (;;) {
    const c = await getConnection(connectionId, opts);
    if (c.status === "active") return c;
    if (c.status === "revoked") {
      throw new BrokerRequestError("connection was denied or revoked", undefined, "revoked");
    }
    opts.onPending?.(c);
    if (timeoutMs > 0 && now() - start >= timeoutMs) {
      throw new BrokerRequestError(`timed out after ${timeoutMs}ms waiting for approval`, undefined, "timeout");
    }
    await sleep(pollMs);
  }
}

export interface ConnectOptions extends WaitForApprovalOptions {
  /** Reuse a non-revoked connection for this app+account if one exists (default true). */
  reuseExisting?: boolean;
  /** Block until approved before returning (default true). */
  awaitApproval?: boolean;
  /** Passed through to the credential provider. */
  refreshBufferSeconds?: number;
}

export interface ConnectResult {
  /** The (active, if awaited) connection. */
  connection: Connection;
  /** Auto-refreshing AWS SDK v3 credential provider bound to the connection. */
  credentials: AwsCredentialIdentityProvider;
}

/**
 * The one-call poppy entry point: request (or reuse) a connection, wait for the
 * user's approval, and hand back the connection plus an auto-refreshing
 * credential provider ready to drop into an AWS SDK client.
 */
export async function connect(input: RequestConnectionInput, opts: ConnectOptions = {}): Promise<ConnectResult> {
  let connection: Connection | undefined;

  if (opts.reuseExisting ?? true) {
    const existing = await listConnections(opts);
    connection = existing.find(
      (c) => c.accountId === input.accountId && c.app.id === input.app.id && c.status !== "revoked",
    );
  }
  if (!connection) connection = await requestConnection(input, opts);

  if ((opts.awaitApproval ?? true) && connection.status !== "active") {
    connection = await waitForApproval(connection.id, opts);
  }

  const credentials = createBrokerCredentialProvider({
    connectionId: connection.id,
    baseUrl: opts.baseUrl,
    fetchFn: opts.fetchFn,
    refreshBufferSeconds: opts.refreshBufferSeconds,
  });

  return { connection, credentials };
}
