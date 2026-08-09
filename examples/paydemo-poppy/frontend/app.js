// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
//
// PaydemoPoppy — demonstrates the standard in-app purchase button end to end.
//
// This is a no-build poppy, so it INLINES the bridge client and a copy of the SDK's
// standard purchase button. A real (bundled) poppy would instead:
//     import { createHostBridgeClient, definePurchaseButton } from "@agentspoppy/extension-sdk";
//     definePurchaseButton(createHostBridgeClient(transport));
// Same element, same wire protocol — just typed and shared.

// --- tiny host bridge client (only the commerce:purchase methods this poppy declared) ---
const pending = new Map();
let seq = 0;
window.addEventListener("message", (e) => {
  if (e.source !== window.parent) return;
  const res = e.data;
  if (!res || typeof res.id !== "string") return;
  const p = pending.get(res.id);
  if (!p) return;
  pending.delete(res.id);
  res.ok ? p.resolve(res.result) : p.reject(new Error(res.error));
});
function call(method, ...params) {
  return new Promise((resolve, reject) => {
    const id = `req-${Date.now().toString(36)}-${++seq}`;
    pending.set(id, { resolve, reject });
    window.parent.postMessage({ id, method, params }, "*");
    setTimeout(() => pending.delete(id) && reject(new Error(`host call "${method}" timed out`)), 130_000);
  });
}
const host = {
  purchaseInfo: (product, opts) => call("purchaseInfo", product, ...(opts ? [opts] : [])),
  buyProduct: (product, opts) => call("buyProduct", product, ...(opts ? [opts] : [])),
  isPurchased: (product, opts) => call("isPurchased", product, ...(opts ? [opts] : [])),
};

// --- the standard <agentspoppy-purchase> button (inlined copy of the SDK component) ---
const SYMBOLS = { usd: "$", eur: "€", gbp: "£", cad: "$", aud: "$" };
const fmt = (p) => {
  const amt = `${SYMBOLS[p.currency] ?? p.currency.toUpperCase() + " "}${(p.amountMinor / 100).toFixed(2)}`;
  return p.kind === "subscription" ? `${amt}/${p.interval === "month" ? "mo" : "yr"}` : amt;
};
const STYLE = `button{display:inline-flex;align-items:center;gap:7px;border:none;border-radius:999px;padding:8px 15px;font:600 14px system-ui;cursor:pointer;background:#d97757;color:#1a1712}button:hover:not(:disabled){background:#e08a6d}button:disabled{opacity:.6}.mark{width:14px;height:14px}.owned{color:#2f8f4e;font:600 14px system-ui;display:inline-flex;align-items:center;gap:6px}`;
const MARK = `<svg class="mark" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="7" r="4"/><circle cx="12" cy="17" r="4"/><circle cx="7" cy="12" r="4"/><circle cx="17" cy="12" r="4"/></svg>`;
class PurchaseButton extends HTMLElement {
  connectedCallback() {
    this.root = this.attachShadow({ mode: "open" });
    this.refresh();
  }
  get product() { return this.getAttribute("product") ?? ""; }
  async refresh() {
    this.paint(`<span class="owned">…</span>`);
    const info = await host.purchaseInfo(this.product).catch(() => null);
    if (!info) return this.paint("");
    if (info.owned) return this.paint(`<span class="owned">${MARK} Owned</span>`);
    if (!info.price) return this.paint("");
    this.paint(`<button type="button">${MARK}<span>${info.price.kind === "subscription" ? "Subscribe" : "Buy"} · ${fmt(info.price)}</span></button>`);
    this.root.querySelector("button").addEventListener("click", () => this.buy());
  }
  async buy() {
    const btn = this.root.querySelector("button");
    if (btn) { btn.disabled = true; btn.querySelector("span").textContent = "Waiting for payment…"; }
    const res = await host.buyProduct(this.product).catch(() => ({ owned: false }));
    if (res.owned) this.dispatchEvent(new CustomEvent("purchased", { bubbles: true }));
    this.refresh();
  }
  paint(inner) { this.root.innerHTML = `<style>${STYLE}</style>${inner}`; }
}
customElements.define("agentspoppy-purchase", PurchaseButton);

// --- unlock the "Pro feature" when owned (on load, and when a purchase completes) ---
const feature = document.getElementById("feature");
function unlock() {
  feature.classList.add("unlocked");
  feature.textContent = "✓ Pro feature unlocked — thanks for buying!";
}
document.addEventListener("purchased", unlock);
host.isPurchased("pro").then((owned) => { if (owned) unlock(); });
