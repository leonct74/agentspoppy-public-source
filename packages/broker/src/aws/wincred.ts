// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Windows Credential Manager custody (docs/specs/operator-key-custody.md).
 *
 * The built-in `cmdkey` can WRITE a generic credential but cannot read one back, and
 * the migration's verify-before-strip rule is only as strong as the readback — so this
 * goes through the real CredRead/CredWrite/CredDelete API, P/Invoked from a PowerShell
 * script.
 *
 * How the pieces travel, and why:
 *  - the SCRIPT arrives via `-EncodedCommand` (base64 of UTF-16LE) — one whole parsed
 *    unit with real exit-code semantics. The earlier `-Command -` (script on stdin)
 *    transport had REPL semantics: a statement error was NON-terminating, the `exit 1`
 *    guard after it never ran, and the session reached EOF with exit 0 — an operation
 *    that did nothing reported success. Caught by the CI vault smoke, 2026-09-01.
 *    The script contains no secret, so argv is fine for it;
 *  - the SECRET arrives in an environment variable of the child — never in argv, where
 *    any process on the machine could read it from the command line; a child's env is
 *    visible only to the same user, which is exactly DPAPI's own protection level;
 *  - the readback leaves as base64 on stdout, sidestepping console encoding;
 *  - every script runs under $ErrorActionPreference='Stop', and mutating operations
 *    must print an explicit success marker — "the process exited 0" is never taken as
 *    proof the API call happened.
 *
 * Credentials persist LOCAL_MACHINE (survive logoff) and are protected per-user by
 * DPAPI — the same bar as everything else in the user's Credential Manager.
 */
import { execFileSync } from "node:child_process";
import { platform } from "node:os";

/** TargetName prefix. Stable — renaming it would orphan stored secrets. */
export const WINCRED_TARGET_PREFIX = "AgentsPoppy AWS operator key/";

const SECRET_CHARSET = /^[A-Za-z0-9/+=]+$/;
const KEYID_CHARSET = /^[A-Z0-9]+$/;

type Exec = (file: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv }) => string;
const realExec: Exec = (file, args, opts) =>
  execFileSync(file, args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    input: opts.input,
    env: opts.env,
    windowsHide: true,
  });
let exec: Exec = realExec;
/** Test seam. Unit tests must never touch a real Credential Manager. */
export function setWincredExecForTests(fn: Exec | null): void {
  exec = fn ?? realExec;
}

const PINVOKE = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class ApCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32")] public static extern void CredFree(IntPtr cred);
}
'@
`;

function runScript(script: string, env: Record<string, string>): string {
  const full = "$ErrorActionPreference = 'Stop'\n" + PINVOKE + script;
  const encoded = Buffer.from(full, "utf16le").toString("base64");
  return exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    env: { ...process.env, ...env },
  });
}

/** CI diagnosability: opt-in stderr on swallowed failures. Never logs the secret. */
function debug(op: string, err: unknown): void {
  if (process.env.AP_VAULT_DEBUG) console.error(`wincred: ${op} failed:`, err instanceof Error ? err.message : err);
}

/** GetLastWin32Error to stderr, then exit 1 — a red run must say WHICH API failed and why. */
const fail = (api: string) =>
  `[Console]::Error.Write('${api} err=' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 1`;

export function wincredAvailable(): boolean {
  return platform() === "win32";
}

export function wincredStore(keyId: string, secret: string): boolean {
  if (!wincredAvailable() || !KEYID_CHARSET.test(keyId) || !SECRET_CHARSET.test(secret)) return false;
  try {
    const out = runScript(
      `
$bytes = [Text.Encoding]::UTF8.GetBytes($env:AP_SECRET)
$blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
$c = New-Object ApCred+CREDENTIAL
$c.Type = 1; $c.Persist = 2
$c.TargetName = $env:AP_TARGET
$c.UserName = $env:AP_ACCT
$c.CredentialBlobSize = $bytes.Length
$c.CredentialBlob = $blob
if (-not [ApCred]::CredWriteW([ref]$c, 0)) { ${fail("CredWriteW")} }
[Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
[Console]::Out.Write('AP_WROTE')
`,
      { AP_SECRET: secret, AP_TARGET: WINCRED_TARGET_PREFIX + keyId, AP_ACCT: keyId },
    );
    if (!out.includes("AP_WROTE")) return false;
    return wincredRead(keyId) === secret;
  } catch (err) {
    debug("store", err);
    return false;
  }
}

export function wincredRead(keyId: string): string | null {
  if (!wincredAvailable() || !KEYID_CHARSET.test(keyId)) return null;
  try {
    const out = runScript(
      `
$ptr = [IntPtr]::Zero
if (-not [ApCred]::CredReadW($env:AP_TARGET, 1, 0, [ref]$ptr)) { ${fail("CredReadW")} }
$c = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][ApCred+CREDENTIAL])
$bytes = New-Object byte[] $c.CredentialBlobSize
[Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $bytes, 0, $c.CredentialBlobSize)
[ApCred]::CredFree($ptr)
[Console]::Out.Write([Convert]::ToBase64String($bytes))
`,
      { AP_TARGET: WINCRED_TARGET_PREFIX + keyId },
    );
    const secret = Buffer.from(out.trim(), "base64").toString("utf8");
    return SECRET_CHARSET.test(secret) ? secret : null;
  } catch (err) {
    debug("read", err);
    return null;
  }
}

export function wincredRemove(keyId: string): boolean {
  if (!wincredAvailable() || !KEYID_CHARSET.test(keyId)) return false;
  try {
    const out = runScript(
      `
if (-not [ApCred]::CredDeleteW($env:AP_TARGET, 1, 0)) { ${fail("CredDeleteW")} }
[Console]::Out.Write('AP_DELETED')
`,
      { AP_TARGET: WINCRED_TARGET_PREFIX + keyId },
    );
    return out.includes("AP_DELETED");
  } catch (err) {
    debug("remove", err);
    return false;
  }
}
