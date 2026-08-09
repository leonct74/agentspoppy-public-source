// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import type { Connection } from "@agentspoppy/core";
import { statusLabel } from "../lib/format";

export function StatusBadge({ status }: { status: Connection["status"] }) {
  return <span className={`badge badge-${status}`}>{statusLabel(status)}</span>;
}
