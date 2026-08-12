// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Local JSON-backed persistence for the broker: connected accounts, connections,
 * and per-connection audit. Single-operator, local-first — stored under
 * ~/.agentspoppy/state.json (override with AGENTSPOPPY_HOME, mainly for tests).
 *
 * Each method is read-modify-write, SERIALIZED through an in-process mutex (many
 * poppy backends hit the broker concurrently at app open — see `locked`), with
 * atomic write-then-rename persistence. Credential material is NOT stored here —
 * that is the (deliberately deferred) secure custody layer; see providers.ts.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { ApprovalRequest, AuditEntry, ConnectedAccount, Connection } from "@agentspoppy/core";

export interface BrokerState {
  accounts: ConnectedAccount[];
  connections: Connection[];
  /** connectionId → audit entries. */
  audit: Record<string, AuditEntry[]>;
  /** Supervised-mode approval requests (pending + recently decided). */
  approvals: ApprovalRequest[];
  /** Extension ids (manifest.id) the host must REFUSE to load/run — the local
   *  rung-1 blocklist. A blocked poppy's backend is never spawned (and a running
   *  one is killed), even if it's on disk. Reversible via unblock. */
  blockedExtensions: string[];
}

/** Where AgentsPoppy keeps everything of its own. Exported because per-poppy data
 *  directories hang off it too (registry.ts), and there must be exactly one answer. */
export function agentsPoppyHome(): string {
  return process.env.AGENTSPOPPY_HOME ?? join(homedir(), ".agentspoppy");
}

const homeDir = agentsPoppyHome;

function statePath(): string {
  return join(homeDir(), "state.json");
}

export class Store {
  /**
   * Serializes every state access. Each method is read-modify-write on one shared
   * file, and at app open MANY poppy backends mint concurrently — unserialized,
   * two interleaved mutations lose one of the writes (the classic race: a poppy's
   * just-parked supervised approval was erased by another poppy's audit append,
   * so its poll answered "approval not found"). A promise chain is a sufficient
   * mutex for the single broker process that owns this file.
   */
  private chain: Promise<unknown> = Promise.resolve();
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    // Keep the chain alive whether fn resolves or rejects (a failed write must not
    // wedge every later operation), while callers still see the real outcome.
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<BrokerState> {
    try {
      const raw = await fs.readFile(statePath(), "utf8");
      const p = JSON.parse(raw) as Partial<BrokerState>;
      return {
        accounts: p.accounts ?? [],
        connections: p.connections ?? [],
        audit: p.audit ?? {},
        approvals: p.approvals ?? [],
        blockedExtensions: p.blockedExtensions ?? [],
      };
    } catch {
      return { accounts: [], connections: [], audit: {}, approvals: [], blockedExtensions: [] };
    }
  }

  private async write(state: BrokerState): Promise<void> {
    const path = statePath();
    await fs.mkdir(dirname(path), { recursive: true });
    // Atomic replace: a reader must never see a half-written file — parsing a torn
    // JSON falls back to EMPTY state, and the next mutation would persist that
    // emptiness (total state loss). Write-then-rename makes that impossible.
    const tmp = `${path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(tmp, path);
  }

  listAccounts(): Promise<ConnectedAccount[]> {
    return this.locked(async () => {
      return (await this.read()).accounts;
    });
  }

  addAccount(account: ConnectedAccount): Promise<void> {
    return this.locked(async () => {
      const s = await this.read();
      s.accounts.push(account);
      await this.write(s);
    });
  }

  /**
   * Forget an account locally, cascading to any connections tied to it (and their
   * audit), so nothing is orphaned. Does NOT touch cloud resources. No-op if the
   * account doesn't exist.
   */
  removeAccount(id: string): Promise<void> {
    return this.locked(async () => {
      const s = await this.read();
      if (!s.accounts.some((a) => a.id === id)) return;
      s.accounts = s.accounts.filter((a) => a.id !== id);
      const goneConnIds = new Set(s.connections.filter((c) => c.accountId === id).map((c) => c.id));
      for (const cid of goneConnIds) delete s.audit[cid];
      s.connections = s.connections.filter((c) => c.accountId !== id);
      s.approvals = s.approvals.filter((a) => !goneConnIds.has(a.connectionId));
      await this.write(s);
    });
  }

  /** Replace an account by id. No-op if it doesn't exist. */
  updateAccount(account: ConnectedAccount): Promise<void> {
    return this.locked(async () => {
      const s = await this.read();
      const i = s.accounts.findIndex((a) => a.id === account.id);
      if (i < 0) return;
      s.accounts[i] = account;
      await this.write(s);
    });
  }

  listConnections(): Promise<Connection[]> {
    return this.locked(async () => {
      return (await this.read()).connections;
    });
  }

  getConnection(id: string): Promise<Connection | undefined> {
    return this.locked(async () => {
      return (await this.read()).connections.find((c) => c.id === id);
    });
  }

  /** Insert or replace a connection by id. */
  putConnection(connection: Connection): Promise<void> {
    return this.locked(async () => {
      const s = await this.read();
      const i = s.connections.findIndex((c) => c.id === connection.id);
      if (i >= 0) s.connections[i] = connection;
      else s.connections.push(connection);
      await this.write(s);
    });
  }

  /**
   * Drop a connection record entirely, cascading to its audit and any approvals
   * so nothing is orphaned. Used to clear a revoked connection from the list.
   * No-op if it doesn't exist.
   */
  removeConnection(id: string): Promise<void> {
    return this.locked(async () => {
      const s = await this.read();
      if (!s.connections.some((c) => c.id === id)) return;
      s.connections = s.connections.filter((c) => c.id !== id);
      delete s.audit[id];
      s.approvals = s.approvals.filter((a) => a.connectionId !== id);
      await this.write(s);
    });
  }

  appendAudit(connectionId: string, entry: AuditEntry): Promise<void> {
    return this.locked(async () => {
      const s = await this.read();
      (s.audit[connectionId] ??= []).push(entry);
      await this.write(s);
    });
  }

  getAudit(connectionId: string): Promise<AuditEntry[]> {
    return this.locked(async () => {
      return (await this.read()).audit[connectionId] ?? [];
    });
  }

  // --- supervised-mode approvals ---

  listApprovals(): Promise<ApprovalRequest[]> {
    return this.locked(async () => {
      return (await this.read()).approvals;
    });
  }

  getApproval(id: string): Promise<ApprovalRequest | undefined> {
    return this.locked(async () => {
      return (await this.read()).approvals.find((a) => a.id === id);
    });
  }

  addApproval(approval: ApprovalRequest): Promise<void> {
    return this.locked(async () => {
      const s = await this.read();
      s.approvals.push(approval);
      await this.write(s);
    });
  }

  /**
   * Atomically find an approval matching `match`, or park `candidate` if none does.
   * The find and the add happen under ONE lock — two concurrent requests for the
   * same operation converge on a single approval instead of each parking its own
   * (which showed the user two authorization prompts for one poppy open).
   */
  findOrAddApproval(
    candidate: ApprovalRequest,
    match: (a: ApprovalRequest) => boolean,
  ): Promise<{ approval: ApprovalRequest; created: boolean }> {
    return this.locked(async () => {
      const s = await this.read();
      const hit = s.approvals.find(match);
      if (hit) return { approval: hit, created: false };
      s.approvals.push(candidate);
      await this.write(s);
      return { approval: candidate, created: true };
    });
  }

  /** Replace an approval by id. No-op if it doesn't exist. */
  updateApproval(approval: ApprovalRequest): Promise<void> {
    return this.locked(async () => {
      const s = await this.read();
      const i = s.approvals.findIndex((a) => a.id === approval.id);
      if (i < 0) return;
      s.approvals[i] = approval;
      await this.write(s);
    });
  }

  // --- extension blocklist (rung-1 local ban) ---

  listBlockedExtensions(): Promise<string[]> {
    return this.locked(async () => {
      return (await this.read()).blockedExtensions;
    });
  }

  /** Add an extension id to the blocklist (idempotent). */
  blockExtension(id: string): Promise<void> {
    return this.locked(async () => {
      const s = await this.read();
      if (!s.blockedExtensions.includes(id)) {
        s.blockedExtensions.push(id);
        await this.write(s);
      }
    });
  }

  /** Remove an extension id from the blocklist (idempotent). */
  unblockExtension(id: string): Promise<void> {
    return this.locked(async () => {
      const s = await this.read();
      if (s.blockedExtensions.includes(id)) {
        s.blockedExtensions = s.blockedExtensions.filter((x) => x !== id);
        await this.write(s);
      }
    });
  }
}
