// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The poppy-side credential helper — what a connected app imports to get AWS
 * credentials from a *local* AgentsPoppy broker.
 *
 * AgentsPoppy mints short-lived (~1h) scoped credentials. A long-running agent
 * must never hold one for its whole lifetime: it holds the **connection** and
 * lets this provider transparently re-mint as expiry approaches. So a 24h+ agent
 * just works — and the moment the user pauses/revokes the connection, the next
 * refresh fails and access dies within the token's TTL.
 *
 * The provider is shaped to drop straight into an AWS SDK v3 client as its
 * `credentials`, but carries zero dependency on the SDK (or on a DOM `fetch`),
 * so any poppy can use it regardless of its own stack.
 */

export const DEFAULT_BASE_URL = "http://127.0.0.1:8799";
const DEFAULT_REFRESH_BUFFER_SECONDS = 300;

/** Raw credentials as the broker returns them over HTTP. */
export interface ScopedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** ISO 8601 expiry. */
  expiration: string;
}

/** AWS SDK v3 `AwsCredentialIdentity` shape (structural — no SDK import needed). */
export interface AwsCredentialIdentity {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

/** An AWS SDK v3 credential provider: pass directly as a client's `credentials`. */
export type AwsCredentialIdentityProvider = () => Promise<AwsCredentialIdentity>;

/**
 * Minimal `fetch` surface — the global `fetch` satisfies it; tests inject a fake.
 * `headers`/`body` are optional so the same shape serves both the credential
 * mint (POST, no body) and the connection helpers (POST with a JSON body).
 */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * A single operation the poppy is about to perform. Pass it when minting so a
 * *supervised* connection can show the user exactly what's about to happen and
 * narrow the vended credentials to just this. A mutating operation under
 * supervision blocks until the user approves it in AgentsPoppy.
 */
export interface OperationIntent {
  /** Plain-language summary the user approves, e.g. "Delete user pool 'acme-users'". */
  summary: string;
  /**
   * The exact grants this operation needs (must be within the connection's
   * permission set). Structural — matches `@agentspoppy/core`'s PermissionGrant.
   */
  grants: { service: string; actions: string[]; resourceScope: string }[];
}

/** A pending approval the broker handed back (surfaced via {@link MintCredentialOptions.onApprovalPending}). */
export interface ApprovalInfo {
  id: string;
  connectionId: string;
  requestedAt: string;
  operation: OperationIntent | null;
  status: string;
  expiresAt: string;
}

export interface MintCredentialOptions {
  /** Broker base URL (default {@link DEFAULT_BASE_URL}). */
  baseUrl?: string;
  /** Injectable fetch (defaults to the runtime global). */
  fetchFn?: FetchLike;
  /** The operation about to run — drives supervised approval + credential narrowing. */
  operation?: OperationIntent;
  /** Poll interval while a supervised approval is pending (default 1500ms). */
  approvalPollMs?: number;
  /** Give up after this long waiting for approval (default 0 = wait indefinitely). */
  approvalTimeoutMs?: number;
  /** Called each time we observe a still-pending approval (for a "waiting for approval…" line). */
  onApprovalPending?: (approval: ApprovalInfo) => void;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock in epoch-ms (defaults to {@link Date.now}). */
  now?: () => number;
}

export interface BrokerCredentialOptions extends MintCredentialOptions {
  /** The connection to mint credentials for. */
  connectionId: string;
  /** Refresh this many seconds before expiry (default 300). */
  refreshBufferSeconds?: number;
}

export class BrokerCredentialError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "BrokerCredentialError";
  }
}

function resolveFetch(fetchFn?: FetchLike): FetchLike {
  const f = fetchFn ?? (globalThis as unknown as { fetch?: FetchLike }).fetch;
  if (!f) throw new BrokerCredentialError("no fetch available in this runtime — pass fetchFn");
  return f;
}

function isScopedCredentials(v: unknown): v is ScopedCredentials {
  const c = v as Partial<ScopedCredentials> | null;
  return !!c && !!c.accessKeyId && !!c.secretAccessKey && !!c.sessionToken && !!c.expiration;
}

async function errorFor(res: { status: number; json(): Promise<unknown> }): Promise<BrokerCredentialError> {
  let message = `broker returned ${res.status}`;
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    if (body?.message) message = body.message;
    code = body?.error;
  } catch {
    /* non-JSON error body — keep the status-based message */
  }
  return new BrokerCredentialError(message, res.status, code);
}

/**
 * One-shot: mint a fresh set of scoped credentials for a connection.
 *
 * For a normal connection this returns immediately. For a **supervised**
 * connection performing a mutating (or undeclared) operation, the broker answers
 * with an approval the user must grant in AgentsPoppy; this function then polls
 * until it's approved (→ credentials) or denied/timed-out (→ {@link BrokerCredentialError}).
 * Pass `operation` so the user sees exactly what's being approved and the creds
 * are narrowed to it.
 *
 * Throws if the broker refuses (e.g. the connection is paused/revoked → 409) or
 * returns a malformed body.
 */
export async function mintCredentials(connectionId: string, opts: MintCredentialOptions = {}): Promise<ScopedCredentials> {
  const base = opts.baseUrl ?? DEFAULT_BASE_URL;
  const doFetch = resolveFetch(opts.fetchFn);
  const url = `${base}/connections/${encodeURIComponent(connectionId)}/credentials`;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.approvalPollMs ?? 1500;
  const timeoutMs = opts.approvalTimeoutMs ?? 0;
  const now = opts.now ?? Date.now;
  const start = now();

  const post = (body?: object) =>
    doFetch(url, {
      method: "POST",
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });

  let res = await post(opts.operation ? { operation: opts.operation } : undefined);
  for (;;) {
    if (!res.ok) throw await errorFor(res); // 202 is "ok"; only real failures land here
    const body = await res.json();
    if (isScopedCredentials(body)) return body;

    // Otherwise it's an approval-required response — wait for the user, then re-poll.
    const approval = (body as { approval?: ApprovalInfo }).approval;
    if (!approval?.id) throw new BrokerCredentialError("broker returned malformed credentials");
    opts.onApprovalPending?.(approval);
    if (timeoutMs > 0 && now() - start >= timeoutMs) {
      throw new BrokerCredentialError(`timed out after ${timeoutMs}ms waiting for approval`, undefined, "timeout");
    }
    await sleep(pollMs);
    res = await post({ approvalId: approval.id });
  }
}

/**
 * An auto-refreshing AWS-compatible credential provider for a connection.
 *
 * Caches the current credentials and only re-mints once they're within
 * `refreshBufferSeconds` of expiry; concurrent calls during a refresh share a
 * single in-flight request. Plug it straight into an SDK client:
 *
 *   const s3 = new S3Client({ credentials: createBrokerCredentialProvider({ connectionId }) });
 */
export function createBrokerCredentialProvider(opts: BrokerCredentialOptions): AwsCredentialIdentityProvider {
  const bufferMs = (opts.refreshBufferSeconds ?? DEFAULT_REFRESH_BUFFER_SECONDS) * 1000;
  const clock = opts.now ?? Date.now;

  let cached: ScopedCredentials | null = null;
  let inflight: Promise<ScopedCredentials> | null = null;

  function isFresh(c: ScopedCredentials): boolean {
    const exp = Date.parse(c.expiration);
    return Number.isFinite(exp) && clock() < exp - bufferMs;
  }

  function refresh(): Promise<ScopedCredentials> {
    if (inflight) return inflight; // coalesce concurrent refreshes into one mint
    inflight = mintCredentials(opts.connectionId, opts)
      .then((c) => {
        cached = c;
        return c;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return async () => {
    const c = cached && isFresh(cached) ? cached : await refresh();
    return {
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      sessionToken: c.sessionToken,
      expiration: new Date(c.expiration),
    };
  };
}
