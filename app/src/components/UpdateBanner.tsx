// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * "A new AgentsPoppy is available" — the container's own update prompt.
 * Deliberately consent-first: the banner only informs; downloading, installing
 * and relaunching happen on an explicit click, never automatically. Dismiss
 * hides that version for the rest of the session (it returns next launch).
 */
import { useEffect, useState } from "react";
import { checkForSelfUpdate, type AvailableUpdate } from "../lib/selfUpdate";
import { Icon } from "./Icon";

type Phase = "idle" | "installing" | "done" | "failed";

export function UpdateBanner({ check = checkForSelfUpdate }: { check?: typeof checkForSelfUpdate }) {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [pct, setPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void check().then((u) => {
      if (!cancelled && u) setUpdate(u);
    });
    return () => {
      cancelled = true;
    };
  }, [check]);

  if (!update || dismissed) return null;

  async function install() {
    if (!update) return;
    setPhase("installing");
    setError(null);
    try {
      await update.install(setPct);
      setPhase("done");
      await update.relaunch();
    } catch (e) {
      setPhase("failed");
      setError(e instanceof Error ? e.message : "The update could not be installed.");
    }
  }

  return (
    <div className="notice update-banner" role="status">
      <Icon name="download" />
      {phase === "installing" ? (
        <p>
          Updating to AgentsPoppy {update.version}…{pct !== null ? ` ${pct}%` : ""} — the app will restart by
          itself when it's done.
        </p>
      ) : phase === "done" ? (
        <p>Update installed — restarting…</p>
      ) : (
        <>
          <p>
            <b>AgentsPoppy {update.version} is available.</b> Updates are signed and install only when you say
            so{error ? ` — ${error}` : ""}
          </p>
          <div className="update-banner__actions">
            <button className="btn btn-primary" onClick={() => void install()}>
              {phase === "failed" ? "Try again" : "Update & restart"}
            </button>
            <button className="btn link" onClick={() => setDismissed(true)}>
              Not now
            </button>
          </div>
        </>
      )}
    </div>
  );
}
