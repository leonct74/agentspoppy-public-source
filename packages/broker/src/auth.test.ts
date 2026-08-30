// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { bearerToken, devHatchGrantsHost, generateToken, isSeaBuild, resolveCaller, tokensMatch } from "./auth";

describe("broker auth helpers", () => {
  it("mints distinct, non-trivial tokens", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
  });

  it("parses a Bearer header (case-insensitive), rejects junk", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
    expect(bearerToken("bearer   xyz  ")).toBe("xyz");
    expect(bearerToken(["Bearer first", "Bearer second"])).toBe("first");
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken("")).toBeNull();
  });

  it("tokensMatch is exact and null-safe", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abcd")).toBe(false);
    expect(tokensMatch("abc", "abx")).toBe(false);
    expect(tokensMatch(null, "abc")).toBe(false);
    expect(tokensMatch("abc", null)).toBe(false);
  });

  describe("resolveCaller", () => {
    const hostToken = "HOST";
    const resolveBackend = (t: string) => (t === "BACKEND-A" ? "conn-a" : null);

    it("host token → host role", () => {
      expect(resolveCaller("HOST", { hostToken, resolveBackend })).toEqual({ role: "host" });
    });

    it("a known backend token → backend role bound to its connection", () => {
      expect(resolveCaller("BACKEND-A", { hostToken, resolveBackend })).toEqual({
        role: "backend",
        connectionId: "conn-a",
      });
    });

    it("an unknown / missing token → anonymous", () => {
      expect(resolveCaller("nope", { hostToken, resolveBackend })).toEqual({ role: "anonymous" });
      expect(resolveCaller(null, { hostToken, resolveBackend })).toEqual({ role: "anonymous" });
    });

    it("devOpen makes every caller the host (browser dev harness only)", () => {
      // In a from-source dev run isSeaBuild() is false, so the hatch is live.
      expect(resolveCaller(null, { devOpen: true })).toEqual({ role: "host" });
      expect(resolveCaller("anything", { devOpen: true, hostToken })).toEqual({ role: "host" });
    });

    it("the dev hatch is INERT in a packaged (SEA) build — the env-var backdoor can't grant host", () => {
      // A same-user attacker launching the real app with AGENTSPOPPY_DEV_OPEN=1 must not be
      // handed the management plane (docs/specs/operator-key-least-privilege.md §5). The gate
      // is pure so both artifact states are deterministic.
      expect(devHatchGrantsHost(true, false)).toBe(true); // from-source dev: hatch live
      expect(devHatchGrantsHost(true, true)).toBe(false); // packaged build: hatch closed
      expect(devHatchGrantsHost(false, false)).toBe(false);
      expect(devHatchGrantsHost(undefined, false)).toBe(false);
    });

    it("isSeaBuild is false in a from-source test run (so devOpen still works here)", () => {
      expect(isSeaBuild()).toBe(false);
    });
  });
});
