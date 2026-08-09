// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { bearerToken, generateToken, resolveCaller, tokensMatch } from "./auth";

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
      expect(resolveCaller(null, { devOpen: true })).toEqual({ role: "host" });
      expect(resolveCaller("anything", { devOpen: true, hostToken })).toEqual({ role: "host" });
    });
  });
});
