// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { TAGGED_AS_SELF } from "@agentspoppy/core";
import type { ExtensionManifest } from "@agentspoppy/extension-sdk";
import { Store } from "../store";
import { BrokerService } from "../service";
import { StubActivityProvider, StubCloudProvider, StubCredentialVendor } from "../providers";
import { StubAwsBootstrap } from "../aws";
import { ExtensionRegistry, grantsSignature } from "./registry";
import { StubBackendHost } from "./backend-host";

function service(): BrokerService {
  return new BrokerService({
    store: new Store(),
    credentials: new StubCredentialVendor(),
    cloud: new StubCloudProvider(),
    aws: new StubAwsBootstrap(),
    activity: new StubActivityProvider(),
  });
}

function manifest(overrides: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    id: "com.mailpoppy.desktop",
    name: "MailPoppy",
    version: "1.0.0",
    permissionSet: {
      id: "mailpoppy-backend",
      name: "MailPoppy backend",
      description: "",
      grants: [{ service: "s3", actions: ["CreateBucket"], resourceScope: "arn:aws:s3:::mailpoppy*" }],
      requiredTags: ["agentspoppy:connection"],
      limits: null,
    },
    frontend: { entry: "ui/index.html" },
    capabilities: ["aws:credentials", "connection:read"],
    ...overrides,
  };
}

describe("grantsSignature", () => {
  it("is stable across action order but changes with scope", () => {
    const a = grantsSignature([{ service: "s3", actions: ["Put", "Get"], resourceScope: "*" }]);
    const reordered = grantsSignature([{ service: "s3", actions: ["Get", "Put"], resourceScope: "*" }]);
    const rescoped = grantsSignature([{ service: "s3", actions: ["Put", "Get"], resourceScope: "arn:x" }]);
    expect(a).toBe(reordered);
    expect(a).not.toBe(rescoped);
  });

  it("ignores a grant's `reason` — consent is about capability, not about prose", () => {
    // Load-bearing in both directions. If `reason` were in the signature, every poppy adding
    // one (now required on unconfined grants, AGENTS.md §3) would supersede its connection and
    // drag the whole fleet's users through a fresh approval for a documentation change. And a
    // reason must never be able to BUY consent either: the text is the developer's claim, the
    // scope beside it is what the user is actually approving.
    const bare = [{ service: "s3", actions: ["Get"], resourceScope: "*" }];
    const explained = [{ service: "s3", actions: ["Get"], resourceScope: "*", reason: "why it must be wide" }];
    const reworded = [{ service: "s3", actions: ["Get"], resourceScope: "*", reason: "a completely different claim" }];
    expect(grantsSignature(explained)).toBe(grantsSignature(bare));
    expect(grantsSignature(reworded)).toBe(grantsSignature(explained));
  });
});

describe("ExtensionRegistry.reconcile", () => {
  let home: string;
  beforeEach(() => {
    home = join(tmpdir(), `agentspoppy-reg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.AGENTSPOPPY_HOME = home;
    process.env.AGENTSPOPPY_LEDGER = join(home, "ledger.json");
  });
  afterEach(async () => {
    delete process.env.AGENTSPOPPY_HOME;
    delete process.env.AGENTSPOPPY_LEDGER;
    await fs.rm(home, { recursive: true, force: true });
  });

  async function linked(): Promise<{ s: BrokerService; reg: ExtensionRegistry; accountId: string }> {
    const s = service();
    const account = await s.linkAccount({ accountId: "123456789012", regions: ["eu-west-1"] });
    return { s, reg: new ExtensionRegistry(s), accountId: account.id };
  }

  it("creates a pending connection from the manifest when none exists", async () => {
    const { s, reg, accountId } = await linked();
    const conn = await reg.reconcile(manifest(), accountId);

    expect(conn.status).toBe("pending");
    expect(conn.app.id).toBe("com.mailpoppy.desktop");
    expect(conn.permissionSet.grants).toHaveLength(1);
    expect(await s.listConnections()).toHaveLength(1);
  });

  it("reuses the existing connection when the manifest scope is unchanged", async () => {
    const { s, reg, accountId } = await linked();
    const first = await reg.reconcile(manifest(), accountId);
    const again = await reg.reconcile(manifest(), accountId);

    expect(again.id).toBe(first.id);
    // No duplicate, and the original wasn't revoked.
    expect(await s.listConnections()).toHaveLength(1);
  });

  it("supersedes the connection when the declared scope changes", async () => {
    const { s, reg, accountId } = await linked();
    const first = await reg.reconcile(manifest(), accountId);

    // A new grant (mailpoppy adding the apigateway /tags scope, say) → drift.
    const widened = manifest({
      permissionSet: {
        ...manifest().permissionSet,
        grants: [
          { service: "s3", actions: ["CreateBucket"], resourceScope: "arn:aws:s3:::mailpoppy*" },
          { service: "apigateway", actions: ["POST"], resourceScope: "arn:aws:apigateway:*::/tags*" },
        ],
      },
    });
    const next = await reg.reconcile(widened, accountId);

    expect(next.id).not.toBe(first.id);
    expect(next.status).toBe("pending");
    expect(next.permissionSet.grants).toHaveLength(2);

    const all = await s.listConnections();
    expect(all.find((c) => c.id === first.id)?.status).toBe("revoked");
    // Exactly one live (non-revoked) connection for the app.
    expect(all.filter((c) => c.status !== "revoked")).toHaveLength(1);
  });

  it("carries TAGGED_AS_SELF grants through unchanged", async () => {
    const { reg, accountId } = await linked();
    const conn = await reg.reconcile(
      manifest({
        permissionSet: {
          ...manifest().permissionSet,
          grants: [{ service: "cognito-idp", actions: ["DeleteUserPool"], resourceScope: TAGGED_AS_SELF }],
        },
      }),
      accountId,
    );
    expect(conn.permissionSet.grants[0]?.resourceScope).toBe(TAGGED_AS_SELF);
  });
});

describe("ExtensionRegistry lifecycle (start/stop)", () => {
  let home: string;
  beforeEach(() => {
    home = join(tmpdir(), `agentspoppy-reg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.AGENTSPOPPY_HOME = home;
    process.env.AGENTSPOPPY_LEDGER = join(home, "ledger.json");
  });
  afterEach(async () => {
    delete process.env.AGENTSPOPPY_HOME;
    delete process.env.AGENTSPOPPY_LEDGER;
    await fs.rm(home, { recursive: true, force: true });
  });

  async function setup(m: ExtensionManifest = manifest({ backend: { entry: "bin/backend", transport: "http" } })) {
    const s = service();
    const account = await s.linkAccount({ accountId: "123456789012", regions: ["eu-west-1"] });
    const host = new StubBackendHost();
    const reg = new ExtensionRegistry(s, { backendHost: host, brokerBaseUrl: "http://127.0.0.1:8799", allocatePort: async () => 41234 });
    reg.install({ manifest: m, root: "/opt/ext/mailpoppy" });
    return { s, reg, host, accountId: account.id, manifest: m };
  }

  it("does NOT spawn the backend while the connection is only pending", async () => {
    const { reg, host, accountId } = await setup();
    const state = await reg.start("com.mailpoppy.desktop", accountId);
    expect(state.backend).toBe("awaiting-approval");
    expect(state.connectionStatus).toBe("pending");
    expect(host.started).toHaveLength(0);
  });

  it("spawns the backend once approved, injecting the bootstrap, and is idempotent", async () => {
    const { s, reg, host, accountId } = await setup();
    const first = await reg.start("com.mailpoppy.desktop", accountId);
    await s.approve(first.connectionId!);

    const running = await reg.start("com.mailpoppy.desktop", accountId);
    expect(running.backend).toBe("running");
    expect(running.port).toBe(41234);
    expect(host.started).toHaveLength(1);

    const boot = host.started[0]!.bootstrap;
    expect(boot.connectionId).toBe(first.connectionId);
    expect(boot.port).toBe(41234);
    expect(boot.credentialsUrl).toBe(`http://127.0.0.1:8799/connections/${first.connectionId}/credentials`);
    expect(boot.account).toEqual({ accountId: "123456789012", region: "eu-west-1" });
    // The stub setup reports the CURRENT template version (≥3, boundary present), so the
    // bootstrap carries the boundary ARN for the poppy's CFN PermissionsBoundaryArn
    // parameter (docs/specs/broker-role-v2.md, step 2).
    expect(boot.permissionsBoundaryArn).toBe("arn:aws:iam::123456789012:policy/AgentsPoppyBoundary");

    // Starting again doesn't double-spawn.
    await reg.start("com.mailpoppy.desktop", accountId);
    expect(host.started).toHaveLength(1);
  });

  it("mints a credential token bound to this poppy's connection, and revokes it on stop", async () => {
    const { s, reg, host, accountId } = await setup();
    const first = await reg.start("com.mailpoppy.desktop", accountId);
    await s.approve(first.connectionId!);
    await reg.start("com.mailpoppy.desktop", accountId);

    const token = host.started[0]!.bootstrap.credentialsToken!;
    expect(typeof token).toBe("string");
    // The token resolves ONLY to its own connection — that's what scopes a poppy to
    // minting its own creds and nothing else.
    expect(reg.resolveBackendToken(token)).toBe(first.connectionId);
    expect(reg.resolveBackendToken("some-other-token")).toBeNull();

    // Stopping (disable/revoke) invalidates the token immediately.
    await reg.stop("com.mailpoppy.desktop");
    expect(reg.resolveBackendToken(token)).toBeNull();
  });

  it("omits the boundary ARN when the deployed setup predates it — the poppy must deploy unbounded", async () => {
    // A CreateRole naming a PermissionsBoundary policy the account doesn't have is refused
    // by IAM, so uncertainty or a pre-boundary setup (< v3) means NO claim, not a guess
    // (docs/specs/broker-role-v2.md step 2 — the fragility the CfnParameter design removes).
    const s = service();
    // Pre-boundary account: the setup reads as version 2.
    (s as unknown as { aws: { readSetupVersion: () => Promise<unknown> } }).aws.readSetupVersion = async () => ({
      state: "outdated",
      deployed: 2,
      expected: 4,
    });
    const account = await s.linkAccount({ accountId: "123456789012", regions: ["eu-west-1"] });
    const host = new StubBackendHost();
    const reg = new ExtensionRegistry(s, {
      backendHost: host,
      brokerBaseUrl: "http://127.0.0.1:8799",
      allocatePort: async () => 41234,
    });
    const m = manifest({ backend: { entry: "bin/backend", transport: "http" } });
    reg.install({ manifest: m, root: "/opt/ext/mailpoppy" });
    const first = await reg.start("com.mailpoppy.desktop", account.id);
    await s.approve(first.connectionId!);
    await reg.start("com.mailpoppy.desktop", account.id);
    expect(host.started[0]!.bootstrap.permissionsBoundaryArn).toBeUndefined();
  });

  it("omits the boundary ARN when the setup status is unreadable — never a guess", async () => {
    const s = service();
    (s as unknown as { aws: { readSetupVersion: () => Promise<unknown> } }).aws.readSetupVersion = async () => {
      throw new Error("throttled");
    };
    const account = await s.linkAccount({ accountId: "123456789012", regions: ["eu-west-1"] });
    const host = new StubBackendHost();
    const reg = new ExtensionRegistry(s, {
      backendHost: host,
      brokerBaseUrl: "http://127.0.0.1:8799",
      allocatePort: async () => 41234,
    });
    const m = manifest({ backend: { entry: "bin/backend", transport: "http" } });
    reg.install({ manifest: m, root: "/opt/ext/mailpoppy" });
    const first = await reg.start("com.mailpoppy.desktop", account.id);
    await s.approve(first.connectionId!);
    await reg.start("com.mailpoppy.desktop", account.id);
    expect(host.started[0]!.bootstrap.permissionsBoundaryArn).toBeUndefined();
  });

  it("omits the boundary ARN for a SECOND account — the setup status only describes the first", async () => {
    // getSetupStatus() reads listAccounts()[0]. Claiming a boundary for any other account
    // on that basis would hand a poppy an ARN its own account may not have, and IAM refuses
    // CreateRole against a boundary that doesn't exist — breaking the deploy this field is
    // supposed to protect.
    const s = service();
    await s.linkAccount({ accountId: "123456789012", regions: ["eu-west-1"] });
    const second = await s.linkAccount({ accountId: "111122223333", regions: ["eu-west-1"] });
    const host = new StubBackendHost();
    const reg = new ExtensionRegistry(s, {
      backendHost: host,
      brokerBaseUrl: "http://127.0.0.1:8799",
      allocatePort: async () => 41234,
    });
    const m = manifest({ backend: { entry: "bin/backend", transport: "http" } });
    reg.install({ manifest: m, root: "/opt/ext/mailpoppy" });
    const first = await reg.start("com.mailpoppy.desktop", second.id);
    await s.approve(first.connectionId!);
    await reg.start("com.mailpoppy.desktop", second.id);
    expect(host.started[0]!.bootstrap.account.accountId).toBe("111122223333");
    expect(host.started[0]!.bootstrap.permissionsBoundaryArn).toBeUndefined();
  });

  it("pause() stops the backend + invalidates its token and list() shows 'paused'; resume() respawns", async () => {
    const { s, reg, host, accountId } = await setup();
    const first = await reg.start("com.mailpoppy.desktop", accountId);
    await s.approve(first.connectionId!);
    await reg.start("com.mailpoppy.desktop", accountId);
    const token = host.started[0]!.bootstrap.credentialsToken!;
    expect((await reg.list())[0]?.backend).toBe("running");

    // Hard pause: the backend is stopped (can't act on cached creds) and its token is dead,
    // but the connection is paused (not revoked/blocked) — a distinct, reversible state.
    const paused = await reg.pause(first.connectionId!);
    expect(paused.status).toBe("paused");
    expect((await reg.list())[0]?.backend).toBe("paused");
    expect(reg.resolveBackendToken(token)).toBeNull();

    // Resume: back to active, backend respawned.
    const resumed = await reg.resume(first.connectionId!);
    expect(resumed.status).toBe("active");
    expect((await reg.list())[0]?.backend).toBe("running");
  });

  it("list() surfaces a revoked poppy as 'revoked', not a misleading 'awaiting-approval'", async () => {
    const { s, reg, accountId } = await setup();
    const first = await reg.start("com.mailpoppy.desktop", accountId);
    await s.approve(first.connectionId!);
    await reg.start("com.mailpoppy.desktop", accountId);
    await s.revoke(first.connectionId!);

    const state = (await reg.list())[0];
    expect(state?.backend).toBe("revoked");
    expect(state?.connectionStatus).toBe("revoked");
  });

  it("block() stops a running backend, refuses restart, and list() shows 'blocked'; unblock() restores", async () => {
    const { s, reg, accountId } = await setup();
    const first = await reg.start("com.mailpoppy.desktop", accountId);
    await s.approve(first.connectionId!);
    expect((await reg.start("com.mailpoppy.desktop", accountId)).backend).toBe("running");

    // Block: the backend is stopped and can't come back (start short-circuits).
    await reg.block("com.mailpoppy.desktop");
    expect((await reg.list())[0]?.backend).toBe("blocked");
    expect((await reg.start("com.mailpoppy.desktop", accountId)).backend).toBe("blocked");
    expect(await s.listBlockedExtensions()).toEqual(["com.mailpoppy.desktop"]);

    // Unblock: it can start again.
    await reg.unblock("com.mailpoppy.desktop");
    expect((await reg.start("com.mailpoppy.desktop", accountId)).backend).toBe("running");
  });

  it("restart() respawns a running backend with a fresh token, resolving the account itself", async () => {
    const { s, reg, host, accountId } = await setup();
    const first = await reg.start("com.mailpoppy.desktop", accountId);
    await s.approve(first.connectionId!);
    await reg.start("com.mailpoppy.desktop", accountId);
    const oldToken = host.started[0]!.bootstrap.credentialsToken!;

    // No accountId passed — restart resolves it from the extension's own connection.
    const state = await reg.restart("com.mailpoppy.desktop");
    expect(state.backend).toBe("running");
    // A genuine stop→start cycle, not the idempotent short-circuit: a second spawn happened…
    expect(host.started).toHaveLength(2);
    // …the wedged process's token is dead, and the new one is live.
    expect(reg.resolveBackendToken(oldToken)).toBeNull();
    expect(reg.resolveBackendToken(host.started[1]!.bootstrap.credentialsToken!)).toBe(first.connectionId);
  });

  it("restart() also brings up a backend that was never running (the stuck-at-enable case)", async () => {
    const { s, reg, host, accountId } = await setup();
    const first = await reg.start("com.mailpoppy.desktop", accountId);
    await s.approve(first.connectionId!);
    // Approved but never spawned — e.g. the original start was interrupted.
    expect(host.started).toHaveLength(0);
    const state = await reg.restart("com.mailpoppy.desktop");
    expect(state.backend).toBe("running");
    expect(host.started).toHaveLength(1);
  });

  it("stop() halts the backend and list() reflects it", async () => {
    const { s, reg, accountId } = await setup();
    const first = await reg.start("com.mailpoppy.desktop", accountId);
    await s.approve(first.connectionId!);
    await reg.start("com.mailpoppy.desktop", accountId);

    expect((await reg.list())[0]?.backend).toBe("running");
    await reg.stop("com.mailpoppy.desktop");
    expect((await reg.list())[0]?.backend).toBe("stopped");
  });

  it("a frontend-only extension (no backend) never spawns", async () => {
    const frontendOnly = manifest(); // no backend in the base manifest
    const { reg, host, accountId, s } = await setup(frontendOnly);
    const first = await reg.start("com.mailpoppy.desktop", accountId);
    await s.approve(first.connectionId!);
    const state = await reg.start("com.mailpoppy.desktop", accountId);
    expect(state.backend).toBe("none");
    expect(host.started).toHaveLength(0);
  });

  it("proxyBackend forwards to the running backend and returns its status + body; null when stopped", async () => {
    // A stand-in backend on a real loopback port (StubBackendHost hands back this port).
    const seen: Array<{ method?: string; url?: string; body: string }> = [];
    const srv = http.createServer((rq, rs) => {
      let body = "";
      rq.on("data", (c) => (body += c));
      rq.on("end", () => {
        seen.push({ method: rq.method, url: rq.url, body });
        rs.writeHead(rq.url === "/boom" ? 500 : 200, { "content-type": "application/json" });
        rs.end(JSON.stringify(rq.url === "/boom" ? { error: "no" } : { ok: true }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as import("node:net").AddressInfo).port;

    const s = service();
    const account = await s.linkAccount({ accountId: "123456789012", regions: ["eu-west-1"] });
    const reg = new ExtensionRegistry(s, { backendHost: new StubBackendHost(), allocatePort: async () => port });
    reg.install({ manifest: manifest({ backend: { entry: "bin/backend", transport: "http" } }), root: "/opt/ext/mailpoppy" });

    const first = await reg.start("com.mailpoppy.desktop", account.id);
    await s.approve(first.connectionId!);
    await reg.start("com.mailpoppy.desktop", account.id); // spawn (stub) → running, port set

    const ok = await reg.proxyBackend("com.mailpoppy.desktop", { method: "POST", path: "/deploy", body: { d: 1 } });
    expect(ok).toMatchObject({ status: 200 });
    expect(ok!.body).toContain("ok");
    expect(seen[0]).toMatchObject({ method: "POST", url: "/deploy" });
    expect(JSON.parse(seen[0]!.body)).toEqual({ d: 1 });

    const err = await reg.proxyBackend("com.mailpoppy.desktop", { method: "GET", path: "/boom" });
    expect(err?.status).toBe(500);

    await reg.stop("com.mailpoppy.desktop");
    expect(await reg.proxyBackend("com.mailpoppy.desktop", { method: "GET", path: "/x" })).toBeNull();

    await new Promise<void>((r) => srv.close(() => r()));
  });
});

describe("ExtensionRegistry frontend serving", () => {
  let root: string;
  beforeEach(async () => {
    root = join(tmpdir(), `agentspoppy-fe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(join(root, "ui", "assets"), { recursive: true });
    await fs.writeFile(join(root, "ui", "index.html"), "<!doctype html><title>MailPoppy</title>");
    await fs.writeFile(join(root, "ui", "assets", "app.js"), "console.log('hi')");
    await fs.writeFile(join(root, "secret.txt"), "do not serve me");
  });
  afterEach(async () => fs.rm(root, { recursive: true, force: true }));

  function reg(): ExtensionRegistry {
    const r = new ExtensionRegistry(service(), { backendHost: new StubBackendHost(), brokerBaseUrl: "http://127.0.0.1:8799" });
    r.install({ manifest: manifest({ frontend: { entry: "ui/index.html" } }), root });
    return r;
  }

  it("iconUrl is served only for a declared icon that exists inside the frontend dir", async () => {
    await fs.writeFile(join(root, "ui", "assets", "icon.png"), "png");
    const mk = (icon: string) => {
      const r = new ExtensionRegistry(service(), { backendHost: new StubBackendHost(), brokerBaseUrl: "http://127.0.0.1:8799" });
      r.install({ manifest: manifest({ icon }), root });
      return r;
    };
    expect((await mk("ui/assets/icon.png").list())[0]?.iconUrl).toBe(
      "http://127.0.0.1:8799/ext-ui/com.mailpoppy.desktop/assets/icon.png",
    );
    // A dangling icon path (MailPoppy v0.1.0 shipped one) → no iconUrl, never a broken <img>.
    expect((await mk("ui/missing.svg").list())[0]?.iconUrl).toBeUndefined();
    // A file OUTSIDE the served frontend dir stays unexposed (containment).
    expect((await mk("secret.txt").list())[0]?.iconUrl).toBeUndefined();
    expect((await mk("../secret.txt").list())[0]?.iconUrl).toBeUndefined();
  });

  it("frontendUrl is set in list() only when the entry file exists on disk", async () => {
    const present = (await reg().list())[0];
    expect(present?.frontendUrl).toBe("http://127.0.0.1:8799/ext-ui/com.mailpoppy.desktop/index.html");

    // A manifest whose entry doesn't exist → no frontendUrl (no broken iframe).
    const missing = new ExtensionRegistry(service(), { brokerBaseUrl: "http://127.0.0.1:8799" });
    missing.install({ manifest: manifest(), root: "/opt/does/not/exist" });
    expect((await missing.list())[0]?.frontendUrl).toBeUndefined();
  });

  it("serves index.html and nested assets with the right content-type", async () => {
    const r = reg();
    const html = await r.readFrontendAsset("com.mailpoppy.desktop", "index.html");
    expect(html?.contentType).toBe("text/html; charset=utf-8");
    expect(html?.bytes.toString()).toContain("MailPoppy");
    const js = await r.readFrontendAsset("com.mailpoppy.desktop", "assets/app.js");
    expect(js?.contentType).toBe("text/javascript; charset=utf-8");
  });

  it("refuses path traversal out of the frontend dir, and 404s the missing", async () => {
    const r = reg();
    expect(await r.readFrontendAsset("com.mailpoppy.desktop", "../secret.txt")).toBeNull();
    expect(await r.readFrontendAsset("com.mailpoppy.desktop", "../../etc/hosts")).toBeNull();
    expect(await r.readFrontendAsset("com.mailpoppy.desktop", "nope.js")).toBeNull();
    expect(await r.readFrontendAsset("unknown.ext", "index.html")).toBeNull();
  });
});
