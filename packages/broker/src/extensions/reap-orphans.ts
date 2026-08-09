// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Startup sweep for orphaned poppy backends.
 *
 * A poppy sidecar is a child of the broker, and the broker takes its children with
 * it on exit (`killAllBackends` on `process.on("exit")`). But that handler can only
 * run if the broker dies catchably — and until v0.2.8 the Tauri shell's `kill_broker`
 * sent SIGKILL on quit, so every graceful app quit orphaned the whole set of running
 * sidecars. Machines accumulated dozens of idle sidecar processes (each holding a
 * loopback port and ~100MB), which is exactly the congestion that made poppies hang
 * in "loading" (observed live 2026-07-24: 63 orphans across 5 poppies).
 *
 * The invariant that makes this sweep safe: it runs at broker startup, BEFORE this
 * broker has spawned anything. At that moment, ANY process whose executable lives
 * under the extensions root belongs to a previous broker session — there is nothing
 * legitimate to spare. (Another AgentsPoppy instance would hold a different
 * AGENTSPOPPY_HOME and therefore a different extensions root; the single shared
 * broker port already prevents two brokers over the same home.)
 */

export interface ReapDeps {
  /** List candidate processes: returns raw `pid<sep>command` lines (injectable for tests). */
  listProcesses?: () => Promise<string>;
  /** Send a signal to a pid (injectable for tests). */
  kill?: (pid: number, signal: NodeJS.Signals | number) => void;
  platform?: NodeJS.Platform;
}

/** Parse `ps -axo pid=,command=` output into {pid, command} rows. Pure — unit-tested. */
export function parsePsLines(out: string): Array<{ pid: number; command: string }> {
  const rows: Array<{ pid: number; command: string }> = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    rows.push({ pid: Number(m[1]), command: m[2] });
  }
  return rows;
}

/**
 * True when the process's command places its executable under `root`. Matches on
 * the executable PATH (first token semantics are messy with spaces, so we simply
 * require the command to CONTAIN the root prefix — the root is an absolute,
 * user-specific path like /Users/x/.agentspoppy/extensions/, making false
 * positives implausible).
 */
export function isOrphanSidecarCommand(command: string, root: string): boolean {
  const norm = root.endsWith("/") || root.endsWith("\\") ? root : root + (root.includes("\\") ? "\\" : "/");
  return command.includes(norm);
}

/**
 * Kill every process running from under the extensions root. Returns the pids
 * signalled. Unix: SIGTERM (these are our own disposables; they exit promptly).
 * Never throws — a failed sweep must not stop the broker from starting.
 */
export async function reapOrphanSidecars(root: string, deps: ReapDeps = {}): Promise<number[]> {
  const platform = deps.platform ?? process.platform;
  const kill =
    deps.kill ??
    ((pid: number, sig: NodeJS.Signals | number) => {
      process.kill(pid, sig);
    });
  const reaped: number[] = [];
  try {
    const listProcesses =
      deps.listProcesses ??
      (async () => {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const run = promisify(execFile);
        if (platform === "win32") {
          // PowerShell CIM query — emits "pid<space>path" lines to match parsePsLines.
          const { stdout } = await run("powershell", [
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ExecutablePath)\" }",
          ]);
          return stdout;
        }
        const { stdout } = await run("ps", ["-axo", "pid=,command="]);
        return stdout;
      });
    const out = await listProcesses();
    for (const { pid, command } of parsePsLines(out)) {
      if (pid === process.pid) continue; // never self, however the broker is launched
      if (!isOrphanSidecarCommand(command, root)) continue;
      try {
        kill(pid, "SIGTERM");
        reaped.push(pid);
      } catch {
        /* already gone / not ours — skip */
      }
    }
    if (reaped.length) {
      console.error(`reap-orphans: terminated ${reaped.length} orphaned poppy backend(s) from a previous session`);
    }
  } catch (err) {
    console.error("reap-orphans: sweep failed (continuing):", err instanceof Error ? err.message : err);
  }
  return reaped;
}
