// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
/// <reference lib="dom" />

/**
 * The STANDARD AgentsPoppy purchase button — a framework-agnostic custom element
 * (`<agentspoppy-purchase>`) a poppy drops in to sell one of its products. It renders a fixed,
 * recognisable look inside a shadow root (so it reads the same across every poppy and can't be
 * quietly restyled into something misleading), and drives the whole flow through the host bridge:
 *
 *   <agentspoppy-purchase product="pro"></agentspoppy-purchase>
 *   <agentspoppy-purchase product="domain-access" target="acme.com"></agentspoppy-purchase>
 *
 * It shows the price (from the developer's priced product), flips to "Owned" once bought, and on
 * click runs `bridge.buyProduct` → AgentsPoppy checkout. It dispatches a bubbling `purchased` event
 * on success so the poppy can unlock the feature. Payment details never touch the poppy; entitlement
 * is verified server-side — the button is UI, the truth is the host.
 *
 * Call {@link definePurchaseButton} once (with your host bridge) after the frontend boots.
 */
import type { HostBridge, PurchaseInfo } from "./host-api";

const TAG = "agentspoppy-purchase";
const SYMBOLS: Record<string, string> = { usd: "$", eur: "€", gbp: "£", cad: "$", aud: "$" };

function formatPrice(price: NonNullable<PurchaseInfo["price"]>): string {
  const major = (price.amountMinor / 100).toFixed(2);
  const amount = `${SYMBOLS[price.currency] ?? price.currency.toUpperCase() + " "}${major}`;
  return price.kind === "subscription" ? `${amount}/${price.interval === "month" ? "mo" : "yr"}` : amount;
}

const STYLE = `
  :host { display: inline-block; font-family: system-ui, -apple-system, sans-serif; }
  button {
    display: inline-flex; align-items: center; gap: 7px;
    border: none; border-radius: 999px; padding: 8px 15px;
    font-size: 14px; font-weight: 600; cursor: pointer;
    background: #d97757; color: #1a1712;
  }
  button:hover:not(:disabled) { background: #e08a6d; }
  button:disabled { opacity: 0.6; cursor: default; }
  .mark { width: 14px; height: 14px; flex: none; }
  .owned { color: #2f8f4e; font-weight: 600; font-size: 14px; display: inline-flex; align-items: center; gap: 6px; }
  .owned .mark { color: #2f8f4e; }
  .manage { margin-left: 9px; background: none; border: none; padding: 0; color: #8f8a80; font-size: 13px; text-decoration: underline; cursor: pointer; }
  .manage:hover { color: #1a1712; }
`;

// The AgentsPoppy four-petal mark, so the button is recognisable as a platform purchase.
const MARK = `<svg class="mark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="7" r="4"/><circle cx="12" cy="17" r="4"/><circle cx="7" cy="12" r="4"/><circle cx="17" cy="12" r="4"/></svg>`;

/**
 * Define the `<agentspoppy-purchase>` element, bound to the poppy's host bridge. Idempotent and a
 * no-op outside a browser (SSR-safe). Attributes: `product` (required), `target` (optional
 * per-instance scope), `label` (optional button-text override).
 */
export function definePurchaseButton(bridge: HostBridge): void {
  if (typeof window === "undefined" || typeof customElements === "undefined") return;
  if (customElements.get(TAG)) return;

  class PurchaseButton extends HTMLElement {
    private root = this.attachShadow({ mode: "open" });

    connectedCallback(): void {
      void this.refresh();
    }

    private get product(): string {
      return this.getAttribute("product") ?? "";
    }
    private get opts(): { target?: string } | undefined {
      const target = this.getAttribute("target") ?? undefined;
      return target ? { target } : undefined;
    }

    /** Re-read price + ownership from the host and repaint. */
    async refresh(): Promise<void> {
      this.paint(`<span class="owned">…</span>`);
      const info = await bridge.purchaseInfo(this.product, this.opts).catch(() => null);
      if (!info) {
        this.paint(""); // couldn't load — render nothing rather than a broken button
        return;
      }
      if (info.owned) {
        // ALWAYS offer "Manage" once owned → the host opens the billing portal (cancel a
        // subscription, update the card, see invoices/receipts). This is a PLATFORM REQUIREMENT: a
        // buyer must always be able to find how to cancel/what they paid, so it's rendered here by
        // the SDK (in the shadow root) and can't be dropped by a poppy that uses this button. For a
        // one-time purchase the portal simply shows the receipt (nothing to cancel).
        this.paint(`<span class="owned">${MARK} Owned</span><button type="button" class="manage">Manage</button>`);
        this.root
          .querySelector(".manage")
          ?.addEventListener("click", () => void bridge.manageSubscription(this.product, this.opts).catch(() => {}));
        return;
      }
      if (!info.price) {
        this.paint(""); // not for sale (free) — nothing to show
        return;
      }
      const label = this.getAttribute("label") ?? `${info.price.kind === "subscription" ? "Subscribe" : "Buy"} · ${formatPrice(info.price)}`;
      this.paint(`<button type="button">${MARK}<span>${escapeHtml(label)}</span></button>`);
      this.root.querySelector("button")?.addEventListener("click", () => void this.buy());
    }

    private async buy(): Promise<void> {
      const btn = this.root.querySelector("button");
      if (btn) {
        btn.disabled = true;
        btn.querySelector("span")!.textContent = "Waiting for payment…";
      }
      const res = await bridge.buyProduct(this.product, this.opts).catch(() => ({ owned: false }));
      if (res.owned) {
        this.dispatchEvent(new CustomEvent("purchased", { bubbles: true, detail: { product: this.product, target: this.opts?.target } }));
        void this.refresh();
      } else if (btn) {
        void this.refresh(); // reset to the buy state
      }
    }

    private paint(inner: string): void {
      this.root.innerHTML = `<style>${STYLE}</style>${inner}`;
    }
  }

  customElements.define(TAG, PurchaseButton);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
