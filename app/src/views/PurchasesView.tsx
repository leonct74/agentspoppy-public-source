// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The host-owned Purchases view — every purchase this install has made, across every poppy,
 * with a prominent Manage/Cancel path. This is a PLATFORM guarantee: a poppy's own UI may offer a
 * cancel button as a courtesy, but the user never depends on it — cancellation always lives here,
 * in the host's chrome, one click from the sidebar. Cancelling opens Stripe's hosted billing
 * portal in the system browser (cancel, change card, invoices), so payment stays out of the app.
 */
import { useEffect, useState } from "react";
import { buyerId, getCommerceBase, formatPrice, listPurchases, startBillingPortal, type Purchase } from "../lib/commerce";
import { openExternal } from "../components/ExtLink";

const renewDate = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

const STATUS_LABEL: Record<Purchase["status"], { text: string; tone: "ok" | "warn" | "muted" }> = {
  active: { text: "Active", tone: "ok" },
  trialing: { text: "Free trial", tone: "ok" },
  past_due: { text: "Payment problem", tone: "warn" },
  canceled: { text: "Canceled", tone: "muted" },
  none: { text: "Inactive", tone: "muted" },
};

export function PurchasesView({
  poppyNames,
  onBack,
}: {
  /** Installed poppy display names by id — uninstalled ones fall back to the raw id. */
  poppyNames: Record<string, string>;
  onBack: () => void;
}) {
  const [purchases, setPurchases] = useState<Purchase[] | null>(null);
  const [portalBusy, setPortalBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void listPurchases(getCommerceBase(), buyerId()).then(setPurchases);
  }, []);

  const manage = async (p: Purchase) => {
    const key = `${p.poppyId}/${p.productId}`;
    setPortalBusy(key);
    setErr(null);
    try {
      const url = await startBillingPortal(getCommerceBase(), p.poppyId, buyerId());
      if (url) openExternal(url);
      else setErr("Couldn’t open the billing page — check your connection and try again.");
    } finally {
      setPortalBusy(null);
    }
  };

  return (
    <section className="purchases-view">
      {/* True back navigation — returns to wherever the user came FROM (a poppy, the
          dashboard…), never a hardcoded destination. */}
      <button className="btn link" onClick={onBack}>
        ← Back
      </button>

      <div className="detail-head">
        <h2>Purchases</h2>
      </div>
      <p className="muted" style={{ margin: "2px 0 18px", fontSize: 13.5, maxWidth: 620 }}>
        Everything you’ve bought through AgentsPoppy, in one place. Cancelling a subscription never
        depends on a poppy’s own screens — you can always do it from here.
      </p>

      {err && <p style={{ color: "var(--crimson)", fontSize: 13 }}>{err}</p>}

      {purchases === null ? (
        <p className="muted">Loading…</p>
      ) : purchases.length === 0 ? (
        <div className="cap-card" style={{ maxWidth: 620 }}>
          <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
            Nothing yet. When you subscribe to a premium feature in any poppy, it appears here — with
            its price, its status, and a cancel button that’s always one click away.
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10, maxWidth: 620 }}>
          {purchases.map((p) => {
            const key = `${p.poppyId}/${p.productId}`;
            const status = STATUS_LABEL[p.status] ?? STATUS_LABEL.none;
            const lifetime = p.kind === "one_time";
            return (
              <div key={key} className="cap-card">
                <div className="cap-card-head">
                  <strong style={{ fontSize: 14 }}>{p.name}</strong>
                  <span
                    style={{
                      fontSize: 11.5,
                      padding: "2px 9px",
                      borderRadius: 999,
                      border: "1px solid var(--border)",
                      color:
                        status.tone === "ok" ? "var(--green, #7bbf7b)" : status.tone === "warn" ? "var(--amber, #d9a557)" : "var(--muted)",
                    }}
                  >
                    {lifetime && p.entitled ? "Lifetime" : status.text}
                  </span>
                </div>
                <p className="muted" style={{ margin: "0 0 10px", fontSize: 12.5 }}>
                  {poppyNames[p.poppyId] ?? p.poppyId}
                  {p.target ? ` · ${p.target}` : ""}
                  {p.pricing ? ` · ${formatPrice(p.pricing)}` : ""}
                  {p.kind === "subscription" && p.entitled && p.currentPeriodEnd
                    ? ` · renews ${renewDate(p.currentPeriodEnd)}`
                    : ""}
                </p>
                {p.kind === "subscription" ? (
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <button className="btn" disabled={portalBusy === key} onClick={() => void manage(p)}>
                      {portalBusy === key ? "Opening…" : p.entitled ? "Manage or cancel" : "Billing & invoices"}
                    </button>
                    <span className="muted" style={{ fontSize: 12 }}>
                      Opens your secure billing page in the browser.
                    </span>
                  </div>
                ) : (
                  <span className="muted" style={{ fontSize: 12 }}>
                    {p.entitled ? "Yours for good — nothing renews, nothing to cancel." : "No longer active."}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* The id this install's purchases are tied to. Support (and the platform's own comp
          panel) ask for it, and until now it lived only in localStorage — findable with
          developer tools or not at all. Shown last: useful when needed, noise otherwise. */}
      <div className="cap-card" style={{ maxWidth: 620, marginTop: 18 }}>
        <p className="muted" style={{ margin: "0 0 8px", fontSize: 12.5 }}>
          Your purchases are tied to this install. Support may ask for its id:
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <code style={{ fontSize: 12, flex: 1, overflowX: "auto", whiteSpace: "nowrap" }}>{buyerId()}</code>
          <button
            className="btn"
            onClick={async () => {
              await navigator.clipboard.writeText(buyerId());
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
    </section>
  );
}
