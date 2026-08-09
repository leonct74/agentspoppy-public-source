// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { useEffect, useState } from "react";

/**
 * A live mm:ss countdown to an ISO timestamp — used for the short-lived
 * credential session a poppy currently holds. Ticks once a second. When it
 * lapses it says so (the next AWS call re-mints; a supervised poppy re-asks).
 */
export function Countdown({ expiresAt, prefix }: { expiresAt: string; prefix?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const exp = Date.parse(expiresAt);
  if (!Number.isFinite(exp)) return null;

  const ms = exp - now;
  if (ms <= 0) {
    // Self-contained phrase (no `prefix` here): a caller's lead-in like "expires in" only
    // makes sense for a live countdown, not the lapsed state — and short-lived creds simply
    // re-mint on the next AWS call, so say so rather than leave the user wondering.
    return (
      <span className="countdown countdown--expired" title="Expired — renews automatically on the next AWS call (a supervised app re-asks for your approval).">
        expired — renews on next use
      </span>
    );
  }
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return (
    <span className="countdown" title="Time until this app's current credentials expire and must be re-minted">
      {prefix}
      {m}:{String(s).padStart(2, "0")}
    </span>
  );
}
