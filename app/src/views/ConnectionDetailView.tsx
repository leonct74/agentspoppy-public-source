// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { useState } from "react";
import type { ActivityEvent, AuditEntry, Connection, InfraGraph, Inventory, ResidualResource } from "@agentspoppy/core";
import {
  assessPermissionSet,
  brokerGuarantees,
  grantCannotBeNarrowed,
  serviceStake,
  summarizeObserved,
  awsConsoleUrl,
  grantCanDestroy,
  grantCanLaunchUntracked,
  grantCanMutate,
  groupByService,
  ledgerConsoleUrl,
} from "@agentspoppy/core";
import { InfraMap } from "../components/InfraMap";
import { PoppySpinner } from "../components/PoppySpinner";
import { serviceColor, summarizeFootprint } from "../lib/infraLayout";
import { StatusBadge } from "../components/StatusBadge";
import { RiskBadge } from "../components/RiskBadge";
import { Countdown } from "../components/Countdown";
import { Icon } from "../components/Icon";
import { formatDateTime } from "../lib/format";

export interface ConnectionDetailViewProps {
  connection: Connection;
  inventory: Inventory;
  audit: AuditEntry[];
  /**
   * The observed register: what this poppy has actually done (CloudTrail, app-keyed).
   * null = still loading · "unavailable" = the trail could not be read — and the view must
   * keep those three states apart, because "no events" is only meaningful when the trail
   * was actually readable.
   */
  observed?: { events: ActivityEvent[]; sinceMinutes: number } | "unavailable" | null;
  /** The verified service graph — drawn as the infrastructure map. Null while still loading. */
  infra?: InfraGraph | null;
  /** The map is still being fetched/verified — show a placeholder so it doesn't pop in. */
  infraLoading?: boolean;
  /** AWS couldn't be read at all (bad/expired operator creds, or missing read perms) — show a
   *  reconnect banner instead of a misleading empty map. */
  infraError?: string | null;
  /** Start the reconnect flow (re-enter operator credentials) — wired to the banner's button so
   *  the fix is one click from where the failure is shown, not a path the user has to hunt for. */
  onReconnect?: () => void;
  /** The view auto-refreshes on an interval — show a subtle "Live" cue so the user knows. */
  live?: boolean;
  onBack: () => void;
  onPause: () => void;
  onResume: () => void;
  onRevoke: () => void;
  onTeardown: () => void;
  /** Teardown is in flight (emptying buckets + waiting for DELETE_COMPLETE). */
  tearingDown?: boolean;
  /** A one-off result notice (e.g. what teardown removed, or why nothing was removed). */
  notice?: string | null;
  /** Render the notice as a warning (e.g. teardown left resources behind). */
  noticeWarn?: boolean;
  onDismissNotice?: () => void;
  /** Leftovers the teardown genuinely couldn't remove — listed with console links so the
   *  user can finish by hand. Never silent: orphaned-but-hidden is the worst outcome. */
  leftovers?: ResidualResource[];
  /** Teardown's host cleanup hit AccessDenied — the user's access policy predates the
   *  host-cleanup permissions. Shown with a one-click jump to the update-policy fix. */
  cleanupAuthProblem?: boolean;
  /** Route to the "update your access policy" panel (ConnectAwsView). */
  onUpdatePolicy?: () => void;
  /** Forget a revoked connection — clears its local record and returns to the list. */
  onForget?: () => void;
  /** Navigate to the poppy so the user can re-enable + approve it. A revoked poppy can't run its
   *  own cleanup, so a complete teardown needs it active again first — this jumps them to that flow. */
  onReEnable?: () => void;
  /** This poppy is blocked (rung-1 ban). A blocked poppy can't run its own cleanup even if
   *  re-approved (start() short-circuits on the blocklist), so we must NOT steer teardown through
   *  "re-enable first" — it would dead-end. When true, teardown goes straight to the host-only path. */
  poppyBlocked?: boolean;
  /** Toggle supervised mode (require per-operation approval before it can change anything). */
  onToggleSupervise?: (supervised: boolean) => void;
  /** Shown only while the connection is pending — decide after reviewing. */
  onApprove?: () => void;
  onDeny?: () => void;
  /** Block this poppy from loading/running (rung-1 local ban). Offered from the
   *  Report dialog's self-protection options; omit to hide the block option. */
  onBlock?: () => void;
}

/** Open a URL (a mailto: report, here) in the OS handler; new-tab fallback in plain-browser dev.
 *  Best-effort — never throws (the opener can be unavailable, or window.open blocked). */
function openUrlExternal(url: string): void {
  import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("plugin:opener|open_url", { url, with: null }))
    .catch(() => {
      try {
        window.open(url, "_blank", "noopener");
      } catch {
        /* no opener available (e.g. tests) — the report action still completes */
      }
    });
}

/** Where community reports go until the marketplace/directory backend aggregates them. */
const REPORT_TO = "support@mailpoppy.com";

const REPORT_CATEGORIES = [
  { id: "malicious", label: "Malicious / destructive behaviour" },
  { id: "resources", label: "Damaged or deleted my resources" },
  { id: "privacy", label: "Privacy / data concern" },
  { id: "bug", label: "Bug or broken behaviour" },
] as const;
type ReportCategory = (typeof REPORT_CATEGORIES)[number]["id"];

/** The per-poppy view: what it can do, what it built, and the controls. */
export function ConnectionDetailView(props: ConnectionDetailViewProps) {
  const { connection: c, inventory, audit } = props;
  const [showSupervisedHelp, setShowSupervisedHelp] = useState(false);
  // Tearing down deletes the poppy's *entire* footprint (buckets, tables, user pools) and can't be
  // undone — so a single stray click must never trigger it. The button opens a confirm that makes
  // the user *type the poppy's name* before the destructive action unlocks, forcing awareness of
  // exactly which poppy they're wiping.
  const [confirmTeardown, setConfirmTeardown] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const teardownArmed = confirmText.trim().toLowerCase() === c.app.name.trim().toLowerCase();
  const closeConfirm = () => {
    setConfirmTeardown(false);
    setConfirmText("");
  };
  // Guard the "revoke before I delete, for safety" instinct — which is actually the
  // unsafe order (see the Revoke button + this dialog below).
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  // Reporting: any user can flag a poppy (bug / privacy / malicious) — the community
  // signal that feeds ring-fencing. Until the directory backend aggregates reports,
  // this files one out-of-band and lets the user self-protect (pause / block) now.
  const [showReport, setShowReport] = useState(false);
  const [reportCategory, setReportCategory] = useState<ReportCategory>("malicious");
  const [reportDetail, setReportDetail] = useState("");
  const [reportPause, setReportPause] = useState(false);
  const [reportBlock, setReportBlock] = useState(false);
  const closeReport = () => {
    setShowReport(false);
    setReportDetail("");
    setReportPause(false);
    setReportBlock(false);
    setReportCategory("malicious");
  };
  const submitReport = () => {
    const catLabel = REPORT_CATEGORIES.find((r) => r.id === reportCategory)?.label ?? reportCategory;
    const subject = `[Poppy report] ${c.app.name} — ${catLabel}`;
    const body =
      `Poppy: ${c.app.name} (${c.app.id})\n` +
      `Connection: ${c.id}\n` +
      `AWS account: ${c.accountId}\n` +
      `Category: ${catLabel}\n\n` +
      `What happened:\n${reportDetail.trim() || "(no detail provided)"}\n`;
    openUrlExternal(`mailto:${REPORT_TO}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
    // Self-protection, applied immediately so the user isn't left exposed while a
    // report is triaged.
    if (reportPause && c.status === "active") props.onPause();
    if (reportBlock) props.onBlock?.();
    closeReport();
  };
  // The teardown *preview* — exactly what the destroy will remove, summarised from the same live
  // footprint the map is drawn from (no extra AWS call), so the user can vet the blast radius
  // before they ever type the confirm word.
  const footprint = props.infra ? summarizeFootprint(props.infra) : null;
  const stackNames = inventory.stacks.map((s) => s.stackName);
  const risk = assessPermissionSet(c.permissionSet);
  const hasFootprint = inventory.stacks.length > 0 || inventory.ledger.length > 0;
  // A revoked/blocked poppy can't run its own cleanup hook, but teardown is NEVER blocked:
  // the host's residual cleanup deletes everything still tagged as the poppy's, so the user
  // can always clean up, in every state. What the host CAN'T see is the poppy's un-tagged /
  // un-taggable leftovers (e.g. DNS records) — only the poppy's own hook knows those — so for
  // a revoked (re-approvable) poppy we RECOMMEND re-enabling first, without ever requiring it.
  // A blocked poppy would dead-end on re-enable (the host won't spawn a blocked backend), so
  // it gets honest blocked copy instead of the recommendation.
  const revokedWithFootprint = c.status === "revoked" && hasFootprint;
  const recommendReEnable = revokedWithFootprint && !props.poppyBlocked && !!props.onReEnable;

  // Activity newest-first: the latest events (and any just-finished teardown result) should be
  // visible at a glance, without scrolling to the bottom of a long history.
  const recentFirst = [...audit].sort((a, b) => {
    const ta = Date.parse(a.ts);
    const tb = Date.parse(b.ts);
    if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
    return tb - ta;
  });

  type Finding = {
    level: "high" | "medium";
    title: string;
    body: string;
    gated: boolean;
    service?: string;
  };

  // THE STANDARD these two sections follow (docs/specs/permission-presentation.md):
  //
  //   "What it can do"  — the BOUNDARY of each permission. What is inside the fence.
  //   "What's at stake" — the CONSEQUENCE if that boundary is not maintained.
  //
  // They answer different questions, so they legitimately carry different colours for the
  // same grant, and a confined grant can still be red here. AffiliatePoppy's IAM grant is
  // bounded to `role/AffiliatePoppy*` — that is the boundary, and it is narrow. But if that
  // boundary ever failed, what leaks is the power to decide who can do what, which is the
  // worst thing on the list. Both statements are true at once; the old heading ("Risks to the
  // rest of your account") was what made them read as a contradiction, because it asserted
  // reach the scope line had just denied.
  const stakeFindings: Finding[] = [
    ...risk.grants
      .filter(({ risk: gr }) => (!gr.scoped || gr.level === "high") && gr.level !== "low")
      .map(({ grant, risk: gr }) => ({
        level: gr.level as "high" | "medium",
        title:
          gr.level === "high"
            ? gr.scoped
              ? `${grant.service.toUpperCase()} — controls who can do what in your account`
              : grantCanLaunchUntracked(grant) && !grantCanDestroy(grant)
                ? `${grant.service.toUpperCase()} — can start up resources AgentsPoppy cannot track`
                : `${grant.service.toUpperCase()} — can change resources beyond its own`
            : grantCanMutate(grant)
              ? `${grant.service.toUpperCase()} — can create new resources in your account`
              : `${grant.service.toUpperCase()} — can read resources beyond its own`,
        body: gr.reason,
        // `gated` means supervision actually holds this for approval — which is driven by
        // hasUnscopedGrants (broker service.ts). A CONFINED grant is never why a connection is
        // supervised, and the Supervised pill's tooltip says it is, so it must not carry one.
        gated: !gr.scoped,
        service: grant.service.toUpperCase(),
      })),
    ...risk.warnings.map((w) => ({
      level: "medium" as const,
      title: "Footprint can't be tracked or torn down",
      body: w,
      gated: false,
    })),
  ]
    // Worst first, not manifest order. This panel closes the page, and most readers stop
    // after the first card or two — the order decides what they actually learn. High before
    // medium; within a level, account-wide reach before confined.
    .sort((a, b) => {
      if (a.level !== b.level) return a.level === "high" ? -1 : 1;
      if (a.gated !== b.gated) return a.gated ? -1 : 1;
      return 0;
    });

  // The capabilities that make this connection reach beyond its own resources — the reason
  // it's supervised. Confined grants are excluded above, so this can no longer name one.
  const reachServices = [
    ...new Set(stakeFindings.filter((f) => f.gated && f.service).map((f) => f.service as string)),
  ];

  return (
    <section className="detail">
      <button className="btn link" onClick={props.onBack}>
        ← All poppies
      </button>

      <div className="detail-head">
        <h2>{c.app.name}</h2>
        <StatusBadge status={c.status} />
        {props.live && (
          <span className="live-pill" title="This view updates automatically — activity and the map refresh on their own.">
            <span className="live-dot" /> Live
          </span>
        )}
        <button
          className="btn link detail-head__report"
          onClick={() => setShowReport(true)}
          title={`Report a problem or malicious behaviour with ${c.app.name}`}
        >
          <Icon name="shield" /> Report
        </button>
      </div>

      {/* Controls first: a new user sees the reassuring "I can pause / revoke / tear
          this down anytime" actions up front, without scrolling past capabilities. */}
      <h3>Controls</h3>
      <div className="controls">
        {c.status === "pending" && props.onApprove && (
          <button className="btn btn-primary" onClick={props.onApprove}>
            Approve
          </button>
        )}
        {c.status === "pending" && props.onDeny && (
          <button className="btn" onClick={props.onDeny}>
            Deny
          </button>
        )}
        {c.status === "active" && (
          <button className="btn" onClick={props.onPause}>
            Pause
          </button>
        )}
        {c.status === "paused" && (
          <button className="btn" onClick={props.onResume}>
            Resume
          </button>
        )}
        {(c.status === "active" || c.status === "paused") && (
          <button
            className="btn"
            // If the poppy still has a footprint, revoking FIRST would strand it: once
            // revoked, the poppy's own cleanup can't run, so "tear down" can no longer
            // remove what it retained. Steer the safe order (tear down first) instead of
            // letting a cautious "revoke before deleting" quietly orphan resources.
            onClick={() => (hasFootprint ? setConfirmRevoke(true) : props.onRevoke())}
          >
            Revoke access
          </button>
        )}
        {c.status !== "pending" && (
          <button
            className="btn btn-danger"
            onClick={() => setConfirmTeardown(true)}
            disabled={props.tearingDown}
          >
            {props.tearingDown ? (
              <>
                <PoppySpinner size={13} tone="current" className="btn-poppy" />
                Tearing down…
              </>
            ) : (
              "Tear down everything it built"
            )}
          </button>
        )}
        {c.status === "revoked" && props.onForget && (
          <button
            className="btn"
            onClick={props.onForget}
            title="Remove this revoked connection from the list (local record only)"
          >
            Remove from list
          </button>
        )}
      </div>

      {/* Teardown runs for a minute or two (emptying buckets, waiting on AWS) — a live
          spinner + reassurance so the user never doubts it's actually in progress. */}
      {props.tearingDown && (
        <div className="notice teardown-status" role="status" aria-live="polite">
          <PoppySpinner size={16} />
          <p>
            Tearing down {c.app.name}… emptying buckets and waiting for AWS to confirm every resource
            is gone. This can take a minute or two — you can leave this screen, it keeps running.
          </p>
        </div>
      )}

      {confirmRevoke && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="revoke-order-title">
          <div className="modal-backdrop" onClick={() => setConfirmRevoke(false)} />
          <div className="modal-card">
            <div className="modal-danger-head">
              <Icon name="shield" />
              <h3 id="revoke-order-title">Delete what {c.app.name} built first?</h3>
            </div>
            <p className="modal-body">
              {c.app.name} has created resources in your AWS account. If you want to remove them,
              <strong> tear it down before revoking</strong> — once access is revoked, {c.app.name}
              can no longer run its own cleanup. AgentsPoppy will still remove everything tagged as
              built by {c.app.name}, but <strong>things only {c.app.name} knows about (e.g. DNS
              records it created) can be left behind</strong>.
            </p>
            <p className="modal-body muted">
              Revoking only cuts off {c.app.name}’s access — it does <em>not</em> delete what it built.
              You can still revoke now if that’s what you want; teardown stays available afterwards.
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setConfirmRevoke(false)}>
                Cancel
              </button>
              <button
                className="btn"
                onClick={() => {
                  setConfirmRevoke(false);
                  props.onRevoke();
                }}
              >
                Revoke access only
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setConfirmRevoke(false);
                  setConfirmTeardown(true);
                }}
              >
                Tear down first
              </button>
            </div>
          </div>
        </div>
      )}

      {showReport && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="report-title">
          <div className="modal-backdrop" onClick={closeReport} />
          <div className="modal-card">
            <div className="modal-danger-head">
              <Icon name="shield" />
              <h3 id="report-title">Report {c.app.name}</h3>
            </div>
            <p className="modal-body muted">
              Flag a problem or malicious behaviour. Reports help the community ring-fence bad
              poppies — and you can protect yourself right now.
            </p>

            <div className="report-cats">
              {REPORT_CATEGORIES.map((cat) => (
                <label key={cat.id} className="report-cat">
                  <input
                    type="radio"
                    name="report-category"
                    checked={reportCategory === cat.id}
                    onChange={() => setReportCategory(cat.id)}
                  />
                  {cat.label}
                </label>
              ))}
            </div>

            <label className="report-detail-label" htmlFor="report-detail">
              What happened? <span className="muted">(optional)</span>
            </label>
            <textarea
              id="report-detail"
              className="report-detail"
              rows={4}
              value={reportDetail}
              onChange={(e) => setReportDetail(e.target.value)}
              placeholder="Describe what the poppy did…"
            />

            <div className="report-protect">
              <div className="report-protect__head">Protect yourself now (recommended)</div>
              {c.status === "active" && (
                <label className="report-protect__opt">
                  <input type="checkbox" checked={reportPause} onChange={(e) => setReportPause(e.target.checked)} />
                  Pause this poppy — stops its access immediately (you can resume later).
                </label>
              )}
              {props.onBlock && (
                <label className="report-protect__opt">
                  <input type="checkbox" checked={reportBlock} onChange={(e) => setReportBlock(e.target.checked)} />
                  Block from loading — it won’t run again until you unblock it.
                </label>
              )}
            </div>

            <div className="modal-actions">
              <button className="btn" onClick={closeReport}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={submitReport}>
                Send report
              </button>
            </div>
            <p className="modal-body muted report-foot">
              Opens a pre-filled email to {REPORT_TO}. (Cross-user aggregation + automatic
              ring-fencing arrive with the curated directory.)
            </p>
          </div>
        </div>
      )}

      {confirmTeardown && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="teardown-confirm-title">
          <div className="modal-backdrop" onClick={closeConfirm} />
          <div className="modal-card">
            <div className="modal-danger-head">
              <Icon name="shield" />
              <h3 id="teardown-confirm-title">Tear down everything {c.app.name} built?</h3>
            </div>
            <p className="modal-body">
              This permanently deletes <strong>every AWS resource {c.app.name} created</strong> in this
              account — its CloudFormation stack and everything in it: S3 buckets (and all their
              contents), databases, and Cognito user pools. <strong>This cannot be undone.</strong>
            </p>
            <p className="modal-body muted">
              Your other AWS resources are untouched. {c.app.name} will only work again if it can
              rebuild from scratch.
            </p>

            {recommendReEnable ? (
              <div className="modal-body reapprove-gate">
                <p>
                  {c.app.name}’s access is revoked, so it can’t run its own cleanup — but you can
                  still tear down: AgentsPoppy deletes its stack and then{" "}
                  <strong>directly removes everything still tagged as built by {c.app.name}</strong>.
                  Anything it can’t remove is listed afterwards, with console links.
                </p>
                <p style={{ color: "var(--amber, #d6a419)" }}>
                  For the <strong>most complete</strong> cleanup, re-enable {c.app.name} first — some
                  things only it knows how to remove (e.g. DNS records it created) — then tear down
                  while it’s active.
                </p>
              </div>
            ) : props.poppyBlocked && hasFootprint ? (
              <p className="modal-body report-foot" style={{ color: "var(--amber, #d6a419)" }}>
                ⚠ {c.app.name} is blocked, so its own cleanup can’t run (the host won’t start a
                blocked poppy). AgentsPoppy still deletes its stack and directly removes everything
                tagged as built by {c.app.name} — but things only {c.app.name} knows about (e.g. DNS
                records it created) <strong>can be left behind</strong>, and AgentsPoppy can’t see
                those. Unblock it from Report first if you want its own cleanup to run.
              </p>
            ) : c.status === "revoked" ? (
              <p className="modal-body report-foot" style={{ color: "var(--amber, #d6a419)" }}>
                ⚠ {c.app.name}’s access was already revoked, so its own cleanup can’t run —
                AgentsPoppy deletes its stack and directly removes everything still tagged as built
                by {c.app.name}; anything left is listed afterwards.
              </p>
            ) : null}

            <div className="teardown-preview">
              <div className="teardown-preview__head">What will be deleted</div>
              {footprint && footprint.total > 0 ? (
                <>
                  <p className="teardown-preview__count">
                    <strong>{footprint.total}</strong> resource{footprint.total === 1 ? "" : "s"} across{" "}
                    {footprint.services.length} service{footprint.services.length === 1 ? "" : "s"}
                    {stackNames.length > 0 &&
                      ` · ${stackNames.length} stack${stackNames.length === 1 ? "" : "s"}`}
                  </p>
                  <div className="teardown-preview__chips">
                    {footprint.services.map((s) => (
                      <span key={s.service} className="td-chip">
                        <span className="td-chip__dot" style={{ background: serviceColor(s.service) }} />
                        {s.label} <strong>×{s.count}</strong>
                      </span>
                    ))}
                  </div>
                  {stackNames.length > 0 && (
                    <p className="teardown-preview__stacks muted">
                      Stack{stackNames.length === 1 ? "" : "s"}: {stackNames.join(", ")} — and everything inside.
                    </p>
                  )}
                  {footprint.outOfStack > 0 && (
                    <p className="teardown-preview__note muted">
                      {footprint.outOfStack} live outside the stack — removed by {c.app.name}’s own
                      cleanup, then re-checked.
                    </p>
                  )}
                </>
              ) : props.infraLoading ? (
                <p className="muted teardown-preview__loading">
                  <PoppySpinner size={13} className="btn-poppy" /> Reading {c.app.name}’s live footprint…
                </p>
              ) : stackNames.length > 0 ? (
                <p className="muted">
                  {stackNames.length} CloudFormation stack{stackNames.length === 1 ? "" : "s"} (
                  {stackNames.join(", ")}) — and every resource inside.
                </p>
              ) : (
                <p className="muted">
                  AgentsPoppy will delete any CloudFormation stack tagged as built by {c.app.name} and
                  sweep for leftovers. Nothing tagged as theirs is visible right now.
                </p>
              )}
            </div>

            <label className="field-label modal-confirm-label">
              To confirm, type <strong>{c.app.name}</strong> below.
              <input
                className="field"
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={c.app.name}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                aria-label={`Type ${c.app.name} to confirm teardown`}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && teardownArmed) {
                    closeConfirm();
                    props.onTeardown();
                  }
                }}
              />
            </label>
            <div className="modal-actions">
              <button className="btn" onClick={closeConfirm}>
                Cancel
              </button>
              {recommendReEnable && (
                // The recommended-but-never-required path: jump to the poppy to Enable →
                // Approve so its OWN cleanup (DNS records etc.) can run before the wipe.
                <button
                  className="btn"
                  onClick={() => {
                    closeConfirm();
                    props.onReEnable?.();
                  }}
                >
                  Re-enable first (recommended)
                </button>
              )}
              <button
                className="btn btn-danger"
                disabled={!teardownArmed}
                title={teardownArmed ? undefined : `Type ${c.app.name} to enable`}
                onClick={() => {
                  closeConfirm();
                  props.onTeardown();
                }}
              >
                Tear it all down
              </button>
            </div>
          </div>
        </div>
      )}

      {props.notice && (
        <div className={`notice${props.noticeWarn ? " notice--warn" : ""}`} role="status">
          <Icon name={props.noticeWarn ? "shield" : "check"} />
          <p>{props.notice}</p>
          {props.onDismissNotice && (
            <button className="btn link" onClick={props.onDismissNotice}>
              Dismiss
            </button>
          )}
        </div>
      )}

      {/* Anything teardown genuinely couldn't remove, one row per resource with a console
          jump — the user can always finish a cleanup by hand, never hunt blind. Also shown
          when cleanup was DENIED even if the (lagging) sweep listed nothing, so the
          update-policy fix is never invisible. */}
      {((props.leftovers && props.leftovers.length > 0) || props.cleanupAuthProblem) && (
        <div className="notice notice--warn leftovers" role="alert">
          <Icon name="shield" />
          <div className="leftovers__body">
            {props.leftovers && props.leftovers.length > 0 && (
              <strong>
                {props.leftovers.length} resource{props.leftovers.length === 1 ? "" : "s"} could not
                be removed
              </strong>
            )}
            {props.cleanupAuthProblem && (
              <p className="leftovers__auth">
                Your AgentsPoppy access policy predates automatic cleanup — update it, then tear down
                again.{" "}
                {props.onUpdatePolicy && (
                  <button className="btn link" onClick={props.onUpdatePolicy}>
                    Update access policy
                  </button>
                )}
              </p>
            )}
            {props.leftovers && props.leftovers.length > 0 && (
              <ul className="leftovers__list">
                {props.leftovers.map((r) => (
                  <li key={r.arn} className="leftovers__row">
                    <span className="leftovers__type">{r.resourceType || "resource"}</span>
                    <span className="leftovers__arn" title={r.arn}>
                      {r.arn}
                    </span>
                    {r.consoleUrl && (
                      <button className="btn link" onClick={() => openUrlExternal(r.consoleUrl as string)}>
                        Open in console ↗
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {props.onToggleSupervise && c.status !== "pending" && c.status !== "revoked" && (
        <div className={`risk-card ${c.supervised ? "risk-card--medium" : "risk-card--ok"} supervise-card`}>
          <Icon name="shield" />
          <div>
            <div className="supervise-title-row">
              <strong>
                {c.supervised ? "Supervised — you approve its AWS access" : "Unsupervised — acts within its scope"}
              </strong>
              <button
                type="button"
                className="help-btn"
                aria-expanded={showSupervisedHelp}
                aria-label="How does supervised mode work?"
                onClick={() => setShowSupervisedHelp((v) => !v)}
              >
                ?
              </button>
            </div>
            <p>
              {c.supervised
                ? `While supervised, AgentsPoppy holds this connection's credentials for your approval — ${c.app.name} can't reach AWS until you say yes.${
                    reachServices.length
                      ? ` It's supervised because it can reach beyond its own resources (${reachServices.join(", ")}).`
                      : ""
                  }`
                : "This app vends credentials on demand within its approved scope (already enforced inside every credential). Turn on supervision to require your approval before it reaches AWS."}
            </p>
            {c.status === "active" && c.credentialsExpireAt && (
              <p className="muted">
                Current session{" "}
                <strong className="session-countdown">
                  <Countdown expiresAt={c.credentialsExpireAt} prefix="expires in " />
                </strong>
              </p>
            )}
            {showSupervisedHelp && (
              <div className="help-note" role="note">
                <p style={{ margin: "0 0 6px" }}>
                  <strong>Supervised</strong> means AgentsPoppy holds {c.app.name}’s AWS credentials and you
                  approve each time it needs to make a <em>change</em>. Read-only checks vend automatically,
                  and every credential is scope-limited to its permission set regardless — so it can never
                  exceed what you granted.
                </p>
                <p style={{ margin: 0 }}>
                  Credentials are short-lived. <strong>“Expired”</strong> just means none are live right now:
                  {" "}
                  {c.app.name} has <em>no</em> access until its next change re-asks for your approval — so
                  expiry is the safe resting state, never a gap. There’s no manual refresh; it re-mints on
                  demand. Full model: AgentsPoppy’s Supervision guide (docs/SUPERVISION.md).
                </p>
              </div>
            )}
          </div>
          <button className="btn supervise-toggle" onClick={() => props.onToggleSupervise?.(!c.supervised)}>
            {c.supervised ? "Turn off" : "Turn on"}
          </button>
        </div>
      )}

      <h3>What AgentsPoppy enforces</h3>
      <p className="muted section-note">
        The floor under everything below — enforced by the platform whatever {c.app.name} asks
        for. Each line says where it is pinned, because a guarantee you cannot check is just a
        claim. Three of them depend on this poppy and say so when they do not apply.
      </p>
      <ul className="guarantee-list">
        {brokerGuarantees(c.permissionSet, { supervised: c.supervised ?? false }).map((g) => (
          <li key={g.id} className={g.holds ? "g-holds" : "g-absent"}>
            <span className="g-mark" aria-hidden="true">{g.holds ? "✓" : "—"}</span>
            <span className="g-body">
              {/* When it does not hold, the ABSENCE is the message — the promise is shown
                  struck so the user sees what they are not getting, not just prose. */}
              <span className={g.holds ? undefined : "g-struck"}>{g.text}</span>
              {g.absent ? <span className="g-why">{g.absent}</span> : null}
              <span className="g-pin">{g.pin}</span>
            </span>
          </li>
        ))}
      </ul>

      <h3>What it built in your cloud</h3>
      {props.infraError ? (
        <div className="notice notice--warn infra-unreadable" role="alert">
          <Icon name="shield" />
          <div>
            <strong>AgentsPoppy can’t read this AWS account</strong>
            <p>{props.infraError}</p>
            <p className="muted">
              Until it can, the map can’t show what {c.app.name} built — even if the deploy
              succeeded. Reconnect your AWS account to restore it.
            </p>
            {props.onReconnect && (
              <button className="btn btn-primary" onClick={props.onReconnect}>
                Reconnect AWS
              </button>
            )}
          </div>
        </div>
      ) : props.infra && props.infra.nodes.length > 0 ? (
        <InfraMap graph={props.infra} />
      ) : props.infraLoading ? (
        <div className="infra-loading" role="status" aria-live="polite">
          <PoppySpinner size={18} />
          <span className="muted">Mapping your cloud…</span>
        </div>
      ) : !hasFootprint ? (
        <p className="muted">Nothing yet.</p>
      ) : null}

      <h3>What it can do</h3>
      <div className="cap-grid">
        {risk.grants.map(({ grant, risk: gr }, i) => {
          // Never describe an UNSCOPED grant with a phrase that reads as a constraint.
          // "Resources matching arn:aws:route53:::hostedzone/*" sat directly under a red
          // Unscoped badge and told the user the opposite of what the badge said — and
          // that pattern really does match every hosted zone in the account.
          // Two kinds of "its own", and the card must not call them the same thing
          // (docs/specs/permission-presentation.md rule 3). A tag scope PROVES ownership:
          // I3 births every resource tagged or refuses it, and the tag cannot be forged
          // onto someone else's. A name pattern only bounds a namespace — it genuinely
          // cannot reach outside it, but nothing enforces that the poppy created what
          // sits under that name. 44 of the fleet's 56 confined grants are name-scoped;
          // all of them used to render "Only its own resources", an ownership claim the
          // mechanism does not make.
          const where = gr.scoped
            ? grant.resourceScope === "tagged-as-self"
              ? "Only what it created — born tagged as its own, enforced by AWS"
              : `Anything named ${grant.resourceScope} — bounded by name, not by ownership`
            : grantCanLaunchUntracked(grant)
              ? "New resources anywhere in your account — untagged, so not tracked"
              : grantCanMutate(grant) && !grantCanDestroy(grant)
                ? "New resources it creates (not existing ones)"
                : grant.resourceScope === "*" || grant.resourceScope.length === 0
                  ? "Any resource in your account"
                  : `Any resource in your account — ${grant.resourceScope} matches all of them`;
          // Rule C. The boundary above is honest either way, but "any resource" alone
          // reads as a choice the developer made. For these actions AWS publishes no
          // resource types at all, so "*" is the only grant that authorises them and
          // scoping one would simply deny it. Saying nothing was the accusation.
          const awsIsTheLimit = !gr.scoped && grantCannotBeNarrowed(grant);
          return (
            <div key={i} className="cap-card">
              <div className="cap-card-head">
                <span className="cap-svc">{grant.service.toUpperCase()}</span>
                <RiskBadge level={gr.level} scoped={gr.scoped} />
              </div>
              <div className="cap-verb">
                {grantCanDestroy(grant)
                  ? "Create, change & delete"
                  : grantCanLaunchUntracked(grant)
                    ? "Start up new"
                    : grantCanMutate(grant)
                      ? "Create only"
                      : "Read-only"}
              </div>
              <p className="cap-where muted">{where}</p>
              {awsIsTheLimit ? (
                <p className="cap-note muted">
                  AWS offers no way to narrow this —{" "}
                  {grant.actions.length === 1 ? "this action accepts" : "these actions accept"} no
                  resource limit, so this is the tightest form the permission can take.
                </p>
              ) : null}
              {/* The middle register (docs/specs/permission-presentation.md): what the
                  permission is FOR, in the developer's own words. AGENTS.md requires it on
                  every unconfined grant, and only the developer can supply it — the boundary
                  above is computed, the CloudTrail record comes later. Its standing is a
                  CLAIM: the label must say whose words these are, and nothing about the
                  rating or scope may lean on it. Plain text by the manifest validator;
                  rendered as text by React regardless. */}
              {grant.reason ? (
                <p className="cap-reason">
                  <span className="cap-reason-label">Developer&rsquo;s note — in their own words</span>
                  {grant.reason}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      <h3>What it has actually done</h3>
      {/* The observed register (docs/specs/permission-presentation.md): the one column
          neither the platform nor the developer writes — CloudTrail wrote it. Three states,
          kept strictly apart: loading, unreadable, and readable (which includes quiet).
          A quiet result must not editorialise: CloudTrail is the user's own account-wide
          setting and the provider swallows per-region failures, so silence is "nothing
          recorded", never "it did nothing". And restraint is not safety — an unused
          permission is still a permission, which is why this section can never soften
          the sections above it. */}
      {props.observed === "unavailable" ? (
        <p className="muted section-note">
          CloudTrail could not be read, so there is no record to show here. CloudTrail is your
          account&rsquo;s own logging setting; without it, this section can&rsquo;t tell whether
          anything happened.
        </p>
      ) : props.observed == null ? (
        <p className="muted section-note" role="status">Reading CloudTrail…</p>
      ) : (
        (() => {
          const days = Math.round(props.observed.sinceMinutes / (24 * 60));
          const ob = summarizeObserved(props.observed.events);
          if (ob.total === 0) {
            return (
              <p className="muted section-note">
                Nothing recorded in the last {days} days. (CloudTrail is your account&rsquo;s own
                logging — a region with it switched off contributes nothing here.)
              </p>
            );
          }
          return (
            <div className="observed">
              <p className="muted section-note">
                From CloudTrail, the last {days} days: {ob.changes} change{ob.changes === 1 ? "" : "s"},{" "}
                {ob.reads} read{ob.reads === 1 ? "" : "s"}. This is the record AWS kept — neither{" "}
                {c.app.name} nor AgentsPoppy writes it.
              </p>
              {ob.rows.map((r) => (
                <div key={r.service} className="observed-row">
                  <span className="observed-svc">{r.service.toUpperCase()}</span>
                  <span className="observed-counts">
                    {r.changes > 0 ? `${r.changes} change${r.changes === 1 ? "" : "s"}` : "no changes"}
                    {" · "}
                    {r.reads} read{r.reads === 1 ? "" : "s"}
                  </span>
                  <span className="observed-actions">
                    {Object.entries(r.actions)
                      .sort((a, b) => b[1] - a[1])
                      .map(([a, n]) => `${a}×${n}`)
                      .join("  ")}
                  </span>
                </div>
              ))}
            </div>
          );
        })()
      )}

      {inventory.stacks.map((s) => (
        <div key={s.stackName} className="stack">
          <div className="stack-head">
            {s.stackName} <span className="muted">· {s.region}</span>
          </div>
          {groupByService(s.resources).map((grp) => (
            <div key={grp.service} className="svc-group">
              <div className="svc-name">{grp.service}</div>
              <ul>
                {grp.items.map((r) => {
                  const url = awsConsoleUrl(r.type, r.physicalId, s.region);
                  const label = r.physicalId || r.logicalId;
                  return (
                    <li key={r.logicalId}>
                      {url ? (
                        <a href={url} target="_blank" rel="noreferrer">
                          {label}
                        </a>
                      ) : (
                        label
                      )}{" "}
                      <span className="muted">{r.status}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ))}

      {inventory.ledger.length > 0 && (
        <div className="ledger">
          <div className="svc-name">Out-of-stack changes</div>
          <ul>
            {inventory.ledger.map((e, i) => {
              const url = ledgerConsoleUrl(e);
              const label = `${e.action} ${e.service} ${e.resourceType} — ${e.name}`;
              return (
                <li key={i}>
                  {url ? (
                    <a href={url} target="_blank" rel="noreferrer">
                      {label}
                    </a>
                  ) : (
                    label
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <h3>Activity</h3>
      <ul className="audit">
        {recentFirst.map((a, i) => (
          <li key={i}>
            <span className="muted" title={a.ts}>
              {formatDateTime(a.ts)}
            </span>{" "}
            {a.type}
            {a.detail ? ` — ${a.detail}` : ""}
          </li>
        ))}
      </ul>

      <h3>What's at stake if these limits don't hold</h3>
      <p className="muted section-note">
        Above is what {c.app.name} can reach. This is what would be exposed if one of those
        limits failed — so a tightly-bounded permission can still be serious here, and that is
        not a contradiction.
      </p>
      {stakeFindings.length === 0 ? (
        <div className="risk-card risk-card--ok">
          <Icon name="check" />
          <div>
            <strong>Nothing here would reach beyond its own resources</strong>
            <p>Every permission is bounded, and none of them touches how access is granted.</p>
          </div>
        </div>
      ) : (
        <div className="risk-grid">
          {stakeFindings.map((f, i) => (
            <div key={i} className={`risk-card risk-card--${f.level}`}>
              <Icon name="shield" />
              <div>
                <strong>{f.title}</strong>
                <p>{f.body}</p>
                {/* The hand-written half of Panel 3: what this SERVICE controls, so the
                    consequence is legible without AWS knowledge. Platform-authored fact
                    about AWS itself — a missing entry renders nothing, never filler. */}
                {f.service && serviceStake(f.service) ? (
                  <p className="stake-context">{serviceStake(f.service)}</p>
                ) : null}
              </div>
              {c.supervised && f.gated && (
                <span
                  className="supervised-pill"
                  title={`Supervised — this ${f.service ?? "capability"} access reaches beyond ${c.app.name}'s own resources, which is why the connection is supervised. AgentsPoppy holds its credentials for your approval, so nothing here happens until you say yes.`}
                >
                  <span className="supervised-dot" /> Supervised
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
