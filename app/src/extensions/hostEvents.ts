// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * A tiny in-app broadcast so a host action on one screen (e.g. tearing a poppy down
 * from its Manage view) can reach that poppy's live, mounted-but-hidden iframe on
 * another screen. The management view and the extension frame sit in separate branches
 * of the App tree, so a module-level pub/sub is cleaner than threading a callback
 * through both.
 *
 * Each mounted {@link ExtensionFrame} subscribes and forwards events for ITS OWN
 * connection into its frame (via postMessage), where the poppy's frontend can react —
 * see the guest-side `HostEvent` handling in the SDK bridge (and MailPoppy's copy).
 */
import type { HostEvent } from "@agentspoppy/extension-sdk";

type Listener = (event: HostEvent) => void;

const listeners = new Set<Listener>();

/** Broadcast a host event to every mounted ExtensionFrame. Synchronous. */
export function emitHostEvent(event: HostEvent): void {
  // Snapshot: a listener could (un)subscribe during dispatch.
  for (const listener of [...listeners]) listener(event);
}

/** Subscribe to host-event broadcasts. Returns an unsubscribe fn. */
export function onHostEventEmitted(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
