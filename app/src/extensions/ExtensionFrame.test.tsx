// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import type { HostBridge, HostResponse } from "@agentspoppy/extension-sdk";
import { ExtensionFrame } from "./ExtensionFrame";
import { emitHostEvent } from "./hostEvents";

afterEach(cleanup);

function fakeBridge(): HostBridge {
  return {
    ensureAccess: async () => "granted",
    getConnection: async () => ({ id: "c1" }) as never,
    getAudit: async () => [],
    getInventory: async () => ({}) as never,
    invokeBackend: async () => ({}) as never,
    openExternal: async () => {},
    notify: async () => {},
    purchaseInfo: async () => ({ productId: "default", name: "default", price: null, owned: false }),
    buyProduct: async () => ({ owned: false }),
    isPurchased: async () => false,
    manageSubscription: async () => {},
  };
}

/** Send a postMessage as if it came from the iframe's own content window. */
function postFromFrame(iframe: HTMLIFrameElement, data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data, source: iframe.contentWindow }));
}

describe("ExtensionFrame", () => {
  it("renders a sandboxed iframe (scripts + own-origin storage, but no top-nav)", () => {
    const { container } = render(
      <ExtensionFrame connId="c1" src="about:blank" title="MailPoppy" capabilities={["connection:read"]} bridge={fakeBridge()} />,
    );
    const iframe = container.querySelector("iframe")!;
    const sandbox = iframe.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    // Served from the broker origin (≠ host app origin), so same-origin storage/modules
    // work while staying isolated from the host. But NOT allowed to navigate the top frame.
    expect(sandbox).toContain("allow-same-origin");
    expect(sandbox).not.toContain("allow-top-navigation");
  });

  it("services a granted bridge call from the frame and posts the response back", async () => {
    const bridge = fakeBridge();
    const ensure = vi.spyOn(bridge, "ensureAccess");
    const { container } = render(
      <ExtensionFrame connId="c1" src="about:blank" title="MailPoppy" capabilities={["aws:credentials"]} bridge={bridge} />,
    );
    const iframe = container.querySelector("iframe")!;
    const post = vi.spyOn(iframe.contentWindow!, "postMessage");
    postFromFrame(iframe, { id: "r1", method: "ensureAccess", params: [] });
    await waitFor(() => expect(ensure).toHaveBeenCalled());
    await waitFor(() => expect(post).toHaveBeenCalled());
    const res = (post.mock.calls[0]?.[0] ?? {}) as HostResponse;
    expect(res).toMatchObject({ id: "r1", ok: true, result: "granted" });
  });

  it("refuses a call whose capability the manifest did not declare", async () => {
    const bridge = fakeBridge();
    const ensure = vi.spyOn(bridge, "ensureAccess");
    const { container } = render(
      // capabilities lacks aws:credentials → ensureAccess must be refused before the bridge runs.
      <ExtensionFrame connId="c1" src="about:blank" title="MailPoppy" capabilities={["connection:read"]} bridge={bridge} />,
    );
    const iframe = container.querySelector("iframe")!;
    const post = vi.spyOn(iframe.contentWindow!, "postMessage");
    postFromFrame(iframe, { id: "r2", method: "ensureAccess", params: [] });
    await waitFor(() => expect(post).toHaveBeenCalled());
    const res = (post.mock.calls[0]?.[0] ?? {}) as HostResponse;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/capability "aws:credentials" is not granted/);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("forwards a host event for its own connection into the frame", async () => {
    const { container } = render(
      <ExtensionFrame connId="c1" src="about:blank" title="MailPoppy" capabilities={["connection:read"]} bridge={fakeBridge()} />,
    );
    const iframe = container.querySelector("iframe")!;
    const post = vi.spyOn(iframe.contentWindow!, "postMessage");
    emitHostEvent({ hostEvent: "connection-changed", connectionId: "c1", reason: "teardown" });
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]?.[0]).toMatchObject({ hostEvent: "connection-changed", connectionId: "c1", reason: "teardown" });
  });

  it("ignores a host event addressed to a different connection", async () => {
    const { container } = render(
      <ExtensionFrame connId="c1" src="about:blank" title="MailPoppy" capabilities={["connection:read"]} bridge={fakeBridge()} />,
    );
    const iframe = container.querySelector("iframe")!;
    const post = vi.spyOn(iframe.contentWindow!, "postMessage");
    emitHostEvent({ hostEvent: "connection-changed", connectionId: "other", reason: "teardown" });
    await new Promise((r) => setTimeout(r, 20));
    expect(post).not.toHaveBeenCalled();
  });

  it("ignores messages that are not from its own frame", async () => {
    const bridge = fakeBridge();
    const ensure = vi.spyOn(bridge, "ensureAccess");
    render(<ExtensionFrame connId="c1" src="about:blank" title="MailPoppy" capabilities={["aws:credentials"]} bridge={bridge} />);
    // source defaults to null (not the iframe) → handler must bail.
    window.dispatchEvent(new MessageEvent("message", { data: { id: "r3", method: "ensureAccess", params: [] } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(ensure).not.toHaveBeenCalled();
  });
});
