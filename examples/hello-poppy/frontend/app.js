// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: MIT
//
// Hello Poppy frontend logic.
//
// The host embeds this page in a sandboxed iframe and listens for `postMessage`
// requests. We send `{ id, method, params }`; the host replies `{ id, ok, result }`
// (or `{ id, ok:false, error }`). It only honours a method whose CAPABILITY this
// extension declared in extension.json — try calling one you didn't declare and the
// host refuses it.
//
// This no-build scaffold inlines a tiny bridge client so it stays dependency-free. A
// bundled extension (Vite/React/etc.) should instead import `createHostBridgeClient`
// from `@agentspoppy/extension-sdk` — same wire protocol, typed.

const pending = new Map();
let seq = 0;

window.addEventListener("message", (e) => {
  if (e.source !== window.parent) return; // only trust the host frame
  const res = e.data;
  if (!res || typeof res.id !== "string") return;
  const p = pending.get(res.id);
  if (!p) return;
  pending.delete(res.id);
  if (res.ok) p.resolve(res.result);
  else p.reject(new Error(res.error));
});

function call(method, ...params) {
  return new Promise((resolve, reject) => {
    const id = `req-${Date.now().toString(36)}-${++seq}`;
    pending.set(id, { resolve, reject });
    window.parent.postMessage({ id, method, params }, "*");
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`host call "${method}" timed out`));
    }, 30_000);
  });
}

// The capability-gated host surface (only the methods this extension declared).
const host = {
  getConnection: () => call("getConnection"), // needs "connection:read"
  invokeBackend: (req) => call("invokeBackend", req), // needs "backend:invoke"
  openExternal: (url) => call("openExternal", url), // needs "host:openExternal"
  notify: (n) => call("notify", n), // needs "host:notify"
};

const $ = (id) => document.getElementById(id);
const show = (value) => {
  const el = $("output");
  el.classList.remove("muted");
  el.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
};

// 1) Render this extension's own connection (its declared access + status).
async function renderConnection() {
  try {
    const c = await host.getConnection();
    const grants = c.permissionSet?.grants ?? [];
    $("connection").innerHTML = `
      <div class="row"><span class="k">App</span><strong>${escapeHtml(c.app?.name ?? c.app?.id ?? "—")}</strong></div>
      <div class="row" style="margin-top:6px"><span class="k">Status</span>
        <span class="pill ${c.status === "active" ? "ok" : ""}">${escapeHtml(c.status ?? "—")}</span></div>
      <div style="margin-top:12px">
        <div class="k" style="font-size:12px;margin-bottom:4px">Declared AWS access</div>
        ${grants
          .map(
            (g) => `<div class="grant">
              <span class="svc">${escapeHtml(g.service)}</span>
              <span class="muted">· ${g.actions?.length ?? 0} action(s)</span>
              <div class="scope">${escapeHtml(g.resourceScope)}</div>
            </div>`,
          )
          .join("")}
      </div>`;
  } catch (err) {
    $("connection").textContent = `Couldn't read the connection: ${err.message}`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// Give a button an immediate in-flight state while an async handler runs, so it NEVER
// looks dead: disable it (no double-fire) and swap its label to a busy form, then ALWAYS
// restore it — even if the work throws (that's what `finally` guarantees). Every poppy
// button that awaits something must do this; a button that just sits there for the seconds
// a request takes is the #1 recurring poppy bug. See AGENTS.md §9 "Every button must respond".
function withPending(btn, busyLabel, fn) {
  return async () => {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyLabel;
    try {
      await fn();
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  };
}

// 2) Wire the buttons to the three other capabilities — each with an in-flight state.
$("btn-backend").addEventListener(
  "click",
  withPending($("btn-backend"), "Calling…", async () => {
    try {
      show(await host.invokeBackend({ method: "GET", path: "/info" }));
    } catch (err) {
      show(`Backend call failed: ${err.message}`);
    }
  }),
);

$("btn-open").addEventListener(
  "click",
  withPending($("btn-open"), "Opening…", async () => {
    try {
      await host.openExternal("https://docs.aws.amazon.com/");
      show("Asked the host to open the AWS docs in your browser.");
    } catch (err) {
      show(`openExternal failed: ${err.message}`);
    }
  }),
);

$("btn-notify").addEventListener(
  "click",
  withPending($("btn-notify"), "Notifying…", async () => {
    try {
      await host.notify({ title: "Hello Poppy", body: "A notification, surfaced by the host." });
      show("Asked the host to show a notification.");
    } catch (err) {
      show(`notify failed: ${err.message}`);
    }
  }),
);

renderConnection();
