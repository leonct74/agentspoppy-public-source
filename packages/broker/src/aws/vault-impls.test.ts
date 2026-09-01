// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The per-platform vault implementations. Command SHAPE is what these pin — how the
 * secret travels — because that is the security property: stdin or env, never argv.
 * Real vault round-trips run in each platform's CI build (scripts/vault-smoke.mjs);
 * unit tests here never touch a real vault.
 */
import { afterEach, describe, expect, it } from "vitest";
import { platform } from "node:os";
import { libsecretAvailable, libsecretRead, libsecretStore, setLibsecretExecForTests } from "./libsecret";
import { setWincredExecForTests, wincredAvailable, wincredRemove, wincredStore, WINCRED_TARGET_PREFIX } from "./wincred";

afterEach(() => {
  setLibsecretExecForTests(null);
  setWincredExecForTests(null);
});

describe("platform guards fail closed", () => {
  it("each impl refuses to run off its platform", () => {
    if (platform() !== "win32") expect(wincredAvailable()).toBe(false);
    if (platform() !== "linux") expect(libsecretAvailable()).toBe(false);
    if (platform() !== "win32") expect(wincredStore("TESTKEYIDEXAMPLE0000", "abc123")).toBe(false);
    if (platform() !== "linux") expect(libsecretStore("TESTKEYIDEXAMPLE0000", "abc123")).toBe(false);
  });
});

describe.skipIf(platform() !== "linux")("libsecret command shape (linux)", () => {
  it("the secret travels on stdin, never argv", () => {
    const calls: { args: string[]; input?: string }[] = [];
    setLibsecretExecForTests((_f, args, opts) => {
      calls.push({ args, input: opts.input });
      if (args[0] === "lookup") return "abc123/+=\n";
      return "";
    });
    libsecretStore("TESTKEYIDEXAMPLE0000", "abc123/+=");
    const store = calls.find((c) => c.args[0] === "store");
    expect(store?.input).toBe("abc123/+=");
    expect(store?.args.join(" ")).not.toContain("abc123");
    expect(libsecretRead("TESTKEYIDEXAMPLE0000")).toBe("abc123/+=");
  });
});

describe.skipIf(platform() !== "win32")("wincred command shape (windows)", () => {
  const decodeScript = (args: string[]) =>
    Buffer.from(args[args.indexOf("-EncodedCommand") + 1] ?? "", "base64").toString("utf16le");

  it("the secret travels in the child env, the script via -EncodedCommand — never argv", () => {
    const calls: { file: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    setWincredExecForTests((file, args, opts) => {
      calls.push({ file, args, env: opts.env });
      // Discriminate on script BODY — the P/Invoke preamble names every extern.
      const script = decodeScript(args);
      if (script.includes("ToBase64String")) return Buffer.from("abc123/+=").toString("base64");
      if (script.includes("CredWriteW([ref]")) return "AP_WROTE";
      return "";
    });
    expect(wincredStore("TESTKEYIDEXAMPLE0000", "abc123/+=")).toBe(true);
    const write = calls[0]!;
    expect(write.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(write.env?.AP_SECRET).toBe("abc123/+=");
    expect(write.env?.AP_TARGET).toBe(WINCRED_TARGET_PREFIX + "TESTKEYIDEXAMPLE0000");
    const script = decodeScript(write.args);
    expect(script).toContain("CredWriteW");
    // fail-closed transport: whole-script parse, no REPL statement-error swallowing
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    // the secret rides only in env — not in argv raw, and not inside the encoded script
    expect(write.args.join(" ")).not.toContain("abc123");
    expect(script).not.toContain("abc123");
  });

  it("remove trusts the explicit marker, never a bare exit 0", () => {
    setWincredExecForTests(() => "");
    expect(wincredRemove("TESTKEYIDEXAMPLE0000")).toBe(false);
    setWincredExecForTests(() => "AP_DELETED");
    expect(wincredRemove("TESTKEYIDEXAMPLE0000")).toBe(true);
  });
});
