// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Always-visible sidebar panel: is AgentsPoppy connected to AWS, can it actually
 * OPERATE the account (policy health), and which region are we in — plus a one-click
 * fix that lands on the right step. Driven by the same "can we assume the broker role"
 * signal the per-connection map uses, so it never disagrees with a poppy's own banner.
 */
import { RegionSwitcher } from "./RegionSwitcher";

/** Connection + policy health, worst-to-best. */
export type AwsHealth = "checking" | "disconnected" | "unreachable" | "unauthorized" | "healthy";

type Tone = "muted" | "on" | "warn" | "bad";
/** What a fix button does: start onboarding, re-enter credentials, or update the IAM policy. */
export type FixAction = "connect" | "change-creds" | "update-policy";
interface Display {
  tone: Tone;
  label: string;
  note?: string;
  fix?: { label: string; action: FixAction };
}

/** Map a health state to what the panel shows + which fix it offers. */
export function healthDisplay(health: AwsHealth): Display {
  switch (health) {
    case "checking":
      return { tone: "muted", label: "Checking connection…" };
    case "disconnected":
      return {
        tone: "muted",
        label: "Not connected",
        note: "Connect an AWS account so AgentsPoppy can guard how your apps use it.",
        fix: { label: "Connect AWS", action: "connect" },
      };
    case "unreachable":
      return {
        tone: "bad",
        label: "Can't reach AWS",
        note: "Your operator credentials are invalid or expired.",
        fix: { label: "Reconnect", action: "change-creds" },
      };
    case "unauthorized":
      return {
        tone: "warn",
        label: "Access needs a fix",
        note: "Connected, but this user can't operate the account yet — its AWS policy needs updating.",
        fix: { label: "Fix access", action: "update-policy" },
      };
    case "healthy":
      return { tone: "on", label: "Connected" };
  }
}

const TONE_CLASS: Record<Tone, string> = { muted: "", on: "is-on", warn: "is-warn", bad: "is-bad" };

export function AccountHealth({
  health,
  accountId,
  region,
  footprintRegions = [],
  switchingRegion,
  onOpenRegion,
  onSwitchRegion,
  onFix,
}: {
  health: AwsHealth;
  /** The linked AWS account id, shown when healthy. */
  accountId?: string | null;
  region?: string | null;
  footprintRegions?: string[];
  switchingRegion?: boolean;
  onOpenRegion?: () => void;
  onSwitchRegion?: (region: string) => void;
  /** Start the right fix flow (connect / re-enter credentials / update the IAM policy). */
  onFix: (action: FixAction) => void;
}): JSX.Element {
  const d = healthDisplay(health);
  return (
    <div className="acct-health">
      <div className={`acct-health__status ${TONE_CLASS[d.tone]}`}>
        <span className="status-dot" /> {d.label}
      </div>

      {health === "healthy" && accountId && <div className="acct-health__acct">AWS {accountId}</div>}

      {d.note && <p className="acct-health__note">{d.note}</p>}

      {d.fix && (
        <button
          type="button"
          className="btn btn-primary acct-health__fix"
          onClick={() => onFix(d.fix!.action)}
        >
          {d.fix.label}
        </button>
      )}

      {/* Where your poppies operate — always in sight when an account is linked. */}
      {onSwitchRegion && region && (
        <RegionSwitcher
          region={region}
          footprintRegions={footprintRegions}
          switching={switchingRegion}
          onOpen={onOpenRegion}
          onSwitch={onSwitchRegion}
        />
      )}
    </div>
  );
}
