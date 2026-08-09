// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The Tauri WKWebview aggressively caches dev assets across launches, which can
// serve a stale bundle after code changes. Forbid caching in dev so every launch
// fetches fresh.
const noStoreInDev: Plugin = {
  name: "agentspoppy-no-store-dev",
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), noStoreInDev],
  // Fixed port so the Tauri shell's devUrl matches (see src-tauri/tauri.conf.json).
  // 1430 keeps clear of MailPoppy's dev server (1420/1421) when both are open.
  server: { port: 1430, strictPort: true },
  clearScreen: false,
  test: {
    environment: "jsdom",
  },
});
