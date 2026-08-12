// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Renders an extension's frontend in a SANDBOXED iframe and bridges its host calls.
 *
 * The iframe is served from the broker's loopback origin (127.0.0.1:<brokerPort>),
 * which is DIFFERENT from the host app's own origin — so even with `allow-same-origin`
 * the frame cannot read the host app's DOM, storage, or cookies. `allow-same-origin`
 * is required for the extension to actually function: ES-module scripts are fetched in
 * CORS mode (an opaque/null origin can't load them), and web apps need `localStorage`
 * (an opaque origin throws on access). The frame's storage is partitioned to the broker
 * origin, isolated from the host.
 *
 * Its intended door to anything privileged is the postMessage bridge wired here — every
 * call is gated by `handleHostRequest` against the extension's manifest-declared
 * `capabilities` before the host bridge runs (the app-side counterpart to the SDK's
 * createHostBridgeClient).
 *
 * A hostile frontend can skip the bridge and call the broker's HTTP API directly, since it
 * is same-origin to the loopback broker. That used to be an open question; it is now closed
 * by caller auth (`broker/src/auth.ts`, one gate in `http.ts`). The frame holds no token —
 * the host token goes only to this app, the credentials token only to a backend's bootstrap
 * — so it authenticates as `anonymous`, and every route except static assets (`/ext-ui/*`)
 * and single-use download tokens (`/ext-dl/*`) answers 401. It cannot mint credentials, list
 * connections, or touch another poppy.
 *
 * What the frame CAN do is what any web page can: talk to the network. It holds no cloud
 * credentials — those are minted into a poppy's BACKEND, never here — and it has no
 * filesystem, no subprocesses and no environment, because the browser engine provides none
 * of those APIs. For a frontend-only poppy that is the entire threat surface.
 */
import { useEffect, useRef } from "react";
import { type Capability, type HostBridge, type HostRequest, handleHostRequest } from "@agentspoppy/extension-sdk";
import { onHostEventEmitted } from "./hostEvents";

export function ExtensionFrame({
  connId,
  src,
  title,
  capabilities,
  bridge,
}: {
  /** The connection this frame is bound to — used to route host events to it. */
  connId: string;
  src: string;
  title: string;
  capabilities: readonly Capability[];
  bridge: HostBridge;
}): JSX.Element {
  const ref = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = ref.current;
      // Only accept messages from THIS extension's frame.
      if (!frame || e.source !== frame.contentWindow) return;
      const req = e.data as Partial<HostRequest> | null;
      if (!req || typeof req.id !== "string" || typeof req.method !== "string") return;
      void handleHostRequest(req as HostRequest, { capabilities, bridge }).then((res) => {
        // The sandboxed frame has an opaque origin; "*" is the only usable target here.
        frame.contentWindow?.postMessage(res, "*");
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [capabilities, bridge]);

  // Forward host events for THIS connection into the frame, so a poppy whose backend
  // changed under it (e.g. torn down from the Manage view while this tab was hidden but
  // still mounted) can refresh instead of showing stale state. Same opaque-origin "*".
  useEffect(() => {
    return onHostEventEmitted((event) => {
      if (event.connectionId !== connId) return;
      ref.current?.contentWindow?.postMessage(event, "*");
    });
  }, [connId]);

  return (
    <iframe
      ref={ref}
      src={src}
      title={title}
      className="ext-frame"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
      // Delegate clipboard-WRITE (not read) to the extension frame, otherwise its
      // copy-to-clipboard buttons (recovery keys, attachment links, IAM policies)
      // are blocked by Permissions Policy on the cross-origin loopback frame.
      allow="clipboard-write"
    />
  );
}
