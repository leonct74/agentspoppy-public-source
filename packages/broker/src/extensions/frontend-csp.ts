// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The machine gate, frontend half (docs/specs/machine-gate.md): the poppy tab's
 * network access, compiled from the manifest's declaration into a
 * Content-Security-Policy the WEBVIEW ENGINE enforces. This is the strongest of the
 * gate's two halves — nothing running inside the page can patch its way around the
 * browser — and it directly covers the founder's "user navigation data" concern: a
 * tab that cannot call home cannot report browsing.
 *
 * Served on every /ext-ui response, compiled from `network.machine` (door 3 — the
 * poppy's own code on this machine), never from `network.egress`, which is about the
 * Lambdas it deploys. Spec decision 1 applies here too: an UNDECLARED poppy gets no
 * restriction (null) — breaking older manifests is the wrong failure, and the catalogue
 * already forces a declaration at their next update.
 *
 * What a declared tab keeps, so real poppy UIs don't break:
 *  - its own origin for everything (scripts, styles, images, fonts);
 *  - loopback on any port — the backend it talks to sits on a host-assigned local
 *    port, and local traffic is not egress from the machine;
 *  - THE PLATFORM'S OWN API. AgentsPoppy requires every poppy to mount the standard
 *    Feedback tab (AGENTS.md §9a), and that tab talks to agentspoppy.com from the
 *    poppy's own frontend by design. A gate that refused it would break a tab the
 *    platform itself mandates — the host contradicting its own contract. Same class as
 *    loopback: plumbing the poppy did not choose is never collateral. connect-src only,
 *    and only the frontend: a BACKEND reaching the platform is the poppy's own choice
 *    and must be declared like any other host;
 *  - inline styles ('unsafe-inline' on style-src only): React-style inline styling
 *    is ubiquitous, and a style attribute fetches nothing by itself — actual
 *    fetches (background images, fonts) stay governed by their own directives.
 */
import type { EgressDeclaration, NetworkDeclaration } from "@agentspoppy/core";

const LOOPBACK_SOURCES = "http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*";

/**
 * The platform's own API origin — where the mandated Feedback tab (and the in-poppy
 * purchase flow) post. Kept in step with `extension-sdk/src/feedback-tab.ts`'s
 * DEFAULT_API, which every poppy vendors verbatim; a poppy that points its tab
 * elsewhere with `api="…"` declares that host itself.
 */
export const PLATFORM_API_ORIGIN = "https://agentspoppy.com";

/** The external sources a declaration allows, as CSP source expressions. */
function externalSources(egress: EgressDeclaration): string {
  if (egress === "none" || egress === "user-directed") return "";
  if (egress === "aws-only") return "https://*.amazonaws.com https://*.api.aws";
  return egress.map((h) => `https://${h}`).join(" ");
}

/**
 * The Content-Security-Policy for a poppy frontend, or null for an undeclared
 * manifest (no restriction — observe-mode's frontend equivalent).
 */
export function frontendCsp(network: NetworkDeclaration | undefined): string | null {
  const machine = network?.machine;
  if (machine === undefined) return null;
  // "user-directed": no list exists — restricting the tab would break the declared
  // behaviour, so the frontend stays unrestricted (the machine gate logs, backend-side).
  if (machine === "user-directed") return null;
  const external = externalSources(machine);
  const ext = external ? ` ${external}` : "";
  return [
    "default-src 'self'",
    `connect-src 'self' ${LOOPBACK_SOURCES} ${PLATFORM_API_ORIGIN}${ext}`,
    `img-src 'self' data:${ext}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    `form-action 'self'${ext}`,
  ].join("; ");
}
