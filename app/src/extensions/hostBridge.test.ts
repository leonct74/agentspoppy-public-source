// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi, afterEach } from "vitest";
import type { Connection } from "@agentspoppy/core";
import { broker } from "../api/broker";
import { createBrokerHostBridge } from "./hostBridge";

afterEach(() => vi.restoreAllMocks());

function bridgeWith() {
  return createBrokerHostBridge({
    connectionId: "c1",
    extensionId: "com.mailpoppy.desktop",
    openExternal: async () => {},
    notify: async () => {},
  });
}

describe("createBrokerHostBridge", () => {
  it("ensureAccess maps connection status to an access state", async () => {
    const get = vi.spyOn(broker, "getConnection");
    get.mockResolvedValueOnce({ status: "active" } as Connection);
    expect(await bridgeWith().ensureAccess()).toBe("granted");
    get.mockResolvedValueOnce({ status: "pending" } as Connection);
    expect(await bridgeWith().ensureAccess()).toBe("pending");
    get.mockResolvedValueOnce({ status: "revoked" } as Connection);
    expect(await bridgeWith().ensureAccess()).toBe("denied");
  });

  it("getConnection/getAudit/getInventory delegate to the broker for THIS connection", async () => {
    const conn = vi.spyOn(broker, "getConnection").mockResolvedValue({ id: "c1" } as Connection);
    const audit = vi.spyOn(broker, "audit").mockResolvedValue([]);
    const inv = vi.spyOn(broker, "inventory").mockResolvedValue({} as never);
    const b = bridgeWith();
    await b.getConnection();
    await b.getAudit();
    await b.getInventory();
    expect(conn).toHaveBeenCalledWith("c1");
    expect(audit).toHaveBeenCalledWith("c1");
    expect(inv).toHaveBeenCalledWith("c1");
  });

  it("invokeBackend proxies through the broker for THIS extension", async () => {
    const spy = vi.spyOn(broker, "invokeExtensionBackend").mockResolvedValue({ ok: true, n: 7 } as never);
    const out = await bridgeWith().invokeBackend<{ ok: boolean; n: number }>({ method: "POST", path: "/deploy", body: { x: 1 } });
    expect(out).toEqual({ ok: true, n: 7 });
    expect(spy).toHaveBeenCalledWith("com.mailpoppy.desktop", { method: "POST", path: "/deploy", body: { x: 1 } });
  });

  it("invokeBackend surfaces the broker proxy error (status-coded) to the caller", async () => {
    vi.spyOn(broker, "invokeExtensionBackend").mockRejectedValue(new Error('backend 500: {"message":"boom"}'));
    await expect(bridgeWith().invokeBackend({ method: "GET", path: "/x" })).rejects.toThrow(/backend 500/);
  });
});
