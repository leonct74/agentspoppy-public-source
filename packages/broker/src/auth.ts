// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Caller authentication for the broker's local HTTP API.
 *
 * The broker binds to loopback, but "loopback" is NOT a trust boundary here: every
 * poppy's backend is a local process too, so without this a malicious poppy could
 * enumerate and REVOKE / PAUSE / TEAR DOWN a competitor's connection (all plain,
 * unauthenticated routes before this). Two token classes fix that:
 *
 *  - HOST token — one per broker run, generated at startup and handed ONLY to the
 *    desktop UI (via a channel a spawned backend can't read — see serve.ts / the
 *    Tauri host). Required for the whole management plane: listing connections,
 *    revoke / pause / resume / approve / deny / supervise / teardown / forget,
 *    accounts, operator AWS calls, and starting/stopping extensions.
 *
 *  - BACKEND token — one per spawned poppy backend, minted by the extension registry
 *    and injected into that backend's bootstrap. It authorises ONLY that poppy's own
 *    `/connections/<its-id>/credentials` mint — nothing else, and never another
 *    poppy's id. So a poppy can still mint its own scoped AWS creds, but can't touch
 *    a sibling.
 *
 * This does NOT constrain legitimate poppy-to-poppy INTEGRATION: cooperating apps
 * exchange functionality/data through their own channels; "revoke my competitor"
 * is simply never a cooperation primitive, so locking the control plane to the host
 * costs interop nothing.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";

/**
 * The broker prints exactly one line `<prefix><token>` on stdout at startup; the
 * Tauri host parses that line to learn the host token (and does NOT echo it). Kept
 * as a shared constant so the emitter and any parser agree. The Rust host hard-codes
 * the same literal — keep them in sync.
 */
export const HOST_TOKEN_STDOUT_PREFIX = "AGENTSPOPPY_HOST_TOKEN=";

/** Mint an unguessable, URL-safe token. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Pull the token out of an `Authorization: Bearer <token>` header value. */
export function bearerToken(headerValue: string | string[] | undefined): string | null {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!value) return null;
  const m = /^Bearer\s+(.+)$/i.exec(value.trim());
  return m ? m[1]!.trim() : null;
}

/** Constant-time string compare (avoids leaking the host token via timing). */
export function tokensMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Who the broker believes is calling, after checking the presented token. */
export type Caller =
  | { role: "host" }
  | { role: "backend"; connectionId: string }
  | { role: "anonymous" };

export interface AuthConfig {
  /** The host token this broker run will accept for the management plane. */
  hostToken?: string;
  /** Dev escape hatch (browser-only harness, no Tauri host to hold a token): treat
   *  every caller as the host. NEVER set in the packaged app. */
  devOpen?: boolean;
  /** Resolve a backend token to the connection id it was minted for (or null). */
  resolveBackend?: (token: string) => string | null;
}

/**
 * True when this process is a packaged single-executable build. A property of the
 * ARTIFACT itself — not a build-time flag a from-source run might accidentally
 * carry — which is why it gates the dev escape hatch below.
 */
export function isSeaBuild(): boolean {
  try {
    // Sync on purpose (resolveCaller sits on the request path). In the packaged SEA
    // the bundle is CJS: the ambient `require` is real and `import.meta.url` is
    // UNDEFINED — createRequire(import.meta.url) THROWS there, and this catch then
    // returned false IN THE ARTIFACT THIS FUNCTION EXISTS TO DETECT, silently
    // re-arming the dev escape hatch the packaged build promises is inert
    // (shipped that way in 0.3.14; caught the same day). Ambient require first.
    const req = typeof require === "function" ? require : createRequire(import.meta.url);
    return (req("node:sea") as { isSea?: () => boolean }).isSea?.() ?? false;
  } catch {
    return false;
  }
}

/**
 * Whether the dev escape hatch actually grants host. Pure + exported so the gate
 * is unit-tested with both artifact states (the real isSeaBuild is environment-
 * dependent). `devOpen` alone is NOT enough in a packaged build — see resolveCaller.
 */
export function devHatchGrantsHost(devOpen: boolean | undefined, isSea: boolean): boolean {
  return !!devOpen && !isSea;
}

/** Classify a request's presented token into a {@link Caller}. */
export function resolveCaller(token: string | null, cfg: AuthConfig): Caller {
  // The dev escape hatch is INERT in packaged builds: a local process that launches
  // the real app (or the shipped broker binary) with AGENTSPOPPY_DEV_OPEN=1 in its
  // environment must not be handed the management plane — and with the operator key
  // moving out of world-readable files, the management plane is the secret's door.
  if (devHatchGrantsHost(cfg.devOpen, isSeaBuild())) return { role: "host" }; // dev harness
  if (token && cfg.hostToken && tokensMatch(token, cfg.hostToken)) return { role: "host" };
  if (token && cfg.resolveBackend) {
    const connectionId = cfg.resolveBackend(token);
    if (connectionId) return { role: "backend", connectionId };
  }
  return { role: "anonymous" };
}
