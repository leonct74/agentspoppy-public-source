// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Open a link in the user's SYSTEM browser from inside the Tauri webview. A plain
 * `<a target="_blank">` does nothing in a Tauri window (there is no browser tab to
 * open into), so every outbound link must route through the opener plugin. Falls back
 * to `window.open` in a plain browser (the dev harness).
 */
import type { ReactNode } from "react";

const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function openExternal(url: string): void {
  if (isTauri()) {
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("plugin:opener|open_url", { url, with: null }))
      .catch(() => {});
  } else {
    window.open(url, "_blank", "noopener");
  }
}

export function ExtLink({
  href,
  children,
  className,
  title,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  title?: string;
}): JSX.Element {
  return (
    <a
      className={className}
      href={href}
      title={title}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        // In Tauri, intercept the click and hand the URL to the OS browser.
        if (isTauri()) {
          e.preventDefault();
          openExternal(href);
        }
      }}
    >
      {children}
    </a>
  );
}
