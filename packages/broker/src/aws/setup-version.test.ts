// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { needsSetupUpdate, setupVersionStatus } from "./setup-version";
import { TEMPLATE_VERSION } from "./role-template";

const read = (outputs: Record<string, string>) => ({ ok: true as const, outputs });

describe("setupVersionStatus", () => {
  it("reads a matching version as current", () => {
    const s = setupVersionStatus(read({ TemplateVersion: String(TEMPLATE_VERSION) }));
    expect(s.state).toBe("current");
    expect(s.deployed).toBe(TEMPLATE_VERSION);
    expect(needsSetupUpdate(s)).toBe(false);
  });

  it("reads an older version as outdated", () => {
    const s = setupVersionStatus(read({ TemplateVersion: "1" }), 3);
    expect(s.state).toBe("outdated");
    expect(s.deployed).toBe(1);
    expect(needsSetupUpdate(s)).toBe(true);
  });

  // Every stack in the field right now. The output was introduced in v2, so its
  // absence is not ambiguity — it is proof of v1.
  it("treats a stack with NO version output as v1, not as unknown", () => {
    const s = setupVersionStatus(read({ BrokerRoleArn: "arn:aws:iam::1:role/AgentsPoppyBroker" }));
    expect(s.state).toBe("outdated");
    expect(s.deployed).toBe(1);
  });

  it("treats an empty version output the same as a missing one", () => {
    expect(setupVersionStatus(read({ TemplateVersion: "   " })).state).toBe("outdated");
  });

  // Fail safe. "I cannot read this" must never resolve to "you're fine".
  it("never reports current when the stack could not be read", () => {
    const s = setupVersionStatus({ ok: false, kind: "unreadable", reason: "not authorized to call DescribeStacks" });
    expect(s.state).toBe("unknown");
    expect(s.deployed).toBeNull();
    expect(s.reason).toContain("not authorized");
    expect(needsSetupUpdate(s)).toBe(true);
  });

  it("never reports current for a version it cannot parse", () => {
    for (const raw of ["v2", "2.1", "two", "-1", "0", "1e3"]) {
      const s = setupVersionStatus(read({ TemplateVersion: raw }), 2);
      expect(s.state, raw).toBe("unknown");
      expect(s.reason, raw).toContain(raw);
    }
  });

  // A DOWNGRADED app must not tell the user to "update" — that would roll their
  // guardrails backwards, which is the exact opposite of the point.
  it("treats a newer deployed version as current, never as stale", () => {
    const s = setupVersionStatus(read({ TemplateVersion: "9" }), 2);
    expect(s.state).toBe("current");
    expect(s.deployed).toBe(9);
  });

  // No setup at all is not a staleness problem, and the user already has a louder
  // path for it. Nagging here would be prompt noise on a screen that can't act.
  it("stays silent when there is no setup stack at all", () => {
    const s = setupVersionStatus({ ok: false, kind: "absent" });
    expect(s.state).toBe("absent");
    expect(needsSetupUpdate(s)).toBe(false);
  });

  // Nagging someone mid-deploy is the fastest way to train them to ignore the banner.
  it("stays silent while the setup stack is still deploying", () => {
    const s = setupVersionStatus({ ok: false, kind: "pending" });
    expect(s.state).toBe("pending");
    expect(needsSetupUpdate(s)).toBe(false);
  });

  it("defaults to the version this host actually ships", () => {
    expect(setupVersionStatus(read({})).expected).toBe(TEMPLATE_VERSION);
  });
});
