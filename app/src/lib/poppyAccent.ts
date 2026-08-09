// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * A poppy's ONE identity colour — its avatar tile, airlock header, and (via the
 * poppy design kit's `--poppy-accent`) its own UI accent. The assignment lives in
 * the SDK so the host and every poppy compute the SAME colour from the app id;
 * this module just re-exports it for the console's components.
 */
export { POPPY_ACCENTS, poppyAccent } from "@agentspoppy/extension-sdk";
