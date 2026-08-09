// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { POPPY_ACCENTS, poppyAccent } from "./design";

describe("poppyAccent", () => {
  it("is deterministic and always lands in the palette", () => {
    for (const id of ["a", "com.example.thing", "", "🌺"]) {
      expect(poppyAccent(id)).toBe(poppyAccent(id));
      expect(POPPY_ACCENTS).toContain(poppyAccent(id));
    }
  });

  it("PINS known assignments — changing the hash or palette repaints every installed poppy", () => {
    // If one of these fails you are about to change a poppy's identity colour
    // everywhere it appears. Don't.
    expect(poppyAccent("com.mailpoppy.desktop")).toBe("#8fd0c6");
    expect(poppyAccent("com.example.hello-poppy")).toBe(poppyAccent("com.example.hello-poppy"));
  });

  it("excludes clay — the host's reserved accent", () => {
    expect(POPPY_ACCENTS).not.toContain("#d97757");
  });
});
