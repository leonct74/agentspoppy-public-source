// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initBrokerAuth } from "./api/broker";
// Bundled locally (no CDN / no phone-home) — the DESIGN.md type system.
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./theme.css";

// Arm the broker client with the host token (from the Tauri host) before the app's
// first management call. Fire-and-forget with its own retry; never blocks render.
void initBrokerAuth();

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// In the desktop shell the window launches hidden to avoid a blank-webview flash;
// reveal it now that React has rendered. No-op in a plain browser.
if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
    void getCurrentWindow().show();
  });
}
