// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Linux Secret Service custody via `secret-tool` (libsecret's CLI), which talks to
 * whatever keyring the desktop runs — GNOME Keyring, KWallet's bridge, etc.
 * (docs/specs/operator-key-custody.md).
 *
 * The secret travels on stdin in both directions (secret-tool reads it from stdin on
 * store, prints it on lookup) — never in argv.
 *
 * Honest platform truth: plenty of Linux setups have NO unlocked Secret Service — a
 * headless server, a minimal window manager, an SSH session. There `available()` may be
 * true (the binary exists) while store() fails — and that is fine by design: store
 * verifies its own readback, the caller keeps file custody, and nothing breaks. The
 * vault is an upgrade where the desktop provides one, never a requirement.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";

/** The item's attributes. Stable — changing them would orphan stored secrets. */
export const LIBSECRET_ATTRS = { service: "agentspoppy-operator" } as const;
const LABEL = "AgentsPoppy AWS operator key";

const SECRET_CHARSET = /^[A-Za-z0-9/+=]+$/;
const KEYID_CHARSET = /^[A-Z0-9]+$/;
const CANDIDATES = ["/usr/bin/secret-tool", "/bin/secret-tool", "/usr/local/bin/secret-tool"];

type Exec = (file: string, args: string[], opts: { input?: string }) => string;
const realExec: Exec = (file, args, opts) =>
  execFileSync(file, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], input: opts.input });
let exec: Exec = realExec;
let execOverridden = false;
/** Test seam. Unit tests must never touch a real keyring. */
export function setLibsecretExecForTests(fn: Exec | null): void {
  exec = fn ?? realExec;
  execOverridden = fn !== null;
}

function tool(): string | null {
  // Hermetic under the test seam: unit tests pin command shape and must not
  // depend on secret-tool being installed on the machine running them.
  if (execOverridden) return "secret-tool";
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

export function libsecretAvailable(): boolean {
  return platform() === "linux" && tool() !== null;
}

/** CI diagnosability: opt-in stderr on swallowed failures. Never logs the secret. */
function debug(op: string, err: unknown): void {
  if (process.env.AP_VAULT_DEBUG) console.error(`libsecret: ${op} failed:`, err instanceof Error ? err.message : err);
}

export function libsecretStore(keyId: string, secret: string): boolean {
  const t = tool();
  if (!libsecretAvailable() || !t || !KEYID_CHARSET.test(keyId) || !SECRET_CHARSET.test(secret)) return false;
  try {
    exec(t, ["store", "--label", LABEL, "service", LIBSECRET_ATTRS.service, "account", keyId], { input: secret });
    return libsecretRead(keyId) === secret;
  } catch (err) {
    debug("store", err);
    return false;
  }
}

export function libsecretRead(keyId: string): string | null {
  const t = tool();
  if (!libsecretAvailable() || !t || !KEYID_CHARSET.test(keyId)) return null;
  try {
    const out = exec(t, ["lookup", "service", LIBSECRET_ATTRS.service, "account", keyId], {});
    const secret = out.trim();
    return SECRET_CHARSET.test(secret) ? secret : null;
  } catch (err) {
    debug("lookup", err);
    return null;
  }
}

export function libsecretRemove(keyId: string): boolean {
  const t = tool();
  if (!libsecretAvailable() || !t || !KEYID_CHARSET.test(keyId)) return false;
  try {
    exec(t, ["clear", "service", LIBSECRET_ATTRS.service, "account", keyId], {});
    return true;
  } catch (err) {
    debug("clear", err);
    return false;
  }
}
