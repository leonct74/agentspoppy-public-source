// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import {
  AGENTSPOPPY_PROFILE,
  removeIniSection,
  removeAgentsPoppyProfile,
  upsertIniSection,
  writeAgentsPoppyProfile,
} from "./credentials";

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

  it("writes where the SDK reads — AWS_SHARED_CREDENTIALS_FILE wins over ~/.aws", async () => {
    // The SDK's readers honour this env var; if the writer didn't, a sandboxed run
    // (tests, a fresh-user walkthrough) would write the operator key to the real
    // ~/.aws/credentials and then fail to read it back — an apparent AWS failure.
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "ap-creds-"));
    const file = join(dir, "nested", "credentials");
    const prev = process.env.AWS_SHARED_CREDENTIALS_FILE;
    process.env.AWS_SHARED_CREDENTIALS_FILE = file;
    try {
      writeAgentsPoppyProfile({ accessKeyId: "AKIASANDBOX", secretAccessKey: "shh" });
      const out = readFileSync(file, "utf8");
      expect(out).toContain("[agentspoppy]");
      expect(out).toContain("AKIASANDBOX");
    } finally {
      if (prev === undefined) delete process.env.AWS_SHARED_CREDENTIALS_FILE;
      else process.env.AWS_SHARED_CREDENTIALS_FILE = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("removeIniSection", () => {
  it("removes the target section and preserves all others", () => {
    const existing =
      "[default]\naws_access_key_id = KEEP\n\n[agentspoppy]\naws_access_key_id = GONE\naws_secret_access_key = x\n\n[other]\nfoo = bar\n";
    const out = removeIniSection(existing, AGENTSPOPPY_PROFILE);
    expect(out).not.toContain("GONE");
    expect(out).not.toContain("[agentspoppy]");
    expect(out).toContain("[default]");
    expect(out).toContain("KEEP");
    expect(out).toContain("[other]");
    expect(out).toContain("foo = bar");
  });

  it("returns empty when the only section was removed", () => {
    const out = removeIniSection("[agentspoppy]\naws_access_key_id = X\n", AGENTSPOPPY_PROFILE);
    expect(out).toBe("");
  });

  it("is a no-op string transform when the section is absent", () => {
    const existing = "[default]\naws_access_key_id = KEEP\n";
    expect(removeIniSection(existing, AGENTSPOPPY_PROFILE)).toContain("KEEP");
  });
});

describe("removeAgentsPoppyProfile (kill switch / forget)", () => {
  it("removes only the agentspoppy profile from the credentials file, keeping others", async () => {
    const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "ap-creds-rm-"));
    const file = join(dir, "credentials");
    const prev = process.env.AWS_SHARED_CREDENTIALS_FILE;
    process.env.AWS_SHARED_CREDENTIALS_FILE = file;
    try {
      writeFileSync(
        file,
        "[default]\naws_access_key_id = KEEP\n\n[agentspoppy]\naws_access_key_id = AKIAGONE\naws_secret_access_key = s\n",
      );
      expect(removeAgentsPoppyProfile()).toBe(true);
      const out = readFileSync(file, "utf8");
      expect(out).toContain("KEEP");
      expect(out).not.toContain("AKIAGONE");
      expect(out).not.toContain("[agentspoppy]");
      // Idempotent: a second call finds nothing to remove.
      expect(removeAgentsPoppyProfile()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.AWS_SHARED_CREDENTIALS_FILE;
      else process.env.AWS_SHARED_CREDENTIALS_FILE = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
