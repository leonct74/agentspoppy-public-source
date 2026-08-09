// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
//! Orphan-proofing: follow the parent process into the grave.
//!
//! The Tauri host kills the broker on a graceful quit, but a crash or force-quit
//! skips that hook — the broker survives as an orphan, keeps port 8799, and every
//! future app launch spawns a sidecar that dies on EADDRINUSE while the webview
//! talks to the orphan (whose host token it can never learn → endless 401s).
//! So the broker watches its parent and exits the moment it disappears.

/** ESRCH = no such process (gone). EPERM = exists but not ours (alive). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ParentWatchOptions {
  /** The spawning process's PID (the Tauri host passes its own via env). */
  parentPid: number;
  intervalMs?: number;
  /** Injectable for tests. */
  currentPpid?: () => number;
  isAlive?: (pid: number) => boolean;
  onGone?: () => void;
}

/**
 * Poll for the parent's death and invoke `onGone` (default: log + exit 0) once.
 *
 * Two signals, belt and braces: on macOS/Linux an orphan is reparented to pid 1,
 * so a *changed* ppid is a certain, PID-reuse-proof death signal; the kill(pid, 0)
 * probe covers platforms that don't reparent. Returns a stop function.
 */
export function watchParent(opts: ParentWatchOptions): () => void {
  const intervalMs = opts.intervalMs ?? 2000;
  const currentPpid = opts.currentPpid ?? (() => process.ppid);
  const isAlive = opts.isAlive ?? processAlive;
  const onGone =
    opts.onGone ??
    (() => {
      console.error(`parent process ${opts.parentPid} is gone — exiting so port stays reclaimable`);
      process.exit(0);
    });

  const initialPpid = currentPpid();
  const timer = setInterval(() => {
    if (currentPpid() !== initialPpid || !isAlive(opts.parentPid)) {
      clearInterval(timer);
      onGone();
    }
  }, intervalMs);
  // Never keep an otherwise-finished process alive just to watch its parent.
  timer.unref?.();
  return () => clearInterval(timer);
}
