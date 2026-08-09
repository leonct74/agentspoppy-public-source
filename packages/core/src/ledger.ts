// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Append-only provisioning ledger — attribution for out-of-stack mutations.
 *
 * CloudFormation is the source of truth for everything inside a connection's
 * stack(s), but some mutations happen outside a stack via direct API calls
 * (e.g. Route53 records, an SES identity). Those have no CloudFormation record,
 * so we log them here — every create/delete, append-only, tagged with the
 * connection id — so the user can see the *complete* footprint each app touched.
 *
 * Never throws into the caller: a ledger write must never break (or mask) the
 * provisioning operation itself.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { LedgerEntry } from "./types";

function ledgerPath(): string {
  if (process.env.AGENTSPOPPY_LEDGER) return process.env.AGENTSPOPPY_LEDGER;
  const home = process.env.AGENTSPOPPY_HOME ?? join(homedir(), ".agentspoppy");
  return join(home, "provisioning-ledger.json");
}

export async function readLedger(): Promise<LedgerEntry[]> {
  try {
    const raw = await fs.readFile(ledgerPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as LedgerEntry[]) : [];
  } catch {
    return []; // missing/corrupt ledger reads as empty
  }
}

/** Append one or more entries. Best-effort: errors are logged, never thrown. */
export async function record(entries: Array<Omit<LedgerEntry, "ts"> & { ts?: string }>): Promise<void> {
  if (entries.length === 0) return;
  try {
    const path = ledgerPath();
    await fs.mkdir(dirname(path), { recursive: true });
    const existing = await readLedger();
    const now = new Date().toISOString();
    for (const e of entries) existing.push({ ...e, ts: e.ts ?? now });
    await fs.writeFile(path, JSON.stringify(existing, null, 2), "utf8");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("ledger write failed (non-fatal):", err);
  }
}

/** Pure: filter a ledger to a single connection (the per-app footprint). */
export function ledgerForConnection(entries: LedgerEntry[], connectionId: string): LedgerEntry[] {
  return entries.filter((e) => e.connectionId === connectionId);
}
