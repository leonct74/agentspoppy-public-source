// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Native OS notifications for supervised-approval requests, so the user sees
 * one even when the AgentsPoppy window is hidden behind other apps. The webview
 * keeps polling while hidden (the window is hidden, not closed), so the dashboard
 * poll can fire a banner the moment a new approval arrives.
 *
 * Pure no-op outside the Tauri shell (browser dev, tests) — the plugin is only
 * imported when actually running in the desktop app.
 */
import type { ApprovalRequest, Connection } from "@agentspoppy/core";

/** Notification category carrying the Approve / Deny buttons. */
const ACTION_TYPE_ID = "agentspoppy.approval";

/** Approval ids we've already notified about (one banner per request, ever). */
const seen = new Set<string>();
/**
 * First pass after launch records what's already pending WITHOUT alerting, so
 * starting the app doesn't dump a banner for every stale request — we only ping
 * for approvals that arrive while it's running.
 */
let primed = false;

/** True only inside the Tauri webview (so dev/tests never touch the plugin). */
function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Draw the user to the window when an approval lands — a dock bounce (macOS) that
 * persists until they activate the app, plus an unminimise so the bounce leads
 * somewhere. This is the *reliable* attention channel: notification action buttons
 * only render in the "Alerts" style, which an app cannot set, so we never depend on
 * them — the window comes forward to the in-app ApprovalsBar, which always has
 * working Approve / Deny buttons. Deliberately does NOT steal focus (no setFocus),
 * which would be jarring if the user is mid-task in another app. No-op outside Tauri.
 */
async function raiseForApproval(): Promise<void> {
  if (!inTauri()) return;
  try {
    const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    await w.unminimize().catch(() => {});
    await w.requestUserAttention(UserAttentionType.Critical);
  } catch {
    /* window API unavailable — the native banner (if shown) is still the fallback */
  }
}

/**
 * Pop a native banner for any newly-pending approval. Idempotent per id and safe
 * to call on every poll; the connection list is only used to name the app.
 */
export async function notifyPendingApprovals(
  approvals: ApprovalRequest[],
  connections: Connection[],
): Promise<void> {
  const pending = approvals.filter((a) => a.status === "pending");

  if (!primed) {
    for (const a of pending) seen.add(a.id);
    primed = true;
    return;
  }

  const fresh = pending.filter((a) => !seen.has(a.id));
  if (fresh.length === 0) return;
  for (const a of fresh) seen.add(a.id);

  if (!inTauri()) return;

  // Bounce the dock first — this is the channel we can rely on regardless of the
  // user's notification-banner style, and it brings them to the in-app approvals
  // bar where the real buttons live. The native banner below is a bonus nudge.
  await raiseForApproval();

  const { isPermissionGranted, requestPermission, sendNotification } = await import(
    "@tauri-apps/plugin-notification"
  );
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (!granted) return;

  const nameOf = (id: string) => connections.find((c) => c.id === id)?.app.name ?? "An app";
  for (const a of fresh) {
    const app = nameOf(a.connectionId);
    sendNotification({
      title: `${app} needs your approval`,
      // Don't promise inline buttons: macOS only shows notification actions in the
      // "Alerts" style, so point the user to the window (which we've just raised),
      // where the in-app approvals bar always has Approve / Deny.
      body: a.operation?.summary
        ? `${a.operation.summary} — open AgentsPoppy to approve or deny.`
        : `${app} is requesting AWS access — open AgentsPoppy to approve or deny.`,
      // Still attach the action category: for users whose banners ARE set to
      // "Alerts" the buttons appear and work; for everyone else it's harmless.
      actionTypeId: ACTION_TYPE_ID,
      extra: { approvalId: a.id },
    });
  }
}

let actionsReady = false;
let actionHandlers: { approve: (id: string) => void; deny: (id: string) => void } | null = null;

/**
 * Register the Approve / Deny notification buttons and route taps to the broker,
 * so the user can decide straight from the banner without leaving the app they're
 * in. Idempotent: the listener is attached once; later calls just refresh the
 * handlers. No-op outside the Tauri shell.
 */
export async function initApprovalActions(handlers: {
  approve: (approvalId: string) => void;
  deny: (approvalId: string) => void;
}): Promise<void> {
  actionHandlers = handlers;
  if (!inTauri() || actionsReady) return;
  actionsReady = true;

  const { registerActionTypes, onAction } = await import("@tauri-apps/plugin-notification");
  // macOS requires the category to be registered before a notification carrying it
  // is delivered, so do this at startup (well before the first approval arrives).
  await registerActionTypes([
    {
      id: ACTION_TYPE_ID,
      actions: [
        // foreground:false → deciding doesn't yank focus away from the app you're in.
        { id: "approve", title: "Approve", foreground: false },
        { id: "deny", title: "Deny", destructive: true, foreground: false },
      ],
    },
  ]);

  await onAction((n) => {
    // `actionId` isn't in the plugin's TS type but is present on the event payload;
    // a plain body tap reports a default id we deliberately ignore (it just opens
    // the app), so only the explicit Approve / Deny buttons act.
    const actionId = (n as { actionId?: string }).actionId;
    const approvalId = (n.extra as { approvalId?: string } | undefined)?.approvalId;
    if (!approvalId || !actionHandlers) return;
    if (actionId === "approve") actionHandlers.approve(approvalId);
    else if (actionId === "deny") actionHandlers.deny(approvalId);
  });
}
