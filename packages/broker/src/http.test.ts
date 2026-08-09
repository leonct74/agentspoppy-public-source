// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "./store";
import { BrokerService } from "./service";
import { StubActivityProvider, StubCloudProvider, StubCredentialVendor } from "./providers";
import { StubAwsBootstrap } from "./aws";
import { listen } from "./http";
import { DirectoryService, ExtensionRegistry, StubBackendHost } from "./extensions";
import { ATTRIBUTION_TAG_KEYS, TAGGED_AS_SELF } from "@agentspoppy/core";
import type { ExtensionManifest } from "@agentspoppy/extension-sdk";

async function postJson(url: string, body?: unknown): Promise<Response> {
  return fetch(url, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
}

describe("broker HTTP API", () => {
  let home: string;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    home = join(tmpdir(), `agentspoppy-http-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.AGENTSPOPPY_HOME = home;
    process.env.AGENTSPOPPY_LEDGER = join(home, "ledger.json");
    const svc = new BrokerService({
      store: new Store(),
      credentials: new StubCredentialVendor(),
      cloud: new StubCloudProvider(),
      aws: new StubAwsBootstrap(),
      activity: new StubActivityProvider(),
    });
    const started = await listen(svc, 0);
    server = started.server;
    base = `http://127.0.0.1:${started.port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    delete process.env.AGENTSPOPPY_HOME;
    delete process.env.AGENTSPOPPY_LEDGER;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("drives a connection through the API", async () => {
    const acc = await (await postJson(`${base}/accounts`, { accountId: "123456789012", regions: ["eu-west-1"] })).json();
    expect(acc.id).toBeTruthy();

    const conn = await (await postJson(`${base}/connections`, {
      accountId: acc.id,
      app: { id: "com.mailpoppy.desktop", name: "MailPoppy" },
      permissionSet: {
        id: "p", name: "P", description: "",
        grants: [{ service: "s3", actions: ["CreateBucket"], resourceScope: TAGGED_AS_SELF }],
        requiredTags: [...ATTRIBUTION_TAG_KEYS], limits: null,
      },
    })).json();
    expect(conn.status).toBe("pending");

    expect((await (await postJson(`${base}/connections/${conn.id}/approve`)).json()).status).toBe("active");

    const credsRes = await postJson(`${base}/connections/${conn.id}/credentials`);
    expect(credsRes.status).toBe(200);
    expect((await credsRes.json()).accessKeyId).toContain(conn.id);

    expect(await (await fetch(`${base}/connections`)).json()).toHaveLength(1);
    expect(await (await fetch(`${base}/connections/${conn.id}/inventory`)).json()).toMatchObject({ connectionId: conn.id });
  });

  it("serves the role template as a downloadable file", async () => {
    const acc = await (await postJson(`${base}/accounts`, { accountId: "123456789012", regions: [] })).json();
    const res = await fetch(`${base}/accounts/${acc.id}/role-template/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain('filename="agentspoppy-setup.json"');
    expect(JSON.parse(await res.text())).toMatchObject({ AWSTemplateFormatVersion: expect.any(String) });
  });

  it("runs account-less bootstrap, creating + linking the account (fresh machine)", async () => {
    expect(await (await fetch(`${base}/accounts`)).json()).toHaveLength(0);
    const res = await postJson(`${base}/aws/bootstrap`, { accessKeyId: "AKIAADMIN", secretAccessKey: "admin-secret" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.brokerRoleArn).toContain(":role/AgentsPoppyBroker");
    expect(body.account.roleArn).toBe(body.brokerRoleArn);
    // the account is now linked
    expect(await (await fetch(`${base}/accounts`)).json()).toHaveLength(1);
  });

  it("rejects bootstrap with missing credentials", async () => {
    expect((await postJson(`${base}/aws/bootstrap`, { accessKeyId: "AKIA" })).status).toBe(400);
  });

  it("unlinks an account, cascading to its connections", async () => {
    const acc = await (await postJson(`${base}/accounts`, { accountId: "123456789012", regions: [] })).json();
    await postJson(`${base}/connections`, {
      accountId: acc.id,
      app: { id: "x", name: "X" },
      permissionSet: { id: "p", name: "P", description: "", grants: [], requiredTags: [], limits: null },
    });
    expect(await (await fetch(`${base}/connections`)).json()).toHaveLength(1);

    const del = await fetch(`${base}/accounts/${acc.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await (await fetch(`${base}/accounts`)).json()).toHaveLength(0);
    expect(await (await fetch(`${base}/connections`)).json()).toHaveLength(0); // cascaded
  });

  it("supervised connection: credentials → 202 approval → approve → 200", async () => {
    const acc = await (await postJson(`${base}/accounts`, { accountId: "123456789012", regions: ["eu-west-1"] })).json();
    const conn = await (await postJson(`${base}/connections`, {
      accountId: acc.id,
      app: { id: "com.mailpoppy.desktop", name: "MailPoppy" },
      permissionSet: {
        id: "p", name: "P", description: "",
        grants: [{ service: "cognito-idp", actions: ["DeleteUserPool"], resourceScope: TAGGED_AS_SELF }],
        requiredTags: [...ATTRIBUTION_TAG_KEYS], limits: null,
      },
    })).json();
    await postJson(`${base}/connections/${conn.id}/approve`);
    await postJson(`${base}/connections/${conn.id}/supervise`, { supervised: true });

    const op = { summary: "Delete user pool 'acme-users'", grants: [{ service: "cognito-idp", actions: ["DeleteUserPool"], resourceScope: TAGGED_AS_SELF }] };
    const pending = await postJson(`${base}/connections/${conn.id}/credentials`, { operation: op });
    expect(pending.status).toBe(202);
    const { approval } = await pending.json();
    expect(approval.operation.summary).toContain("acme-users");

    // it shows up in the global pending-approvals inbox
    const inbox = await (await fetch(`${base}/approvals`)).json();
    expect(inbox).toHaveLength(1);

    // still pending → still 202
    expect((await postJson(`${base}/connections/${conn.id}/credentials`, { approvalId: approval.id })).status).toBe(202);

    expect((await postJson(`${base}/approvals/${approval.id}/approve`)).status).toBe(200);

    const vended = await postJson(`${base}/connections/${conn.id}/credentials`, { approvalId: approval.id });
    expect(vended.status).toBe(200);
    expect((await vended.json()).accessKeyId).toContain(conn.id);
    expect(await (await fetch(`${base}/approvals`)).json()).toHaveLength(0); // consumed
  });

  it("forgets a revoked connection over the API, dropping it from the list", async () => {
    const acc = await (await postJson(`${base}/accounts`, { accountId: "123456789012", regions: [] })).json();
    const conn = await (await postJson(`${base}/connections`, {
      accountId: acc.id,
      app: { id: "x", name: "X" },
      permissionSet: { id: "p", name: "P", description: "", grants: [], requiredTags: [], limits: null },
    })).json();

    // Can't forget a live one — must revoke first (409).
    expect((await postJson(`${base}/connections/${conn.id}/forget`)).status).toBe(409);

    await fetch(`${base}/connections/${conn.id}`, { method: "DELETE" }); // revoke
    const forgot = await postJson(`${base}/connections/${conn.id}/forget`);
    expect(forgot.status).toBe(200);
    expect(await (await fetch(`${base}/connections`)).json()).toHaveLength(0);
  });

  it("answers CORS preflight for local origins", async () => {
    const res = await fetch(`${base}/connections`, {
      method: "OPTIONS",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "DELETE" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });

  it("does not echo CORS for non-local origins", async () => {
    const res = await fetch(`${base}/connections`, { headers: { origin: "https://evil.example.com" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("maps errors to status codes", async () => {
    expect((await fetch(`${base}/connections/nope`)).status).toBe(404);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    // issuing credentials on a pending connection → 409
    const acc = await (await postJson(`${base}/accounts`, { accountId: "1", regions: [] })).json();
    const conn = await (await postJson(`${base}/connections`, {
      accountId: acc.id,
      app: { id: "x", name: "X" },
      permissionSet: { id: "p", name: "P", description: "", grants: [], requiredTags: [], limits: null },
    })).json();
    expect((await postJson(`${base}/connections/${conn.id}/credentials`)).status).toBe(409);
  });
});

describe("broker HTTP API — extensions (container runtime)", () => {
  let home: string;
  let server: Server;
  let base: string;
  let host: StubBackendHost;

  const manifest: ExtensionManifest = {
    id: "com.mailpoppy.desktop",
    name: "MailPoppy",
    version: "1.0.0",
    permissionSet: {
      id: "mp",
      name: "MailPoppy",
      description: "",
      grants: [{ service: "s3", actions: ["CreateBucket"], resourceScope: "arn:aws:s3:::mailpoppy*" }],
      requiredTags: ["agentspoppy:connection"],
      limits: null,
    },
    frontend: { entry: "ui/index.html" },
    backend: { entry: "bin/backend", transport: "http" },
    capabilities: ["aws:credentials", "connection:read"],
  };

  beforeEach(async () => {
    home = join(tmpdir(), `agentspoppy-http-ext-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.AGENTSPOPPY_HOME = home;
    process.env.AGENTSPOPPY_LEDGER = join(home, "ledger.json");
    const svc = new BrokerService({
      store: new Store(),
      credentials: new StubCredentialVendor(),
      cloud: new StubCloudProvider(),
      aws: new StubAwsBootstrap(),
      activity: new StubActivityProvider(),
    });
    host = new StubBackendHost();
    const registry = new ExtensionRegistry(svc, { backendHost: host, brokerBaseUrl: "http://127.0.0.1:8799", allocatePort: async () => 41234 });
    registry.install({ manifest, root: "/opt/ext/mailpoppy" });
    const started = await listen(svc, 0, registry);
    server = started.server;
    base = `http://127.0.0.1:${started.port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    delete process.env.AGENTSPOPPY_HOME;
    delete process.env.AGENTSPOPPY_LEDGER;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("lists installed extensions and starts one once its connection is approved", async () => {
    const list = await (await fetch(`${base}/extensions`)).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ extensionId: "com.mailpoppy.desktop", backend: "awaiting-approval" });

    await postJson(`${base}/accounts`, { accountId: "123456789012", regions: ["eu-west-1"] });

    // First start (account auto-selected): connection is pending → awaiting-approval, no spawn.
    const pending = await (await postJson(`${base}/extensions/com.mailpoppy.desktop/start`)).json();
    expect(pending.backend).toBe("awaiting-approval");
    expect(host.started).toHaveLength(0);

    // Approve the connection, then start again → backend spawns.
    await postJson(`${base}/connections/${pending.connectionId}/approve`);
    const running = await (await postJson(`${base}/extensions/com.mailpoppy.desktop/start`)).json();
    expect(running).toMatchObject({ backend: "running", port: 41234 });
    expect(host.started).toHaveLength(1);

    // Stop halts it.
    expect((await (await postJson(`${base}/extensions/com.mailpoppy.desktop/stop`)).json()).ok).toBe(true);
  });

  it("rejects start when no AWS account is linked", async () => {
    expect((await postJson(`${base}/extensions/com.mailpoppy.desktop/start`)).status).toBe(400);
  });

  it("restart respawns a running backend (the stuck-poppy unstick lever)", async () => {
    await postJson(`${base}/accounts`, { accountId: "123456789012", regions: ["eu-west-1"] });
    const pending = await (await postJson(`${base}/extensions/com.mailpoppy.desktop/start`)).json();
    await postJson(`${base}/connections/${pending.connectionId}/approve`);
    await postJson(`${base}/extensions/com.mailpoppy.desktop/start`);
    expect(host.started).toHaveLength(1);

    const restarted = await (await postJson(`${base}/extensions/com.mailpoppy.desktop/restart`)).json();
    expect(restarted).toMatchObject({ backend: "running" });
    expect(host.started).toHaveLength(2);
  });

  it("passes /ext-dl local-download bytes through binary-safe with headers", async () => {
    // A tiny real "backend" serving a one-shot download with binary content.
    const payload = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x0a]); // %PDF + non-UTF8 bytes
    const backend = createHttpServer((req, res) => {
      if (req.url === "/local-download/tok-1") {
        res.writeHead(200, {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="report.pdf"',
        });
        res.end(payload);
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
    const backendPort = (backend.address() as AddressInfo).port;

    try {
      // Point the registry's allocated port at the stub backend, approve + start.
      await new Promise<void>((r) => server.close(() => r()));
      const svc = new BrokerService({
        store: new Store(),
        credentials: new StubCredentialVendor(),
        cloud: new StubCloudProvider(),
        aws: new StubAwsBootstrap(),
        activity: new StubActivityProvider(),
      });
      const registry = new ExtensionRegistry(svc, {
        backendHost: new StubBackendHost(),
        brokerBaseUrl: "http://127.0.0.1:8799",
        allocatePort: async () => backendPort,
      });
      registry.install({ manifest, root: "/opt/ext/mailpoppy" });
      const started = await listen(svc, 0, registry);
      server = started.server;
      base = `http://127.0.0.1:${started.port}`;

      await postJson(`${base}/accounts`, { accountId: "123456789012", regions: ["eu-west-1"] });
      const pending = await (await postJson(`${base}/extensions/com.mailpoppy.desktop/start`)).json();
      await postJson(`${base}/connections/${pending.connectionId}/approve`);
      await postJson(`${base}/extensions/com.mailpoppy.desktop/start`);

      const dl = await fetch(`${base}/ext-dl/com.mailpoppy.desktop/local-download/tok-1`);
      expect(dl.status).toBe(200);
      expect(dl.headers.get("content-type")).toBe("application/pdf");
      expect(dl.headers.get("content-disposition")).toBe('attachment; filename="report.pdf"');
      expect(Buffer.from(await dl.arrayBuffer())).toEqual(payload); // byte-identical, not text-mangled

      // Backend not running (stopped) → 502, and other backend routes are NOT exposed.
      await postJson(`${base}/extensions/com.mailpoppy.desktop/stop`);
      expect((await fetch(`${base}/ext-dl/com.mailpoppy.desktop/local-download/tok-1`)).status).toBe(502);
      expect((await fetch(`${base}/ext-dl/com.mailpoppy.desktop/other/route`)).status).toBe(404);
    } finally {
      await new Promise<void>((r) => backend.close(() => r()));
    }
  });
});

describe("broker HTTP API — caller authentication (one poppy can't touch another)", () => {
  let home: string;
  let server: Server;
  let base: string;
  const HOST_TOKEN = "host-secret-token";

  beforeEach(async () => {
    home = join(tmpdir(), `agentspoppy-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.AGENTSPOPPY_HOME = home;
    process.env.AGENTSPOPPY_LEDGER = join(home, "ledger.json");
    const svc = new BrokerService({
      store: new Store(),
      credentials: new StubCredentialVendor(),
      cloud: new StubCloudProvider(),
      aws: new StubAwsBootstrap(),
      activity: new StubActivityProvider(),
    });
    // A registry whose backend tokens we can drive: victim poppy "v" is registered
    // with a known token via a manifest install + a stubbed start.
    const registry = new ExtensionRegistry(svc, {
      backendHost: new StubBackendHost(),
      brokerBaseUrl: "http://127.0.0.1:8799",
      allocatePort: async () => 40100,
    });
    const started = await listen(svc, 0, registry, { hostToken: HOST_TOKEN });
    server = started.server;
    base = `http://127.0.0.1:${started.port}`;

    // Seed a connection so there's something for a rogue caller to try to revoke.
    await postJson(`${base}/accounts`, { accountId: "123456789012", regions: ["eu-west-1"] });
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    delete process.env.AGENTSPOPPY_HOME;
    delete process.env.AGENTSPOPPY_LEDGER;
    await fs.rm(home, { recursive: true, force: true });
  });

  const authed = (token: string, init: RequestInit = {}) => ({
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  });

  it("rejects management routes without the host token", async () => {
    // No token → anonymous → 401 on the whole management plane.
    expect((await fetch(`${base}/connections`)).status).toBe(401); // enumerate
    expect((await fetch(`${base}/connections/whatever`, { method: "DELETE" })).status).toBe(401); // revoke
    expect((await postJson(`${base}/connections/whatever/pause`)).status).toBe(401);
    expect((await postJson(`${base}/connections/whatever/teardown`)).status).toBe(401);
    expect((await fetch(`${base}/accounts`)).status).toBe(401);
  });

  it("accepts management routes WITH the host token", async () => {
    const res = await fetch(`${base}/connections`, authed(HOST_TOKEN));
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("a wrong/guessed token is still anonymous", async () => {
    expect((await fetch(`${base}/connections`, authed("not-the-token"))).status).toBe(401);
  });

  it("static asset routes stay open (no bearer possible from the webview / OS browser)", async () => {
    // These reach the handler (404 missing asset / 502 no running backend) rather than
    // being turned away at the auth gate with 401 — i.e. they're exempt, as intended.
    expect((await fetch(`${base}/ext-ui/whatever/index.html`)).status).not.toBe(401);
    expect((await fetch(`${base}/ext-dl/whatever/local-download/tok`)).status).not.toBe(401);
  });
});

describe("broker HTTP API — the curated directory", () => {
  let home: string;
  let server: Server;
  let base: string;
  const HOST_TOKEN = "host-secret-token";
  const CATALOG = JSON.stringify({
    schemaVersion: 1,
    poppies: [
      { id: "com.example.testpoppy", name: "TestPoppy", version: "1.0.0", repo: "https://example.test/repo" },
    ],
  });

  beforeEach(async () => {
    home = join(tmpdir(), `agentspoppy-http-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.AGENTSPOPPY_HOME = home;
    process.env.AGENTSPOPPY_LEDGER = join(home, "ledger.json");
    const svc = new BrokerService({
      store: new Store(),
      credentials: new StubCredentialVendor(),
      cloud: new StubCloudProvider(),
      aws: new StubAwsBootstrap(),
      activity: new StubActivityProvider(),
    });
    const registry = new ExtensionRegistry(svc, { backendHost: new StubBackendHost(), brokerBaseUrl: "http://127.0.0.1:8799" });
    const directory = new DirectoryService({
      extensionsRoot: join(home, "extensions"),
      registry,
      listBlocked: () => svc.listBlockedExtensions(),
      catalogUrl: "test://catalog.json",
      platformKey: "test-plat",
      fetchBytes: async (url: string) => {
        if (url === "test://catalog.json") return new TextEncoder().encode(CATALOG);
        throw new Error(`no fixture for ${url}`);
      },
    });
    const started = await listen(svc, 0, registry, { hostToken: HOST_TOKEN }, directory);
    server = started.server;
    base = `http://127.0.0.1:${started.port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    delete process.env.AGENTSPOPPY_HOME;
    delete process.env.AGENTSPOPPY_LEDGER;
    await fs.rm(home, { recursive: true, force: true });
  });

  const authed = (init: RequestInit = {}) => ({
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${HOST_TOKEN}` },
  });

  it("requires the host token on both directory routes", async () => {
    expect((await fetch(`${base}/directory/catalog`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/directory/install`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "com.example.testpoppy" }),
        })
      ).status,
    ).toBe(401);
  });

  it("serves the enriched catalog to the host", async () => {
    const res = await fetch(`${base}/directory/catalog`, authed());
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view.poppies).toHaveLength(1);
    expect(view.poppies[0]).toMatchObject({
      id: "com.example.testpoppy",
      installed: false,
      blocked: false,
      platform: { key: "test-plat", available: false },
    });
  });

  it("400s an install with no id, in plain language", async () => {
    const res = await fetch(`${base}/directory/install`, authed({
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${HOST_TOKEN}` },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/which poppy/);
  });

  it("maps install failures onto the right statuses (no package for platform → 400)", async () => {
    const res = await fetch(`${base}/directory/install`, authed({
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${HOST_TOKEN}` },
      body: JSON.stringify({ id: "com.example.testpoppy" }),
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/isn't available for this computer/);
  });

  it("uninstall is host-only and 404s something not installed", async () => {
    expect((await fetch(`${base}/extensions/com.example.testpoppy/uninstall`, { method: "POST" })).status).toBe(401);
    const res = await fetch(`${base}/extensions/com.example.testpoppy/uninstall`, authed({ method: "POST" }));
    expect(res.status).toBe(404);
    expect((await res.json()).message).toMatch(/isn't installed on this computer/);
  });
});
