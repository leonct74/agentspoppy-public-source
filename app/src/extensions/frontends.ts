// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Where to load each installed extension's frontend from. The desktop shell injects
 * a map (extensionId → URL) on `window.__AGENTSPOPPY_EXTENSION_FRONTENDS__` once it
 * has served the installed extensions' built `frontend/` directories (slice 5). Until
 * then this returns undefined and the container falls back to the monitoring view —
 * so the bridge + frame are fully wired but light up only when a frontend is served.
 */
export function extensionFrontendUrl(extensionId: string): string | undefined {
  const map = (globalThis as { __AGENTSPOPPY_EXTENSION_FRONTENDS__?: Record<string, string> })
    .__AGENTSPOPPY_EXTENSION_FRONTENDS__;
  return map?.[extensionId];
}
