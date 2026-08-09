// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi, afterEach } from "vitest";
import { ApiError, broker, setBrokerBaseUrl, setBrokerHostToken } from "./broker";

// Mock the Tauri core bridge so the host-token fetch is exercisable off-device.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "") }));

setBrokerBaseUrl("http://test.local");

afterEach(() => vi.restoreAllMocks());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("broker client", () => {
  it("POSTs approve to the right URL and parses the result", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "c1", status: "active" }));
    vi.stubGlobal("fetch", fetchMock);

    const conn = await broker.approve("c1");

    expect(conn.status).toBe("active");
    expect(fetchMock).toHaveBeenCalledWith("http://test.local/connections/c1/approve", { method: "POST" });
  });

  it("DELETEs to revoke", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "c1", status: "revoked" }));
    vi.stubGlobal("fetch", fetchMock);

    await broker.revoke("c1");
    expect(fetchMock).toHaveBeenCalledWith("http://test.local/connections/c1", { method: "DELETE" });
  });

  it("throws ApiError carrying the broker's status + code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "invalid_state", message: "nope" }, 409)));
    await expect(broker.approve("c1")).rejects.toMatchObject({ status: 409, code: "invalid_state" });
    await expect(broker.approve("c1")).rejects.toBeInstanceOf(ApiError);
  });

  it("GETs the operator identity", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ accountId: "1", arn: "arn:x", userId: "U" }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await broker.awsIdentity()).accountId).toBe("1");
    expect(fetchMock).toHaveBeenCalledWith("http://test.local/aws/identity", undefined);
  });

  it("POSTs a new account as JSON to link it", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "a1", accountId: "123456789012" }));
    vi.stubGlobal("fetch", fetchMock);
    await broker.createAccount({ accountId: "123456789012", alias: "Personal", regions: ["eu-west-1"] });
    expect(fetchMock).toHaveBeenCalledWith("http://test.local/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "123456789012", alias: "Personal", regions: ["eu-west-1"] }),
    });
  });

  it("POSTs the role ARN as JSON to set it on an account", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "a1", roleArn: "arn:aws:iam::1:role/AP" }));
    vi.stubGlobal("fetch", fetchMock);
    await broker.setAccountRole("a1", "arn:aws:iam::1:role/AP");
    expect(fetchMock).toHaveBeenCalledWith("http://test.local/accounts/a1/role", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roleArn: "arn:aws:iam::1:role/AP" }),
    });
  });

  it("GETs the directory catalog", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ sourceUrl: "https://example.test/catalog.json", fetchedAt: "t", poppies: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect((await broker.directoryCatalog()).poppies).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith("http://test.local/directory/catalog", undefined);
  });

  it("POSTs the poppy id as JSON to install from the directory", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, extensionId: "com.mailpoppy.desktop" }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await broker.directoryInstall("com.mailpoppy.desktop")).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("http://test.local/directory/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "com.mailpoppy.desktop" }),
    });
  });

  it("POSTs an uninstall for the extension", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, extensionId: "com.mailpoppy.desktop" }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await broker.uninstallExtension("com.mailpoppy.desktop")).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("http://test.local/extensions/com.mailpoppy.desktop/uninstall", {
      method: "POST",
    });
  });

  it("self-heals a host-token 401: re-arms the token and retries once (Tauri)", async () => {
    // Simulate the packaged app after a rebuild: the broker's cold-start delays the
    // host token, so the first management call 401s. The token then lands and the
    // client must recover on its own rather than 401ing for the whole session.
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    setBrokerHostToken(null);
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as unknown as ReturnType<typeof vi.fn>).mockResolvedValue("HOSTTOKEN");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "unauthorized", message: "this route requires the AgentsPoppy host token" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "c1", status: "active" }));
    vi.stubGlobal("fetch", fetchMock);

    const conn = await broker.approve("c1");
    expect(conn.status).toBe("active");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The retry carries the freshly-armed bearer token.
    const retryInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect((retryInit.headers as Record<string, string>).authorization).toBe("Bearer HOSTTOKEN");

    setBrokerHostToken(null);
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });
});
