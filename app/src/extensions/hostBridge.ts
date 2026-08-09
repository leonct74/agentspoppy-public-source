// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The host's concrete {@link HostBridge} implementation, backed by the local broker
 * API + the extension's spawned backend. This is what services the capability-gated
 * requests an extension frontend makes over the iframe bridge.
 *
 * Security notes baked in:
 *  - `ensureAccess` reports readiness only — it never returns credentials to the
 *    frontend. Scoped credentials are delivered to the BACKEND (via the bootstrap),
 *    never here.
 *  - `invokeBackend` proxies to the backend's loopback port, so the frontend never
 *    learns the port or reaches the network itself.
 */
import type { AccessState, BackendInvoke, HostBridge, HostNotification, PurchaseInfo, PurchaseOptions } from "@agentspoppy/extension-sdk";
import { broker } from "../api/broker";
import { getCommerceBase, buyerId, getProducts, checkEntitlement, startCheckout, startBillingPortal } from "../lib/commerce";

export interface BrokerHostBridgeContext {
  /** The connection this extension is bound to. */
  connectionId: string;
  /** This extension's id — used to proxy backend calls through the broker. */
  extensionId: string;
  /** Open a URL in the system browser. */
  openExternal: (url: string) => Promise<void>;
  /** Surface a host notification / toast on the extension's behalf. */
  notify: (n: HostNotification) => Promise<void>;
}

export function createBrokerHostBridge(ctx: BrokerHostBridgeContext): HostBridge {
  return {
    // Readiness only — the actual scoped-credential mint (and any supervised approval)
    // happens in the backend against the injected credentialsUrl.
    async ensureAccess(): Promise<AccessState> {
      const conn = await broker.getConnection(ctx.connectionId);
      if (conn.status === "active") return "granted";
      if (conn.status === "pending") return "pending";
      return "denied";
    },
    getConnection: () => broker.getConnection(ctx.connectionId),
    getAudit: () => broker.audit(ctx.connectionId),
    getInventory: () => broker.inventory(ctx.connectionId),
    // Proxy through the broker (the webview can't reach the backend's port directly —
    // CORS). The broker forwards to the spawned backend and returns its response; a
    // non-2xx surfaces as `backend <status>: <body>` for the frontend's error contract.
    invokeBackend: <T = unknown>(request: BackendInvoke): Promise<T> =>
      broker.invokeExtensionBackend<T>(ctx.extensionId, request),
    openExternal: (url) => ctx.openExternal(url),
    notify: (n) => ctx.notify(n),

    // --- In-app purchases (commerce:purchase). The poppyId is this extension's id; the buyerId is
    // the host's stable per-install id. Payment runs in the system browser; entitlement is
    // server-verified — the poppy only ever learns owned/not-owned. ---
    async purchaseInfo(productId: string, options?: PurchaseOptions): Promise<PurchaseInfo> {
      const base = getCommerceBase();
      const buyer = buyerId();
      const [products, owned] = await Promise.all([
        getProducts(base, ctx.extensionId),
        checkEntitlement(base, ctx.extensionId, buyer, productId, options?.target),
      ]);
      const prod = products.find((p) => p.productId === productId);
      return {
        productId,
        name: prod?.name ?? productId,
        price: prod
          ? { amountMinor: prod.pricing.amountMinor, currency: prod.pricing.currency, kind: prod.pricing.kind, interval: prod.pricing.interval, trialDays: prod.pricing.trialDays }
          : null,
        owned,
      };
    },
    async buyProduct(productId: string, options?: PurchaseOptions): Promise<{ owned: boolean }> {
      const base = getCommerceBase();
      const buyer = buyerId();
      const url = await startCheckout(base, ctx.extensionId, buyer, productId, options?.target);
      if (!url) return { owned: false };
      await ctx.openExternal(url);
      // Poll for the entitlement the webhook writes on payment (~2 min), then give up.
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        if (await checkEntitlement(base, ctx.extensionId, buyer, productId, options?.target)) return { owned: true };
      }
      return { owned: false };
    },
    isPurchased: (productId: string, options?: PurchaseOptions) =>
      checkEntitlement(getCommerceBase(), ctx.extensionId, buyerId(), productId, options?.target),
    // Open the buyer's billing portal (cancel / update card / invoices) in the system browser. The
    // portal is per-customer, so productId/options aren't needed to address it — kept for API
    // symmetry. A missing portal URL (no subscription) simply opens nothing.
    async manageSubscription(): Promise<void> {
      const url = await startBillingPortal(getCommerceBase(), ctx.extensionId, buyerId());
      if (url) await ctx.openExternal(url);
    },
  };
}
