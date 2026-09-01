// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The everyday key's security panel: its age (the rotation nudge) and the kill
 * switch (docs/specs/operator-key-least-privilege.md §4-5).
 *
 * The kill switch copy is deliberately honest about three things: it revokes THIS
 * computer's key only; it takes effect usually within seconds but IAM is eventually
 * consistent (allow minutes); and sessions already issued live out their remaining
 * hour. Recovery is the normal setup flow with the user's setup credentials.
 */
import { useEffect, useState } from "react";
import { ApiError, broker } from "../api/broker";
import { Icon } from "./Icon";

const ROTATION_NUDGE_DAYS = 90;

/** Module-level on purpose — a default-parameter closure re-triggers the effect every render. */
const defaultLoadInfo = (): Promise<{ profileKeyId: string | null; mintedAt: string | null; secretCustody?: "keychain" | "file" | "none"; vaultName?: string }> =>
  broker.operatorKeyInfo();
const defaultRevoke = (): Promise<{ deletedKeyId: string; alreadyGone: boolean }> => broker.revokeOperatorKey();

export function keyAgeDays(mintedAt: string, now: Date = new Date()): number | null {
  const t = Date.parse(mintedAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / (24 * 60 * 60 * 1000)));
}

type RevokePhase =
  | { kind: "idle" }
  | { kind: "confirm" }
  | { kind: "working" }
  | { kind: "done"; alreadyGone: boolean }
  | { kind: "failed"; message: string };

export function KeySecurityPanel({
  onRevoked,
  loadInfo = defaultLoadInfo,
  revoke = defaultRevoke,
}: {
  /** Called after a successful revoke, so the app re-probes identity (now dead). */
  onRevoked?: () => void;
  /** Injected in tests. */
  loadInfo?: () => Promise<{ profileKeyId: string | null; mintedAt: string | null; secretCustody?: "keychain" | "file" | "none"; vaultName?: string }>;
  revoke?: () => Promise<{ deletedKeyId: string; alreadyGone: boolean }>;
}) {
  const [info, setInfo] = useState<{ profileKeyId: string | null; mintedAt: string | null; secretCustody?: "keychain" | "file" | "none"; vaultName?: string } | null>(null);
  const [phase, setPhase] = useState<RevokePhase>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    void loadInfo()
      .then((i) => {
        if (!cancelled) setInfo(i);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [loadInfo]);

  if (!info?.profileKeyId) return null;
  const age = info.mintedAt ? keyAgeDays(info.mintedAt) : null;

  const doRevoke = async () => {
    setPhase({ kind: "working" });
    try {
      const res = await revoke();
      setPhase({ kind: "done", alreadyGone: res.alreadyGone });
      onRevoked?.();
    } catch (err) {
      const message =
        err instanceof ApiError && (err.code === "not_operator" || err.code === "setup_outdated")
          ? err.message
          : `The key was NOT revoked: ${(err as Error).message ?? "unknown error"}. Nothing on this machine was changed.`;
      setPhase({ kind: "failed", message });
    }
  };

  if (phase.kind === "done") {
    return (
      <div className="panel" data-testid="key-security">
        <h3>
          <Icon name="shield" /> This computer's key
        </h3>
        <p className="ok">
          <Icon name="check" />{" "}
          {phase.alreadyGone
            ? "That key was already dead in AWS (revoked elsewhere) — it has now been removed from this machine too."
            : "The key was revoked and removed from this machine. New sign-ins with it fail from now on (usually within seconds — AWS can take a few minutes); anything already running stops within the hour."}
        </p>
        <p className="muted">
          This computer is now disconnected. To reconnect, run setup again with your setup credentials —
          about two minutes.
        </p>
      </div>
    );
  }

  return (
    <div className="panel" data-testid="key-security">
      <h3>
        <Icon name="shield" /> This computer's key
      </h3>
      <p className="muted">
        Key <code>{info.profileKeyId}</code>
        {age !== null ? <> · created {age === 0 ? "today" : `${age} day${age === 1 ? "" : "s"} ago`}</> : null}
        {/* Custody, phase 2: where the SECRET half lives. The founder's positioning line —
            safer than the old way of keeping a key in a file — earned only when true, so
            "file" states it plainly rather than pretending. */}
        {info.secretCustody === "keychain" ? (
          <> · secret in the {info.vaultName ?? "OS keyring"} — not in any file</>
        ) : info.secretCustody === "file" ? (
          <> · secret in ~/.aws/credentials</>
        ) : null}
      </p>
      {age !== null && age >= ROTATION_NUDGE_DAYS && (
        <p className="inline-warning">
          This key is over {ROTATION_NUDGE_DAYS} days old. Rotating it takes about two minutes: run{" "}
          <strong>Update setup</strong> with your setup credentials, and this machine gets a fresh key (old
          backups and copies of the old one become useless).
        </p>
      )}
      {phase.kind === "idle" && (
        <button className="btn danger" onClick={() => setPhase({ kind: "confirm" })}>
          Revoke this computer's key…
        </button>
      )}
      {phase.kind === "confirm" && (
        <div className="inline-warning" role="alert">
          <p>
            <strong>Think this computer (or a backup of it) is compromised?</strong> Revoking deletes this
            computer's key in AWS — it can never be used again, here or anywhere. It usually takes effect in
            seconds (AWS can take a few minutes), and sessions already issued expire within the hour. Other
            computers' keys are untouched. Reconnecting takes ~2 minutes of setup with your setup
            credentials.
          </p>
          <button className="btn danger" onClick={() => void doRevoke()}>
            Revoke the key now
          </button>
          <button className="btn link" onClick={() => setPhase({ kind: "idle" })}>
            Cancel
          </button>
        </div>
      )}
      {phase.kind === "working" && <p className="muted">Revoking…</p>}
      {phase.kind === "failed" && (
        <p className="inline-error" role="alert">
          {phase.message}
        </p>
      )}
    </div>
  );
}
