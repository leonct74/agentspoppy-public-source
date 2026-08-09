// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { AGENTSPOPPY_PROFILE, upsertIniSection, writeAgentsPoppyProfile } from "./credentials";

const body = ["aws_access_key_id = AKIAEXAMPLE", "aws_secret_access_key = secret"];

describe("upsertIniSection", () => {
  it("appends a new section to an empty file", () => {
    const out = upsertIniSection("", AGENTSPOPPY_PROFILE, body);
    expect(out).toBe(`[agentspoppy]\naws_access_key_id = AKIAEXAMPLE\naws_secret_access_key = secret\n`);
  });

  it("appends after existing profiles without touching them", () => {
    const existing = "[default]\naws_access_key_id = AKIADEFAULT\naws_secret_access_key = def\n";
    const out = upsertIniSection(existing, AGENTSPOPPY_PROFILE, body);
    expect(out).toContain("[default]");
    expect(out).toContain("AKIADEFAULT"); // default profile preserved
    expect(out).toContain("[agentspoppy]");
    expect(out.indexOf("[default]")).toBeLessThan(out.indexOf("[agentspoppy]"));
  });

  it("replaces an existing section's body and preserves later sections", () => {
    const existing =
      "[agentspoppy]\naws_access_key_id = OLD\naws_secret_access_key = old\n\n[default]\naws_access_key_id = KEEP\n";
    const out = upsertIniSection(existing, AGENTSPOPPY_PROFILE, body);
    expect(out).not.toContain("OLD");
    expect(out).toContain("AKIAEXAMPLE");
    expect(out).toContain("[default]");
    expect(out).toContain("KEEP"); // the section after agentspoppy is intact
  });
});

describe("writeAgentsPoppyProfile", () => {
  it("rejects empty credentials before touching the filesystem", () => {
    expect(() => writeAgentsPoppyProfile({ accessKeyId: "", secretAccessKey: "x" })).toThrow(/Access Key ID/);
    expect(() => writeAgentsPoppyProfile({ accessKeyId: "x", secretAccessKey: "  " })).toThrow(/Secret Access Key/);
  });
});
