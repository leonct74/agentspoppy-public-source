// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The host's thin client for the platform commerce service (agentspoppy-web) — the buyer side of
 * the 5% commission (MARKETPLACE.md). A paid poppy is bought via hosted Stripe Checkout (opened in
 * the system browser); once the webhook records the entitlement, /api/entitlement reports it and
 * the card unlocks to Install.
 *
 * The commerce service is the SAME origin that serves the catalog, so we derive its base from the
 * catalog's sourceUrl — no extra config. The buyerId is a stable per-install id (this is the
 * capability that ties a purchase to this machine); v1 keeps it local, which is enough for a
 * desktop license. Server-side install enforcement is a later hardening.
 */

/** Display pricing carried on a paid catalog entry (mirrors the broker's DirectoryPricing). */
export interface CommercePricing {
  kind: "subscription" | "one_time";
  amountMinor: number;
  currency: string;
  interval?: "month" | "year";
  /** Free-trial length in days (subscriptions only), set by the developer in /admin. Absent = none. */
  trialDays?: number;
}

const BUYER_KEY = "ap.buyerId";

/** A stable per-install buyer id. Minted once and persisted; ties entitlements to this install. */
export function buyerId(): string {
  let id = localStorage.getItem(BUYER_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(BUYER_KEY, id);
  }
  return id;
}

/** The commerce service base = the origin that serves the catalog. null if the URL is unusable. */
export function commerceBase(catalogSourceUrl: string | undefined): string | null {
  if (!catalogSourceUrl) return null;
  try {
    return new URL(catalogSourceUrl).origin;
  } catch {
    return null;
  }
}

// The commerce base cached from the last catalog load, so the in-poppy purchase bridge (which runs
// outside the directory view) can reach the same origin. Defaults to the canonical site until a
// catalog load pins it (both hit the same backend/Firestore).
let cachedBase = "https://agentspoppy.com";
export function setCommerceBase(catalogSourceUrl: string | undefined): void {
  const b = commerceBase(catalogSourceUrl);
  if (b) cachedBase = b;
}
export function getCommerceBase(): string {
  return cachedBase;
}

/** A product's price + ownership, for the in-poppy purchase button. */
export interface ProductInfo {
  productId: string;
  name: string;
  price: CommercePricing | null;
  owned: boolean;
}

/** Load a poppy's products (id, name, pricing) from the commerce plane. */
export async function getProducts(
  base: string,
  poppyId: string,
): Promise<Array<{ productId: string; name: string; pricing: CommercePricing }>> {
  try {
    const res = await fetch(`${base}/api/products/${encodeURIComponent(poppyId)}`);
    if (!res.ok) return [];
    const j = (await res.json()) as { products?: Array<{ productId: string; name: string; pricing: CommercePricing }> };
    return j.products ?? [];
  } catch {
    return [];
  }
}

/** One row of the host's Subscriptions view — a buyer's standing on one product. */
export interface Purchase {
  poppyId: string;
  productId: string;
  target: string | null;
  name: string;
  pricing: CommercePricing | null;
  kind: "subscription" | "one_time";
  status: "active" | "trialing" | "past_due" | "canceled" | "none";
  currentPeriodEnd: number | null;
  entitled: boolean;
}

/** Everything this buyer has bought, across every poppy — for the host-owned Subscriptions view
 *  (the platform's guarantee that cancelling never depends on a poppy's own UI). */
export async function listPurchases(base: string, buyer: string): Promise<Purchase[]> {
  try {
    const res = await fetch(`${base}/api/purchases?buyerId=${encodeURIComponent(buyer)}`);
    if (!res.ok) return [];
    const j = (await res.json()) as { purchases?: Purchase[] };
    return j.purchases ?? [];
  } catch {
    return [];
  }
}

function entParams(poppyId: string, buyer: string, productId?: string, target?: string): string {
  const p = new URLSearchParams({ poppyId, buyerId: buyer });
  if (productId) p.set("productId", productId);
  if (target) p.set("target", target);
  return p.toString();
}

const SYMBOLS: Record<string, string> = { usd: "$", eur: "€", gbp: "£", cad: "$", aud: "$" };

/** "$4.99/mo" · "£29.00". Assumes 2-decimal currencies (the common case). */
export function formatPrice(p: CommercePricing): string {
  const major = (p.amountMinor / 100).toFixed(2);
  const amount = `${SYMBOLS[p.currency] ?? p.currency.toUpperCase() + " "}${major}`;
  return p.kind === "one_time" ? amount : `${amount}/${p.interval === "month" ? "mo" : "yr"}`;
}

/** Is this buyer entitled to this product right now? Any error → false (fail closed on the paywall).
 *  productId/target default to the whole-poppy "default" unlock when omitted. */
export async function checkEntitlement(
  base: string,
  poppyId: string,
  buyer: string,
  productId?: string,
  target?: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/entitlement?${entParams(poppyId, buyer, productId, target)}`);
    if (!res.ok) return false;
    const j = (await res.json()) as { entitled?: boolean };
    return j?.entitled === true;
  } catch {
    return false;
  }
}

/** Open the buyer's billing portal — returns the Stripe-hosted portal URL to open, or null on
 *  failure (e.g. the buyer has no subscription on this poppy's account). The opaque buyerId is the
 *  capability; the portal lets them cancel / update card / view invoices. */
export async function startBillingPortal(base: string, poppyId: string, buyer: string): Promise<string | null> {
  try {
    const res = await fetch(`${base}/api/billing-portal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ poppyId, buyerId: buyer }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { url?: string };
    return typeof j?.url === "string" ? j.url : null;
  } catch {
    return null;
  }
}

/** Begin a purchase — returns the hosted Checkout URL to open, or null on failure. */
export async function startCheckout(
  base: string,
  poppyId: string,
  buyer: string,
  productId?: string,
  target?: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${base}/api/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ poppyId, buyerId: buyer, ...(productId ? { productId } : {}), ...(target ? { target } : {}) }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { url?: string };
    return typeof j?.url === "string" ? j.url : null;
  } catch {
    return null;
  }
}
