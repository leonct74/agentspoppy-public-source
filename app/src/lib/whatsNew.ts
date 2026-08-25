// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * "What's new" — telling the user what a version of AgentsPoppy actually changed.
 *
 * Why this exists at all, and why it is keyed off the RUNNING version rather than an
 * update check: on Windows the app ships through the Microsoft Store, which updates it
 * silently on its own schedule and tells the user nothing. There is no prompt to attach
 * notes to, and no moment where the user agrees to anything. Comparing the version the
 * app is running against the last one it recorded seeing works on every platform,
 * including a Store install, because it needs no update mechanism — only the version.
 *
 * On macOS and Linux this runs alongside the update banner rather than replacing it: the
 * banner says what is coming, this says what arrived.
 */

export interface ReleaseNote {
  version: string;
  date: string;
  summary: string;
  changes: string[];
  /** Shipped only through the Microsoft Store; hidden elsewhere. */
  windowsOnly?: boolean;
}

const FEED_URL = "https://agentspoppy.com/releases/notes.json";
const SEEN_KEY = "agentspoppy.lastSeenVersion";

/** True only inside the Tauri webview, so dev and tests never touch native code. */
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * The version this app is running, or null outside Tauri (plain-browser dev).
 * Returns the same value on all three platforms, MSIX included — which is what makes
 * this the one signal Windows can rely on.
 */
export async function currentVersion(): Promise<string | null> {
  if (!inTauri()) return null;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return null;
  }
}

/** Fetch the notes feed. Resolves [] on any failure — missing notes must never be an error. */
export async function fetchReleaseNotes(fetchImpl: typeof fetch = fetch): Promise<ReleaseNote[]> {
  try {
    const res = await fetchImpl(FEED_URL, { headers: { accept: "application/json" } });
    if (!res.ok) return [];
    const body = (await res.json()) as { releases?: unknown };
    if (!Array.isArray(body.releases)) return [];
    return body.releases.filter(isReleaseNote);
  } catch {
    return [];
  }
}

function isReleaseNote(v: unknown): v is ReleaseNote {
  const r = v as Partial<ReleaseNote>;
  return (
    !!r &&
    typeof r.version === "string" &&
    typeof r.summary === "string" &&
    Array.isArray(r.changes) &&
    r.changes.every((c) => typeof c === "string")
  );
}

/** The note for one version, or null when the feed has no entry for it. */
export function noteFor(version: string, notes: ReleaseNote[]): ReleaseNote | null {
  return notes.find((n) => n.version === version) ?? null;
}

/**
 * Everything the user has not seen yet: the notes between the version they last ran and
 * the one they are running now. Someone who skips two versions should read both, not just
 * the newest — on Windows especially, where updates arrive without being announced.
 *
 * Ordering comes from the feed (newest first) rather than from parsing version numbers,
 * so a version scheme change cannot silently drop entries.
 */
export function notesSince(lastSeen: string | null, current: string, notes: ReleaseNote[]): ReleaseNote[] {
  const currentIdx = notes.findIndex((n) => n.version === current);
  if (currentIdx === -1) return [];
  if (!lastSeen) return notes.slice(currentIdx, currentIdx + 1);
  const lastIdx = notes.findIndex((n) => n.version === lastSeen);
  // An unknown last-seen version (downgrade, or a version predating the feed) shows just
  // the current one rather than the entire history.
  if (lastIdx === -1) return notes.slice(currentIdx, currentIdx + 1);
  if (lastIdx <= currentIdx) return [];
  return notes.slice(currentIdx, lastIdx);
}

/**
 * Whether to open the panel unprompted. Only on a version CHANGE — never on a first run
 * (nothing has changed for someone who just installed the app), and never repeatedly.
 */
export function shouldAnnounce(lastSeen: string | null, current: string | null): boolean {
  return !!current && !!lastSeen && lastSeen !== current;
}

export function lastSeenVersion(store: Pick<Storage, "getItem"> = localStorage): string | null {
  try {
    return store.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

export function recordSeenVersion(version: string, store: Pick<Storage, "setItem"> = localStorage): void {
  try {
    store.setItem(SEEN_KEY, version);
  } catch {
    // A blocked storage must not stop the app starting; the panel simply reappears.
  }
}

/**
 * Whether this build is managed by the Microsoft Store, which decides the copy: the Store
 * installs updates itself and gives the app no way to do it, so offering an Update button
 * there would be a promise the channel cannot keep.
 *
 * Detected from the user agent rather than a plugin: it needs no new dependency and no new
 * permission. It cannot tell a Store install from a manually-installed one on Windows —
 * that distinction needs MSIX-context detection, which does not exist yet — so the copy is
 * written to be true either way.
 */
export function isWindows(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): boolean {
  return /windows/i.test(ua);
}
