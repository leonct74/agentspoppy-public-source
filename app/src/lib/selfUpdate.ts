// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Self-update for the AgentsPoppy container itself (poppies update via the
 * catalog instead). Checks the signed `latest.json` feed on the public releases
 * repo, and — only after the user explicitly confirms — downloads, installs and
 * relaunches. The feed and artifacts are signed with the project's updater key
 * (tauri-plugin-updater verifies before installing), so a compromised CDN or
 * repo README can't push code; and the USER gates every update — no silent
 * auto-apply, matching the poppy-update principle.
 *
 * All plugin access is behind dynamic imports + an in-Tauri guard so plain-
 * browser dev and vitest never touch native code.
 */

export interface AvailableUpdate {
  version: string;
  /** Release notes from latest.json (may be empty). */
  body: string;
  /** Download + install, reporting progress; resolves when installed. */
  install(onProgress: (pct: number | null) => void): Promise<void>;
  /** Restart the app into the new version. */
  relaunch(): Promise<void>;
}

/** True only inside the Tauri webview (so dev/tests never touch the plugin). */
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Check the feed once. Resolves null when up to date, not running under Tauri,
 * offline, or the feed has no entry for this platform (e.g. a Store-managed
 * install whose updates come from the Store) — a failed check must never nag.
 */
export async function checkForSelfUpdate(): Promise<AvailableUpdate | null> {
  if (!inTauri()) return null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      body: update.body ?? "",
      async install(onProgress) {
        let total = 0;
        let got = 0;
        await update.downloadAndInstall((e) => {
          if (e.event === "Started") total = e.data.contentLength ?? 0;
          if (e.event === "Progress") {
            got += e.data.chunkLength;
            onProgress(total > 0 ? Math.min(100, Math.round((got / total) * 100)) : null);
          }
          if (e.event === "Finished") onProgress(100);
        });
      },
      async relaunch() {
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      },
    };
  } catch {
    return null; // offline / feed unreachable / platform absent — stay quiet
  }
}
