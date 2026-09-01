// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The one-time notice that the operator secret moved into the OS vault
 * (docs/specs/operator-key-custody.md).
 *
 * Why it exists (founder, 2026-09-01): the migration ran silently on their own machine
 * and they asked "how do I know if the key has actually migrated?" — a security change
 * of this significance must announce itself once, not wait to be discovered in a panel.
 * Once: dismissal is remembered per machine; the connection panel keeps the permanent
 * custody line for anyone who looks later.
 */
import { useEffect, useState } from "react";
import { broker } from "../api/broker";
import { Icon } from "./Icon";

const SEEN_KEY = "agentspoppy.custodyNoticeSeen";

export function CustodyNotice({
  loadInfo = () => broker.operatorKeyInfo(),
}: {
  loadInfo?: () => Promise<{ profileKeyId: string | null; secretCustody?: "keychain" | "file" | "none"; vaultName?: string }>;
}) {
  const [show, setShow] = useState(false);
  const [vault, setVault] = useState("OS keyring");
  useEffect(() => {
    let gone = false;
    try {
      if (localStorage.getItem(SEEN_KEY)) return;
    } catch {
      /* storage unavailable — show at most this session */
    }
    loadInfo()
      .then((i) => {
        if (!gone && i.profileKeyId && i.secretCustody === "keychain") { setVault(i.vaultName ?? "OS keyring"); setShow(true); }
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [loadInfo]);

  if (!show) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* per-session dismissal is still fine */
    }
    setShow(false);
  };
  return (
    <div className="banner banner-row custody-notice" role="status">
      <div>
        <strong>
          <Icon name="shield" /> Your AWS secret key now lives in the {vault}.
        </strong>{" "}
        It was moved out of <code>~/.aws/credentials</code> — only after the stored copy was verified —
        so no file on this computer holds it any more. Your other AWS profiles and tools are untouched.
        Details are under Manage your AWS connection.
      </div>
      <button className="btn" onClick={dismiss}>
        Got it
      </button>
    </div>
  );
}
