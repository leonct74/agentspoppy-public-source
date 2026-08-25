// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { extractZip } from "./zip";
import { buildZip } from "./zip.fixtures";

describe("extractZip — duplicate entries", () => {
  let dest: string;
  beforeEach(async () => {
    dest = join(tmpdir(), `agentspoppy-dupe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });
  afterEach(async () => {
    await fs.rm(dest, { recursive: true, force: true });
  });

  // The package-shadowing attack: one archive, one sha256, two manifests. A reviewer
  // that searches the entry list takes the first; extraction writes each in turn, so
  // the last is what actually runs. Reviewed strict, installed unconfined.
  it("refuses an archive carrying the same name twice", async () => {
    const zip = buildZip([
      { name: "extension.json", data: '{"isolation":"strict"}' },
      { name: "extension.json", data: '{"isolation":"none"}' },
    ]);
    await expect(extractZip(zip, dest)).rejects.toThrow(/two files called "extension.json"/);
  });

  it("installs nothing when it refuses", async () => {
    const zip = buildZip([
      { name: "extension.json", data: '{"isolation":"strict"}' },
      { name: "extension.json", data: '{"isolation":"none"}' },
    ]);
    await expect(extractZip(zip, dest)).rejects.toThrow();
    // The shadowed manifest must not be sitting on disk after the refusal.
    await expect(fs.readFile(join(dest, "extension.json"), "utf8")).rejects.toThrow();
  });

  it("still accepts distinct names", async () => {
    const zip = buildZip([
      { name: "extension.json", data: "{}" },
      { name: "backend/index.cjs", data: "// ok" },
    ]);
    await expect(extractZip(zip, dest)).resolves.toContain("extension.json");
  });
});

describe("extractZip", () => {
  let dest: string;
  beforeEach(async () => {
    dest = join(tmpdir(), `agentspoppy-zip-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dest, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(dest, { recursive: true, force: true });
  });

  it("extracts a STORE archive with nested directories", async () => {
    const zip = buildZip([
      { name: "extension.json", data: '{"id":"x"}' },
      { name: "frontend/", data: undefined },
      { name: "frontend/index.html", data: "<html>hi</html>" },
      { name: "backend/bin", data: "#!/bin/sh\necho hi" },
    ]);
    const extracted = await extractZip(zip, dest);
    expect(extracted).toContain("frontend/index.html");
    expect(await fs.readFile(join(dest, "extension.json"), "utf8")).toBe('{"id":"x"}');
    expect(await fs.readFile(join(dest, "frontend/index.html"), "utf8")).toBe("<html>hi</html>");
    expect(await fs.readFile(join(dest, "backend/bin"), "utf8")).toContain("echo hi");
  });

  it("refuses compressed entries with a plain-language error", async () => {
    const zip = buildZip([{ name: "a.txt", data: "hello", method: 8 }]);
    await expect(extractZip(zip, dest)).rejects.toThrow(/stored uncompressed/);
  });

  it("refuses path traversal via ..", async () => {
    const zip = buildZip([{ name: "../evil.txt", data: "x" }]);
    await expect(extractZip(zip, dest)).rejects.toThrow(/outside its own folder/);
    await expect(fs.stat(join(dest, "..", "evil.txt"))).rejects.toThrow();
  });

  it("refuses absolute entry paths", async () => {
    const zip = buildZip([{ name: "/etc/evil", data: "x" }]);
    await expect(extractZip(zip, dest)).rejects.toThrow(/outside its own folder/);
  });

  it("refuses backslash separators", async () => {
    const zip = buildZip([{ name: "a\\b.txt", data: "x" }]);
    await expect(extractZip(zip, dest)).rejects.toThrow(/outside its own folder/);
  });

  it("refuses a CRC mismatch (corrupted download)", async () => {
    const zip = buildZip([{ name: "a.txt", data: "hello", corruptCrc: true }]);
    await expect(extractZip(zip, dest)).rejects.toThrow(/integrity check/);
  });

  it("refuses zip64 markers", async () => {
    const zip = buildZip([{ name: "a.txt", data: "x" }], { totalEntries: 0xffff });
    await expect(extractZip(zip, dest)).rejects.toThrow(/zip64/);
  });

  it("refuses garbage that is not a zip", async () => {
    await expect(extractZip(new TextEncoder().encode("not a zip at all"), dest)).rejects.toThrow(
      /isn't a poppy package/,
    );
  });
});
