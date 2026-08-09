// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * AWS error classification + the "I couldn't read this account at all" signal.
 *
 * The footprint scans (CloudFormation list + the tag sweep) are best-effort per region — an
 * opt-in region you haven't enabled simply errors and is skipped. But a *credentials* failure
 * (invalid/expired operator key) or a blanket permission denial errors in EVERY region, which,
 * if swallowed the same way, makes a broken connection look identical to an empty account: a
 * blank map, no explanation. {@link isAwsAuthError} tells the two apart so the scan can raise
 * {@link AccountUnreadableError} when nothing could be read — surfaced to the user as
 * "reconnect your AWS account" instead of a misleading "nothing here".
 */

/** AWS error `name`s (SDK v3) / `Code`s that mean "your credentials or permissions are the problem". */
const AUTH_ERROR_NAMES = new Set([
  "InvalidClientTokenId",
  "UnrecognizedClientException",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
  "InvalidSignatureException",
  "AuthFailure",
  "ExpiredToken",
  "ExpiredTokenException",
  "TokenRefreshRequired",
  "AccessDenied",
  "AccessDeniedException",
  "CredentialsProviderError",
  "CredentialsError",
]);

/** True if an error is a credentials/permission failure (vs. a region being disabled, a throttle, …). */
export function isAwsAuthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; Code?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const name = e.name ?? e.Code ?? "";
  if (AUTH_ERROR_NAMES.has(name)) return true;
  if (e.$metadata?.httpStatusCode === 403) return true;
  const msg = String(e.message ?? "");
  return /security token.*invalid|not authorized|access denied|expired token|invalid.*credential|could not (?:be )?resolve.*credential|unable to.*credential/i.test(
    msg,
  );
}

/**
 * Raised when AgentsPoppy could not read an account's footprint at all — every region failed
 * and at least one failure was a credentials/permission problem. The service maps this to a
 * dedicated error code so the UI can prompt a reconnect rather than render an empty map.
 */
export class AccountUnreadableError extends Error {
  constructor(
    message: string,
    /** "auth" = invalid/expired credentials; "denied" = valid creds lacking the read permissions. */
    readonly kind: "auth" | "denied" = "auth",
  ) {
    super(message);
    this.name = "AccountUnreadableError";
  }
}
