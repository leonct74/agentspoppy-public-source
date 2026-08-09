// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { useState, type ReactNode } from "react";
import { Icon } from "./Icon";

export interface DisclosureProps {
  /** The always-visible summary line — the question the user might be asking. */
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  /** "trust" gives it the accent treatment for the headline transparency panel. */
  tone?: "default" | "trust";
}

/**
 * Progressive disclosure: the user chooses how much detail to absorb. Collapsed
 * by default so the happy path stays uncluttered; expandable for the curious or
 * the cautious — which is exactly the audience that needs to trust this app.
 */
export function Disclosure({ title, children, defaultOpen = false, tone = "default" }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`disclosure disclosure-${tone}${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="disclosure-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="chevron" className="disclosure-chevron" />
        <span>{title}</span>
      </button>
      {open && <div className="disclosure-body">{children}</div>}
    </div>
  );
}
