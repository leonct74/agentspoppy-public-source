// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * "Your AgentsPoppy setup needs updating" — the banner without which the whole
 * broker-role-versioning exercise is pointless.
 *
 * The guardrails that stop a connected app escalating to admin are written into the
 * user's OWN AWS account by the one-time setup stack. Shipping a tightened guardrail
 * therefore changes NOTHING for anyone until they re-apply setup — and until this
 * banner existed, "Re-apply setup" was a button nobody knew to press.
 * (docs/specs/broker-role-v2.md)
 *
 * Two rules it is built around:
 *
 *  - **Never cry wolf.** A check that failed says "couldn't check", not "you are out
 *    of date". A banner that is wrong even occasionally teaches people to click past
 *    every banner, which costs more security than it buys.
 *  - **Say what it will cost.** Re-applying needs elevated AWS credentials once; the
 *    everyday operator key deliberately cannot modify the setup. Hiding that until
 *    the user has already started is how the old flow dead-ended them.
 */
import { useEffect, useRef, useState } from "react";
import { broker, type SetupVersionStatus } from "../api/broker";
import { Icon } from "./Icon";

/**
 * Module-level ON PURPOSE. As a default parameter this closure would be a NEW function
 * identity on every render, and it is an effect dependency — so each fetch would set state,
 * re-render, mint a new identity, and fetch again. Measured at ~11,500 requests in 300ms,
 * each one a CloudFormation call: enough to throttle the account into the "couldn't check"
 * state this component exists to avoid, and fast enough that "Not now" is undone before the
 * click finishes. The component's own tests all passed a stable `load`, so none of them saw it.
 */
const defaultLoad = (): Promise<SetupVersionStatus> => broker.setupStatus();

export function SetupUpdateBanner({
  onUpdate,
  refreshKey = 0,
  load = defaultLoad,
}: {
  /** Jump to the setup flow's re-apply step (the button that already exists). */
  onUpdate: () => void;
  /**
   * Bumped by the app whenever setup may have changed. Without it the check runs once at
   * launch and the banner keeps nagging a user who has just done what it asked — the
   * fastest possible way to teach someone that this banner means nothing.
   */
  refreshKey?: number;
  /** Injected in tests. */
  load?: () => Promise<SetupVersionStatus>;
}) {
  const [status, setStatus] = useState<SetupVersionStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  // Only a CHANGE in refreshKey clears a dismissal: a re-check is a fresh verdict, so an
  // earlier "not now" must not keep hiding a banner about a different state — but neither
  // may a re-render silently un-dismiss the one the user just put away.
  const lastKey = useRef(refreshKey);
  useEffect(() => {
    let cancelled = false;
    if (refreshKey !== lastKey.current) {
      lastKey.current = refreshKey;
      setDismissed(false);
    }
    // A failed check must leave the banner hidden, not stuck showing a stale verdict:
    // the broker already converts every readable failure into an honest `unknown`, so
    // reaching here means the broker itself was unreachable — which the app surfaces
    // elsewhere and this banner has nothing useful to add to.
    void load()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [load, refreshKey]);

  // `absent` (no setup at all) and `pending` (mid-deploy) stay silent on purpose —
  // the first has a louder path of its own, the second is being fixed right now.
  if (!status || dismissed) return null;
  if (status.state !== "outdated" && status.state !== "unknown") return null;

  const stale = status.state === "outdated";
  return (
    <div className="notice update-banner" role="status">
      <Icon name="shield" />
      <div>
        <p>
          <b>{stale ? "Your AgentsPoppy setup needs updating." : "AgentsPoppy couldn't check your setup."}</b>{" "}
          {stale
            ? `The protections AgentsPoppy relies on live in your own AWS account, and yours are from an earlier version (setup version ${status.deployed}; this release expects ${status.expected}). Until you update, any protection added since then isn't actually in place.`
            : `So it can't tell whether the protections in your AWS account are current${status.reason ? ` — ${status.reason}` : ""}. Re-applying setup is safe either way: it changes nothing if you're already up to date.`}
        </p>
        <p className="update-banner__notes">
          It's an in-place update and takes a few seconds, but it needs your setup credentials once —
          your admin keys, or your setup IAM user carrying the <strong>current</strong> AgentsPoppy
          access policy (this update adds a permission, so an older copy of the policy must be
          replaced first; the next screen shows exactly how). The everyday key AgentsPoppy uses
          deliberately can't change its own protections.
        </p>
      </div>
      <div className="update-banner__actions">
        <button className="btn btn-primary" onClick={onUpdate}>
          Update setup
        </button>
        <button className="btn link" onClick={() => setDismissed(true)}>
          Not now
        </button>
      </div>
    </div>
  );
}
