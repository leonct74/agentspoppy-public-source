// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { parseDeepLink } from "./deepLink";

describe("parseDeepLink", () => {
  it("accepts a well-formed install link", () => {
    expect(parseDeepLink("agentspoppy://install?id=com.mailpoppy.desktop")).toEqual({
      action: "install",
      id: "com.mailpoppy.desktop",
    });
  });

  it("accepts the triple-slash spelling (action in pathname, not host)", () => {
    expect(parseDeepLink("agentspoppy:///install?id=com.example.poppy")).toEqual({
      action: "install",
      id: "com.example.poppy",
    });
  });

  it("lowercases the id (finder-typed links, case-insensitive hosts)", () => {
    expect(parseDeepLink("agentspoppy://install?id=Com.Example.Poppy")?.id).toBe("com.example.poppy");
  });

  it("rejects other schemes even with the right shape", () => {
    expect(parseDeepLink("https://install?id=com.example.poppy")).toBeNull();
    expect(parseDeepLink("mailpoppy://install?id=com.example.poppy")).toBeNull();
  });

  it("rejects unknown actions", () => {
    expect(parseDeepLink("agentspoppy://approve?id=com.example.poppy")).toBeNull();
    expect(parseDeepLink("agentspoppy://install/extra?id=com.example.poppy")).toBeNull();
  });

  it("rejects a missing, empty, or malformed id", () => {
    expect(parseDeepLink("agentspoppy://install")).toBeNull();
    expect(parseDeepLink("agentspoppy://install?id=")).toBeNull();
    expect(parseDeepLink("agentspoppy://install?id=..")).toBeNull();
    expect(parseDeepLink("agentspoppy://install?id=has space")).toBeNull();
    expect(parseDeepLink("agentspoppy://install?id=" + "a".repeat(200))).toBeNull();
  });

  it("ignores anything that would let a page define a package: URLs are not ids", () => {
    expect(parseDeepLink("agentspoppy://install?id=https://evil.example/pkg.poppy")).toBeNull();
    expect(parseDeepLink("agentspoppy://install?url=https://evil.example/pkg.poppy")).toBeNull();
  });

  it("rejects garbage and non-URLs", () => {
    expect(parseDeepLink("")).toBeNull();
    expect(parseDeepLink("not a url")).toBeNull();
  });
});
