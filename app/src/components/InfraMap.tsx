// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The cloud infrastructure map: a poppy's footprint drawn as services (spheres) wired by their
 * stack-template dependencies (animated edges). Built from the broker's verified
 * {@link InfraGraph}, so it doubles as a live map AND a teardown report — after teardown,
 * removed services dim out and any real leftover stays lit, so "what's still there" is obvious.
 * Click a service to expand it: a panel lists its individual resources, each with a deep-link
 * into the AWS console (the finish-it-yourself escape hatch).
 */
import { useState } from "react";
import type { InfraGraph } from "@agentspoppy/core";
import {
  layoutServiceGraph,
  serviceAbbr,
  serviceColor,
  serviceLabel,
  statusLabel,
  toServiceGraph,
  type PositionedNode,
} from "../lib/infraLayout";

// Each service gets its own grid cell; the viewBox is sized to cols×rows so spheres + their
// labels always have room — no overlap however many services a real stack has.
const CELL_W = 168;
const CELL_H = 120;
const PAD = 40;
const R = 28;
const REMOVED_FILL = "#5f6b85";

// The human-facing service name now lives in infraLayout (serviceLabel) so the map and the
// teardown preview can't drift apart.
const label = serviceLabel;

/** "AWS::S3::Bucket" → "Bucket" — the human-meaningful tail of a CloudFormation type. */
function prettyType(resourceType: string): string {
  const parts = resourceType.split("::");
  return parts[parts.length - 1] ?? resourceType;
}

const cellCenter = (n: PositionedNode): { x: number; y: number } => ({
  x: PAD + (n.col + 0.5) * CELL_W,
  y: PAD + (n.row + 0.5) * CELL_H,
});

/** Trim a line between two node centres so it starts/ends at the circle edges, not inside them. */
function trimmed(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return `M${(a.x + ux * R).toFixed(1)} ${(a.y + uy * R).toFixed(1)} L${(b.x - ux * R).toFixed(1)} ${(b.y - uy * R).toFixed(1)}`;
}

/** Lighten (amt > 0, toward white) or darken (amt < 0, toward black) a #rrggbb colour. */
function shade(hex: string, amt: number): string {
  const body = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1];
  if (!body) return hex;
  const num = parseInt(body, 16);
  const t = amt < 0 ? 0 : 255;
  const p = Math.abs(amt);
  const mix = (v: number) => Math.round(v + (t - v) * p);
  const to2 = (v: number) => v.toString(16).padStart(2, "0");
  return `#${to2(mix((num >> 16) & 0xff))}${to2(mix((num >> 8) & 0xff))}${to2(mix(num & 0xff))}`;
}

/** Open a URL in the OS browser (Tauri opener plugin), falling back to a new tab in plain-browser dev. */
function openExternal(url: string): void {
  import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("plugin:opener|open_url", { url, with: null }))
    .catch(() => window.open(url, "_blank", "noopener"));
}

export function InfraMap({ graph }: { graph: InfraGraph }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [showVerifyingHelp, setShowVerifyingHelp] = useState(false);
  const serviceGraph = toServiceGraph(graph);
  const { nodes: positioned, cols, rows } = layoutServiceGraph(serviceGraph);
  if (positioned.length === 0) {
    return <p className="muted">Nothing deployed yet — the map fills in once this poppy creates resources.</p>;
  }
  const VB_W = PAD * 2 + Math.max(cols, 1) * CELL_W;
  const VB_H = PAD * 2 + Math.max(rows, 1) * CELL_H;
  const at = new Map(positioned.map((n) => [n.service, cellCenter(n)]));
  const statusOf = new Map(positioned.map((n) => [n.service, n.status]));
  const hasRemoved = positioned.some((n) => n.status === "removed");
  const hasUnverified = positioned.some((n) => n.status === "unverified");
  const selNode = positioned.find((n) => n.service === selected) ?? null;

  return (
    <div className="infra-map">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        width="100%"
        role="img"
        aria-label={`Infrastructure map: ${positioned.length} service(s) — ${positioned.map((n) => `${label(n.service)} ${statusLabel(n.status)}`).join(", ")}`}
      >
        <defs>
          {positioned
            .filter((n) => n.status !== "removed")
            .map((n) => {
              const c = serviceColor(n.service);
              return (
                <radialGradient key={n.service} id={`sph-${n.service}`} cx="35%" cy="28%" r="78%">
                  <stop offset="0%" stopColor={shade(c, 0.5)} />
                  <stop offset="55%" stopColor={c} />
                  <stop offset="100%" stopColor={shade(c, -0.32)} />
                </radialGradient>
              );
            })}
        </defs>

        {serviceGraph.edges.map((e, i) => {
          const a = at.get(e.from);
          const b = at.get(e.to);
          if (!a || !b) return null;
          const live = statusOf.get(e.from) === "present" && statusOf.get(e.to) === "present";
          const d = trimmed(a, b);
          return (
            <g key={i}>
              <path d={d} fill="none" stroke="var(--border)" strokeWidth={2} opacity={0.9} />
              {live && (
                <circle r={3} fill="var(--primary)">
                  <animateMotion dur="2.6s" repeatCount="indefinite" path={d} />
                </circle>
              )}
            </g>
          );
        })}

        {positioned.map((n) => {
          const p = at.get(n.service)!;
          const removed = n.status === "removed";
          const unverified = n.status === "unverified";
          const isSel = n.service === selected;
          return (
            <g
              key={n.service}
              className={`infra-node${isSel ? " infra-node--selected" : ""}`}
              role="button"
              aria-pressed={isSel}
              aria-label={`${label(n.service)}, ${n.count} resource${n.count === 1 ? "" : "s"}, ${statusLabel(n.status)} — click to expand`}
              onClick={() => setSelected(isSel ? null : n.service)}
            >
              {!removed && <circle cx={p.x} cy={p.y} r={R + 7} fill={serviceColor(n.service)} opacity={0.13} />}
              {isSel && <circle cx={p.x} cy={p.y} r={R + 5} fill="none" stroke="var(--primary)" strokeWidth={2} />}
              {unverified && (
                <circle cx={p.x} cy={p.y} r={R + 3} fill="none" stroke="var(--warn)" strokeWidth={2} strokeDasharray="3 4">
                  <animate attributeName="opacity" values="0.4;1;0.4" dur="1.8s" repeatCount="indefinite" />
                </circle>
              )}
              <circle
                className="infra-sphere"
                cx={p.x}
                cy={p.y}
                r={R}
                fill={removed ? REMOVED_FILL : `url(#sph-${n.service})`}
                opacity={removed ? 0.45 : 1}
              />
              <text
                x={p.x}
                y={p.y + 5}
                textAnchor="middle"
                fontSize={14}
                fontWeight={700}
                fill="#ffffff"
                opacity={removed ? 0.55 : 0.96}
                style={{ pointerEvents: "none" }}
              >
                {serviceAbbr(n.service)}
              </text>
              {n.count > 1 && (
                <>
                  <circle cx={p.x + R - 5} cy={p.y - R + 5} r={9} fill="var(--surface-0)" stroke="var(--border)" strokeWidth={1} />
                  <text
                    x={p.x + R - 5}
                    y={p.y - R + 8.5}
                    textAnchor="middle"
                    fontSize={10}
                    fontWeight={700}
                    fill="var(--text)"
                    style={{ pointerEvents: "none" }}
                  >
                    {n.count}
                  </text>
                </>
              )}
              <text x={p.x} y={p.y + R + 18} textAnchor="middle" fontSize={12.5} fontWeight={600} fill="var(--text)" opacity={removed ? 0.55 : 1}>
                {label(n.service)}
              </text>
              {n.status !== "present" && (
                <text x={p.x} y={p.y + R + 32} textAnchor="middle" fontSize={10.5} fill={removed ? "var(--muted)" : "var(--warn)"}>
                  {statusLabel(n.status)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {selNode && (
        <div className="infra-panel">
          <div className="infra-panel__head">
            <strong>{label(selNode.service)}</strong>
            <span className="infra-pill" data-status={selNode.status}>{statusLabel(selNode.status)}</span>
            <span className="muted">
              {selNode.count} {selNode.count === 1 ? "resource" : "resources"}
            </span>
            <button className="infra-panel__close" onClick={() => setSelected(null)} aria-label="Close resource list">
              ×
            </button>
          </div>
          <ul className="infra-reslist">
            {selNode.resources.map((r) => (
              <li key={r.id} className="infra-res">
                <span className="infra-res__dot" data-status={r.status} />
                <span className="infra-res__name" title={r.name}>
                  {r.name}
                </span>
                <span className="infra-res__type">{prettyType(r.resourceType)}</span>
                <span className="infra-res__region">{r.region}</span>
                {r.consoleUrl ? (
                  <a
                    className="infra-res__link"
                    href={r.consoleUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => {
                      e.preventDefault();
                      openExternal(r.consoleUrl!);
                    }}
                  >
                    Open in console ↗
                  </a>
                ) : (
                  <span className="infra-res__link infra-res__link--off">{statusLabel(r.status)}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="infra-legend">
        <span>
          <span className="infra-dot" style={{ background: "#8aa0c8" }} /> present
        </span>
        {hasUnverified && (
          <span>
            <span className="infra-dot infra-dot--ring" /> verifying
            <button
              type="button"
              className="help-btn"
              aria-expanded={showVerifyingHelp}
              aria-label={`What does "verifying" mean?`}
              onClick={() => setShowVerifyingHelp((v) => !v)}
            >
              ?
            </button>
          </span>
        )}
        {hasRemoved && (
          <span>
            <span className="infra-dot" style={{ background: REMOVED_FILL, opacity: 0.5 }} /> removed
          </span>
        )}
        <span className="muted">click a service to see its resources</span>
      </div>

      {hasUnverified && showVerifyingHelp && (
        <p className="help-note" role="note">
          <strong>“Verifying”</strong> means AgentsPoppy couldn’t independently confirm this resource
          exists. AWS’s tag index can lag for a while after a service is created or torn down, so one
          can linger here briefly even after it’s gone. Open the resource’s <em>“Open in console”</em>
          link — if AWS shows it as <em>not found</em>, it’s already been torn down and will drop off
          here once AWS catches up.
        </p>
      )}
    </div>
  );
}
