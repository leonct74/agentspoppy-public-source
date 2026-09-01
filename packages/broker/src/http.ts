// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The basic broker API — a thin Node-http router over the service. Bound to
 * 127.0.0.1 only (local-first; no remote surface). Kept dependency-free for
 * auditability. The desktop UI and connecting apps talk to this.
 */
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { AppIdentity, PermissionSet } from "@agentspoppy/core";
import { BrokerError, BrokerService } from "./service";
import type { DirectoryService, ExtensionRegistry } from "./extensions";
import { frontendCsp } from "./extensions";
import { type AuthConfig, bearerToken, resolveCaller } from "./auth";

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : undefined;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

/**
 * Map a bootstrap request body to setup creds, or `undefined` when none were
 * supplied — the signal to reuse the already-connected credentials.
 */
function setupFromBody(
  b: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string } | undefined,
): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined {
  if (!b?.accessKeyId && !b?.secretAccessKey) return undefined;
  return { accessKeyId: b?.accessKeyId ?? "", secretAccessKey: b?.secretAccessKey ?? "", sessionToken: b?.sessionToken };
}

function statusForError(code: BrokerErrorCodeLike): number {
  switch (code) {
    case "not_found":
      return 404;
    case "invalid_state":
      return 409;
    case "bad_request":
      return 400;
    case "account_unreadable":
      return 502; // upstream (AWS) couldn't be read — creds/permissions, not a client error
    case "eviction_required": // needs explicit consent — the UI confirms and retries
    case "not_operator": // wrong standing identity — the UI routes to the key switch
    case "setup_outdated": // deployed template predates the capability — re-apply first
      return 409;
    default:
      return 500;
  }
}

type BrokerErrorCodeLike = BrokerError["code"];

/**
 * Echo the request origin only for *local* origins — the Vite dev server and the
 * Tauri webview. The broker already binds to 127.0.0.1; this stops arbitrary
 * websites' JS from driving a local broker. (This is only a CORS guard for browser
 * callers — per-app caller-authentication is enforced separately by the token gate
 * in {@link handle} + {@link resolveCaller}, since a native poppy backend isn't
 * subject to CORS at all.)
 */
function corsOriginFor(origin: string | undefined): string | null {
  if (!origin) return null;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  if (origin.startsWith("tauri://") || origin === "http://tauri.localhost") return origin;
  return null;
}

/** Route a single request against the service. Exported for testing.
 *
 * `auth` gates the API by caller (see {@link AuthConfig}). Omitting it entirely keeps
 * the pre-auth behaviour (fully open) — used by the many existing unit tests and any
 * embedder that supplies its own front door. The packaged app always passes a real
 * host token (serve.ts), so production is locked down. */
export async function handle(
  service: BrokerService,
  req: IncomingMessage,
  res: ServerResponse,
  registry?: ExtensionRegistry,
  auth?: AuthConfig,
  directory?: DirectoryService,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);

  const allowOrigin = corsOriginFor(req.headers.origin);
  if (allowOrigin) {
    res.setHeader("access-control-allow-origin", allowOrigin);
    res.setHeader("vary", "Origin");
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, authorization");
  }
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ---- Caller authentication (one gate, before any route dispatch) ------------
  // No `auth` supplied → legacy open mode (tests / custom embedders). Otherwise the
  // whole management plane needs the HOST token; only two surfaces are exempt:
  //   • ext-ui / ext-dl — static frontend assets + single-use download tokens,
  //     fetched by the webview / the OS browser, which can't carry a bearer header.
  //   • /connections/:id/credentials — a poppy backend minting its OWN scoped creds,
  //     allowed with a backend token bound to that same connection id (or the host).
  // Everything else (list/revoke/pause/resume/approve/deny/supervise/teardown/forget,
  // accounts, aws, extensions start/stop/backend) is host-only — so one poppy can
  // never enumerate, disable, or tear down another.
  if (auth) {
    const caller = resolveCaller(bearerToken(req.headers.authorization), {
      hostToken: auth.hostToken,
      devOpen: auth.devOpen,
      resolveBackend: (t) => registry?.resolveBackendToken(t) ?? null,
    });
    const isAssetRoute = parts[0] === "ext-ui" || parts[0] === "ext-dl";
    const isCredentialsMint =
      parts[0] === "connections" && parts.length === 3 && parts[2] === "credentials" && method === "POST";
    if (!isAssetRoute) {
      const id = isCredentialsMint ? decodeURIComponent(parts[1] as string) : null;
      const allowed = isCredentialsMint
        ? caller.role === "host" || (caller.role === "backend" && caller.connectionId === id)
        : caller.role === "host";
      if (!allowed) {
        return send(res, 401, {
          error: "unauthorized",
          message: "this route requires the AgentsPoppy host token",
        });
      }
    }
  }

  try {
    // /aws/identity — operator identity + "are my AWS credentials working?"
    if (parts[0] === "aws" && parts[1] === "identity" && parts.length === 2 && method === "GET") {
      return send(res, 200, await service.getAwsIdentity());
    }

    // /aws/setup-status — is the broker role deployed in this account the one this host
    // expects? Read-only; host-only like every other /aws route.
    if (parts[0] === "aws" && parts[1] === "setup-status" && parts.length === 2 && method === "GET") {
      return send(res, 200, await service.getSetupStatus());
    }

    // /aws/key-info — this machine's operator-key id + mint time. Never secrets.
    if (parts[0] === "aws" && parts[1] === "key-info" && parts.length === 2 && method === "GET") {
      return send(res, 200, await service.getOperatorKeyInfo());
    }

    // /aws/revoke-key — the kill switch: delete THIS machine's operator key in AWS,
    // then forget it locally (that order; a failed delete leaves the profile alone).
    if (parts[0] === "aws" && parts[1] === "revoke-key" && parts.length === 2 && method === "POST") {
      return send(res, 200, await service.revokeOperatorKey());
    }

    // /aws/bootstrap — AUTOMATED setup with NO account linked yet (fresh machine):
    // derive + upsert the account from the setup creds. In-memory creds, never persisted.
    if (parts[0] === "aws" && parts[1] === "bootstrap" && parts.length === 2 && method === "POST") {
      const b = (await readJsonBody(req)) as
        | { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string; region?: string }
        | undefined;
      return send(res, 200, await service.deployBootstrap(null, setupFromBody(b), b?.region));
    }

    // /aws/credentials — in-app key entry: save pasted keys, return the resolved identity
    if (parts[0] === "aws" && parts[1] === "credentials" && parts.length === 2 && method === "POST") {
      const b = (await readJsonBody(req)) as
        | { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string }
        | undefined;
      return send(res, 200, await service.setAwsCredentials({
        accessKeyId: b?.accessKeyId ?? "",
        secretAccessKey: b?.secretAccessKey ?? "",
        sessionToken: b?.sessionToken,
      }));
    }

    // /accounts/:id/role-template/download — serve the template as a downloadable file.
    // WKWebView ignores `<a download>`, so the UI opens this loopback URL in the system
    // browser; Content-Disposition makes the browser save it instead of rendering it.
    if (
      parts[0] === "accounts" &&
      parts.length === 4 &&
      parts[2] === "role-template" &&
      parts[3] === "download" &&
      method === "GET"
    ) {
      const { templateJson } = await service.roleTemplate(parts[1] as string);
      res.writeHead(200, {
        "content-type": "application/json",
        "content-disposition": 'attachment; filename="agentspoppy-setup.json"',
      });
      res.end(templateJson);
      return;
    }

    // /accounts/:id/role-template · /accounts/:id/verify · /accounts/:id/role
    if (parts[0] === "accounts" && parts.length === 3) {
      const id = parts[1] as string;
      if (parts[2] === "role-template" && method === "GET") return send(res, 200, await service.roleTemplate(id));
      if (parts[2] === "verify" && method === "POST") return send(res, 200, await service.verifyAccount(id));
      // AUTOMATED setup: deploy the stack on the user's behalf with elevated setup
      // creds (in-memory only, never persisted). Idempotent / resumable.
      if (parts[2] === "bootstrap" && method === "POST") {
        const b = (await readJsonBody(req)) as
          | {
              accessKeyId?: string;
              secretAccessKey?: string;
              sessionToken?: string;
              updateOnly?: boolean;
              /** Step 0: switch this machine onto the operator key before touching the template. */
              keysFirst?: boolean;
              /** Consent to retire the oldest other key at IAM's two-key limit. */
              allowEviction?: boolean;
            }
          | undefined;
        return send(
          res,
          200,
          await service.deployBootstrap(id, setupFromBody(b), undefined, b?.updateOnly === true, {
            keysFirst: b?.keysFirst === true,
            allowEviction: b?.allowEviction === true,
          }),
        );
      }
      if (parts[2] === "role" && method === "POST") {
        const b = (await readJsonBody(req)) as { roleArn?: string } | undefined;
        return send(res, 200, await service.setAccountRoleArn(id, b?.roleArn ?? ""));
      }
      // Re-point the account to a new region, then restart this account's poppy backends so
      // they operate in it (the region is baked into each backend's bootstrap at spawn time).
      if (parts[2] === "region" && method === "POST") {
        const b = (await readJsonBody(req)) as { region?: string } | undefined;
        const updated = await service.setAccountRegion(id, b?.region ?? "");
        if (registry) await registry.restartForAccount(id).catch(() => {});
        return send(res, 200, updated);
      }
    }

    // /accounts/:id — DELETE: forget this account locally (linked the wrong one)
    if (parts[0] === "accounts" && parts.length === 2 && method === "DELETE") {
      return send(res, 200, await service.unlinkAccount(parts[1] as string));
    }

    // /accounts
    if (parts[0] === "accounts" && parts.length === 1) {
      if (method === "GET") return send(res, 200, await service.listAccounts());
      if (method === "POST") {
        const b = (await readJsonBody(req)) as
          | { accountId?: string; alias?: string; regions?: string[]; roleArn?: string }
          | undefined;
        return send(res, 201, await service.linkAccount({
          accountId: b?.accountId ?? "",
          alias: b?.alias,
          regions: b?.regions ?? [],
          roleArn: b?.roleArn,
        }));
      }
    }

    // /activity — recent account activity, attributed (external = outside AgentsPoppy)
    if (parts[0] === "activity" && parts.length === 1 && method === "GET") {
      const sinceMinutes = Number(url.searchParams.get("sinceMinutes")) || undefined;
      const limit = Number(url.searchParams.get("limit")) || undefined;
      return send(res, 200, await service.getActivity({ sinceMinutes, limit }));
    }

    // /approvals — supervised-mode operations awaiting the user's decision
    if (parts[0] === "approvals" && parts.length === 1 && method === "GET") {
      return send(res, 200, await service.listPendingApprovals());
    }
    // /approvals/:id/approve · /approvals/:id/deny
    if (parts[0] === "approvals" && parts.length === 3 && method === "POST") {
      const approvalId = parts[1] as string;
      if (parts[2] === "approve") return send(res, 200, await service.approveApproval(approvalId));
      if (parts[2] === "deny") return send(res, 200, await service.denyApproval(approvalId));
    }

    // /connections
    if (parts[0] === "connections" && parts.length === 1) {
      if (method === "GET") return send(res, 200, await service.listConnections());
      if (method === "POST") {
        const b = (await readJsonBody(req)) as
          | { accountId?: string; app?: AppIdentity; permissionSet?: PermissionSet }
          | undefined;
        return send(res, 201, await service.requestConnection({
          accountId: b?.accountId ?? "",
          app: b?.app as AppIdentity,
          permissionSet: b?.permissionSet as PermissionSet,
        }));
      }
    }

    // /connections/:id  and  /connections/:id/:action
    if (parts[0] === "connections" && parts.length >= 2) {
      const id = parts[1] as string;
      const action = parts[2];

      if (!action) {
        if (method === "GET") return send(res, 200, await service.getConnection(id));
        if (method === "DELETE") return send(res, 200, await service.revoke(id));
      } else if (action === "activity" && method === "GET") {
        // The observed register: what this poppy has actually done (CloudTrail, app-keyed).
        const sinceMinutes = Number(url.searchParams.get("sinceMinutes")) || undefined;
        return send(res, 200, await service.getConnectionActivity(id, { sinceMinutes }));
      } else if (method === "POST") {
        switch (action) {
          case "approve":
            return send(res, 200, await service.approve(id));
          case "deny":
            return send(res, 200, await service.deny(id));
          case "pause":
            // Hard pause: the registry variant also stops the backend + invalidates its
            // credential token, so a paused poppy genuinely halts (no acting on cached
            // creds). Without a registry (headless/tests) the state flip is all there is.
            return send(res, 200, registry ? await registry.pause(id) : await service.pause(id));
          case "resume":
            return send(res, 200, registry ? await registry.resume(id) : await service.resume(id));
          case "supervise": {
            const b = (await readJsonBody(req)) as { supervised?: boolean } | undefined;
            return send(res, 200, await service.setSupervised(id, b?.supervised ?? false));
          }
          case "credentials": {
            // Supervised connections may answer with an approval (202) instead of creds.
            const b = (await readJsonBody(req)) as
              | { operation?: { summary: string; grants: unknown[] }; approvalId?: string }
              | undefined;
            const result = await service.requestCredentials(id, {
              operation: b?.operation as never,
              approvalId: b?.approvalId,
            });
            if (result.kind === "credentials") return send(res, 200, result.credentials);
            return send(res, 202, { approvalRequired: true, approval: result.approval });
          }
          case "teardown":
            // App-specific cleanup of out-of-stack resources FIRST (best-effort), then the
            // host's generic stack delete + tag sweep that verifies nothing was left behind.
            // The service runs the hook inside the teardown window so a supervised poppy can
            // mint its self-scoped cleanup creds without a per-operation approval prompt.
            return send(
              res,
              200,
              await service.teardown(id, registry ? { runHook: (cid) => registry.runTeardownHook(cid) } : {}),
            );
          case "forget":
            // Drop a revoked connection from the list (local record only; no cloud change).
            return send(res, 200, await service.forgetConnection(id));
        }
      } else if (method === "GET") {
        switch (action) {
          case "inventory":
            return send(res, 200, await service.getInventory(id));
          case "infra":
            return send(res, 200, await service.getInfraGraph(id));
          case "audit":
            return send(res, 200, await service.getAudit(id));
        }
      }
    }

    // /directory/catalog — the curated directory, enriched with local install state.
    // Host-only (the auth gate above): the catalog names URLs, and only the host UI
    // may see or act on them.
    if (parts[0] === "directory" && parts[1] === "catalog" && parts.length === 2 && method === "GET") {
      if (!directory) return send(res, 404, { error: "not_found", message: "poppy installs aren't enabled on this broker" });
      return send(res, 200, await directory.getCatalog());
    }
    // /directory/install — download, verify and hot-install a catalog poppy BY ID.
    // Deliberately no URL parameter: the catalog is the only remote source.
    if (parts[0] === "directory" && parts[1] === "install" && parts.length === 2 && method === "POST") {
      if (!directory) return send(res, 404, { error: "not_found", message: "poppy installs aren't enabled on this broker" });
      const b = (await readJsonBody(req)) as { id?: string } | undefined;
      if (!b?.id) return send(res, 400, { error: "bad_request", message: "which poppy should be installed? (missing id)" });
      return send(res, 200, await directory.install(b.id));
    }
    // /directory/update — replace an already-installed poppy with the version the catalog
    // now lists (atomic swap; the approved connection is preserved). Same BY-ID contract.
    if (parts[0] === "directory" && parts[1] === "update" && parts.length === 2 && method === "POST") {
      if (!directory) return send(res, 404, { error: "not_found", message: "poppy installs aren't enabled on this broker" });
      const b = (await readJsonBody(req)) as { id?: string } | undefined;
      if (!b?.id) return send(res, 400, { error: "bad_request", message: "which poppy should be updated? (missing id)" });
      return send(res, 200, await directory.update(b.id));
    }
    // /directory/preview-update — download+verify the new package but DON'T apply it, so the
    // user can audit (repo diff, scope change, verify-with-agent) before consenting.
    if (parts[0] === "directory" && parts[1] === "preview-update" && parts.length === 2 && method === "POST") {
      if (!directory) return send(res, 404, { error: "not_found", message: "poppy installs aren't enabled on this broker" });
      const b = (await readJsonBody(req)) as { id?: string } | undefined;
      if (!b?.id) return send(res, 400, { error: "bad_request", message: "which poppy's update should be previewed? (missing id)" });
      return send(res, 200, await directory.previewUpdate(b.id));
    }
    // /directory/apply-update — the human's consent step: NOW download, verify and install the
    // update the user reviewed (nothing was fetched at preview time). Returns what its scope changed.
    if (parts[0] === "directory" && parts[1] === "apply-update" && parts.length === 2 && method === "POST") {
      if (!directory) return send(res, 404, { error: "not_found", message: "poppy installs aren't enabled on this broker" });
      const b = (await readJsonBody(req)) as { id?: string } | undefined;
      if (!b?.id) return send(res, 400, { error: "bad_request", message: "which poppy should be updated? (missing id)" });
      return send(res, 200, await directory.applyUpdate(b.id));
    }

    // /extensions — installed extensions + their runtime state (container model)
    if (parts[0] === "extensions" && parts.length === 1 && method === "GET") {
      return send(res, 200, registry ? await registry.list() : []);
    }
    // /extensions/:id/start · /extensions/:id/stop
    if (parts[0] === "extensions" && parts.length === 3 && method === "POST") {
      if (!registry) return send(res, 404, { error: "not_found", message: "extensions are not enabled on this broker" });
      const id = parts[1] as string;
      if (parts[2] === "start") {
        const b = (await readJsonBody(req)) as { accountId?: string } | undefined;
        const accountId = b?.accountId ?? (await service.listAccounts())[0]?.id;
        if (!accountId) return send(res, 400, { error: "bad_request", message: "no AWS account linked yet" });
        return send(res, 200, await registry.start(id, accountId));
      }
      if (parts[2] === "stop") {
        await registry.stop(id);
        return send(res, 200, { ok: true });
      }
      // Restart: stop + respawn this extension's backend — the unstick lever. A wedged
      // backend may never have filed its approval request (so no banner ever showed);
      // respawning re-runs its bootstrap, which re-files it. Host-only, like start/stop.
      if (parts[2] === "restart") {
        return send(res, 200, await registry.restart(id));
      }
      // Uninstall: remove the app from THIS computer (files + registration). The
      // cloud footprint and the approved connection are deliberately untouched —
      // deleting infrastructure is the separate teardown act, never a side effect.
      if (parts[2] === "uninstall") {
        if (!directory) return send(res, 404, { error: "not_found", message: "poppy installs aren't enabled on this broker" });
        return send(res, 200, await directory.uninstall(decodeURIComponent(id)));
      }
      // Rung-1 blocklist: refuse to load/run this extension (kills it if running).
      // Host-only (management plane) — enforced by the auth gate above.
      if (parts[2] === "block") {
        await registry.block(id);
        return send(res, 200, { ok: true });
      }
      if (parts[2] === "unblock") {
        await registry.unblock(id);
        return send(res, 200, { ok: true });
      }
      // Proxy a host→backend call (the webview only ever talks to the broker). Returns
      // the backend's status + body verbatim so the caller sees a faithful response.
      if (parts[2] === "backend") {
        const b = (await readJsonBody(req)) as { method?: string; path?: string; body?: unknown } | undefined;
        const out = await registry.proxyBackend(id, { method: b?.method ?? "GET", path: b?.path ?? "/", body: b?.body });
        if (!out) return send(res, 502, { error: "backend_unavailable", message: "extension backend is not running" });
        res.writeHead(out.status, { "content-type": out.contentType });
        res.end(out.body);
        return;
      }
    }

    // /ext-dl/:id/local-download/:token — binary-safe passthrough to an extension
    // backend's ONE-SHOT download endpoint. A poppy's sandboxed iframe can't trigger a
    // native file save, so its backend mints a single-use token and the SYSTEM BROWSER
    // fetches it here (the browser can reach the broker's port, never the backend's).
    // Deliberately restricted to the /local-download prefix: tokens are single-use and
    // short-lived, and no other backend route is reachable this way.
    if (parts[0] === "ext-dl" && parts.length === 4 && parts[2] === "local-download" && method === "GET") {
      if (!registry) return send(res, 404, { error: "not_found", message: "extensions are not enabled on this broker" });
      const id = decodeURIComponent(parts[1] as string);
      const token = decodeURIComponent(parts[3] as string);
      const out = await registry.fetchBackendBytes(id, `/local-download/${encodeURIComponent(token)}`);
      if (!out) return send(res, 502, { error: "backend_unavailable", message: "extension backend is not running" });
      res.writeHead(out.status, {
        "content-type": out.contentType,
        ...(out.contentDisposition ? { "content-disposition": out.contentDisposition } : {}),
      });
      res.end(Buffer.from(out.bytes));
      return;
    }

    // /ext-ui/:id/*  — serve an installed extension's sandboxed frontend assets, so the
    // host can point its iframe tab at them. Read-only; path-traversal-guarded in the registry.
    if (parts[0] === "ext-ui" && parts.length >= 2 && method === "GET") {
      if (!registry) return send(res, 404, { error: "not_found", message: "extensions are not enabled on this broker" });
      const id = decodeURIComponent(parts[1] as string);
      const rel = parts.slice(2).map(decodeURIComponent).join("/") || "index.html";
      const asset = await registry.readFrontendAsset(id, rel);
      if (!asset) return send(res, 404, { error: "not_found", message: `no frontend asset "${rel}" for ${id}` });
      // The machine gate's frontend half (docs/specs/machine-gate.md): a declared
      // manifest's network egress, compiled to a CSP the webview engine enforces.
      // Null for undeclared manifests — observe mode never breaks an older poppy.
      const csp = frontendCsp(registry.get(id)?.manifest.permissionSet?.network);
      res.writeHead(200, {
        "content-type": asset.contentType,
        ...(csp ? { "content-security-policy": csp } : {}),
      });
      res.end(asset.bytes);
      return;
    }

    send(res, 404, { error: "not_found", message: `no route for ${method} ${url.pathname}` });
  } catch (err) {
    if (err instanceof BrokerError) return send(res, statusForError(err.code), { error: err.code, message: err.message });
    if (err instanceof SyntaxError) return send(res, 400, { error: "bad_request", message: "invalid JSON body" });
    send(res, 500, { error: "internal", message: (err as Error).message });
  }
}

export function createServer(
  service: BrokerService,
  registry?: ExtensionRegistry,
  auth?: AuthConfig,
  directory?: DirectoryService,
): Server {
  return createHttpServer((req, res) => {
    void handle(service, req, res, registry, auth, directory);
  });
}

/** Start the broker on 127.0.0.1 (local-first). Returns the server + bound port. */
export async function listen(
  service: BrokerService,
  port = 0,
  registry?: ExtensionRegistry,
  auth?: AuthConfig,
  directory?: DirectoryService,
): Promise<{ server: Server; port: number }> {
  const server = createServer(service, registry, auth, directory);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); // surface EADDRINUSE etc. as a rejection, not an uncaught event
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return { server, port: (server.address() as AddressInfo).port };
}
