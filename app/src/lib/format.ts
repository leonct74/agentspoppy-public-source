// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import type { ConnectedAccount, Connection } from "@agentspoppy/core";

export interface AccountGroup {
  account: ConnectedAccount;
  /** Connections under this account — "poppies", in the family-brand sense. */
  poppies: Connection[];
}

/** Group connections ("poppies") under the AWS account they belong to. */
export function groupConnectionsByAccount(
  accounts: ConnectedAccount[],
  connections: Connection[],
): AccountGroup[] {
  return accounts.map((account) => ({
    account,
    poppies: connections.filter((c) => c.accountId === account.id),
  }));
}

export function statusLabel(status: Connection["status"]): string {
  switch (status) {
    case "pending":
      return "Awaiting your approval";
    case "active":
      return "Active";
    case "paused":
      return "Paused";
    case "revoked":
      return "Revoked";
  }
}

/** "1 poppy" / "3 poppies" — "poppy" = any app connected to AgentsPoppy. */
export function poppyCount(n: number): string {
  return `${n} ${n === 1 ? "poppy" : "poppies"}`;
}

export function accountLabel(account: ConnectedAccount): string {
  return account.alias ? `${account.alias} (${account.accountId})` : account.accountId;
}

/** A compact "just now" / "12m ago" / "3h ago" / "2d ago" from an ISO timestamp. */
export function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * An absolute date + time in the user's own locale and time zone, e.g.
 * "21 Jun 2026, 14:32" (en-GB) or "Jun 21, 2026, 2:32 PM" (en-US). Empty
 * string for an unparseable timestamp. Uses the runtime locale (no arg).
 */
export function formatDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
