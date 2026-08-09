// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The extension registry — the host's bridge between an extension's declared
 * manifest and a broker {@link Connection}.
 *
 * In the container model the **manifest is the single source of truth** for what an
 * extension is allowed to do. So when an extension is loaded/enabled, the host
 * *reconciles* its connection to the manifest: create one if none exists, reuse it
 * if its scope still matches, or **supersede** it (revoke + recreate, re-approved by
 * the user) if the declared scope has changed. This kills, centrally, the drift that
 * plagued the two-app model — where a connection kept whatever scope it was first
 * given and a shipped grant fix never reached it (each poppy had to special-case the
 * supersede itself; now the host owns it).
 *
 * Pure of any spawn/IO: it composes the existing {@link BrokerService} only. Backend
 * process lifecycle is a separate seam (a later phase) so this stays unit-testable.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import type { Connection, ConnectionStatus, PermissionGrant } from "@agentspoppy/core";
import type { BackendBootstrap, Capability, ExtensionManifest } from "@agentspoppy/extension-sdk";
import type { BrokerService } from "../service";
import { generateToken } from "../auth";
import { type BackendHost, type BackendProcess, NodeBackendHost } from "./backend-host";

/**
 * A canonical signature of a permission set's grants, for detecting whether a
 * manifest's declared scope differs from a stored connection's. Per grant we take
 * `[service, sorted actions, resourceScope]`; actions are sorted so mere ordering
 * isn't a change, but grant order — and any added/removed grant — still is.
 */
export function grantsSignature(grants: readonly PermissionGrant[]): string {
  return JSON.stringify(
    grants.map((g) => [g.service, [...g.actions].sort(), g.resourceScope]),
  );
}

/** An extension the host has installed (its manifest + where its files live). */
export interface InstalledExtension {
  manifest: ExtensionManifest;
  /** Absolute path to the extension's root (where `manifest.backend.entry` resolves). */
  root: string;
}

/** Whether (and why) an extension's backend is running. */
export type BackendState = "running" | "stopped" | "awaiting-approval" | "none" | "blocked" | "paused" | "revoked";

/** The host-facing runtime status of one installed extension. */
export interface ExtensionRuntimeState {
  extensionId: string;
  /** The manifest's display name — the UI's fallback before a connection exists. */
  name: string;
  connectionId?: string;
  connectionStatus?: ConnectionStatus;
  /** "none" = a frontend-only extension; "awaiting-approval" = connection not yet active. */
  backend: BackendState;
  port?: number;
  /** The host-bridge capabilities the manifest declares — the gate for its frontend's calls. */
  capabilities: Capability[];
  /** Loopback URL the host serves this extension's installed frontend from (when present). */
  frontendUrl?: string;
  /** Loopback URL of the poppy's app icon (when its manifest declares one that exists). */
  iconUrl?: string;
}

/** Minimal content-type map for the static frontend assets the host serves. */
const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  wasm: "application/wasm",
};

function contentTypeFor(file: string): string {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export interface ExtensionRegistryOptions {
  /** How backends are launched (defaults to the real {@link NodeBackendHost}). */
  backendHost?: BackendHost;
  /** Base URL the backend mints scoped credentials against (the broker's own address). */
  brokerBaseUrl?: string;
  /** Allocate a free loopback port for an "http" backend (defaults to an OS-assigned one). */
  allocatePort?: () => Promise<number>;
}

export class ExtensionRegistry {
  private readonly backendHost: BackendHost;
  private readonly brokerBaseUrl: string;
  private readonly allocatePort: () => Promise<number>;
  private readonly installed = new Map<string, InstalledExtension>();
  private readonly running = new Map<string, BackendProcess>();
  // Per-backend credential tokens: token → connection id it may mint creds for, plus
  // the reverse (extension id → its current token) so a stop/respawn revokes the old
  // one. A poppy is handed its token in the bootstrap and presents it to mint ONLY
  // its own connection's credentials — never a sibling's.
  private readonly backendTokens = new Map<string, string>();
  private readonly tokenByExtension = new Map<string, string>();

  constructor(
    private readonly service: BrokerService,
    opts: ExtensionRegistryOptions = {},
  ) {
    this.backendHost = opts.backendHost ?? new NodeBackendHost();
    this.brokerBaseUrl = opts.brokerBaseUrl ?? "http://127.0.0.1:8799";
    this.allocatePort = opts.allocatePort ?? freePort;
  }

  /** Register an installed extension (idempotent; keyed by manifest id). */
  install(extension: InstalledExtension): void {
    this.installed.set(extension.manifest.id, extension);
  }

  /** Whether an extension with this id is registered on this host. */
  has(extensionId: string): boolean {
    return this.installed.has(extensionId);
  }

  /** The installed extension for this id (its manifest + where its files live), if any. */
  get(extensionId: string): InstalledExtension | undefined {
    return this.installed.get(extensionId);
  }

  /**
   * Remove an extension from the registry: stop its backend (which also revokes
   * its credential token), then forget it. Deliberately does NOT touch the files
   * on disk or the connection — the caller owns those decisions (the directory's
   * uninstall removes the files; the connection stays approved so a reinstall
   * reconnects without re-asking).
   */
  async remove(extensionId: string): Promise<void> {
    await this.stop(extensionId);
    this.installed.delete(extensionId);
  }

  /**
   * The loopback URL the host serves this extension's frontend from — but only when
   * the built entry file actually exists on disk (so the app shows a real tab, never a
   * broken iframe). Served by {@link readFrontendAsset} via the broker's /ext-ui route.
   */
  private frontendUrlFor(manifest: ExtensionManifest, root: string): string | undefined {
    const entry = manifest.frontend?.entry;
    if (!entry || !existsSync(resolve(root, entry))) return undefined;
    return `${this.brokerBaseUrl}/ext-ui/${encodeURIComponent(manifest.id)}/${basename(entry)}`;
  }

  /**
   * The loopback URL the host serves this extension's app icon from — but only when
   * the manifest declares one that actually exists INSIDE the frontend dir (the only
   * place the host serves static assets from, via /ext-ui). Unlike the manifest's
   * package-relative `icon` path, this is directly renderable in an <img>.
   */
  private iconUrlFor(manifest: ExtensionManifest, root: string): string | undefined {
    if (!manifest.icon || !manifest.frontend) return undefined;
    const dir = resolve(root, dirname(manifest.frontend.entry));
    const target = resolve(root, manifest.icon);
    if (!target.startsWith(dir + sep) || !existsSync(target)) return undefined;
    const rel = target.slice(dir.length + 1).split(sep).map(encodeURIComponent).join("/");
    return `${this.brokerBaseUrl}/ext-ui/${encodeURIComponent(manifest.id)}/${rel}`;
  }

  /**
   * Read one static asset of an extension's installed frontend, for the host to serve
   * into the sandboxed iframe. Resolves paths under the frontend dir ONLY (any attempt
   * to escape it returns null), and 404s (null) anything missing or non-file.
   */
  async readFrontendAsset(extensionId: string, relPath: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    const inst = this.installed.get(extensionId);
    if (!inst?.manifest.frontend) return null;
    const dir = resolve(inst.root, dirname(inst.manifest.frontend.entry));
    const target = resolve(dir, relPath);
    // Containment: the resolved path must be the dir itself or strictly inside it.
    if (target !== dir && !target.startsWith(dir + sep)) return null;
    const bytes = await readFile(target).catch(() => null); // EISDIR/ENOENT → null
    return bytes ? { bytes, contentType: contentTypeFor(target) } : null;
  }

  /**
   * Ensure a connection exists for this extension under `accountId`, matching the
   * manifest's declared scope, and return it.
   *
   * - none yet → create a `pending` connection (the user approves it in the host);
   * - exists + scope unchanged → reuse as-is;
   * - exists + scope drifted → revoke the stale one and create a fresh `pending`
   *   connection carrying the new scope (a scope change re-requires consent).
   */
  async reconcile(manifest: ExtensionManifest, accountId: string): Promise<Connection> {
    // The stored iconUrl must be renderable, so normalize the manifest's package-relative
    // path to the served /ext-ui URL (or omit it when the declared file doesn't exist).
    const root = this.installed.get(manifest.id)?.root;
    const iconUrl = root ? this.iconUrlFor(manifest, root) : undefined;
    const app = {
      id: manifest.id,
      name: manifest.name,
      ...(iconUrl ? { iconUrl } : {}),
    };
    const existing = (await this.service.listConnections()).find(
      (c) => c.app.id === manifest.id && c.accountId === accountId && c.status !== "revoked",
    );

    const want = grantsSignature(manifest.permissionSet.grants);
    if (existing && grantsSignature(existing.permissionSet.grants) === want) return existing;
    if (existing) await this.service.revoke(existing.id); // declared scope changed → supersede

    return this.service.requestConnection({ accountId, app, permissionSet: manifest.permissionSet });
  }

  /**
   * Bring an installed extension up: reconcile its connection, then — only if it's
   * `active` and declares a backend — spawn that backend (idempotent). A pending
   * connection yields `awaiting-approval` and spawns nothing; call `start` again
   * after the user approves. The credential never reaches the host or the frontend:
   * the backend mints its own short-lived, scoped creds against the injected
   * `credentialsUrl`.
   */
  async start(extensionId: string, accountId: string): Promise<ExtensionRuntimeState> {
    const inst = this.installed.get(extensionId);
    if (!inst) throw new Error(`extension ${extensionId} is not installed`);

    const conn = await this.reconcile(inst.manifest, accountId);
    const base = {
      extensionId,
      name: inst.manifest.name,
      connectionId: conn.id,
      connectionStatus: conn.status,
      capabilities: inst.manifest.capabilities,
      frontendUrl: this.frontendUrlFor(inst.manifest, inst.root),
      iconUrl: this.iconUrlFor(inst.manifest, inst.root),
    };
    // Rung-1 blocklist: a blocked poppy never spawns its backend, whatever its
    // connection state. (A running one was already killed when it was blocked.)
    if ((await this.service.listBlockedExtensions()).includes(extensionId)) {
      return { ...base, backend: "blocked" };
    }
    if (conn.status !== "active") return { ...base, backend: "awaiting-approval" };
    if (!inst.manifest.backend) return { ...base, backend: "none" };

    const existing = this.running.get(extensionId);
    if (existing?.running) return { ...base, backend: "running", port: existing.port };

    const bootstrap = await this.bootstrapFor(conn, inst.manifest);
    // Register the backend's credential token so it can mint its OWN creds (and
    // only its own). Superseding any previous token for this extension.
    if (bootstrap.credentialsToken) {
      const prev = this.tokenByExtension.get(extensionId);
      if (prev) this.backendTokens.delete(prev);
      this.backendTokens.set(bootstrap.credentialsToken, conn.id);
      this.tokenByExtension.set(extensionId, bootstrap.credentialsToken);
    }
    const proc = await this.backendHost.start({ manifest: inst.manifest, root: inst.root, bootstrap });
    this.running.set(extensionId, proc);
    return { ...base, backend: "running", port: proc.port };
  }

  /**
   * Proxy a host call to an extension's running backend. The webview talks ONLY to the
   * broker (this runs in Node, so no browser CORS / port-allowlist friction the way a
   * direct webview→backend fetch hits); the broker forwards to the spawned backend's
   * loopback port and returns its status + body verbatim. Null when not running.
   */
  async proxyBackend(
    extensionId: string,
    invoke: { method: string; path: string; body?: unknown },
  ): Promise<{ status: number; contentType: string; body: string } | null> {
    const proc = this.running.get(extensionId);
    if (!proc?.running || proc.port === undefined) return null;
    const res = await fetch(`http://127.0.0.1:${proc.port}${invoke.path}`, {
      method: invoke.method,
      headers: invoke.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: invoke.body !== undefined ? JSON.stringify(invoke.body) : undefined,
    });
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      body: await res.text(),
    };
  }

  /**
   * Fetch RAW BYTES from an extension's running backend — the binary-safe sibling of
   * {@link proxyBackend}, whose `res.text()` would mangle file content. Powers the
   * host's `/ext-dl` download passthrough: the backend mints a one-shot download
   * token (e.g. a decrypted attachment the sandboxed iframe can't save natively) and
   * the SYSTEM BROWSER fetches it through the broker, so the backend's loopback port
   * never has to be revealed to the frontend. Null when the backend isn't running.
   */
  async fetchBackendBytes(
    extensionId: string,
    path: string,
  ): Promise<{ status: number; contentType: string; contentDisposition: string | null; bytes: Uint8Array } | null> {
    const proc = this.running.get(extensionId);
    if (!proc?.running || proc.port === undefined) return null;
    const res = await fetch(`http://127.0.0.1:${proc.port}${path}`);
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      contentDisposition: res.headers.get("content-disposition"),
      bytes: new Uint8Array(await res.arrayBuffer()),
    };
  }

  /**
   * Run a poppy's declared teardown hook, if any — best-effort app-specific cleanup of
   * OUT-OF-STACK resources (DNS records, account-level identities) before the host
   * deletes its stack(s). Resolves silently when there's no hook, no matching extension,
   * or the backend can't be started; the host's stack delete + tag sweep run regardless,
   * so a missing/failed hook degrades to a residual report rather than a broken teardown.
   */
  async runTeardownHook(connectionId: string): Promise<void> {
    const conn = (await this.service.listConnections()).find((c) => c.id === connectionId);
    if (!conn) return;
    const inst = this.installed.get(conn.app.id);
    const endpoint = inst?.manifest.teardown?.endpoint;
    if (!inst || !endpoint) return; // no teardown hook declared
    if (!this.running.get(inst.manifest.id)?.running) {
      // Bring the backend up so it can clean up (no-op if the connection isn't active).
      await this.start(inst.manifest.id, conn.accountId).catch(() => {});
    }
    await this.proxyBackend(inst.manifest.id, { method: "POST", path: endpoint }).catch(() => {});
  }

  /**
   * Restart the running backends connected to an account — e.g. after its region changed, so each
   * re-spawns with the new region baked into its bootstrap. Extensions on other accounts, and ones
   * with no running backend, are left alone. Best-effort per extension.
   */
  async restartForAccount(accountId: string): Promise<void> {
    const conns = await this.service.listConnections();
    for (const inst of this.installed.values()) {
      if (!this.running.get(inst.manifest.id)?.running) continue;
      const conn = conns.find((c) => c.app.id === inst.manifest.id && c.status !== "revoked");
      if (!conn || conn.accountId !== accountId) continue;
      await this.stop(inst.manifest.id);
      await this.start(inst.manifest.id, accountId).catch(() => {});
    }
  }

  /**
   * Restart ONE extension's backend (stop → start) — the user-facing unstick lever.
   * A backend can wedge in ways the user can't see or fix (e.g. on a slow machine its
   * credential request never gets filed, so the approval banner never appears and the
   * poppy waits forever). Respawning re-runs its bootstrap, which re-files the request.
   * Unlike {@link restartForAccount} this is NOT best-effort: the user pressed a
   * button, so a failed start must surface, not vanish.
   */
  async restart(extensionId: string): Promise<ExtensionRuntimeState> {
    const conns = await this.service.listConnections();
    const conn = conns.find((c) => c.app.id === extensionId && c.status !== "revoked");
    const accountId = conn?.accountId ?? (await this.service.listAccounts())[0]?.id;
    if (!accountId) throw new Error("no AWS account linked yet");
    await this.stop(extensionId);
    return this.start(extensionId, accountId);
  }

  /** Stop an extension's backend (e.g. on disable/revoke). Idempotent. */
  async stop(extensionId: string): Promise<void> {
    // Invalidate its credential token first, so a stopped/revoked poppy can't keep
    // minting even if its process lingers a moment.
    const token = this.tokenByExtension.get(extensionId);
    if (token) {
      this.backendTokens.delete(token);
      this.tokenByExtension.delete(extensionId);
    }
    const proc = this.running.get(extensionId);
    if (!proc) return;
    await proc.stop();
    this.running.delete(extensionId);
  }

  /** Resolve a backend credential token to the connection id it may mint for (or null). */
  resolveBackendToken(token: string): string | null {
    return this.backendTokens.get(token) ?? null;
  }

  /**
   * Block an extension (rung-1 local ban): persist the block, and immediately kill
   * its backend if running — so a poppy caught misbehaving stops NOW and won't spawn
   * again (start() short-circuits on the blocklist BEFORE spawning; note reconcile()
   * itself still runs and can mint a pending connection, but the backend never starts,
   * so a blocked poppy's teardown hook can't run either). Reversible via unblock.
   */
  async block(extensionId: string): Promise<void> {
    await this.service.blockExtension(extensionId);
    await this.stop(extensionId);
  }

  /** Lift a block so the extension can start again on the next start(). */
  async unblock(extensionId: string): Promise<void> {
    await this.service.unblockExtension(extensionId);
  }

  /**
   * HARD pause: flip the connection to paused AND stop its backend + invalidate its
   * credential token — so it can't keep acting on cached credentials (the whole point
   * of pause). Without stopping the backend, a paused poppy keeps working until its
   * cached STS session expires (~1h). Reversible via {@link resume}, which respawns it.
   */
  async pause(connectionId: string): Promise<Connection> {
    const conn = await this.service.pause(connectionId);
    await this.stop(conn.app.id);
    return conn;
  }

  /** Resume a paused connection: flip it back to active and respawn its backend. */
  async resume(connectionId: string): Promise<Connection> {
    const conn = await this.service.resume(connectionId);
    await this.start(conn.app.id, conn.accountId).catch(() => {});
    return conn;
  }

  /** The runtime state of every installed extension, for the host's sidebar/registry view. */
  async list(): Promise<ExtensionRuntimeState[]> {
    const conns = await this.service.listConnections();
    const blocked = new Set(await this.service.listBlockedExtensions());
    return [...this.installed.values()].map((inst) => {
      // Prefer a LIVE connection; fall back to a revoked one only when that's all there is,
      // so a revoked-but-still-installed poppy reads as "revoked" instead of masquerading as
      // "awaiting approval". (After re-approval the live one is found first, as before.)
      const forApp = conns.filter((c) => c.app.id === inst.manifest.id);
      const conn = forApp.find((c) => c.status !== "revoked") ?? forApp.find((c) => c.status === "revoked");
      const proc = this.running.get(inst.manifest.id);
      const backend: BackendState = blocked.has(inst.manifest.id)
        ? "blocked"
        : !inst.manifest.backend
          ? "none"
          : conn?.status === "paused"
            ? "paused" // hard-paused by the user: backend stopped, distinct from "stopped"
            : conn?.status === "revoked"
              ? "revoked" // access withdrawn; re-approve to bring it back
              : proc?.running
                ? "running"
                : conn?.status === "active"
                  ? "stopped"
                  : "awaiting-approval";
      return {
        extensionId: inst.manifest.id,
        name: inst.manifest.name,
        connectionId: conn?.id,
        connectionStatus: conn?.status,
        backend,
        port: proc?.port,
        capabilities: inst.manifest.capabilities,
        frontendUrl: this.frontendUrlFor(inst.manifest, inst.root),
        iconUrl: this.iconUrlFor(inst.manifest, inst.root),
      };
    });
  }

  private async bootstrapFor(conn: Connection, manifest: ExtensionManifest): Promise<BackendBootstrap> {
    const account = (await this.service.listAccounts()).find((a) => a.id === conn.accountId);
    if (!account) throw new Error(`account ${conn.accountId} not found for extension ${manifest.id}`);
    const port = manifest.backend?.transport === "stdio" ? undefined : await this.allocatePort();
    return {
      connectionId: conn.id,
      credentialsUrl: `${this.brokerBaseUrl}/connections/${encodeURIComponent(conn.id)}/credentials`,
      credentialsToken: generateToken(),
      port,
      account: { accountId: account.accountId, region: account.regions[0] ?? "us-east-1" },
    };
  }
}

/** An OS-assigned free loopback port (the default port allocator for http backends). */
async function freePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}
