// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Phase-2 custody (docs/specs/operator-key-custody.md). The properties that carry the
 * security weight, each pinned:
 *   - migration NEVER strips the file before a verified Keychain readback;
 *   - a keychain-marked profile whose item is gone fails LOUDLY, never silently
 *     through to the SDK chain (the chain could resolve a DIFFERENT identity);
 *   - other profiles in the file survive every custody operation;
 *   - removal deletes the Keychain item too.
 * The exec is injected — these tests must never touch the developer's real keychain —
 * and platform gating is bypassed by injecting exec on every platform.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:os";
import { KEYCHAIN_SERVICE, keychainRead, keychainStore, setKeychainExecForTests } from "./keychain";
import { setVaultForTests } from "./vault";
import {
  migrateSecretToKeychain,
  operatorCredentials,
  readProfileInlineSecret,
  removeAgentsPoppyProfile,
  secretCustody,
  writeAgentsPoppyProfile,
} from "./credentials";

const darwin = platform() === "darwin";
// Custody logic runs on EVERY platform through the injected vault — CI Linux and a
// future Windows runner test the same migration/resolution/removal properties the
// founder's Mac does. Only the exec-level keychain tests stay darwin-gated.
const d = describe;

let dir: string;
let vault: Map<string, string>;
let failStore: boolean;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ap-custody-"));
  process.env.AWS_SHARED_CREDENTIALS_FILE = join(dir, "credentials");
  vault = new Map();
  failStore = false;
  setVaultForTests({
    name: "test vault",
    available: () => true,
    store: (k, v) => {
      if (failStore) return false;
      vault.set(k, v);
      return true;
    },
    read: (k) => vault.get(k) ?? null,
    remove: (k) => vault.delete(k),
  });
  setKeychainExecForTests((_file, args, opts) => {
    if (args[0] === "-i") {
      if (failStore) throw new Error("keychain denied");
      const m = /add-generic-password -U -s "[^"]+" -a "([^"]+)" -w "([^"]+)"/.exec(opts.input ?? "");
      if (!m) throw new Error("bad add command");
      vault.set(m[1]!, m[2]!);
      return "";
    }
    if (args[0] === "find-generic-password") {
      const acct = args[args.indexOf("-a") + 1]!;
      const v = vault.get(acct);
      if (v === undefined) throw new Error("not found");
      return v + "\n";
    }
    if (args[0] === "delete-generic-password") {
      const acct = args[args.indexOf("-a") + 1]!;
      if (!vault.delete(acct)) throw new Error("not found");
      return "";
    }
    throw new Error("unexpected security call");
  });
});

afterEach(() => {
  setVaultForTests(null);
  setKeychainExecForTests(null);
  delete process.env.AWS_SHARED_CREDENTIALS_FILE;
  rmSync(dir, { recursive: true, force: true });
});

const file = () => readFileSync(join(dir, "credentials"), "utf8");
const KEY = "TESTKEYIDEXAMPLE0000";
const SECRET = "abcDEF123/+=abcDEF123abcDEF123abcDEF1234";

d("writing a new key", () => {
  it("puts the secret straight in the keychain — the file never holds it", () => {
    writeAgentsPoppyProfile({ accessKeyId: KEY, secretAccessKey: SECRET });
    expect(vault.get(KEY)).toBe(SECRET);
    expect(file()).toContain("# aws_secret_access_key is in the");
    expect(file()).not.toContain(SECRET);
    expect(secretCustody()).toBe("keychain");
  });

  it("falls back to the inline write when the keychain fails — key entry must never brick", () => {
    failStore = true;
    writeAgentsPoppyProfile({ accessKeyId: KEY, secretAccessKey: SECRET });
    expect(file()).toContain(SECRET);
    expect(secretCustody()).toBe("file");
  });

  it("session-token credentials stay inline — temporary, they expire on their own", () => {
    writeAgentsPoppyProfile({ accessKeyId: KEY, secretAccessKey: SECRET, sessionToken: "tok" });
    expect(vault.size).toBe(0);
    expect(file()).toContain(SECRET);
  });

  it("leaves other profiles untouched", () => {
    writeFileSync(join(dir, "credentials"), "[default]\naws_access_key_id = OTHER\naws_secret_access_key = other-secret\n");
    writeAgentsPoppyProfile({ accessKeyId: KEY, secretAccessKey: SECRET });
    expect(file()).toContain("[default]");
    expect(file()).toContain("other-secret");
  });
});

d("migration — verify before you strip", () => {
  const seedInline = () => {
    failStore = true; // force the legacy inline layout
    writeAgentsPoppyProfile({ accessKeyId: KEY, secretAccessKey: SECRET });
    failStore = false;
  };

  it("moves an inline secret into the keychain and strips the file", () => {
    seedInline();
    expect(migrateSecretToKeychain()).toBe("migrated");
    expect(vault.get(KEY)).toBe(SECRET);
    expect(file()).not.toContain(SECRET);
    expect(file()).toContain("# aws_secret_access_key is in the");
    expect(file()).toContain(KEY); // the key id stays
  });

  it("NEVER touches the file when the keychain write fails", () => {
    seedInline();
    const before = file();
    failStore = true;
    expect(migrateSecretToKeychain()).toBe("failed");
    expect(file()).toBe(before);
  });

  it("is idempotent — a migrated profile reports already", () => {
    seedInline();
    migrateSecretToKeychain();
    expect(migrateSecretToKeychain()).toBe("already");
  });

  it("skips session-token profiles and empty state", () => {
    expect(migrateSecretToKeychain()).toBe("skipped"); // no profile at all
    failStore = true;
    writeAgentsPoppyProfile({ accessKeyId: KEY, secretAccessKey: SECRET, sessionToken: "tok" });
    failStore = false;
    expect(migrateSecretToKeychain()).toBe("skipped");
  });
});

d("resolution", () => {
  it("keychain custody resolves to the stored pair", async () => {
    writeAgentsPoppyProfile({ accessKeyId: KEY, secretAccessKey: SECRET });
    const provider = await operatorCredentials();
    const creds = await (provider as () => Promise<{ accessKeyId: string; secretAccessKey: string }>)();
    expect(creds).toEqual({ accessKeyId: KEY, secretAccessKey: SECRET });
  });

  it("a marked profile with a MISSING item fails loudly — never the silent SDK chain", async () => {
    writeAgentsPoppyProfile({ accessKeyId: KEY, secretAccessKey: SECRET });
    vault.clear(); // the item vanishes (locked keychain, deleted by hand, restored backup)
    const provider = await operatorCredentials();
    await expect(
      (provider as () => Promise<unknown>)(),
    ).rejects.toThrow(/Keychain item is missing|unreadable/);
  });
});

d("removal", () => {
  it("deletes the keychain item along with the profile section", () => {
    writeFileSync(join(dir, "credentials"), "[default]\naws_access_key_id = OTHER\n");
    writeAgentsPoppyProfile({ accessKeyId: KEY, secretAccessKey: SECRET });
    expect(removeAgentsPoppyProfile()).toBe(true);
    expect(vault.has(KEY)).toBe(false);
    expect(file()).toContain("[default]"); // everyone else survives
    expect(readProfileInlineSecret()).toBeNull();
  });
});

describe.skipIf(!darwin)("the keychain module itself (real exec shape, darwin only)", () => {
  // These go through the keychain exec seam, not the vault override.
  beforeEach(() => setVaultForTests(null));
  it("store verifies its own readback", () => {
    expect(keychainStore(KEY, SECRET)).toBe(true);
    expect(keychainRead(KEY)).toBe(SECRET);
  });
  it("refuses a secret whose charset could escape the command", () => {
    expect(keychainStore(KEY, 'evil" -w "x')).toBe(false);
    expect(vault.size).toBe(0);
  });
  it("service name is stable — renaming orphans stored secrets", () => {
    expect(KEYCHAIN_SERVICE).toBe("AgentsPoppy AWS operator key");
  });
});
