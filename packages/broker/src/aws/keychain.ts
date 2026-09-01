// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * macOS Keychain custody for the operator's secret access key
 * (docs/specs/operator-key-custody.md — phase 2).
 *
 * The broker is a Node SEA binary, so no native Security.framework module: it shells to
 * /usr/bin/security. Writes go through `security -i` — commands arrive on STDIN, so the
 * secret never appears in an argv that `ps` could observe. Reads use
 * `find-generic-password -w`; items created by the security CLI are readable by it
 * without a user prompt, which is what makes headless resolution work.
 *
 * Every function is best-effort and non-throwing: custody callers decide what a failure
 * means (migration aborts and leaves the file; key entry falls back to the inline
 * write). The exec is injectable so unit tests never touch a real keychain.
 */
import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import { existsSync } from "node:fs";

/** The Keychain item's service name. Stable — renaming it would orphan stored secrets. */
export const KEYCHAIN_SERVICE = "AgentsPoppy AWS operator key";

const SECURITY = "/usr/bin/security";

/** AWS secret access keys are base64-ish; refuse anything else before it nears a shell. */
const SECRET_CHARSET = /^[A-Za-z0-9/+=]+$/;
const KEYID_CHARSET = /^[A-Z0-9]+$/;

type Exec = (file: string, args: string[], opts: { input?: string }) => string;

const realExec: Exec = (file, args, opts) =>
  execFileSync(file, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], input: opts.input });

let exec: Exec = realExec;
/** Test seam. Unit tests must never touch the developer's real keychain. */
export function setKeychainExecForTests(fn: Exec | null): void {
  exec = fn ?? realExec;
}

/** True where Keychain custody can work: macOS with the security CLI present. */
export function keychainAvailable(): boolean {
  return platform() === "darwin" && existsSync(SECURITY);
}

/**
 * Store the secret for this key id, then READ IT BACK and compare — only a verified
 * round trip counts as stored. Returns false on any failure or mismatch.
 */
export function keychainStore(keyId: string, secret: string): boolean {
  if (!keychainAvailable()) return false;
  if (!KEYID_CHARSET.test(keyId) || !SECRET_CHARSET.test(secret)) return false;
  try {
    // -U updates in place if the item exists (a re-pasted key replaces the old secret).
    exec(SECURITY, ["-i"], {
      input: `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "${keyId}" -w "${secret}"\n`,
    });
    return keychainRead(keyId) === secret;
  } catch {
    return false;
  }
}

/** The stored secret for this key id, or null (missing, denied, or not macOS). */
export function keychainRead(keyId: string): string | null {
  if (!keychainAvailable() || !KEYID_CHARSET.test(keyId)) return null;
  try {
    const out = exec(SECURITY, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", keyId, "-w"], {});
    const secret = out.trim();
    return SECRET_CHARSET.test(secret) ? secret : null;
  } catch {
    return null;
  }
}

/** Delete the stored secret. Best-effort: used by the kill switch and Forget-this-key. */
export function keychainRemove(keyId: string): boolean {
  if (!keychainAvailable() || !KEYID_CHARSET.test(keyId)) return false;
  try {
    exec(SECURITY, ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", keyId], {});
    return true;
  } catch {
    return false;
  }
}
