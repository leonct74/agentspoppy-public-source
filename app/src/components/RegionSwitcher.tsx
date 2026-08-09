// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The sidebar AWS-region control: an always-visible chip showing the linked account's region,
 * and a guided switch. This is the region AgentsPoppy reads your cloud in and sets up NEW work in.
 * Switching restarts the account's poppies — but a poppy already deployed in another region keeps
 * operating there (each pins itself to where its own resources live), so this never moves or breaks
 * a running deployment. The panel shows where your poppies' resources actually live and warns when
 * you're about to point AgentsPoppy at a region with none.
 */
import { useState } from "react";
import { AWS_REGIONS, regionLabel } from "../lib/regions";

export function RegionSwitcher({
  region,
  footprintRegions,
  switching,
  onOpen,
  onSwitch,
}: {
  /** The linked account's current region, or null when no account is linked yet. */
  region: string | null;
  /** Regions where this account's poppies actually have resources (for the mismatch warning). */
  footprintRegions: string[];
  switching?: boolean;
  /** Called when the panel opens, so the host can (best-effort) load `footprintRegions`. */
  onOpen?: () => void;
  onSwitch: (region: string) => void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(region ?? "");

  if (!region) return null; // no linked account → nothing to switch

  const toggle = () => {
    if (!open) {
      setSelected(region);
      onOpen?.();
    }
    setOpen((o) => !o);
  };

  const changed = selected !== "" && selected !== region;
  const mismatch = changed && footprintRegions.length > 0 && !footprintRegions.includes(selected);

  return (
    <div className="region-switcher">
      <button
        type="button"
        className="region-chip"
        onClick={toggle}
        aria-expanded={open}
        title="AgentsPoppy's active AWS region — where it reads your cloud and sets up new things"
      >
        <span className="region-dot" />
        <span className="region-chip__id">{region}</span>
        <span className="region-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="region-pop" role="dialog" aria-label="Switch AWS region">
          <div className="region-pop__head">AWS region</div>
          <p className="region-pop__hint">
            The region AgentsPoppy reads your cloud in and sets up new things in. An app you’ve already
            deployed in another region keeps running there — this won’t move it.
          </p>
          {footprintRegions.length > 0 && (
            <p className="region-pop__found">
              Your apps’ resources are in:{" "}
              {footprintRegions.map((r, i) => (
                <span key={r}>
                  {i > 0 && ", "}
                  <strong>{r}</strong>
                </span>
              ))}
            </p>
          )}
          <label className="region-pop__label">
            Switch to
            <select
              className="region-select"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={switching}
            >
              {AWS_REGIONS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id} · {r.label}
                </option>
              ))}
            </select>
          </label>

          {mismatch && (
            <p className="region-pop__warn" role="alert">
              Your apps have no resources in <strong>{selected}</strong>. Switching here will make
              them look in the wrong place — pick the region your resources are in.
            </p>
          )}

          {changed && (
            <p className="region-pop__consequence">
              This restarts your connected apps and points new setups at {regionLabel(selected)}. Anything
              already deployed in another region keeps running where it is.
            </p>
          )}

          <div className="region-pop__actions">
            <button type="button" className="btn" onClick={() => setOpen(false)} disabled={switching}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!changed || switching}
              onClick={() => {
                onSwitch(selected);
                setOpen(false);
              }}
            >
              {switching ? "Switching…" : `Switch to ${selected}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
