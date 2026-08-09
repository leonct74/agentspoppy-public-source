// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { PoppyMark } from "./PoppyMark";

/**
 * The loading spinner — the AgentsPoppy poppy mark, turning continuously. Replaces
 * the old border-circle spinners so every "working…" state wears the brand.
 *
 * `tone`: "primary" paints it the accent (default, for standalone/inline use);
 * "current" inherits `currentColor` (for use inside a coloured button, so it reads
 * white on a primary button). The mark's strokes are `currentColor`, so either way
 * it takes the wrapper's colour. Transparent background — drop it anywhere.
 */
export function PoppySpinner({
  size = 16,
  tone = "primary",
  className,
  label,
}: {
  size?: number;
  tone?: "primary" | "current";
  className?: string;
  /** When set, the spinner announces itself (role=status); otherwise it's decorative. */
  label?: string;
}) {
  const classes = ["poppy-spinner", tone === "current" && "poppy-spinner--current", className]
    .filter(Boolean)
    .join(" ");
  return (
    <span
      className={classes}
      style={{ width: size, height: size }}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <PoppyMark className="poppy-spinner__mark" />
    </span>
  );
}
