// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The official AgentsPoppy mark — the monoline poppy (orange strokes, no fills):
 * four overlapping petal outlines around a stamen ring. Rendered inline (not an
 * <img>) so it stays crisp at any size and can be animated and recoloured by CSS.
 * The stroke uses `currentColor`, so the caller sets the hue via `color`.
 */
export function PoppyMark({ className }: { className?: string }) {
  const petal =
    "M 0 -52 C -66 -74, -92 -152, -54 -196 C -22 -232, 22 -232, 54 -196 C 92 -152, 66 -74, 0 -52 Z";
  return (
    <svg
      className={className}
      viewBox="0 0 512 512"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="AgentsPoppy"
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth={20}
        strokeLinecap="round"
        strokeLinejoin="round"
        transform="translate(256 256) rotate(-10)"
      >
        <path d={petal} />
        <path d={petal} transform="rotate(90)" />
        <path d={petal} transform="rotate(180)" />
        <path d={petal} transform="rotate(270)" />
        <circle r={30} strokeWidth={18} />
        <g strokeWidth={14}>
          <line x1={40} y1={-40} x2={56} y2={-56} />
          <line x1={40} y1={40} x2={56} y2={56} />
          <line x1={-40} y1={40} x2={-56} y2={56} />
          <line x1={-40} y1={-40} x2={-56} y2={-56} />
        </g>
      </g>
    </svg>
  );
}
