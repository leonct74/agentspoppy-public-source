// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, broker, type DirectoryCatalogView, type DirectoryPoppy, type UpdatePreview } from "../api/broker";
import { Icon } from "../components/Icon";
import { ExtLink, openExternal } from "../components/ExtLink";
import { PoppySpinner } from "../components/PoppySpinner";
import { buildAuditPrompt, hasSourceDiff, repoCompareUrl } from "../lib/updateAudit";
import { buyerId, commerceBase, setCommerceBase, formatPrice, checkEntitlement, startCheckout } from "../lib/commerce";

export interface DirectoryViewProps {
  /** A poppy just landed — refresh the host's extension list right away (don't wait on the poll). */
  onInstalled: () => void;
  /** Open an installed poppy's tab (by extension id). */
  onOpenPoppy: (extensionId: string) => void;
  /** A poppy was just uninstalled — refresh + close its tab if it was open. */
  onUninstalled?: (extensionId: string) => void;
  /** A poppy was just updated in place — refresh + remount its tab so it reloads on the new build. */
  onUpdated?: (extensionId: string) => void;
}

function monogram(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
}

/**
 * The curated directory — the in-app browse surface for poppies. Every listing
 * links its open repository (the audit affordance); installing downloads, verifies
 * and unpacks the package broker-side, so this view only asks and reports.
 */
export function DirectoryView({ onInstalled, onOpenPoppy, onUninstalled, onUpdated }: DirectoryViewProps) {
  const [catalog, setCatalog] = useState<DirectoryCatalogView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Which card's install is in flight (one at a time in practice, keyed to be safe),
  // and the last install failure — shown up top, with the card left usable for a retry.
  const [installing, setInstalling] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  // Uninstall is a two-step act: the first click swaps the card's actions for a
  // plain-language confirm (cloud stays untouched), the second actually removes it.
  const [confirmingUninstall, setConfirmingUninstall] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  // Update is audited BEFORE it's applied: "Update" opens a review that downloads+verifies
  // the new package (without installing it), so the user can read the diff, check the AWS
  // scope change, and verify with their agent — then consciously Apply.
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [preview, setPreview] = useState<UpdatePreview | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  // A post-install notice (e.g. "this version asks for new access") — shown as a success banner.
  const [updateNotice, setUpdateNotice] = useState<string | null>(null);

  // Commerce (paid poppies): which paid poppies this install is entitled to, and which Buy is in
  // flight. A paid poppy shows "Buy · $X" until entitled, then unlocks to Install.
  const [entitled, setEntitled] = useState<Record<string, boolean>>({});
  const [buying, setBuying] = useState<string | null>(null);
  const [buyError, setBuyError] = useState<string | null>(null);
  const buyPollRef = useRef<number | null>(null);
  // The id of the review the user most recently opened — so a slower earlier preview that
  // resolves late can't overwrite the panel with the wrong poppy's data (the state is shared).
  const reviewReqRef = useRef<string | null>(null);

  // `silent` keeps the grid on screen for the post-install refresh — no loading flash.
  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) {
      setLoading(true);
      setLoadError(null);
    }
    try {
      setCatalog(await broker.directoryCatalog());
      setLoadError(null);
    } catch {
      // The catalog lives on the internet — the likely cause is being offline,
      // not anything the user did.
      if (!opts.silent)
        setLoadError("Couldn't load Poppies — check your internet connection and try again.");
    } finally {
      if (!opts.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // After each catalog load, learn which paid poppies this install already owns (so they show
  // Install, not Buy). Fail-closed: any error leaves a paid poppy locked.
  useEffect(() => {
    const base = commerceBase(catalog?.sourceUrl);
    if (base) setCommerceBase(catalog?.sourceUrl); // share the origin with the in-poppy purchase bridge
    if (!catalog || !base) return;
    const paid = catalog.poppies.filter((p) => p.pricing && !p.installed);
    if (paid.length === 0) return;
    let cancelled = false;
    const buyer = buyerId();
    void Promise.all(paid.map(async (p) => [p.id, await checkEntitlement(base, p.id, buyer)] as const)).then(
      (pairs) => {
        if (cancelled) return;
        setEntitled((prev) => {
          const next = { ...prev };
          for (const [id, ok] of pairs) next[id] = ok;
          return next;
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [catalog]);

  // Stop any in-flight purchase poll on unmount.
  useEffect(
    () => () => {
      if (buyPollRef.current != null) window.clearInterval(buyPollRef.current);
    },
    [],
  );

  // Buy a paid poppy: open hosted Checkout in the system browser, then poll for the entitlement the
  // webhook writes on payment — when it lands, the card unlocks to Install (no app restart).
  const buy = async (p: DirectoryPoppy) => {
    const base = commerceBase(catalog?.sourceUrl);
    if (!base) {
      setBuyError("Couldn't reach the store — try again in a moment.");
      return;
    }
    setBuyError(null);
    setBuying(p.id);
    const buyer = buyerId();
    const url = await startCheckout(base, p.id, buyer);
    if (!url) {
      setBuyError(`Couldn't start checkout for ${p.name} — nothing was charged. Please try again.`);
      setBuying(null);
      return;
    }
    openExternal(url);
    if (buyPollRef.current != null) window.clearInterval(buyPollRef.current);
    let tries = 0;
    buyPollRef.current = window.setInterval(() => {
      tries += 1;
      void checkEntitlement(base, p.id, buyer).then((ok) => {
        if (ok) {
          setEntitled((prev) => ({ ...prev, [p.id]: true }));
          setBuying(null);
          if (buyPollRef.current != null) window.clearInterval(buyPollRef.current);
          buyPollRef.current = null;
          void load({ silent: true });
        } else if (tries >= 40) {
          // ~2 min with no confirmed payment — stop polling; the user can click Buy again to retry.
          setBuying(null);
          if (buyPollRef.current != null) window.clearInterval(buyPollRef.current);
          buyPollRef.current = null;
        }
      });
    }, 3000);
  };

  const install = async (id: string) => {
    setInstalling(id);
    setInstallError(null);
    try {
      await broker.directoryInstall(id);
      // Refresh both sides: the catalog's installed flags and the host's extension
      // list (the sidebar), so the new poppy appears without waiting on the 3s poll.
      await load({ silent: true });
      onInstalled();
    } catch (e) {
      setInstallError(
        e instanceof ApiError
          ? e.message
          : "Couldn't install this poppy — something unexpected went wrong. Nothing was installed.",
      );
    } finally {
      setInstalling(null);
    }
  };

  // Open the audit review — this does NOT download the package (it reads the open repo);
  // nothing untrusted lands on the machine until the user chooses to install.
  const openReview = async (id: string) => {
    reviewReqRef.current = id;
    setReviewing(id);
    setPreview(null);
    setCopiedPrompt(false);
    setReviewLoading(true);
    setInstallError(null);
    try {
      const pv = await broker.directoryPreviewUpdate(id);
      if (reviewReqRef.current !== id) return; // a newer review was opened — ignore this stale result
      setPreview(pv);
    } catch (e) {
      if (reviewReqRef.current !== id) return;
      setReviewing(null);
      setInstallError(
        e instanceof ApiError
          ? e.message
          : "Couldn't prepare this update for review — check your internet connection and try again.",
      );
    } finally {
      if (reviewReqRef.current === id) setReviewLoading(false);
    }
  };

  const closeReview = () => {
    reviewReqRef.current = null;
    setReviewing(null);
    setPreview(null);
  };

  // Install a reviewed update: NOW download + verify + install (nothing was fetched at review).
  const applyUpdate = async (id: string) => {
    setUpdating(id);
    setInstallError(null);
    setUpdateNotice(null);
    try {
      const res = await broker.directoryApplyUpdate(id);
      await load({ silent: true });
      // Remount the poppy's tab (if open) so it reloads on the new build, and refresh the sidebar.
      onUpdated?.(id);
      onInstalled();
      closeReview();
      // Surface a scope change at install time — the poppy re-approves the new access on next run.
      const added = [...res.grantsAdded, ...res.capabilitiesAdded];
      if (added.length) {
        setUpdateNotice(
          `Updated to v${res.version}. This version asks for new access (${added.join("; ")}) — you'll re-approve it the next time it runs.`,
        );
      }
    } catch (e) {
      // Drop the (now-stale) review so re-clicking Update prepares a fresh copy to audit —
      // e.g. when the broker asked the user to review again because the catalog moved on.
      closeReview();
      setInstallError(
        e instanceof ApiError
          ? e.message
          : "Couldn't update this poppy — something unexpected went wrong. Your installed version is unchanged.",
      );
    } finally {
      setUpdating(null);
    }
  };

  const copyAuditPrompt = async (p: UpdatePreview) => {
    try {
      await navigator.clipboard.writeText(buildAuditPrompt(p));
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 2500);
    } catch {
      // Clipboard blocked — tell the user, and point them at the source-diff link so they
      // can still audit manually rather than silently doing nothing.
      setInstallError(
        "Couldn't copy the audit prompt to your clipboard. You can still review the change via the source-diff link.",
      );
    }
  };

  const uninstall = async (id: string) => {
    setUninstalling(id);
    setInstallError(null);
    try {
      await broker.uninstallExtension(id);
      await load({ silent: true });
      onUninstalled?.(id);
    } catch (e) {
      setInstallError(
        e instanceof ApiError
          ? e.message
          : "Couldn't uninstall this poppy — something unexpected went wrong. It's still installed.",
      );
    } finally {
      setUninstalling(null);
      setConfirmingUninstall(null);
    }
  };

  return (
    <section className="directory">
      <h3 className="os-section-label">Poppies</h3>
      <div className="detail-head">
        <h2>Add poppies</h2>
      </div>
      <p className="muted directory-lede">
        Poppies are apps that run in <strong>your own cloud</strong>, under AgentsPoppy&apos;s watch.
        Every listing links its open repository, so you — or your AI agent — can read exactly what a
        poppy does before you install it.
      </p>

      {installError && <div className="banner banner-error">{installError}</div>}
      {buyError && <div className="banner banner-error">{buyError}</div>}
      {updateNotice && (
        <div className="banner banner-row banner-update">
          <div>{updateNotice}</div>
          <button className="btn link" onClick={() => setUpdateNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      {loadError ? (
        <div className="banner banner-error banner-row">
          <div>{loadError}</div>
          <button className="btn" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : loading && !catalog ? (
        <p className="muted">Loading poppies…</p>
      ) : catalog && catalog.poppies.length === 0 ? (
        <p className="muted">No poppies listed yet — check back soon.</p>
      ) : (
        catalog && (
          <div className="os-group">
            <div className="os-grid">
              {catalog.poppies.map((p) => (
                <div key={p.id} className="os-card">
                  <div className="os-card-head">
                    <span className="os-avatar" aria-hidden="true">
                      {p.icon ? <img src={p.icon} alt="" /> : monogram(p.name)}
                    </span>
                    {p.featured && <span className="badge badge-featured">Featured</span>}
                  </div>

                  <div className="os-card-main">
                    <span className="os-card-name">{p.name}</span>
                    {p.tagline && <span className="os-card-sub muted">{p.tagline}</span>}
                    {p.publisher && <span className="os-card-sub muted">by {p.publisher}</span>}
                    {/* What real installs said, via each poppy's Feedback tab. Unrated poppies
                        show nothing at all — a "0.0 ★" reads as a bad score, not an absent one. */}
                    {p.rating != null && p.ratingCount ? (
                      <span
                        className="os-card-sub muted"
                        title={`${p.rating.toFixed(1)} out of 5, from ${p.ratingCount} ${p.ratingCount === 1 ? "rating" : "ratings"}`}
                      >
                        <span className="stars" aria-hidden="true">
                          <span className="stars-empty">★★★★★</span>
                          <span className="stars-fill" style={{ width: `${(p.rating / 5) * 100}%` }}>
                            ★★★★★
                          </span>
                        </span>{" "}
                        {p.rating.toFixed(1)} ({p.ratingCount})
                      </span>
                    ) : null}
                    <div className="os-card-chips">
                      {p.installed ? (
                        <>
                          <span className="badge">v{p.installedVersion ?? p.version} installed</span>
                          {p.updateAvailable && (
                            <span className="badge badge-update">v{p.version} available</span>
                          )}
                          {p.hostTooOld && (
                            <span className="badge" title={`v${p.version} needs a newer AgentsPoppy`}>
                              v{p.version} needs an AgentsPoppy update
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="badge">v{p.version}</span>
                      )}
                      {!p.installed && p.pricing && (
                        <span className="badge badge-price">{formatPrice(p.pricing)}</span>
                      )}
                    </div>
                    <ExtLink
                      className="directory-source"
                      href={p.repo}
                      title="The poppy's open repository — read exactly what it does before installing"
                    >
                      <Icon name="external" /> Read the source
                    </ExtLink>
                  </div>

                  <div className="os-card-actions">
                    {confirmingUninstall === p.id ? (
                      <div className="directory-confirm">
                        <p>
                          Remove {p.name} from this computer? Everything it built in your cloud
                          stays untouched and keeps working — reinstalling brings it right back.
                          (Deleting the cloud backend is a separate act, on its Manage page.)
                        </p>
                        <div className="directory-confirm__row">
                          <button
                            className="btn btn-primary"
                            disabled={uninstalling === p.id}
                            onClick={() => void uninstall(p.id)}
                          >
                            {uninstalling === p.id ? "Uninstalling…" : "Uninstall"}
                          </button>
                          <button className="btn link" onClick={() => setConfirmingUninstall(null)}>
                            Keep it
                          </button>
                        </div>
                      </div>
                    ) : reviewing === p.id ? (
                      updateReview(
                        p,
                        // Only trust a preview that belongs to THIS card (shared state guard).
                        preview?.id === p.id ? preview : null,
                        reviewLoading,
                        updating === p.id,
                        copiedPrompt,
                        () => void applyUpdate(p.id),
                        () => preview?.id === p.id && void copyAuditPrompt(preview),
                        closeReview,
                      )
                    ) : (
                      cardAction(
                        p,
                        installing,
                        install,
                        openReview,
                        onOpenPoppy,
                        () => setConfirmingUninstall(p.id),
                        { entitled: entitled[p.id] === true, buying: buying === p.id, onBuy: () => void buy(p) },
                      )
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      )}

      <div className="notice">
        <Icon name="download" />
        <p>
          Developers can share poppies outside this catalog too — installing one from your own
          disk always stays open.
        </p>
      </div>
    </section>
  );
}

function cardAction(
  p: DirectoryPoppy,
  installing: string | null,
  install: (id: string) => Promise<void>,
  onReview: (id: string) => void,
  onOpenPoppy: (extensionId: string) => void,
  onConfirmUninstall: () => void,
  commerce: { entitled: boolean; buying: boolean; onBuy: () => void },
) {
  if (p.installed) {
    return (
      <>
        {p.updateAvailable ? (
          <button
            className="btn btn-primary"
            title={`Review and update to v${p.version}`}
            onClick={() => onReview(p.id)}
          >
            Update to v{p.version}…
          </button>
        ) : (
          <span className="badge badge-active">Installed</span>
        )}
        <button className="btn" onClick={() => onOpenPoppy(p.id)}>
          Open
        </button>
        <button className="btn link" onClick={onConfirmUninstall}>
          Uninstall
        </button>
      </>
    );
  }
  if (p.blocked) {
    // Rung-1 local ban: the host refuses to run it, so offering Install would dead-end in a 409.
    return (
      <div className="notice notice--warn directory-note" role="status">
        <Icon name="ban" />
        <p>Blocked on this computer</p>
      </div>
    );
  }
  if (!p.platform.available) {
    return (
      <button className="btn" disabled title={`No package for ${p.platform.key} yet`}>
        Not yet available for this computer
      </button>
    );
  }
  if (p.hostTooOld) {
    // The catalog says this listing needs a newer AgentsPoppy (minHost) — installing
    // would only 409 in the broker, so say the real fix instead.
    return (
      <button className="btn" disabled title="Update AgentsPoppy, then install this poppy">
        Update AgentsPoppy to install
      </button>
    );
  }
  // Paid poppy the buyer hasn't purchased yet → Buy (hosted Checkout) instead of Install. Once the
  // entitlement lands, this falls through to the normal Install button below.
  if (p.pricing && !commerce.entitled) {
    return (
      <button className="btn btn-primary" disabled={commerce.buying} onClick={commerce.onBuy}>
        {commerce.buying ? (
          <>
            <PoppySpinner size={15} tone="current" /> Waiting for payment…
          </>
        ) : (
          `Buy · ${formatPrice(p.pricing)}`
        )}
      </button>
    );
  }
  return (
    <button
      className="btn btn-primary"
      disabled={installing === p.id}
      onClick={() => void install(p.id)}
    >
      {installing === p.id ? (
        <>
          <PoppySpinner size={15} tone="current" /> Installing…
        </>
      ) : (
        "Install"
      )}
    </button>
  );
}

/**
 * The audit-BEFORE-download panel: reviewing reads the OPEN SOURCE (nothing is downloaded to the
 * computer yet). It offers the source diff and a verify-with-your-agent prompt; the package is
 * only fetched + installed when the user clicks "Download & install".
 */
function updateReview(
  p: DirectoryPoppy,
  preview: UpdatePreview | null,
  loading: boolean,
  applying: boolean,
  copiedPrompt: boolean,
  onApply: () => void,
  onCopyPrompt: () => void,
  onCancel: () => void,
) {
  if (loading || !preview) {
    return (
      <div className="directory-confirm" role="status">
        <p>Preparing v{p.version} for review…</p>
        <div className="directory-confirm__row">
          <button className="btn link" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="directory-review">
      <p className="directory-review__lead">
        <strong>Review this update before installing it.</strong> v{preview.installedVersion} → v{preview.version}
      </p>
      <p className="directory-review__scope-ok muted">
        <Icon name="check" /> Reviewing reads the open source — nothing is downloaded to your computer until
        you choose to install.
      </p>

      <button className="btn btn-audit directory-review__verify" onClick={onCopyPrompt}>
        <Icon name={copiedPrompt ? "check" : "shield"} />
        {copiedPrompt ? "Prompt copied — paste it to your AI agent" : "Verify this update with your AI agent"}
      </button>
      <p className="directory-review__audit-hint muted">
        Copies a prompt (written by AgentsPoppy) that has your own AI read the open source and report
        anything undeclared or risky — new external calls, credential access, broader AWS powers — before
        you download it.{" "}
        <ExtLink
          className="directory-source"
          href={repoCompareUrl(preview.repo, preview.installedVersion, preview.version)}
          title="Read the exact source changes between the two releases, in the open repository"
        >
          <Icon name="external" /> {hasSourceDiff(preview.repo) ? "See what changed" : "Read the source"}
        </ExtLink>
      </p>

      <div className="directory-confirm__row">
        <button className="btn btn-primary" disabled={applying} onClick={onApply}>
          {applying ? (
            <>
              <PoppySpinner size={15} tone="current" /> Downloading &amp; installing…
            </>
          ) : (
            `Download & install v${preview.version}`
          )}
        </button>
        <button className="btn link" disabled={applying} onClick={onCancel}>
          Not now
        </button>
      </div>
      {applying && (
        <p className="directory-review__audit-hint muted" role="status">
          Downloading and verifying v{preview.version}, then swapping it in — this can take a minute on a
          slow connection. Keep AgentsPoppy open.
        </p>
      )}
    </div>
  );
}
