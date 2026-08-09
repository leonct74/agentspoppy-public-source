// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The bridge that carries {@link HostBridge} calls across the sandbox boundary
 * between an extension's (sandboxed iframe) frontend and the host.
 *
 * Two halves, both transport-agnostic so they're unit-testable without a real
 * iframe/postMessage:
 *  - GUEST: {@link createHostBridgeClient} turns the typed {@link HostBridge} surface
 *    into request/await-response calls over an injected {@link BridgeTransport}.
 *  - HOST: {@link handleHostRequest} validates an incoming request against the
 *    extension's *declared* capabilities (the manifest allowlist) and only then
 *    dispatches to the host's real {@link HostBridge} implementation.
 *
 * The capability gate is the security seam: a frontend can only reach a host power
 * the user could see and approve in the manifest. Anything else is refused here,
 * before the host implementation runs.
 */
import type { Capability } from "./capabilities";
import { type HostBridge, type HostRequest, type HostResponse, METHOD_CAPABILITY } from "./host-api";

// ---- Guest side (runs in the extension's sandboxed frontend) ----

/** The minimal duplex channel the guest client needs (e.g. window.postMessage + 'message'). */
export interface BridgeTransport {
  /** Send a request to the host. */
  post(message: HostRequest): void;
  /** Subscribe to host responses; returns an unsubscribe fn. */
  subscribe(handler: (response: HostResponse) => void): () => void;
}

export interface HostBridgeClientOptions {
  /** Correlation-id generator (defaults to a random id). */
  idGen?: () => string;
  /** Reject a call if the host hasn't answered within this many ms (default 30s). */
  timeoutMs?: number;
}

let seq = 0;
function defaultId(): string {
  seq += 1;
  return `req-${Date.now().toString(36)}-${seq}`;
}

/**
 * Build a typed {@link HostBridge} that an extension frontend can call directly; each
 * method posts a {@link HostRequest} and resolves when the matching {@link HostResponse}
 * arrives (or rejects on a host error / timeout).
 */
export function createHostBridgeClient(transport: BridgeTransport, opts: HostBridgeClientOptions = {}): HostBridge {
  const idGen = opts.idGen ?? defaultId;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  transport.subscribe((res) => {
    const p = pending.get(res.id);
    if (!p) return; // unknown/duplicate correlation id — ignore
    pending.delete(res.id);
    clearTimeout(p.timer);
    if (res.ok) p.resolve(res.result);
    else p.reject(new Error(res.error));
  });

  const call = <T>(method: keyof HostBridge, params: unknown[]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = idGen();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`host call "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      transport.post({ id, method, params });
    });

  return {
    ensureAccess: (operation) => call("ensureAccess", operation === undefined ? [] : [operation]),
    getConnection: () => call("getConnection", []),
    getAudit: () => call("getAudit", []),
    getInventory: () => call("getInventory", []),
    invokeBackend: (request) => call("invokeBackend", [request]),
    openExternal: (url) => call("openExternal", [url]),
    notify: (notification) => call("notify", [notification]),
    purchaseInfo: (productId, options) => call("purchaseInfo", options === undefined ? [productId] : [productId, options]),
    buyProduct: (productId, options) => call("buyProduct", options === undefined ? [productId] : [productId, options]),
    isPurchased: (productId, options) => call("isPurchased", options === undefined ? [productId] : [productId, options]),
    manageSubscription: (productId, options) => call("manageSubscription", options === undefined ? [productId] : [productId, options]),
  };
}

// ---- Host side (runs in the trusted host, services guest requests) ----

/** A method name the host actually exposes (guards the untrusted `req.method`). */
function isBridgeMethod(method: string): method is keyof HostBridge {
  return Object.prototype.hasOwnProperty.call(METHOD_CAPABILITY, method);
}

/**
 * Service one {@link HostRequest} from an extension frontend: reject it unless its
 * method is real AND the capability that method requires is in the extension's
 * declared `capabilities`; otherwise dispatch to the host's real bridge. Never throws
 * — a bridge implementation error becomes an `{ ok:false }` response so the guest can
 * handle it. `req.method`/`req.params` are treated as untrusted input.
 */
export async function handleHostRequest(
  req: HostRequest,
  ctx: { capabilities: readonly Capability[]; bridge: HostBridge },
): Promise<HostResponse> {
  const method = req.method as unknown as string;
  if (typeof method !== "string" || !isBridgeMethod(method)) {
    return { id: req.id, ok: false, error: `unknown host method: ${String(method)}` };
  }
  const required = METHOD_CAPABILITY[method];
  if (!ctx.capabilities.includes(required)) {
    return { id: req.id, ok: false, error: `capability "${required}" is not granted to this extension (method "${method}")` };
  }
  try {
    const fn = ctx.bridge[method] as (...args: unknown[]) => Promise<unknown>;
    const result = await fn(...(Array.isArray(req.params) ? req.params : []));
    return { id: req.id, ok: true, result };
  } catch (e) {
    return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
