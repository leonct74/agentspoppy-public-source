// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The curated directory's install engine (docs/MARKETPLACE.md §9). The catalog —
 * a static JSON the platform publishes — is the ONLY remote source: callers hand
 * this service an id, never a URL, so install-from-arbitrary-URL is structurally
 * impossible (MARKETPLACE.md §2). The package bytes come from wherever the
 * catalog points (each poppy's own repository releases); that hosting is
 * untrusted by design — the catalog-pinned sha256 is verified here, locally,
 * before anything lands in the extensions root.
 *
 * Installing never starts a poppy: the AWS-approval prompt stays a separate,
 * deliberate user act (registry.start).
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { effectiveIsolation, parseManifest, type ExtensionManifest } from "@agentspoppy/extension-sdk";
import { BrokerError } from "../service";
import type { ExtensionRegistry } from "./registry";
import { extractZip } from "./zip";

/** One downloadable build of a poppy, pinned by content hash. */
export interface DirectoryPackage {
  url: string;
  /** sha256 (hex) of the package zip — verified locally before extraction. */
  sha256: string;
}

/** Display pricing for a paid poppy (sold through the platform's 5% commission — MARKETPLACE.md).
 *  Absent = the poppy is free. This is DISPLAY-ONLY; the authoritative price + the Stripe ids live
 *  server-side in the commerce plane (agentspoppy-web). `amountMinor` is the currency's minor unit
 *  (e.g. cents); `currency` is a lowercase ISO-4217 code; `interval` is present only for subscriptions. */
export interface DirectoryPricing {
  kind: "subscription" | "one_time";
  amountMinor: number;
  currency: string;
  interval?: "month" | "year";
}

/** One catalog listing, as published. */
export interface DirectoryEntry {
  /** Reverse-DNS extension id — becomes the installed extension's id. */
  id: string;
  name: string;
  tagline?: string;
  description?: string;
  publisher?: string;
  website?: string;
  /** The poppy's open repository (required — the open-repo rule). */
  repo: string;
  /** The poppy's app icon as a small PNG data URI — shown on its listing card. */
  icon?: string;
  featured?: boolean;
  version: string;
  /** Per-platform packages keyed by `${process.platform}-${process.arch}`, or `"any"`
   *  for a platform-neutral package (a pure-JS `runtime: "node22"` backend is identical
   *  on every OS — one upload, one sha). A platform-specific key wins over `"any"`. */
  packages?: Record<string, DirectoryPackage>;
  /** Set when the poppy is sold through the platform (5% commission). Absent = free. */
  pricing?: DirectoryPricing;
  /** Average stars (1–5) and how many installs rated, from the Feedback tab every poppy ships.
   *  Absent = nobody has rated yet, which the card says plainly rather than showing a zero. */
  rating?: number;
  ratingCount?: number;
  /** Minimum AgentsPoppy version this listing's package needs (docs/RUNTIMES.md §4.5).
   *  A host older than this must neither install nor offer the update — otherwise the
   *  user gets a button that can only fail (the VPN-Poppy 0.1.3 perpetual-update class). */
  minHost?: string;
  /** Set by a human reviewer for the one sanctioned unconfined release: a named,
   *  one-release data migration that must move state out of the user's home before
   *  its confined successor ships (RUNTIMES.md R7).
   *
   *  It lives on the LISTING, never in the package, and that is the whole point. A
   *  package that could declare itself exempt is not gated at all — which is exactly
   *  how a shadowed second manifest ("isolation": "none") would install unconfined
   *  behind a review that read the first one. Absent means confined-or-refused. */
  allowUnconfined?: boolean;
}

/** A listing enriched with this host's local state, for the app's Directory view. */
export type DirectoryPoppyView = DirectoryEntry & {
  installed: boolean;
  /** The version actually installed on this host (undefined when not installed). May differ
   *  from `version` (the catalog's latest) — that difference is what {@link updateAvailable} flags. */
  installedVersion?: string;
  /** installed AND the catalog now lists a different version — i.e. an update is waiting.
   *  Version equality is the signal (not ordering): a re-published fix or a rollback both count.
   *  Always false while {@link hostTooOld} — never offer an update that can only fail. */
  updateAvailable: boolean;
  /** The listing's minHost is newer than this AgentsPoppy — the UI should say
   *  "update AgentsPoppy first", never show Install/Update. */
  hostTooOld: boolean;
  blocked: boolean;
  platform: { key: string; available: boolean };
};

export interface DirectoryCatalogView {
  sourceUrl: string;
  fetchedAt: string;
  poppies: DirectoryPoppyView[];
}

/**
 * The facts needed to AUDIT an update before deciding to install it — assembled WITHOUT
 * downloading the package (review reads the open repo, not the bytes). Nothing is pulled onto
 * the machine until the user consents; applyUpdate does the download-and-install then.
 */
export interface UpdatePreview {
  id: string;
  name: string;
  /** The open repo the package is built from — where the agent audits the source diff. */
  repo: string;
  installedVersion: string;
  version: string;
  /** The package's pinned sha256 (from the catalog) — what a download will be verified against. */
  sha256: string;
  /** The AWS access the CURRENTLY-installed version has (readable) — the agent compares the new
   *  version's declared scope (in the repo) against this. No download needed to know it. */
  installedGrants: string[];
  /** The host-bridge powers (host:openExternal, aws:credentials, …) the installed version has. */
  installedCapabilities: string[];
  /** Whether the CURRENTLY-installed version's backend is confined ("strict"), unconfined
   *  ("none"), or has no backend at all — so the audit can flag a confinement DOWNGRADE. */
  installedIsolation: "strict" | "none" | "no-backend";
}

/** The outcome of an applied update, including what its declared scope actually changed —
 *  computed from the downloaded manifest, so the user learns the delta at install time. */
export interface UpdateResult {
  ok: true;
  extensionId: string;
  version: string;
  scopeChanged: boolean;
  grantsAdded: string[];
  grantsRemoved: string[];
  capabilitiesAdded: string[];
  capabilitiesRemoved: string[];
}

export interface DirectoryServiceOptions {
  /** Where installed extensions live (serve.ts's extensionsRoot()). */
  extensionsRoot: string;
  registry: ExtensionRegistry;
  /** The rung-1 blocklist (service.listBlockedExtensions). */
  listBlocked: () => Promise<string[]>;
  catalogUrl?: string;
  /** Injectable downloader (tests). Defaults to the resilient {@link httpFetchBytes}. */
  fetchBytes?: (url: string, opts?: FetchBytesOptions) => Promise<Uint8Array>;
  platformKey?: string;
  /** This AgentsPoppy build's version (from tauri.conf.json, injected into the broker
   *  bundle by build-broker.mjs) — powers the catalog minHost gate. Absent in dev runs,
   *  which switches the gate off. */
  hostVersion?: string;
}

const DEFAULT_CATALOG_URL =
  "https://agentspoppy-web--agentspoppy.europe-west4.hosted.app/directory/catalog.json";

const CATALOG_UNREACHABLE =
  "Couldn't reach the poppy catalog — check your internet connection and try again.";
const CATALOG_UNREADABLE =
  "The poppy catalog answered with something this app can't read — try again in a few minutes.";

/** How long a fetched catalog is reused before re-fetching (browsing only — installs always re-fetch). */
const CATALOG_TTL_MS = 60_000;

/**
 * The same shape the manifest schema enforces for ids. Checked BEFORE the catalog
 * id is used in any filesystem path, so even a compromised catalog can't smuggle
 * path separators or dot-segments into the staging dir name.
 */
const SAFE_ID = /^[a-z0-9]+([.-][a-z0-9]+)+$/i;

/** Poppy packages are ~100–200MB today (a bundled sidecar binary); after the shared-runtime
 *  move (docs/RUNTIMES.md) they shrink to a few MB. 256MB admits every legitimate package
 *  through the transition; anything past this is wrong, not big. */
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;

/** The catalog is JSON with inline PNG icons — a few hundred KB. 32MB is absurd headroom. */
const MAX_CATALOG_BYTES = 32 * 1024 * 1024;

/** Options for {@link httpFetchBytes} (and the injectable fetchBytes seam). */
export interface FetchBytesOptions {
  /** Abort — with no retry, more bytes won't help — once the body exceeds this. */
  maxBytes?: number;
  /** Total request attempts, including the first. Later attempts resume via Range. */
  attempts?: number;
  /** Base delay between attempts, growing linearly. Tests pass 0. */
  retryDelayMs?: number;
}

/** Over-`maxBytes` sentinel: the one failure a retry can never fix. */
class DownloadTooLargeError extends Error {}

/**
 * Download a URL fully into memory, surviving the failure modes a big poppy package
 * actually hits (the VPN-Poppy 0.1.3 110MB perpetual-update bug, 2026-07-24): mid-body
 * connection resets and stalls. The body is STREAMED with a running byte count; on any
 * network failure the next attempt sends `Range: bytes=<received>-` so progress is kept
 * (GitHub release assets honor Range; a server answering 200 instead of 206 simply
 * restarts the count). A body over `maxBytes` aborts immediately with no retry.
 * Exported for direct unit-testing.
 */
export async function httpFetchBytes(url: string, opts: FetchBytesOptions = {}): Promise<Uint8Array> {
  const attempts = opts.attempts ?? 5;
  const retryDelayMs = opts.retryDelayMs ?? 500;
  const tooLarge = () =>
    new DownloadTooLargeError(
      `This package is far larger than any poppy should be — refusing it. Nothing was installed. — over ${opts.maxBytes} bytes`,
    );
  let chunks: Uint8Array[] = [];
  let received = 0;
  let lastFailure = "";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1 && retryDelayMs > 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs * (attempt - 1)));
    }
    let res: Response;
    try {
      res = await fetch(url, received > 0 ? { headers: { range: `bytes=${received}-` } } : undefined);
    } catch (err) {
      lastFailure = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (!res.ok) {
      // Transient server trouble is worth retrying; anything else (404, 403…) is a
      // real answer that more attempts won't change.
      if (res.status >= 500 || res.status === 429 || res.status === 408) {
        lastFailure = `the server said ${res.status}`;
        continue;
      }
      throw new Error(`The download failed (the server said ${res.status}) — try again later. — ${url}`);
    }
    if (received > 0 && res.status !== 206) {
      // The server ignored the Range request — start over from byte zero.
      chunks = [];
      received = 0;
    }
    try {
      if (!res.body) {
        const all = new Uint8Array(await res.arrayBuffer());
        chunks.push(all);
        received += all.length;
      } else {
        for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
          chunks.push(chunk);
          received += chunk.length;
          if (opts.maxBytes !== undefined && received > opts.maxBytes) throw tooLarge();
        }
      }
      if (opts.maxBytes !== undefined && received > opts.maxBytes) throw tooLarge();
      const out = new Uint8Array(received);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      return out;
    } catch (err) {
      if (err instanceof DownloadTooLargeError) throw err;
      // Mid-body failure: keep what already arrived; the next attempt resumes from it.
      lastFailure = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(
    `Couldn't download from ${new URL(url).host} — check your internet connection and try again.` +
      (lastFailure ? ` — gave up after ${attempts} attempts (${lastFailure})` : ""),
  );
}

/**
 * True when version `host` satisfies `min` (both "X.Y.Z"). Malformed input FAILS OPEN
 * (true): a typo in a catalog's minHost must never brick installs — the sha256 and
 * manifest validation still protect the install itself.
 */
export function versionAtLeast(host: string, min: string): boolean {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const h = parse(host);
  const n = parse(min);
  if (!h || !n) return true;
  for (let i = 0; i < 3; i++) {
    const hv = h[i] ?? 0;
    const nv = n[i] ?? 0;
    if (hv !== nv) return hv > nv;
  }
  return true;
}

export class DirectoryService {
  private readonly extensionsRoot: string;
  private readonly registry: ExtensionRegistry;
  private readonly listBlocked: () => Promise<string[]>;
  private readonly catalogUrl: string;
  private readonly fetchBytes: (url: string, opts?: FetchBytesOptions) => Promise<Uint8Array>;
  private readonly platformKey: string;
  private readonly hostVersion?: string;
  private cache: { at: number; entries: DirectoryEntry[] } | null = null;
  // Per-id single-flight: every install/uninstall/update touches the same <root>/<id> dir
  // (and its .staging-/.trash- siblings), so two concurrent ops on one poppy could delete
  // each other's in-flight staging/backup and leave the registry out of sync with disk.
  // Serialising by id makes each a critical section; different poppies still run in parallel.
  private readonly opLocks = new Map<string, Promise<unknown>>();

  constructor(opts: DirectoryServiceOptions) {
    this.extensionsRoot = opts.extensionsRoot;
    this.registry = opts.registry;
    this.listBlocked = opts.listBlocked;
    this.catalogUrl = opts.catalogUrl ?? process.env.AGENTSPOPPY_DIRECTORY_URL ?? DEFAULT_CATALOG_URL;
    this.fetchBytes = opts.fetchBytes ?? httpFetchBytes;
    this.platformKey = opts.platformKey ?? `${process.platform}-${process.arch}`;
    this.hostVersion = opts.hostVersion;
  }

  /** The minHost gate (docs/RUNTIMES.md §4.5). Off when the host version is unknown (dev). */
  private hostTooOldFor(entry: DirectoryEntry): boolean {
    return !!(entry.minHost && this.hostVersion && !versionAtLeast(this.hostVersion, entry.minHost));
  }

  /** The BrokerError every minHost-gated mutation throws — one message, everywhere. */
  private hostTooOldError(entry: DirectoryEntry): BrokerError {
    return new BrokerError(
      "invalid_state",
      `${entry.name} ${entry.version} needs AgentsPoppy ${entry.minHost} or newer — update AgentsPoppy first, then try again.`,
    );
  }

  /**
   * Serialise mutating operations per poppy id: the next call for an id waits for the
   * previous to finish (whether it resolved or threw), so two ops never touch the same
   * <root>/<id> + staging/backup dirs at once. Distinct ids run concurrently. The stored
   * tail never rejects (so one failure doesn't wedge the chain); callers still get the
   * real result/throw from their own turn.
   */
  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.opLocks.get(id) ?? Promise.resolve()).then(fn, fn);
    this.opLocks.set(
      id,
      run.then(
        () => {},
        () => {},
      ),
    );
    return run;
  }

  /** The catalog, enriched with what this host already knows locally. */
  async getCatalog(): Promise<DirectoryCatalogView> {
    const entries = await this.entries();
    const blocked = new Set(await this.listBlocked());
    return {
      sourceUrl: this.catalogUrl,
      fetchedAt: new Date().toISOString(),
      poppies: entries.map((e) => {
        const installedVersion = this.registry.get(e.id)?.manifest.version;
        const hostTooOld = this.hostTooOldFor(e);
        return {
          ...e,
          installed: installedVersion !== undefined,
          installedVersion,
          // Never flag an update the gate below would refuse — an Update button that can
          // only fail is exactly the perpetual-update trap this field exists to prevent.
          updateAvailable: installedVersion !== undefined && installedVersion !== e.version && !hostTooOld,
          hostTooOld,
          blocked: blocked.has(e.id),
          platform: {
            key: this.platformKey,
            available: !!(e.packages?.[this.platformKey] ?? e.packages?.["any"]),
          },
        };
      }),
    };
  }

  /**
   * Download, verify and install a catalog poppy by id — then hot-register it, so
   * it appears with no broker restart. Any failure discards the staging dir; a
   * package can never half-install.
   */
  async install(id: string): Promise<{ ok: true; extensionId: string }> {
    return this.withLock(id, () => this.installImpl(id));
  }
  private async installImpl(id: string): Promise<{ ok: true; extensionId: string }> {
    // Installs always use a FRESH catalog: a stale cache must never pin old bytes.
    const entries = await this.entries({ fresh: true });
    const entry = entries.find((e) => e.id === id);
    if (!entry) {
      throw new BrokerError("not_found", `"${id}" isn't in the poppy catalog — it may have been removed.`);
    }
    if (!SAFE_ID.test(entry.id)) {
      throw new BrokerError(
        "bad_request",
        `This listing's id isn't a valid poppy id — refusing to install it. Nothing was installed. — id "${entry.id}"`,
      );
    }
    if (this.registry.has(id)) {
      throw new BrokerError("invalid_state", `${entry.name} is already installed.`);
    }
    if ((await this.listBlocked()).includes(id)) {
      throw new BrokerError(
        "invalid_state",
        `${entry.name} is blocked on this computer — unblock it on its poppy card first.`,
      );
    }
    if (this.hostTooOldFor(entry)) throw this.hostTooOldError(entry);

    const { staging, manifest } = await this.stagePackage(entry);
    try {
      const dest = join(this.extensionsRoot, manifest.id);
      try {
        await rename(staging, dest);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM") {
          throw new BrokerError("invalid_state", `${entry.name} is already installed.`);
        }
        throw err;
      }

      // Register into the LIVE registry only after the files are fully in place —
      // frontend serving reads disk per request, so ordering is what makes hot
      // install safe. No restart needed.
      this.registry.install({ manifest, root: dest });
      return { ok: true, extensionId: manifest.id };
    } catch (err) {
      await rm(staging, { recursive: true, force: true });
      throw err;
    }
  }

  /**
   * Update an ALREADY-installed catalog poppy to the version the catalog now lists —
   * download+verify the new package, then atomically swap it in over the old one.
   *
   * The connection is deliberately preserved: the backend is stopped and the extension
   * unregistered (so no file is in use during the swap), but the approved AWS connection
   * stays, so the updated poppy reconnects without re-asking — UNLESS its declared scope
   * changed, in which case the next start() supersedes it (re-consent), exactly as a
   * fresh install of the new manifest would. The new build isn't auto-started (parity
   * with install): opening the poppy brings it back up on the new code.
   *
   * Fail-safe: the new package is fully staged and validated BEFORE anything is touched,
   * and any error during the swap rolls the previous install back — an update can never
   * leave the poppy half-replaced or lost.
   */
  async update(id: string): Promise<{ ok: true; extensionId: string; version: string }> {
    return this.withLock(id, () => this.updateImpl(id));
  }
  private async updateImpl(id: string): Promise<{ ok: true; extensionId: string; version: string }> {
    const { entry, prev, dest } = await this.resolveUpdatable(id);
    // Already current: nothing to do (the UI shouldn't offer it, but be safe + idempotent).
    if (prev.manifest.version === entry.version) {
      return { ok: true, extensionId: id, version: entry.version };
    }
    // Stage + validate the NEW package first — if anything's wrong the existing install
    // is still registered and on disk, untouched.
    const { staging, manifest } = await this.stagePackage(entry);
    return this.swapIn(id, prev, dest, staging, manifest);
  }

  /**
   * Assemble what the user needs to AUDIT an update BEFORE downloading anything: the version
   * delta, the open-repo link (where the agent reads the source diff), the pinned sha256, and
   * the AWS access + host powers the CURRENTLY-installed version has (so the agent can compare
   * the new version's declared scope, in the repo, against it). Reads the catalog + local
   * registry ONLY — the package is never fetched here; that happens in applyUpdate, after the
   * user has reviewed and chosen to proceed. Nothing untrusted lands on the machine at review.
   */
  async previewUpdate(id: string): Promise<UpdatePreview> {
    return this.withLock(id, () => this.previewUpdateImpl(id));
  }
  private async previewUpdateImpl(id: string): Promise<UpdatePreview> {
    const { entry, prev } = await this.resolveUpdatable(id);
    return {
      id: entry.id,
      name: entry.name,
      repo: entry.repo,
      installedVersion: prev.manifest.version,
      version: entry.version,
      sha256: (entry.packages?.[this.platformKey] ?? entry.packages?.["any"])?.sha256 ?? "",
      installedGrants: formatGrants(prev.manifest),
      installedCapabilities: [...(prev.manifest.capabilities ?? [])],
      installedIsolation: prev.manifest.backend ? (prev.manifest.backend.isolation === "strict" ? "strict" : "none") : "no-backend",
    };
  }

  /**
   * Download, verify and install an update — the download happens HERE, only after the user has
   * reviewed and chosen to proceed (nothing is fetched at preview time). Atomically swaps the new
   * package over the old install; the approved connection is preserved (the poppy reconnects
   * without re-asking) UNLESS its declared scope changed, in which case the next start() supersedes
   * it (re-consent). Returns what the scope actually changed — computed from the downloaded
   * manifest — so the app can tell the user at install time. Any error rolls the previous install
   * back, so a failed update can never leave the poppy half-replaced or lost.
   */
  async applyUpdate(id: string): Promise<UpdateResult> {
    return this.withLock(id, () => this.applyUpdateImpl(id));
  }
  private async applyUpdateImpl(id: string): Promise<UpdateResult> {
    const { entry, prev, dest } = await this.resolveUpdatable(id);
    const noChange = {
      scopeChanged: false,
      grantsAdded: [] as string[],
      grantsRemoved: [] as string[],
      capabilitiesAdded: [] as string[],
      capabilitiesRemoved: [] as string[],
    };
    // Already current (e.g. a second concurrent apply, after the first already won): nothing to do.
    if (prev.manifest.version === entry.version) {
      return { ok: true, extensionId: id, version: entry.version, ...noChange };
    }
    const { staging, manifest } = await this.stagePackage(entry);
    const grants = grantDiff(prev.manifest, manifest);
    const caps = capabilityDiff(prev.manifest, manifest);
    await this.swapIn(id, prev, dest, staging, manifest);
    return {
      ok: true,
      extensionId: manifest.id,
      version: manifest.version,
      scopeChanged: grants.scopeChanged,
      grantsAdded: grants.grantsAdded,
      grantsRemoved: grants.grantsRemoved,
      capabilitiesAdded: caps.capabilitiesAdded,
      capabilitiesRemoved: caps.capabilitiesRemoved,
    };
  }

  /** Shared guards for an in-place update: the listing exists + is safe, the poppy is
   *  installed as a catalog install (files at <root>/<id>), and it isn't blocked. */
  private async resolveUpdatable(id: string) {
    const entries = await this.entries({ fresh: true });
    const entry = entries.find((e) => e.id === id);
    if (!entry) {
      throw new BrokerError("not_found", `"${id}" isn't in the poppy catalog — it may have been removed.`);
    }
    if (!SAFE_ID.test(entry.id)) {
      throw new BrokerError(
        "bad_request",
        `This listing's id isn't a valid poppy id — refusing to update it. Nothing changed. — id "${entry.id}"`,
      );
    }
    const prev = this.registry.get(id);
    if (!prev) {
      throw new BrokerError("not_found", `"${id}" isn't installed on this computer, so there's nothing to update.`);
    }
    if ((await this.listBlocked()).includes(id)) {
      throw new BrokerError(
        "invalid_state",
        `${entry.name} is blocked on this computer — unblock it on its poppy card first.`,
      );
    }
    // Only a catalog-installed poppy (files under the extensions root, at <root>/<id>)
    // can be swapped in place; a sideloaded one rooted elsewhere is left untouched.
    const dest = join(this.extensionsRoot, entry.id);
    if (resolve(prev.root) !== resolve(dest)) {
      throw new BrokerError(
        "invalid_state",
        `${entry.name} was installed from outside the catalog, so it can't be updated here — reinstall it from its source.`,
      );
    }
    if (this.hostTooOldFor(entry)) throw this.hostTooOldError(entry);
    return { entry, prev, dest };
  }

  /**
   * The atomic swap shared by update/applyUpdate: stop + unregister the old install (so no
   * file is in use — the CONNECTION is kept, so the poppy reconnects without re-asking unless
   * its scope changed), move the old dir aside, move the staged one in, drop the old. Any
   * failure rolls the previous install back, so an update can never lose or half-replace it.
   */
  private async swapIn(
    id: string,
    prev: { manifest: ExtensionManifest; root: string },
    dest: string,
    staging: string,
    manifest: ExtensionManifest,
  ): Promise<{ ok: true; extensionId: string; version: string }> {
    const backup = join(
      this.extensionsRoot,
      `.trash-${id}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    );
    await this.registry.remove(id);
    let movedAside = false;
    try {
      await renameWithRetry(dest, backup);
      movedAside = true;
      await renameWithRetry(staging, dest);
    } catch (err) {
      await rm(staging, { recursive: true, force: true, maxRetries: 10 }).catch(() => {});
      // Roll back — but re-register the previous install pointing at whichever path actually
      // holds its files now, so the registry never claims it's at `dest` when `dest` is empty.
      // If the restore rename fails (transient EPERM/EBUSY), the files are still in `backup`,
      // so register there rather than orphaning them under a dot-dir the disk scan skips.
      let restored = false;
      if (movedAside) restored = await renameWithRetry(backup, dest).then(() => true).catch(() => false);
      this.registry.install(restored || !movedAside ? prev : { manifest: prev.manifest, root: backup });
      throw err;
    }
    await rm(backup, { recursive: true, force: true, maxRetries: 10 }).catch(() => {});
    this.registry.install({ manifest, root: dest });
    return { ok: true, extensionId: manifest.id, version: manifest.version };
  }

  /**
   * Fetch, verify (size + sha256) and unpack a catalog package into a fresh dot-prefixed
   * staging dir, validating its manifest against the listing and its declared entry files.
   * Returns the staging path (for the caller to move into place) + the parsed manifest.
   * Cleans up the staging dir on any failure, so a half-extracted package never lingers.
   */
  private async stagePackage(entry: DirectoryEntry): Promise<{ staging: string; manifest: ExtensionManifest }> {
    const pkg = entry.packages?.[this.platformKey] ?? entry.packages?.["any"];
    if (!pkg) {
      throw new BrokerError(
        "bad_request",
        `${entry.name} isn't available for this computer yet. — no package for ${this.platformKey}`,
      );
    }

    const bytes = await this.fetchBytes(pkg.url, { maxBytes: MAX_PACKAGE_BYTES });
    if (bytes.length > MAX_PACKAGE_BYTES) {
      throw new BrokerError(
        "bad_request",
        `This package is far larger than any poppy should be — refusing it. Nothing was installed. — ${bytes.length} bytes`,
      );
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest.toLowerCase() !== pkg.sha256.toLowerCase()) {
      throw new BrokerError(
        "bad_request",
        `This download doesn't match what the directory expected — it may be corrupted or tampered with. ` +
          `Nothing was installed. — expected sha256 ${pkg.sha256}, got ${digest}`,
      );
    }

    await mkdir(this.extensionsRoot, { recursive: true });
    // A dot-prefixed staging dir: installExtensionsFromDisk skips dot-entries, so a
    // half-extracted package is never scanned as an extension, even across a restart.
    const staging = join(
      this.extensionsRoot,
      `.staging-${entry.id}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    );
    try {
      await extractZip(bytes, staging);
      const manifest = await this.readPackageManifest(staging, entry);

      // The manifest's own entry paths must stay inside the package (same containment
      // idiom as the zip extractor — a manifest is attacker-supplied content too).
      const frontendFile = this.contained(staging, manifest.frontend.entry);
      if (!(await stat(frontendFile).catch(() => null))) {
        throw new BrokerError(
          "bad_request",
          `The package is missing its app screen (${manifest.frontend.entry}) — it wasn't packed correctly. Nothing was installed.`,
        );
      }
      if (manifest.backend) {
        // Manifests keep a platform-neutral entry ("backend/foo"); Windows packages
        // ship the binary as foo.exe (mirrored at spawn in backend-host).
        let backendFile = this.contained(staging, manifest.backend.entry);
        if (!(await stat(backendFile).catch(() => null))) {
          const exe = this.contained(staging, `${manifest.backend.entry}.exe`);
          if (this.platformKey.startsWith("win32") && (await stat(exe).catch(() => null))) {
            backendFile = exe;
          } else {
            throw new BrokerError(
              "bad_request",
              `The package is missing its backend (${manifest.backend.entry}) — it wasn't packed correctly. Nothing was installed.`,
            );
          }
        }
        // The zip format stores plain 0644 — the backend must be executable to spawn.
        await chmod(backendFile, 0o755);
      }
      return { staging, manifest };
    } catch (err) {
      await rm(staging, { recursive: true, force: true });
      throw err;
    }
  }

  /**
   * Uninstall an extension: stop it, forget it, and remove its files — and ONLY
   * its files. The cloud is deliberately untouched: everything the poppy built
   * keeps running, the approved connection stays, and a reinstall reconnects
   * without re-asking. (Deleting the cloud footprint is the separate, explicit
   * "tear down" act on the poppy's Manage view — never a side effect of this.)
   */
  async uninstall(id: string): Promise<{ ok: true; extensionId: string }> {
    return this.withLock(id, () => this.uninstallImpl(id));
  }
  private async uninstallImpl(id: string): Promise<{ ok: true; extensionId: string }> {
    const inst = this.registry.get(id);
    if (!inst) {
      throw new BrokerError("not_found", `"${id}" isn't installed on this computer.`);
    }
    await this.registry.remove(id);
    // Only remove files that live inside the extensions root — a sideloaded or
    // embedder-registered extension rooted elsewhere is forgotten but never deleted.
    const root = resolve(inst.root);
    const home = resolve(this.extensionsRoot);
    if (root !== home && root.startsWith(home + sep)) {
      await rm(root, { recursive: true, force: true, maxRetries: 10 });
    }
    return { ok: true, extensionId: id };
  }

  private async readPackageManifest(staging: string, entry: DirectoryEntry) {
    let raw: string;
    try {
      raw = await readFile(join(staging, "extension.json"), "utf8");
    } catch {
      throw new BrokerError(
        "bad_request",
        "This package is missing its extension.json — it isn't a poppy package. Nothing was installed.",
      );
    }
    let manifest;
    try {
      manifest = parseManifest(raw);
    } catch (err) {
      throw new BrokerError(
        "bad_request",
        `This package's manifest is invalid, so it can't be installed. Nothing was installed. — ${(err as Error).message}`,
      );
    }
    // The id-squatting defence: a package may only install as what the catalog listed.
    if (manifest.id !== entry.id || manifest.version !== entry.version) {
      throw new BrokerError(
        "bad_request",
        `This package says it is "${manifest.id}" v${manifest.version}, but the directory listed ` +
          `"${entry.id}" v${entry.version} — refusing a package that doesn't match its listing. Nothing was installed.`,
      );
    }
    // The NAME must match too: the manifest's name is what the sidebar shows after
    // install, so a package presenting one name in the directory and another once
    // installed is an impersonation vector, not a packaging mistake.
    if (manifest.name !== entry.name) {
      throw new BrokerError(
        "bad_request",
        `This package calls itself "${manifest.name}", but the directory listed "${entry.name}" — ` +
          `refusing a package that doesn't match its listing. Nothing was installed.`,
      );
    }
    // Confinement is verified against what was actually EXTRACTED, not against what
    // the listing or the reviewer read. Both zip readers now refuse an archive that
    // names extension.json twice, but this is the check that does not depend on them
    // catching it: a catalog install whose manifest asks to run unconfined is refused
    // here, on the bytes that will actually run.
    if (manifest.backend && effectiveIsolation(manifest.backend) === "none" && !entry.allowUnconfined) {
      throw new BrokerError(
        "bad_request",
        `"${entry.name}" asks to run without confinement, which means full access to your files including your AWS credentials. ` +
          `The directory only lists confined poppies, so this package does not match its listing. Nothing was installed.`,
      );
    }
    return manifest;
  }

  private contained(root: string, rel: string): string {
    const abs = resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new BrokerError(
        "bad_request",
        `This package's manifest points outside its own folder — refusing to install it. Nothing was installed. — entry "${rel}"`,
      );
    }
    return abs;
  }

  private async entries(opts: { fresh?: boolean } = {}): Promise<DirectoryEntry[]> {
    if (!opts.fresh && this.cache && Date.now() - this.cache.at < CATALOG_TTL_MS) {
      return this.cache.entries;
    }
    let bytes: Uint8Array;
    try {
      bytes = await this.fetchBytes(this.catalogUrl, { maxBytes: MAX_CATALOG_BYTES });
    } catch {
      throw new Error(CATALOG_UNREACHABLE);
    }
    const entries = parseCatalog(Buffer.from(bytes).toString("utf8"));
    this.cache = { at: Date.now(), entries };
    return entries;
  }
}

/**
 * Diff the AWS scope two manifests declare, for the update-audit UI. A grant is keyed by
 * [service, sorted actions, resourceScope] so a mere reorder isn't a change, but any
 * added/removed/retargeted grant is. Returns human-readable lines (never raw JSON) so the
 * app can show "this update asks for MORE access" plainly, and a `scopeChanged` flag —
 * the signal for the security-relevant warning (the connection is re-approved on a change).
 */
type Grant = { service: string; actions: string[]; resourceScope: string };
const fmtGrant = (g: Grant) => `${g.service} — ${g.resourceScope} (${g.actions.join(", ")})`;
const grantSig = (g: Grant) => JSON.stringify([g.service, [...g.actions].sort(), g.resourceScope]);

/** The AWS grants a manifest declares, as readable lines — the "what it can do now" reference. */
function formatGrants(m: ExtensionManifest): string[] {
  return ((m.permissionSet?.grants ?? []) as Grant[]).map(fmtGrant);
}

function grantDiff(
  installed: ExtensionManifest,
  next: ExtensionManifest,
): { scopeChanged: boolean; grantsAdded: string[]; grantsRemoved: string[] } {
  const before = new Map(((installed.permissionSet?.grants ?? []) as Grant[]).map((g) => [grantSig(g), g]));
  const after = new Map(((next.permissionSet?.grants ?? []) as Grant[]).map((g) => [grantSig(g), g]));
  const grantsAdded = [...after].filter(([k]) => !before.has(k)).map(([, g]) => fmtGrant(g));
  const grantsRemoved = [...before].filter(([k]) => !after.has(k)).map(([, g]) => fmtGrant(g));
  return { scopeChanged: grantsAdded.length > 0 || grantsRemoved.length > 0, grantsAdded, grantsRemoved };
}

/**
 * Diff the HOST-BRIDGE capabilities (host:openExternal, aws:credentials, backend:invoke, …) two
 * manifests declare. These are privileged powers the sandboxed frontend gains over the host, so a
 * broadened capability across an update must be surfaced for consent too — not just AWS grants.
 */
function capabilityDiff(
  installed: ExtensionManifest,
  next: ExtensionManifest,
): { capabilitiesAdded: string[]; capabilitiesRemoved: string[] } {
  const before = new Set<string>(installed.capabilities ?? []);
  const after = new Set<string>(next.capabilities ?? []);
  return {
    capabilitiesAdded: [...after].filter((c) => !before.has(c)),
    capabilitiesRemoved: [...before].filter((c) => !after.has(c)),
  };
}

/** Attempts (~18s of waiting at the default cadence) before a stuck rename gives up. */
const MAX_RENAME_ATTEMPTS = 20;
/** Ceiling for the growing backoff between rename attempts. */
const RENAME_RETRY_CAP_MS = 1000;

/**
 * `rename` that absorbs Windows sharing violations. A directory can't move while any
 * process holds a handle inside it — the just-stopped backend can take a moment to fully
 * release its files (its cwd IS the install dir), and antivirus scanners briefly pin
 * freshly-downloaded ones — and both surface as EBUSY/EPERM. Short growing pauses
 * outlast them; anything persistent still throws. (Field bug 2026-08-22: updating a
 * poppy on Windows failed EBUSY at the swap.) `renameFn`/`baseDelayMs` injectable for tests.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  renameFn: (from: string, to: string) => Promise<void> = rename,
  baseDelayMs = 100,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await renameFn(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== "EBUSY" && code !== "EPERM") || attempt >= MAX_RENAME_ATTEMPTS - 1) throw err;
      // Back off fast at first, then settle at a steady poll: the common case clears in
      // milliseconds, but an antivirus scan of a freshly-extracted ~19 MB poppy can hold
      // the files for many seconds. A 2026-08-23 field report on the FIXED build still saw
      // the update "fail, then pick it up after a bit" — recoverable, but only after the
      // user had already been shown a failure, so the window is deliberately generous.
      await new Promise((r) => setTimeout(r, Math.min(baseDelayMs * 2 ** attempt, RENAME_RETRY_CAP_MS)));
    }
  }
}

/**
 * The uniqueness key for a listing's display name: case-insensitive, ignoring
 * everything but letters and digits — so "Mail-Poppy" can't shadow "MailPoppy"
 * (M15: one name per poppy; lookalikes are the actual threat).
 */
function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * M15 name shape: ASCII letters/digits in words joined by SINGLE spaces or
 * hyphens, ending in a capital-P "Poppy", with a brand of the developer's own
 * before it. Enforced here too (not just by the publish-time validator) so a
 * compromised catalog can't render "mail@poppy"-style workarounds or homoglyph
 * lookalikes in the install UI.
 */
function conformingName(name: string): boolean {
  return /^[A-Za-z0-9]+(?:[ -][A-Za-z0-9]+)*$/.test(name) && /Poppy$/.test(name) && nameKey(name) !== "poppy";
}

/** Listing icons render straight into the app's <img src>, so accept ONLY an inline
 * PNG data URI of bounded size — never a URL (no tracking pixels, no mixed loads). */
function validIconDataUri(icon: unknown): icon is string {
  return (
    typeof icon === "string" &&
    icon.length <= 100_000 && // ~73KB of PNG — far above the 128px spec, cheap to render
    /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(icon)
  );
}

/**
 * Validate the published catalog's shape; drop (and warn about) bad entries rather
 * than failing the rest. Duplicate ids or (normalized) names keep only the FIRST
 * entry — defence in depth behind the publish-time validator, so a bad catalog can
 * never render two poppies with one name or two cards with one id.
 */
function parseCatalog(raw: string): DirectoryEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(CATALOG_UNREADABLE);
  }
  const cat = data as { schemaVersion?: unknown; poppies?: unknown };
  if (cat?.schemaVersion !== 1 || !Array.isArray(cat.poppies)) throw new Error(CATALOG_UNREADABLE);
  const entries: DirectoryEntry[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  for (const p of cat.poppies as Array<Record<string, unknown>>) {
    const ok =
      p &&
      typeof p.id === "string" &&
      typeof p.name === "string" &&
      typeof p.version === "string" &&
      typeof p.repo === "string";
    if (!ok) {
      console.warn(`directory: dropped a catalog entry missing id/name/version/repo`);
      continue;
    }
    const entry = p as unknown as DirectoryEntry;
    // Untrusted JSON: only a real `true` exempts a listing, never a truthy string.
    entry.allowUnconfined = p.allowUnconfined === true;
    if (!conformingName(entry.name)) {
      console.warn(`directory: dropped catalog entry "${entry.name}" (${entry.id}) — its name breaks the naming convention`);
      continue;
    }
    if (seenIds.has(entry.id) || seenNames.has(nameKey(entry.name))) {
      console.warn(`directory: dropped duplicate catalog entry "${entry.name}" (${entry.id}) — first listing keeps the name`);
      continue;
    }
    if (entry.icon !== undefined && !validIconDataUri(entry.icon)) {
      // A bad icon shouldn't cost the poppy its listing — strip it and fall back
      // to the monogram (defence in depth: never hand the webview an arbitrary src).
      console.warn(`directory: stripped a non-conforming icon from "${entry.name}" (${entry.id})`);
      delete entry.icon;
    }
    seenIds.add(entry.id);
    seenNames.add(nameKey(entry.name));
    entries.push(entry);
  }
  return entries;
}
