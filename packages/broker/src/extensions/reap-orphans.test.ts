// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
import { describe, it, expect } from "vitest";
import { parsePsLines, isOrphanSidecarCommand, reapOrphanSidecars } from "./reap-orphans";

const ROOT = "/Users/x/.agentspoppy/extensions";

describe("parsePsLines", () => {
  it("parses pid + command, skipping malformed lines", () => {
    const out = `  123 /usr/bin/thing --flag\n  456 /Users/x/.agentspoppy/extensions/com.a/backend/a-sidecar\nnot a line\n`;
    expect(parsePsLines(out)).toEqual([
      { pid: 123, command: "/usr/bin/thing --flag" },
      { pid: 456, command: `${ROOT}/com.a/backend/a-sidecar` },
    ]);
  });
});

describe("isOrphanSidecarCommand", () => {
  it("matches executables under the extensions root only", () => {
    expect(isOrphanSidecarCommand(`${ROOT}/com.mailpoppy.desktop/backend/mailpoppy-sidecar`, ROOT)).toBe(true);
    expect(isOrphanSidecarCommand("/Applications/AgentsPoppy.app/Contents/MacOS/agentspoppy-broker", ROOT)).toBe(false);
    // a sibling dir that shares the prefix must NOT match (root is boundary-terminated)
    expect(isOrphanSidecarCommand("/Users/x/.agentspoppy/extensions-backup/evil", ROOT)).toBe(false);
  });
});

describe("reapOrphanSidecars", () => {
  it("kills every process under the root except itself, and reports pids", async () => {
    const killed: Array<[number, string | number]> = [];
    const reaped = await reapOrphanSidecars(ROOT, {
      listProcesses: async () =>
        [
          `  ${process.pid} ${ROOT}/self-should-be-skipped`,
          `  201 ${ROOT}/com.a/backend/a-sidecar`,
          `  202 ${ROOT}/com.b/backend/b-sidecar --with args`,
          "  300 /usr/libexec/unrelated",
        ].join("\n"),
      kill: (pid, sig) => killed.push([pid, sig]),
    });
    expect(reaped).toEqual([201, 202]);
    expect(killed).toEqual([
      [201, "SIGTERM"],
      [202, "SIGTERM"],
    ]);
  });

  it("never throws — a failing lister is swallowed", async () => {
    await expect(
      reapOrphanSidecars(ROOT, {
        listProcesses: async () => {
          throw new Error("ps exploded");
        },
      }),
    ).resolves.toEqual([]);
  });

  it("continues past kill failures (already-dead pids)", async () => {
    const reaped = await reapOrphanSidecars(ROOT, {
      listProcesses: async () => `  201 ${ROOT}/a/backend/a\n  202 ${ROOT}/b/backend/b`,
      kill: (pid) => {
        if (pid === 201) throw new Error("ESRCH");
      },
    });
    expect(reaped).toEqual([202]);
  });
});
