// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { CAPABILITIES, capabilityInfo, isCapability } from "./capabilities";
import { METHOD_CAPABILITY } from "./host-api";

describe("capabilities", () => {
  it("has unique ids and non-empty consent copy", () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CAPABILITIES) {
      expect(c.title.trim()).not.toBe("");
      expect(c.description.trim()).not.toBe("");
    }
  });

  it("isCapability accepts known ids and rejects everything else", () => {
    expect(isCapability("aws:credentials")).toBe(true);
    expect(isCapability("connection:read")).toBe(true);
    expect(isCapability("filesystem:write")).toBe(false);
    expect(isCapability("")).toBe(false);
    expect(isCapability(undefined)).toBe(false);
    expect(isCapability(42)).toBe(false);
  });

  it("capabilityInfo round-trips every declared capability", () => {
    for (const c of CAPABILITIES) {
      expect(capabilityInfo(c.id)).toBe(c);
    }
  });

  it("every host-bridge method maps to a real capability", () => {
    for (const cap of Object.values(METHOD_CAPABILITY)) {
      expect(isCapability(cap)).toBe(true);
    }
  });
});
