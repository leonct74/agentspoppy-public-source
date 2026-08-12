// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * agentspoppy:// links — the website→app handoff ("Deploy for real" on a web demo).
 *
 * A deep link is UNTRUSTED input: any web page can fire one. So the only thing a
 * link may carry is a catalogue id; the app resolves that id against the curated
 * directory itself and lands the user on the normal consent ceremony. A link can
 * never name a package URL, a manifest, or anything else that would let a page
 * define what gets installed rather than merely point at it.
 *
 * Accepted shape: agentspoppy://install?id=<reverse-dns-catalogue-id>
 * (Platform URL parsers disagree on whether "install" lands in host or pathname,
 * so both spellings — agentspoppy://install and agentspoppy:///install — parse.)
 */

/** Reverse-DNS ids like `com.mailpoppy.desktop` — same charset the registry allows. */
const CATALOGUE_ID = /^[a-z0-9][a-z0-9.-]{2,127}$/;

export interface InstallLink {
  action: "install";
  /** Catalogue id to focus in the directory — validated charset, but NOT yet known to exist. */
  id: string;
}

/** Parse + validate a deep link. Returns null for anything but a well-formed install link. */
export function parseDeepLink(raw: string): InstallLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "agentspoppy:") return null;
  // "install" may land in host (agentspoppy://install) or pathname (agentspoppy:///install)
  // depending on the platform's parser — but nothing may trail it either way.
  const host = url.host.toLowerCase();
  const path = url.pathname.replace(/\/+$/, "").toLowerCase();
  const action = host ? (path === "" ? host : null) : path.replace(/^\/+/, "");
  if (action !== "install") return null;
  const id = (url.searchParams.get("id") ?? "").trim().toLowerCase();
  if (!CATALOGUE_ID.test(id)) return null;
  return { action: "install", id };
}
