// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The capability vocabulary — the closed set of host-bridge powers an extension's
 * (sandboxed) frontend may call. An extension DECLARES the subset it needs in its
 * manifest; the host enforces that allowlist on every bridge call. This is the
 * frontend's only door to anything privileged: it has no Node, no AWS SDK, and no
 * direct filesystem/network — every such action is a capability the user can see
 * and the host gates.
 *
 * Deliberately small and additive. New powers are new entries here (with copy the
 * consent UI can show), never an open-ended escape hatch.
 */

export interface CapabilityInfo {
  /** The stable capability id used in manifests and the bridge. */
  id: string;
  /** Short title for the consent / extension-detail UI. */
  title: string;
  /** Plain-language description of what enabling it lets the extension do. */
  description: string;
}

export const CAPABILITIES = [
  {
    id: "aws:credentials",
    title: "Use brokered AWS access",
    description:
      "Trigger (and await) the user-approved minting of short-lived, scoped AWS credentials for this extension's own backend. The credentials are delivered to the backend, never to the frontend, and never include the operator's own keys.",
  },
  {
    id: "connection:read",
    title: "Read its own connection",
    description:
      "Read this extension's own connection — its declared permission set, status, audit trail and cloud inventory — to render its permissions and activity view.",
  },
  {
    id: "backend:invoke",
    title: "Call its own backend",
    description:
      "Send requests to this extension's own backend process, which the host spawned and supervises. The host proxies the call; the frontend never reaches AWS or the filesystem directly.",
  },
  {
    id: "host:openExternal",
    title: "Open external links",
    description: "Ask the host to open a URL (e.g. an AWS console page) in the system browser.",
  },
  {
    id: "host:notify",
    title: "Show notifications",
    description: "Ask the host to surface a notification or toast to the user.",
  },
  {
    id: "commerce:purchase",
    title: "Offer in-app purchases",
    description:
      "Show the standard AgentsPoppy purchase button for this poppy's own products and check what the user owns. Checkout runs through AgentsPoppy (a flat 5% on the sale); the poppy never handles payment details and can't gate anything behind an external paywall.",
  },
] as const satisfies readonly CapabilityInfo[];

/** A declared host-bridge power. */
export type Capability = (typeof CAPABILITIES)[number]["id"];

const CAPABILITY_IDS: ReadonlySet<string> = new Set(CAPABILITIES.map((c) => c.id));

/** Type guard: is `value` a known capability id? */
export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && CAPABILITY_IDS.has(value);
}

/** Look up the consent-facing info for a capability. */
export function capabilityInfo(id: Capability): CapabilityInfo {
  // Safe: id is a known capability, so the find always hits.
  return CAPABILITIES.find((c) => c.id === id) as CapabilityInfo;
}
