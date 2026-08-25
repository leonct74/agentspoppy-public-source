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
import { isWindows } from "../lib/whatsNew";
import { Icon } from "./Icon";

type Phase = "idle" | "installing" | "done" | "failed";

/**
 * The Store listing. Opened in the system browser, which then offers to hand off to the
 * Store app. `ms-windows-store://pdp/?productid=…` would jump straight there, but it is an
 * unusual scheme for the opener plugin and cannot be tested from here — the https URL uses
 * the same path as every other external link the app already opens.
 */
const STORE_URL = "https://apps.microsoft.com/detail/9NHZJZH0LLKZ";

async function openStore(): Promise<void> {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(STORE_URL);
  } catch {
    window.open(STORE_URL, "_blank", "noopener,noreferrer");
  }
}

/** The first line of the release notes — a banner wants one sentence, not the whole entry. */
function firstLine(body: string): string {
  const line = body.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.replace(/[*_`#]/g, "").trim();
}

export function UpdateBanner({
  check = checkForSelfUpdate,
  onWindows = isWindows(),
}: {
  check?: typeof checkForSelfUpdate;
  onWindows?: boolean;
}) {
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
          <div>
            <p>
              <b>AgentsPoppy {update.version} is available.</b>{" "}
              {onWindows
                ? "Windows usually installs Store updates on its own, but you can get it now."
                : "Updates are signed and install only when you say so"}
              {error ? ` — ${error}` : ""}
            </p>
            {/* The feed has always carried release notes and the app has always thrown them
                away, so people were asked to accept an update without being told what was in
                it. Shown as plain text: the field is prose from the release, not markup. */}
            {update.body.trim() && <p className="update-banner__notes">{firstLine(update.body)}</p>}
          </div>
          {/* Windows gets a different button, not no button. The Store does not let an app
              install its own update, so "Update & restart" would be a promise this channel
              cannot keep — but auto-update is a Store SETTING the user can switch off, and
              even when it is on it can lag by days. So the honest offer is to open the
              listing, where they can update on the spot. */}
          <div className="update-banner__actions">
            {onWindows ? (
              <button className="btn btn-primary" onClick={() => void openStore()}>
                Open Microsoft Store
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => void install()}>
                {phase === "failed" ? "Try again" : "Update & restart"}
              </button>
            )}
            <button className="btn link" onClick={() => setDismissed(true)}>
              Not now
            </button>
          </div>
        </>
      )}
    </div>
  );
}
