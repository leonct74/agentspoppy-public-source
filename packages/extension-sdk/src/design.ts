// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The poppy accent assignment — the ONE identity colour a poppy gets.
 *
 * This is the single source of truth: the HOST uses it to paint a poppy's
 * sidebar avatar and airlock header, and a poppy uses it to set its own
 * `--poppy-accent` (see poppy.css + DESIGN.md). Deterministic from the app id,
 * so the same poppy is the same colour everywhere, forever — which is also why
 * this hash MUST NEVER CHANGE (a change would repaint every installed poppy;
 * design.test.ts pins known assignments).
 *
 * Clay is deliberately NOT in the palette: it is the host's reserved accent,
 * so no poppy can dress itself up as AgentsPoppy chrome.
 */
export const POPPY_ACCENTS = ["#9dbbe8", "#c9b8e8", "#bccf9e", "#e8b8c9", "#8fd0c6", "#e6c68a"] as const;

export function poppyAccent(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return POPPY_ACCENTS[h % POPPY_ACCENTS.length] ?? POPPY_ACCENTS[0];
}
