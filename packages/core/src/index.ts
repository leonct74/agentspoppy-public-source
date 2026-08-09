// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

// Browser-safe barrel: pure types + helpers only. The fs-backed ledger lives at
// "@agentspoppy/core/ledger" so browser consumers (the app) never pull in node:fs.
export * from "./types";
export * from "./resources";
export * from "./permissions";
export * from "./approvals";
export * from "./activity";
