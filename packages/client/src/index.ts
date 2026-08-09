// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * `@agentspoppy/client` — the zero-dependency client SDK a poppy imports to talk
 * to a local AgentsPoppy broker. Two halves:
 *   - connect:     request a connection + wait for the user's approval
 *   - credentials: an auto-refreshing provider that keeps long-running agents
 *                  working against short-lived tokens
 * Or just call `connect()` for the whole flow in one shot.
 */
export * from "./credentials";
export * from "./connect";
