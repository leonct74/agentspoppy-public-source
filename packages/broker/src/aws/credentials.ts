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
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

/** The profile the in-app key entry writes to (never `default`). */
export const AGENTSPOPPY_PROFILE = "agentspoppy";

export interface AwsKeyInput {
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional — only for temporary (STS) credentials. */
  sessionToken?: string;
}

const awsDir = (): string => join(homedir(), ".aws");
const credentialsPath = (): string => join(awsDir(), "credentials");

/** True if ~/.aws/credentials already contains an `[agentspoppy]` profile. */
export function agentspoppyProfileExists(): boolean {
  try {
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
  return agentspoppyProfileExists()
    ? fromIni({ profile: AGENTSPOPPY_PROFILE, ignoreCache: true })
    : fromNodeProviderChain();
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

  const dir = awsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const p = credentialsPath();
  const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
  const lines = [
    `aws_access_key_id = ${accessKeyId}`,
    `aws_secret_access_key = ${secretAccessKey}`,
    ...(sessionToken ? [`aws_session_token = ${sessionToken}`] : []),
  ];
  writeFileSync(p, upsertIniSection(existing, AGENTSPOPPY_PROFILE, lines), { mode: 0o600 });
}
