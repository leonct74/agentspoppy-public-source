// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Operator AWS credentials: the single resolver every broker AWS client shares,
 * plus the in-app "paste your keys" writer.
 *
 * Resolution prefers a dedicated `[agentspoppy]` profile in ~/.aws/credentials —
 * so the in-app key entry never clobbers the user's `default` profile — and falls
 * back to the SDK's standard provider chain (env, default profile, SSO) so anyone
 * who ran a plain `aws configure` keeps working unchanged.
 *
 * The writer mirrors `aws configure`: it upserts only the `[agentspoppy]` section
 * of ~/.aws/credentials (dir 0700, file 0600), leaving every other profile
 * intact, and never writes `[default]`. The secret is never logged.
 *
 * Custody, phase 2 (docs/specs/operator-key-custody.md): on macOS the SECRET half
 * lives in the Keychain, and the profile keeps only the key id plus a marker
 * comment — the file contains nothing secret. Resolution is key id from the file
 * + secret from the Keychain; a keychain-marked profile whose item is gone fails
 * LOUDLY, never silently through to the SDK chain, because the chain could
 * resolve a different identity and misattribute everything downstream.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { keychainAvailable, keychainRead, keychainRemove, keychainStore } from "./keychain";

/** The profile the in-app key entry writes to (never `default`). */
export const AGENTSPOPPY_PROFILE = "agentspoppy";

export interface AwsKeyInput {
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional — only for temporary (STS) credentials. */
  sessionToken?: string;
}

const awsDir = (): string => join(homedir(), ".aws");
// Honour the SDK's standard override. The SDK's own readers (fromIni, the provider
// chain) already respect AWS_SHARED_CREDENTIALS_FILE — writing to a hardcoded
// ~/.aws/credentials while reading elsewhere would split the operator key across two
// files and break any sandboxed run (tests, a fresh-user walkthrough on a dev
// machine) in a way that looks like an AWS failure.
const credentialsPath = (): string =>
  process.env.AWS_SHARED_CREDENTIALS_FILE ?? join(awsDir(), "credentials");

/** True if ~/.aws/credentials already contains an `[agentspoppy]` profile. */
export function agentspoppyProfileExists(): boolean {
  try {
    // This runs immediately before every real credential resolution (see
    // operatorCredentials), so it is the broker's read-side choke point for
    // re-asserting file permissions — the SDK's own fromIni reader can't do it.
    enforceProfilePermissions();
    const p = credentialsPath();
    return existsSync(p) && /^\s*\[\s*agentspoppy\s*\]\s*$/m.test(readFileSync(p, "utf8"));
  } catch {
    return false;
  }
}

/**
 * The access key id currently stored in the `[agentspoppy]` profile, or null.
 * Lets the bootstrap tell THIS machine's operator key apart from keys other
 * machines hold, so a re-setup replaces only its own (multi-device safety).
 */
export function readAgentsPoppyProfileKeyId(): string | null {
  try {
    const p = credentialsPath();
    if (!existsSync(p)) return null;
    let inSection = false;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (/^\s*\[.*\]\s*$/.test(line)) {
        inSection = line.replace(/\s/g, "") === `[${AGENTSPOPPY_PROFILE}]`;
        continue;
      }
      if (!inSection) continue;
      const m = /^\s*aws_access_key_id\s*=\s*(\S+)\s*$/.exec(line);
      if (m) return m[1]!;
    }
    return null;
  } catch {
    return null;
  }
}

/** The comment the writer leaves in place of the secret when the Keychain holds it. */
export const KEYCHAIN_MARKER = "# aws_secret_access_key is in the macOS Keychain (AgentsPoppy)";

/** The inline secret in the `[agentspoppy]` section, or null (absent or keychain-marked). */
export function readProfileInlineSecret(): string | null {
  try {
    const p = credentialsPath();
    if (!existsSync(p)) return null;
    let inSection = false;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (/^\s*\[.*\]\s*$/.test(line)) {
        inSection = line.replace(/\s/g, "") === `[${AGENTSPOPPY_PROFILE}]`;
        continue;
      }
      if (!inSection) continue;
      const m = /^\s*aws_secret_access_key\s*=\s*(\S+)\s*$/.exec(line);
      if (m) return m[1]!;
    }
    return null;
  } catch {
    return null;
  }
}

/** True when the profile carries a session token (temporary creds — custody skips them). */
function profileHasSessionToken(): boolean {
  try {
    const p = credentialsPath();
    if (!existsSync(p)) return false;
    let inSection = false;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (/^\s*\[.*\]\s*$/.test(line)) {
        inSection = line.replace(/\s/g, "") === `[${AGENTSPOPPY_PROFILE}]`;
        continue;
      }
      if (inSection && /^\s*aws_session_token\s*=/.test(line)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Where the operator secret lives right now — the UI's custody line. */
export function secretCustody(): "keychain" | "file" | "none" {
  if (!agentspoppyProfileExists()) return "none";
  if (readProfileInlineSecret() !== null) return "file";
  return "keychain";
}

/**
 * Phase-2 migration, called once at broker start (docs/specs/operator-key-custody.md):
 * an inline secret on macOS moves into the Keychain — write, READ BACK AND COMPARE,
 * and only then rewrite the profile without it. Any failure leaves the file exactly
 * as it was. Session-token profiles are skipped (temporary creds expire on their own).
 */
export function migrateSecretToKeychain(): "migrated" | "already" | "skipped" | "failed" {
  try {
    if (!keychainAvailable() || !agentspoppyProfileExists()) return "skipped";
    if (profileHasSessionToken()) return "skipped";
    const secret = readProfileInlineSecret();
    if (secret === null) return "already";
    const keyId = readAgentsPoppyProfileKeyId();
    if (!keyId) return "skipped";
    if (!keychainStore(keyId, secret)) return "failed"; // verified readback inside
    const p = credentialsPath();
    const existing = readFileSync(p, "utf8");
    const lines = [`aws_access_key_id = ${keyId}`, KEYCHAIN_MARKER];
    writeFileSync(p, upsertIniSection(existing, AGENTSPOPPY_PROFILE, lines), { mode: 0o600 });
    enforceProfilePermissions();
    return "migrated";
  } catch {
    return "failed";
  }
}

/**
 * The operator credential provider shared by every AWS client in the broker: the
 * dedicated `[agentspoppy]` profile if present, else the SDK's standard chain.
 * The SDK is imported lazily so tests/demo stay offline.
 */
export async function operatorCredentials() {
  const { fromIni, fromNodeProviderChain } = await import("@aws-sdk/credential-providers");
  // `ignoreCache: true` is essential — the SDK memoises ~/.aws files at module
  // scope for the process lifetime, so without it a profile written *after* the
  // first credential read (e.g. just pasted in the form) is invisible until
  // restart ("Could not resolve credentials using profile: [agentspoppy]").
  if (!agentspoppyProfileExists()) return fromNodeProviderChain();
  // Inline secret (legacy, non-macOS, or session creds): the SDK's own reader, as ever.
  if (readProfileInlineSecret() !== null) return fromIni({ profile: AGENTSPOPPY_PROFILE, ignoreCache: true });
  // Keychain custody: key id from the file, secret from the Keychain.
  const keyId = readAgentsPoppyProfileKeyId();
  const secret = keyId ? keychainRead(keyId) : null;
  if (keyId && secret) {
    return async () => ({ accessKeyId: keyId, secretAccessKey: secret });
  }
  // Marked for the Keychain but the item is gone. LOUD, specific, and never a silent
  // fall-through to the chain — the chain could resolve a DIFFERENT identity.
  return async () => {
    throw new Error(
      "AgentsPoppy's stored key points at the macOS Keychain, but the Keychain item is missing " +
        "or unreadable. Reconnect your AWS key in Manage your AWS connection.",
    );
  };
}

/**
 * Upsert one INI section, preserving every other section. If the section exists,
 * its body (down to the next section header or EOF) is replaced; otherwise the
 * section is appended. Pure + line-based for obvious correctness; exported for
 * testing.
 */
export function upsertIniSection(existing: string, section: string, lines: string[]): string {
  const isHeader = (l: string): boolean => /^\s*\[.*\]\s*$/.test(l);
  const isThisHeader = (l: string): boolean => l.replace(/\s/g, "") === `[${section}]`;

  const src = existing.split("\n");
  const out: string[] = [];
  let replaced = false;
  for (let i = 0; i < src.length; ) {
    if (isThisHeader(src[i]!)) {
      out.push(`[${section}]`, ...lines);
      i++;
      while (i < src.length && !isHeader(src[i]!)) i++; // skip the old body
      replaced = true;
    } else {
      out.push(src[i]!);
      i++;
    }
  }

  if (!replaced) {
    const trimmed = out.join("\n").replace(/\s+$/, "");
    const block = `[${section}]\n${lines.join("\n")}\n`;
    return trimmed ? `${trimmed}\n\n${block}` : block;
  }
  const result = out.join("\n");
  return result.endsWith("\n") ? result : `${result}\n`;
}

/**
 * Write/replace the `[agentspoppy]` profile in ~/.aws/credentials with these
 * keys, leaving all other profiles untouched. Creates ~/.aws (0700) and the file
 * (0600) if needed. Throws on empty inputs. Never logs the secret.
 */
export function writeAgentsPoppyProfile(input: AwsKeyInput): void {
  const accessKeyId = input.accessKeyId.trim();
  const secretAccessKey = input.secretAccessKey.trim();
  const sessionToken = input.sessionToken?.trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Both an Access Key ID and a Secret Access Key are required.");
  }

  const p = credentialsPath();
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
  // Phase 2: a long-lived key on macOS goes STRAIGHT to the Keychain — no file secret is
  // ever written. keychainStore verifies its own readback; on any failure the inline
  // write happens exactly as before, because key entry must never brick. Session-token
  // credentials stay inline (temporary — they expire on their own).
  const toKeychain = !sessionToken && keychainStore(accessKeyId, secretAccessKey);
  const lines = toKeychain
    ? [`aws_access_key_id = ${accessKeyId}`, KEYCHAIN_MARKER]
    : [
        `aws_access_key_id = ${accessKeyId}`,
        `aws_secret_access_key = ${secretAccessKey}`,
        ...(sessionToken ? [`aws_session_token = ${sessionToken}`] : []),
      ];
  writeFileSync(p, upsertIniSection(existing, AGENTSPOPPY_PROFILE, lines), { mode: 0o600 });
  enforceProfilePermissions();
}

/**
 * Remove one INI section entirely, preserving everything else. Pure + exported
 * for testing (the inverse of {@link upsertIniSection}'s replace branch).
 */
export function removeIniSection(existing: string, section: string): string {
  const isHeader = (l: string): boolean => /^\s*\[.*\]\s*$/.test(l);
  const isThisHeader = (l: string): boolean => l.replace(/\s/g, "") === `[${section}]`;

  const src = existing.split("\n");
  const out: string[] = [];
  for (let i = 0; i < src.length; ) {
    if (isThisHeader(src[i]!)) {
      i++;
      while (i < src.length && !isHeader(src[i]!)) i++; // drop the section body
    } else {
      out.push(src[i]!);
      i++;
    }
  }
  const result = out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
  return result.trim() ? (result.endsWith("\n") ? result : `${result}\n`) : "";
}

/**
 * Remove the `[agentspoppy]` profile from ~/.aws/credentials, leaving every other
 * profile untouched. Used by the kill switch and "Forget this key" — the profile
 * write path in reverse. Returns true when a section was actually removed.
 * NOTE: this removes, it does not forensically erase — journaling filesystems and
 * SSDs may retain old blocks; no UI copy should claim scrubbing.
 */
export function removeAgentsPoppyProfile(): boolean {
  try {
    const p = credentialsPath();
    if (!existsSync(p)) return false;
    const existing = readFileSync(p, "utf8");
    if (!/^\s*\[\s*agentspoppy\s*\]\s*$/m.test(existing)) return false;
    // The Keychain item goes too — read the key id BEFORE the section is stripped.
    const keyId = readAgentsPoppyProfileKeyId();
    writeFileSync(p, removeIniSection(existing, AGENTSPOPPY_PROFILE), { mode: 0o600 });
    if (keyId) keychainRemove(keyId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-assert 0600/0700 on the credentials file + ~/.aws — an existing file keeps
 * whatever mode it had, so creation-time modes alone don't guarantee the
 * documented story (AUDIT-2026-08-16). Best-effort and deliberately narrow:
 * POSIX only (on Windows chmod just toggles the read-only bit), and ONLY the
 * default ~/.aws path — when AWS_SHARED_CREDENTIALS_FILE points elsewhere (test
 * rigs, sandboxes) the file is not ours to re-mode. Returns a warning string for
 * the UI when enforcement failed, null when fine; never throws, never blocks.
 */
export function enforceProfilePermissions(): string | null {
  if (process.platform === "win32") return null;
  if (process.env.AWS_SHARED_CREDENTIALS_FILE) return null;
  try {
    const p = join(awsDir(), "credentials");
    if (!existsSync(p)) return null;
    chmodSync(awsDir(), 0o700);
    chmodSync(p, 0o600);
    return null;
  } catch (err) {
    return `couldn't restrict ~/.aws permissions: ${(err as Error).message}`;
  }
}

/**
 * The broker's non-secret record of THIS machine's operator key: its id (how a
 * re-setup recognises its OWN key instead of evicting another machine's at IAM's
 * two-key limit — which is why it must survive "Forget this key" removing the
 * profile) and when it was minted (drives the key-age rotation nudge). Lives in
 * the AgentsPoppy home, not ~/.aws: it is broker state, not an AWS credential.
 */
export interface OperatorKeyRecord {
  accessKeyId: string;
  /** ISO 8601 — when this machine minted the key. */
  mintedAt: string;
}

const keyRecordPath = (): string =>
  join(process.env.AGENTSPOPPY_HOME ?? join(homedir(), ".agentspoppy"), "operator-key.json");

export function recordOperatorKey(accessKeyId: string, mintedAt = new Date().toISOString()): void {
  try {
    const p = keyRecordPath();
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(p, JSON.stringify({ accessKeyId, mintedAt } satisfies OperatorKeyRecord, null, 2), {
      mode: 0o600,
    });
  } catch {
    // Best-effort: a missing record degrades to the pre-record behavior.
  }
}

export function readOperatorKeyRecord(): OperatorKeyRecord | null {
  try {
    const raw = readFileSync(keyRecordPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<OperatorKeyRecord>;
    if (typeof parsed.accessKeyId !== "string" || typeof parsed.mintedAt !== "string") return null;
    return { accessKeyId: parsed.accessKeyId, mintedAt: parsed.mintedAt };
  } catch {
    return null;
  }
}

export function clearOperatorKeyRecord(): void {
  try {
    rmSync(keyRecordPath(), { force: true });
  } catch {
    // nothing to clear
  }
}
