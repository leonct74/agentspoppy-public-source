// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Step 0 — "this machine is standing on the wrong key" (docs/specs/operator-key-least-privilege.md).
 *
 * The designed flow ends every machine on the restricted AgentsPoppyOperator key, but the
 * field found machines running day-to-day on the ELEVATED setup key instead (the 0.3.8
 * recovery flow stores whatever key was pasted, and nothing ever noticed). Such a machine
 * holds the most powerful credential in the architecture as its everyday key. This banner
 * detects the state and fixes it in one click: mint the operator key USING the powerful key
 * already present (the wrong state contains its own remedy), verify it, store it.
 *
 * Same honesty rules as SetupUpdateBanner: never cry wolf (an unreadable setup gets the
 * SOFT variant that says "couldn't verify", not a false alarm), and say what it will do.
 */
import { useEffect, useRef, useState } from "react";
import { broker, type CallerIdentity, type SetupVersionStatus } from "../api/broker";
import { Icon } from "./Icon";

export const OPERATOR_USER_MARKER = ":user/AgentsPoppyOperator";

/** Module-level on purpose — a default-parameter closure would re-trigger the effect
 *  every render (the SetupUpdateBanner render-loop bug, ~11,500 requests in 300ms). */
const defaultLoadIdentity = (): Promise<CallerIdentity> => broker.awsIdentity();
const defaultLoadStatus = (): Promise<SetupVersionStatus> => broker.setupStatus();
const defaultSwitchKey = (accountId: string, allowEviction: boolean) =>
  broker.deployBootstrap(accountId, { keysFirst: true, ...(allowEviction ? { allowEviction: true } : {}) });

type Phase =
  | { kind: "idle" }
  | { kind: "switching" }
  | { kind: "confirm-eviction"; message: string }
  | { kind: "done"; keptElsewhere: boolean }
  | { kind: "failed"; message: string };

export function OperatorKeyBanner({
  accountId,
  refreshKey = 0,
  onSwitched,
  onOpenConnect,
  loadIdentity = defaultLoadIdentity,
  loadStatus = defaultLoadStatus,
  switchKey = defaultSwitchKey,
}: {
  /** The linked account to run the switch against (banner is silent without one). */
  accountId: string | null;
  /** Bumped when connection state may have changed — clears dismissal, re-checks. */
  refreshKey?: number;
  /** Called after a successful switch so the app refreshes identity-dependent UI. */
  onSwitched?: () => void;
  /** Fallback route: the connect screen's paste-your-setup-key flow. */
  onOpenConnect?: () => void;
  /** Injected in tests. */
  loadIdentity?: () => Promise<CallerIdentity>;
  loadStatus?: () => Promise<SetupVersionStatus>;
  switchKey?: (
    accountId: string,
    allowEviction: boolean,
  ) => Promise<{ setupNotUpdated?: boolean; setupUpdateError?: string; evictedAccessKeyId?: string }>;
}) {
  const [identity, setIdentity] = useState<CallerIdentity | null>(null);
  const [status, setStatus] = useState<SetupVersionStatus | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [dismissed, setDismissed] = useState(false);

  const lastKey = useRef(refreshKey);
  useEffect(() => {
    let cancelled = false;
    if (refreshKey !== lastKey.current) {
      lastKey.current = refreshKey;
      setDismissed(false);
      setPhase({ kind: "idle" });
    }
    // Both loads are read-only; a failure hides the banner rather than mis-stating.
    void Promise.all([loadIdentity().catch(() => null), loadStatus().catch(() => null)]).then(
      ([id, st]) => {
        if (cancelled) return;
        setIdentity(id);
        setStatus(st);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loadIdentity, loadStatus, refreshKey]);

  if (dismissed || !accountId || !identity) return null;
  if (identity.arn.includes(OPERATOR_USER_MARKER)) return null;
  // `absent` / `pending`: silent — the first has a louder path (there is nothing to switch
  // onto), the second is being fixed right now. `unknown` gets the SOFT variant below.
  if (!status || status.state === "absent" || status.state === "pending") return null;
  const verified = status.state === "current" || status.state === "outdated";

  const run = async (allowEviction: boolean) => {
    setPhase({ kind: "switching" });
    try {
      const res = await switchKey(accountId, allowEviction);
      setPhase({ kind: "done", keptElsewhere: false });
      onSwitched?.();
      // The template half is best-effort in keys-first mode; the staleness banner owns
      // nagging about it, so here we only avoid claiming more than happened.
      void res;
    } catch (err) {
      const msg = (err as Error).message ?? "the switch failed";
      if (/eviction_required|two-access-key limit/i.test(msg)) {
        setPhase({ kind: "confirm-eviction", message: msg });
      } else {
        setPhase({ kind: "failed", message: msg });
      }
    }
  };

  if (phase.kind === "done") {
    return (
      <div className="notice update-banner" role="status">
        <Icon name="shield" />
        <div>
          <p>
            <b>This computer now uses the restricted operator key.</b> The powerful key was needed one
            last time to create it{" "}
            {verified
              ? "and has been replaced in AgentsPoppy's stored profile."
              : "— if it also lives outside AgentsPoppy's own profile (for example in a [default] AWS profile or environment variables), remove it there yourself; AgentsPoppy never edits those."}
          </p>
        </div>
        <div className="update-banner__actions">
          <button className="btn link" onClick={() => setDismissed(true)}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="notice update-banner" role="status">
      <Icon name="shield" />
      <div>
        <p>
          <b>
            {verified
              ? "This computer is using a powerful setup key for everyday work."
              : "This computer is connected with a non-operator key, and AgentsPoppy can't verify your setup with it."}
          </b>{" "}
          {verified ? (
            <>
              It's connected as <code>{identity.arn}</code> — a credential that can change AgentsPoppy's own
              protections, which the everyday key deliberately cannot. One click switches this machine to the
              restricted <code>AgentsPoppyOperator</code> key: AgentsPoppy uses the powerful key once more to
              create it, verifies it works, then stores only the restricted key.
            </>
          ) : (
            <>
              It's connected as <code>{identity.arn}</code>. The safest fix is to run setup once with your
              setup credentials, which ends with this machine on the restricted operator key.
            </>
          )}
        </p>
        {phase.kind === "confirm-eviction" && (
          <p className="update-banner__notes" role="alert">
            {phase.message}
          </p>
        )}
        {phase.kind === "failed" && (
          <p className="update-banner__notes" role="alert">
            The switch didn't complete: {phase.message} Nothing on this machine was changed. You can run
            setup with your setup credentials instead.
          </p>
        )}
      </div>
      <div className="update-banner__actions">
        {verified && phase.kind !== "confirm-eviction" && (
          <button className="btn btn-primary" disabled={phase.kind === "switching"} onClick={() => void run(false)}>
            {phase.kind === "switching" ? "Switching…" : "Switch to the operator key"}
          </button>
        )}
        {phase.kind === "confirm-eviction" && (
          <button className="btn btn-primary" onClick={() => void run(true)}>
            Delete that key and continue
          </button>
        )}
        {(!verified || phase.kind === "failed") && onOpenConnect && (
          <button className="btn" onClick={onOpenConnect}>
            Open setup
          </button>
        )}
        <button className="btn link" onClick={() => setDismissed(true)}>
          Not now
        </button>
      </div>
    </div>
  );
}
