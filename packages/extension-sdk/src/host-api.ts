// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The host API — the typed surface an extension frontend calls, and the wire
 * envelope that carries it across the sandbox boundary, plus the bootstrap the host
 * injects into a spawned backend.
 *
 * Design rules baked into the types:
 *  - The frontend NEVER touches AWS or raw credentials. `ensureAccess` only triggers
 *    and reports the user-approved mint; the actual scoped credentials are delivered
 *    to the BACKEND (via {@link BackendBootstrap}), not here.
 *  - Every {@link HostBridge} method maps to exactly one {@link Capability}
 *    ({@link METHOD_CAPABILITY}); the host refuses any call whose capability the
 *    manifest didn't declare.
 *  - Pure contract: types + the method→capability map. No transport, no IO.
 */
import type { AuditEntry, Connection, Inventory, OperationIntent } from "@agentspoppy/core";
import type { Capability } from "./capabilities";
export type { RatingInfo } from "./feedback-tab";

/** Whether brokered AWS access is currently granted for this extension. */
export type AccessState = "granted" | "pending" | "denied";

/** A proxied call to the extension's own backend (the host forwards to its child process). */
export interface BackendInvoke {
  /** HTTP-ish verb the backend understands. */
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Backend route, e.g. "/deploy/backend". */
  path: string;
  /** Optional JSON body. */
  body?: unknown;
}

/** A notification the host surfaces on the extension's behalf. */
export interface HostNotification {
  title: string;
  body?: string;
}

/** Scope a purchase/entitlement to a specific instance (e.g. a domain), so a product can be
 *  bought "per unit". Omit for a simple one-per-poppy unlock. */
export interface PurchaseOptions {
  target?: string;
}

/** What the standard purchase button needs to render one of a poppy's products. */
export interface PurchaseInfo {
  productId: string;
  /** Human name shown on the button (from the product the developer priced). */
  name: string;
  /** The price, or null when this product isn't for sale (free / not priced yet). */
  price: {
    amountMinor: number;
    currency: string;
    kind: "one_time" | "subscription";
    interval?: "month" | "year";
    /** Free-trial length in days (subscriptions only), set in /admin. Absent = no trial. */
    trialDays?: number;
  } | null;
  /** Whether the buyer already owns it (drives the "Owned" state + feature unlock). */
  owned: boolean;
}

/**
 * The capability-gated surface the host exposes to an extension frontend. The host
 * implements it; an extension programs against it. Each method requires the
 * capability named in {@link METHOD_CAPABILITY}.
 */
export interface HostBridge {
  /**
   * Ensure brokered AWS access is granted, raising a supervised-approval prompt in
   * the host if needed. Resolves once the user has decided. The credentials
   * themselves go to the backend, never to the frontend.
   */
  ensureAccess(operation?: OperationIntent): Promise<AccessState>;
  /** This extension's own connection record (for its permissions/activity view). */
  getConnection(): Promise<Connection>;
  /** This extension's own audit trail. */
  getAudit(): Promise<AuditEntry[]>;
  /** This extension's own cloud footprint. */
  getInventory(): Promise<Inventory>;
  /** Call this extension's own backend; the host proxies to the child process it spawned. */
  invokeBackend<T = unknown>(request: BackendInvoke): Promise<T>;
  /** Open a URL in the system browser. */
  openExternal(url: string): Promise<void>;
  /** Surface a notification / toast via the host. */
  notify(notification: HostNotification): Promise<void>;
  /** Price + ownership for one of THIS poppy's products (for the standard purchase button). */
  purchaseInfo(productId: string, options?: PurchaseOptions): Promise<PurchaseInfo>;
  /**
   * Buy one of this poppy's products: the host opens AgentsPoppy checkout, waits for payment, and
   * resolves `{ owned: true }` once the purchase is confirmed (or `{ owned: false }` if the buyer
   * cancels / it times out). Payment details never touch the poppy.
   */
  buyProduct(productId: string, options?: PurchaseOptions): Promise<{ owned: boolean }>;
  /** Does the buyer currently own this product? The gate a poppy checks before unlocking a feature. */
  isPurchased(productId: string, options?: PurchaseOptions): Promise<boolean>;
  /**
   * Open the buyer's billing portal (Stripe-hosted) in the system browser so they can cancel a
   * subscription, update their card, or view invoices — the self-service management a recurring
   * product requires. Resolves once the host has opened it (the portal itself is the buyer's to
   * drive). No-op-safe for one-time products (the portal simply shows no active subscription).
   */
  manageSubscription(productId: string, options?: PurchaseOptions): Promise<void>;

}


/** Which capability each {@link HostBridge} method requires (enforced against the manifest allowlist). */
export const METHOD_CAPABILITY: Record<keyof HostBridge, Capability> = {
  ensureAccess: "aws:credentials",
  getConnection: "connection:read",
  getAudit: "connection:read",
  getInventory: "connection:read",
  invokeBackend: "backend:invoke",
  openExternal: "host:openExternal",
  notify: "host:notify",
  purchaseInfo: "commerce:purchase",
  buyProduct: "commerce:purchase",
  isPurchased: "commerce:purchase",
  manageSubscription: "commerce:purchase",
};

// ---- Wire envelope (frontend webview <-> host, e.g. over postMessage) ----

/** A request from the frontend to the host bridge. */
export interface HostRequest {
  /** Correlates the response. */
  id: string;
  /** A {@link HostBridge} method name. */
  method: keyof HostBridge;
  /** Positional arguments for the method. */
  params: unknown[];
}

/** The host's reply to a {@link HostRequest}. */
export type HostResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

/**
 * A message the host pushes to the frontend UNSOLICITED — not a reply to a
 * {@link HostRequest}. It lets the host tell a poppy that something about its
 * connection changed out from under it (e.g. the operator tore the backend down from
 * the AgentsPoppy console) so the frontend can refresh instead of showing stale state.
 *
 * Distinguished from a {@link HostResponse} by the `hostEvent` discriminator (a
 * response has `id`+`ok`; an event has neither), so a guest that doesn't listen for it
 * simply ignores it. Delivered over the same postMessage channel, host → frame.
 */
export interface HostEvent {
  /** The kind of change. Today only `"connection-changed"`; `reason` narrows it. */
  hostEvent: "connection-changed";
  /** The connection this event is about (a frame ignores events for other connections). */
  connectionId: string;
  /** Why it changed, so a frontend can react precisely. */
  reason?: "teardown" | "pause" | "resume" | "revoke";
}

// ---- Backend bootstrap (host -> spawned backend child process) ----

/**
 * What the host injects into an extension's backend when it spawns it. This
 * REPLACES the old fixed-port broker discovery: the backend doesn't hunt for the
 * broker or its own connection — the host hands it the exact connection id and a
 * loopback endpoint to mint scoped credentials, plus the port to listen on (for an
 * "http" backend). Credentials are minted on demand against `credentialsUrl`
 * (short-lived, auto-rotating, identical to the v1 client provider) — never the
 * operator's own keys.
 */
export interface BackendBootstrap {
  /** The connection this backend instance is bound to. */
  connectionId: string;
  /** Loopback endpoint the host exposes for minting this connection's scoped credentials. */
  credentialsUrl: string;
  /**
   * Bearer token the backend MUST present when calling {@link credentialsUrl}. It
   * authorises minting for THIS connection only — the broker rejects it on any other
   * connection's route and on the whole management plane, so a poppy can't use it to
   * touch (or revoke/tear down) a sibling. Absent only against a pre-auth broker.
   */
  credentialsToken?: string;
  /** For an "http" backend: the loopback port the host assigned for it to listen on. */
  port?: number;
  /**
   * ARN of the account's `AgentsPoppyBoundary` managed policy — present ONLY when the
   * host has confirmed the deployed setup actually carries it (setup version ≥ 3).
   *
   * A poppy whose CloudFormation template creates IAM roles passes this value as its
   * `PermissionsBoundaryArn` template parameter, so every role it creates is capped by
   * the boundary (docs/specs/broker-role-v2.md, step 2). When absent, pass nothing and
   * deploy unbounded: the account's setup predates the boundary, and a `CreateRole`
   * naming a policy that does not exist is refused by IAM. The host turns this from
   * optional into REQUIRED in step 3, once the fleet attaches it.
   */
  permissionsBoundaryArn?: string;
  /**
   * A directory the host creates and owns for this poppy's own persistent files.
   *
   * Write your state here — not `~/.<yourname>/`. Under
   * `backend.isolation: "strict"` this and the OS temp directory are the ONLY places
   * you may write, and your install directory the only other place you may read; every
   * other path on the machine is denied by the runtime.
   *
   * To hand a file to the user, do not write to their Downloads folder: serve the bytes
   * from your `/local-download/<token>` route and let the host's browser save it.
   */
  dataDir: string;
  /** Resolved AWS context for the connection. */
  account: { accountId: string; region: string };
}
