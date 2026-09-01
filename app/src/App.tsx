// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalRequest, AuditEntry, ConnectedAccount, Connection, InfraGraph, Inventory, ResidualResource } from "@agentspoppy/core";
import { assessPermissionSet } from "@agentspoppy/core";
import { ApiError, broker, type ActivityReport, type ConnectionActivityReport, type ExtensionRuntimeState } from "./api/broker";
import { groupConnectionsByAccount } from "./lib/format";
import { brokerRoleArnFor } from "./lib/brokerRole";
import { initApprovalActions, notifyPendingApprovals } from "./lib/notify";
import { ConnectionsView } from "./views/ConnectionsView";
import { ConnectionDetailView } from "./views/ConnectionDetailView";
import { ConnectAwsView } from "./views/ConnectAwsView";
import { ActivityView } from "./views/ActivityView";
import { DirectoryView } from "./views/DirectoryView";
import { PurchasesView } from "./views/PurchasesView";
import { OnboardingSplash } from "./views/OnboardingSplash";
import { ApprovalsBar } from "./components/ApprovalsBar";
import { UpdateBanner } from "./components/UpdateBanner";
import { CustodyNotice } from "./components/CustodyNotice";
import { SetupUpdateBanner } from "./components/SetupUpdateBanner";
import { OperatorKeyBanner } from "./components/OperatorKeyBanner";
import { WhatsNew } from "./components/WhatsNew";
import { Sidebar, type ActiveSection } from "./components/Sidebar";
import { Icon } from "./components/Icon";
import { poppyAccent } from "./lib/poppyAccent";
import { parseDeepLink } from "./lib/deepLink";
import type { AwsHealth } from "./components/AccountHealth";
import { ExtensionFrame } from "./extensions/ExtensionFrame";
import { emitHostEvent } from "./extensions/hostEvents";
import { createBrokerHostBridge } from "./extensions/hostBridge";
import { extensionFrontendUrl } from "./extensions/frontends";

type View =
  | { type: "list" }
  | { type: "detail"; id: string }
  | { type: "connect"; action?: "change-creds" | "redeploy" | "update-policy" }
  | { type: "activity" }
  | { type: "directory"; focus?: string }
  | { type: "purchases" }
  | { type: "extension"; id: string };

function errMessage(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

// Plain-language fallback when the on-machine engine can't be reached at all.
// This is an app-startup failure, not an AWS one — so it must not mention "cloud".
const ENGINE_DOWN_MSG = "AgentsPoppy didn't start properly. Please close and reopen the app.";

export function App() {
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [view, setView] = useState<View>({ type: "list" });
  // Bumped whenever setup may have changed, so the staleness banner re-checks instead of
  // nagging a user who has just re-applied.
  const [setupCheckKey, setSetupCheckKey] = useState(0);
  // Where Purchases' back arrow returns to — the view the user was on when they opened it.
  const purchasesReturnTo = useRef<View>({ type: "list" });
  // Extensions opened this session. We keep their iframes MOUNTED (just hidden when you
  // navigate elsewhere) so a long-running flow inside — e.g. a deploy with live progress
  // steps — survives moving between screens instead of reloading and losing its state.
  const [openedExt, setOpenedExt] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [splashSeen, setSplashSeen] = useState(false);
  // Rail mode: collapse the sidebar to icons so the active poppy gets more screen. Persisted.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("ap.sidebarCollapsed") === "1",
  );
  const [activity, setActivity] = useState<ActivityReport | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [extensions, setExtensions] = useState<ExtensionRuntimeState[]>([]);
  // Sidebar region switcher: where this account's poppies actually have resources (loaded lazily
  // when the switcher opens, to warn on a region mismatch), and the in-flight switch state.
  const [footprintRegions, setFootprintRegions] = useState<string[]>([]);
  const [switchingRegion, setSwitchingRegion] = useState(false);
  // Account role-ARN repair (the account can lack the role AgentsPoppy assumes to vend creds).
  const [repairingRole, setRepairingRole] = useState(false);
  const [roleRepairError, setRoleRepairError] = useState<string | null>(null);
  // Live connection + policy health for the always-visible sidebar panel. The operator
  // credentials are shared by every AWS client in the broker, so when they lapse or lack a
  // permission, EVERY app's map goes blank — this surfaces that once, up top, with a fix.
  const [awsHealth, setAwsHealth] = useState<AwsHealth>("checking");
  // Is THIS machine standing on the restricted operator key? null = not yet known / no
  // account. It decides which of the two setup banners may show: on a setup key the step-0
  // switch owns the flow (and its one action also re-applies the template), so the staleness
  // banner must stay quiet — showing both is two primary buttons for one job (field report
  // 2026-08-30). docs/specs/operator-key-least-privilege.md.
  const [machineIsOperator, setMachineIsOperator] = useState<boolean | null>(null);

  // Installed extensions + their runtime state (container model) — local broker call.
  const refreshExtensions = useCallback(() => {
    void broker
      .listExtensions()
      .then(setExtensions)
      .catch(() => {
        /* none / transient — keep the last good state */
      });
  }, []);

  // Installed poppies with a newer version waiting in the catalog, as id → new version. Drives
  // the Poppies nav badge (its size) AND the in-poppy "an update is available" banner (per id),
  // so the user is told without opening the catalog. The catalog is remote, so this is
  // best-effort (a blip keeps the last known map) and refreshed sparingly: on startup, on a
  // slow timer, and right after any install/update.
  const [updatablePoppies, setUpdatablePoppies] = useState<Record<string, string>>({});
  const refreshUpdates = useCallback(() => {
    void broker
      .directoryCatalog()
      .then((cat) => {
        const map: Record<string, string> = {};
        for (const p of cat.poppies) if (p.installed && p.updateAvailable) map[p.id] = p.version;
        setUpdatablePoppies(map);
      })
      .catch(() => {
        /* offline / catalog unreachable — keep the last known map */
      });
  }, []);
  const updatesAvailable = Object.keys(updatablePoppies).length;

  // Best-effort: the activity feed (CloudTrail) is informational and may be
  // unavailable (not enabled, perms), so it must never break the dashboard.
  const refreshActivity = useCallback(() => {
    void broker
      .activity()
      .then(setActivity)
      .catch(() => setActivity(null));
  }, []);

  // Supervised-mode approvals waiting on the user — local broker call, cheap.
  const refreshApprovals = useCallback(() => {
    void broker
      .pendingApprovals()
      .then(setApprovals)
      .catch(() => {
        /* transient — keep showing the last good state */
      });
  }, []);

  // Probe the shared operator credentials (STS GetCallerIdentity). Only meaningful once an
  // account is linked AND the local engine is up (we've just listed accounts): a failure then
  // means AWS itself can't be read — creds invalid/expired — so surface the global reconnect
  // prompt. No account linked yet → that's onboarding, not a reconnect.
  const refreshAwsHealth = useCallback(async (accts: ConnectedAccount[]) => {
    const primary = accts[0];
    if (!primary) {
      setAwsHealth("disconnected");
      setMachineIsOperator(null);
      return;
    }
    // Do the credentials even authenticate? The arn also tells us whether this machine is
    // on the restricted operator key (which of the two setup banners may show).
    try {
      const id = await broker.awsIdentity();
      setMachineIsOperator(id.arn.includes(":user/AgentsPoppyOperator"));
    } catch {
      setAwsHealth("unreachable");
      setMachineIsOperator(null);
      return;
    }
    // They authenticate — but can they actually OPERATE the account? Reading the map and
    // vending both assume the broker role, so use that as the health signal (it matches the
    // per-connection banner, instead of only proving the keys authenticate).
    if (!primary.roleArn) {
      setAwsHealth("healthy");
      return;
    }
    try {
      const r = await broker.verifyAccount(primary.id);
      setAwsHealth(r.ok ? "healthy" : "unauthorized");
    } catch {
      setAwsHealth("unauthorized");
    }
  }, []);

  const refreshList = useCallback(async () => {
    try {
      const [a, c] = await Promise.all([broker.listAccounts(), broker.listConnections()]);
      setAccounts(a);
      setConnections(c);
      setError(null);
      refreshActivity();
      refreshApprovals();
      refreshExtensions();
      void refreshAwsHealth(a);
    } catch (e) {
      setError(errMessage(e, ENGINE_DOWN_MSG));
    }
  }, [refreshActivity, refreshApprovals, refreshExtensions, refreshAwsHealth]);

  // Initial load. The on-machine engine starts alongside the window and can take a
  // moment to come up, so retry quietly for ~10s before surfacing anything — a normal
  // startup should never flash an error. Only if it never answers do we say so.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const [a, c] = await Promise.all([broker.listAccounts(), broker.listConnections()]);
          if (cancelled) return;
          setAccounts(a);
          setConnections(c);
          setError(null);
          refreshActivity();
          refreshApprovals();
          refreshExtensions();
          void refreshAwsHealth(a);
          return;
        } catch {
          if (cancelled) return;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (!cancelled) setError(ENGINE_DOWN_MSG);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshActivity, refreshApprovals, refreshExtensions, refreshAwsHealth]);

  // Re-check the catalog for newly-published poppy updates while the app is open, so the
  // Poppies nav badge lights up on its own. Slow (every 5 min — the broker also caches the
  // catalog 60s) and best-effort; also fired right after any install/uninstall/update below.
  useEffect(() => {
    refreshUpdates();
    const t = setInterval(refreshUpdates, 5 * 60_000);
    return () => clearInterval(t);
  }, [refreshUpdates]);

  // Poll for incoming requests so a connection a poppy opens *after* this window is
  // already up appears on its own — no navigating away and back. These are local
  // broker calls (127.0.0.1, no AWS cost); the CloudTrail activity feed is
  // deliberately NOT polled this often. Transient failures are ignored so a blip
  // never wipes what's on screen.
  useEffect(() => {
    const id = setInterval(() => {
      void (async () => {
        try {
          const [a, c] = await Promise.all([broker.listAccounts(), broker.listConnections()]);
          setAccounts(a);
          setConnections(c);
          refreshApprovals();
          refreshExtensions();
        } catch {
          /* transient — keep showing the last good state */
        }
      })();
    }, 3000);
    return () => clearInterval(id);
  }, [refreshApprovals, refreshExtensions]);

  // Fire a native OS banner when a new supervised-approval request lands, so the
  // user notices even with the window hidden. No-op outside the desktop shell.
  useEffect(() => {
    void notifyPendingApprovals(approvals, connections);
  }, [approvals, connections]);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        await refreshList();
        setError(null);
      } catch (e) {
        setError(errMessage(e, "Something went wrong."));
      }
    },
    [refreshList],
  );

  // Wire the notification's Approve / Deny buttons to the broker, so the user can
  // decide straight from the OS banner without switching to AgentsPoppy.
  useEffect(() => {
    void initApprovalActions({
      approve: (id) => void act(() => broker.approveOperation(id)),
      deny: (id) => void act(() => broker.denyOperation(id)),
    });
  }, [act]);

  // agentspoppy:// links — the website's "Deploy for real" handoff. `onOpenUrl` also
  // replays the launching link when the app was started BY the link (cold start).
  // The link is untrusted input from an arbitrary web page: parseDeepLink accepts
  // only a catalogue id, and the directory resolves that id against the curated
  // catalogue itself — a page can point at a poppy, never define one. The import is
  // dynamic so tests (jsdom, no Tauri IPC) never touch the plugin.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/plugin-deep-link")
      .then(async ({ onOpenUrl }) => {
        const stop = await onOpenUrl((urls) => {
          for (const raw of urls) {
            const link = parseDeepLink(raw);
            if (link) setView({ type: "directory", focus: link.id });
          }
        });
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {
        /* not running under Tauri (tests / plain browser) — deep links don't exist there */
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Remember every extension opened this session so its iframe stays alive (below).
  useEffect(() => {
    if (view.type === "extension") {
      setOpenedExt((prev) => (prev.includes(view.id) ? prev : [...prev, view.id]));
    }
  }, [view]);

  const connected = accounts.length > 0;
  // v1 is single-account; the region control acts on the first linked account.
  const primaryAccount = accounts[0] ?? null;
  const region = primaryAccount?.regions[0] ?? null;

  // Best-effort: union of regions across the account's live poppies' footprints, so the switcher
  // can say "your resources are in eu-west-1" and warn before you point them elsewhere. Loaded on
  // demand (it hits AWS per connection) when the switcher opens.
  const loadFootprintRegions = useCallback(() => {
    const live = connections.filter((c) => c.status === "active" || c.status === "paused");
    void Promise.all(
      live.map((c) =>
        broker
          .infra(c.id)
          .then((g) => g.nodes.map((n) => n.region))
          .catch(() => [] as string[]),
      ),
    ).then((sets) => setFootprintRegions([...new Set(sets.flat())].sort()));
  }, [connections]);

  const switchRegion = useCallback(
    async (newRegion: string) => {
      if (!primaryAccount) return;
      setSwitchingRegion(true);
      try {
        await broker.setAccountRegion(primaryAccount.id, newRegion);
        await refreshList(); // accounts + connections + extensions (backends were restarted broker-side)
      } catch (e) {
        setError(errMessage(e, "Couldn't switch region."));
      } finally {
        setSwitchingRegion(false);
      }
    },
    [primaryAccount, refreshList],
  );

  // Repair an account that has no broker role ARN — the role AgentsPoppy assumes to
  // vend each poppy its scoped credentials. Without it, vending dead-ends and every
  // connected app is starved of credentials (a poppy's setup stalls or errors). We
  // re-derive the (account-global, fixed-name) ARN, re-assign it, then VERIFY it's
  // actually assumable before declaring success — never a blind write. On success we
  // refresh, so backends re-vend working credentials on their next call.
  const needsRoleRepair = primaryAccount != null && !primaryAccount.roleArn;
  const repairRole = useCallback(async () => {
    if (!primaryAccount) return;
    setRepairingRole(true);
    setRoleRepairError(null);
    try {
      const roleArn = brokerRoleArnFor(primaryAccount.accountId, accounts);
      await broker.setAccountRole(primaryAccount.id, roleArn);
      const probe = await broker.verifyAccount(primaryAccount.id);
      if (!probe.ok) {
        setRoleRepairError(
          `AgentsPoppy set the account up but still couldn't get in: ${probe.reason}. Try again in a moment, or double-check this is the right AWS account.`,
        );
        return;
      }
      await refreshList();
    } catch (e) {
      setRoleRepairError(errMessage(e, "Couldn't finish setting up the account. Please try again."));
    } finally {
      setRepairingRole(false);
    }
  }, [primaryAccount, accounts, refreshList]);

  // The intro floats above the app as a dismissible overlay. It shows on EVERY launch
  // (not just first run) and must be closed by hand, so its trust message is always
  // communicated. `splashSeen` is per-session state (deliberately not persisted), so
  // it reappears next launch — but not as you navigate around within a session.
  const showSplash = !splashSeen;

  const activeSection: ActiveSection =
    view.type === "activity"
      ? "activity"
      : view.type === "directory"
        ? "directory"
        : view.type === "purchases"
          ? "purchases"
          : view.type === "extension"
            ? { ext: view.id }
            : "dashboard";
  // Name each installed extension from its connection (falls back to the id).
  const sidebarExtensions = extensions.map((e) => ({
    iconUrl: e.iconUrl,
    id: e.extensionId,
    name: connections.find((c) => c.app.id === e.extensionId)?.app.name ?? e.name ?? e.extensionId,
    backend: e.backend,
  }));

  const pausedCount = sidebarExtensions.filter((e) => e.backend === "paused").length;
  const healthWord =
    awsHealth === "healthy" ? "secured" : awsHealth === "unauthorized" ? "access needs a fix" : awsHealth === "unreachable" ? "credentials down" : "not connected";

  // The 1200px reading cap is for the console's prose. A poppy tab lifts it — the
  // whole window belongs to the poppy (founder, 2026-09-01).
  return (
    <div className={view.type === "extension" ? "shell shell--full" : "shell"}>
      <div className="shell-body">
      <Sidebar
        active={activeSection}
        extensions={sidebarExtensions}
        updatesAvailable={updatesAvailable}
        health={awsHealth}
        accountId={primaryAccount?.accountId ?? null}
        onFixConnection={(action) =>
          setView(action === "connect" ? { type: "connect" } : { type: "connect", action })
        }
        region={region}
        footprintRegions={footprintRegions}
        switchingRegion={switchingRegion}
        onOpenRegion={loadFootprintRegions}
        onSwitchRegion={(r) => void switchRegion(r)}
        onDashboard={() => {
          setView({ type: "list" });
          void refreshList();
        }}
        onDirectory={() => setView({ type: "directory" })}
        onActivity={() => {
          setView({ type: "activity" });
          refreshActivity();
        }}
        onPurchases={() => {
          // Remember where the user came from so Purchases' back arrow is TRUE back
          // navigation (returns to the poppy/screen they left), not a fixed destination.
          if (view.type !== "purchases") purchasesReturnTo.current = view;
          setView({ type: "purchases" });
        }}
        onExtension={(id) => setView({ type: "extension", id })}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() =>
          setSidebarCollapsed((v) => {
            const next = !v;
            localStorage.setItem("ap.sidebarCollapsed", next ? "1" : "0");
            return next;
          })
        }
      />

      {/* A poppy tab runs FLUSH (founder, 2026-09-01): the host's padding — especially
          the 64px at the bottom — cost the poppy real space in an unmaximised window.
          Console views keep the padding; a poppy gets every pixel, and manages its own
          scrolling instead of scrolling inside a scrolling host. */}
      <main className={view.type === "extension" ? "shell-main shell-main--flush" : "shell-main"}>
        {error && <div className="banner banner-error">{error}</div>}

        {needsRoleRepair && primaryAccount && (
          <div className="banner banner-warn banner-row">
            <div>
              <strong>This account needs a quick fix.</strong> AgentsPoppy isn't fully set up for AWS account{" "}
              <code>{primaryAccount.accountId}</code> yet, so your apps can't get the temporary access they need to
              work — that's why their setup can stall. AgentsPoppy can finish this for you.
              {roleRepairError && <div className="banner-sub">{roleRepairError}</div>}
            </div>
            <button className="btn btn-primary" disabled={repairingRole} onClick={() => void repairRole()}>
              {repairingRole ? "Fixing…" : "Fix it"}
            </button>
          </div>
        )}

        <UpdateBanner />
        <CustodyNotice />
        {/* The two setup banners are mutually exclusive by which key this machine holds, so a
            user is never shown two primary buttons for what is really one job (field report
            2026-08-30). On a SETUP key, step 0 owns the flow — one click switches the key AND
            re-applies the current template — so the staleness banner stays quiet. On the
            OPERATOR key, the staleness banner owns re-applying (which needs setup creds). While
            the key is still unknown (machineIsOperator === null), neither shows.
            Not on the connect screen: that IS the fix. */}
        {view.type !== "connect" && machineIsOperator === true && (
          <SetupUpdateBanner
            refreshKey={setupCheckKey}
            onUpdate={() => setView({ type: "connect", action: "redeploy" })}
          />
        )}
        {view.type !== "connect" && machineIsOperator === false && (
          <OperatorKeyBanner
            accountId={primaryAccount?.id ?? null}
            refreshKey={setupCheckKey}
            onSwitched={() => {
              setMachineIsOperator(null); // re-probe identity + staleness after the switch
              setSetupCheckKey((k) => k + 1);
              void refreshList(); // re-reads identity (→ machineIsOperator) via refreshAwsHealth
            }}
            onOpenConnect={() => setView({ type: "connect", action: "redeploy" })}
          />
        )}
        <ApprovalsBar
          approvals={approvals}
          connections={connections}
          onApprove={(aid) => void act(() => broker.approveOperation(aid))}
          onDeny={(aid) => void act(() => broker.denyOperation(aid))}
        />

        {view.type === "list" && (
          <ConnectionsView
            groups={groupConnectionsByAccount(accounts, connections)}
            activity={activity}
            onSelect={(id) => setView({ type: "detail", id })}
            onApprove={(id) => void act(() => broker.approve(id))}
            onDeny={(id) => void act(() => broker.deny(id))}
            onConnect={() => setView({ type: "connect" })}
            onViewActivity={() => setView({ type: "activity" })}
            onManageAws={(action) => setView({ type: "connect", action })}
            onDisconnect={(accountId) => void act(() => broker.unlinkAccount(accountId))}
            onForget={(id) => void act(() => broker.forget(id))}
            onOpenDirectory={() => setView({ type: "directory" })}
          />
        )}

        {view.type === "directory" && (
          <DirectoryView
            focusId={view.focus}
            onInstalled={() => {
              refreshExtensions();
              refreshUpdates();
            }}
            onOpenPoppy={(id) => setView({ type: "extension", id })}
            onUninstalled={(id) => {
              // Close the poppy's kept-alive tab (its files are gone) and refresh
              // the sidebar right away instead of waiting on the 3s poll.
              setOpenedExt((prev) => prev.filter((x) => x !== id));
              void refreshExtensions();
              refreshUpdates();
            }}
            onUpdated={(id) => {
              // Remount the poppy's kept-alive tab so it reloads on the new build (its
              // frontend files were just swapped), and re-count the pending updates.
              setOpenedExt((prev) => prev.filter((x) => x !== id));
              void refreshExtensions();
              refreshUpdates();
            }}
          />
        )}

        {view.type === "activity" && (
          <ActivityView
            report={activity}
            onBack={() => {
              setView({ type: "list" });
              refreshActivity();
            }}
          />
        )}

        {view.type === "purchases" && (
          <PurchasesView
            poppyNames={Object.fromEntries(sidebarExtensions.map((e) => [e.id, e.name]))}
            onBack={() => setView(purchasesReturnTo.current)}
          />
        )}

        {view.type === "connect" && (
          <ConnectAwsView
            accounts={accounts}
            initialAction={view.action}
            onBack={() => {
              setView({ type: "list" });
              void refreshList();
              setSetupCheckKey((n) => n + 1); // leaving setup = re-read what's deployed
            }}
            onChanged={() => {
              void refreshList();
              setSetupCheckKey((n) => n + 1);
            }}
          />
        )}

        {view.type === "detail" && (
          <DetailContainer
            id={view.id}
            onBack={() => {
              setView({ type: "list" });
              void refreshList();
            }}
            onAct={act}
            onReconnect={() => setView({ type: "connect", action: "change-creds" })}
            onOpenExtension={(extId) => setView({ type: "extension", id: extId })}
            blockedExtensionIds={extensions.filter((e) => e.backend === "blocked").map((e) => e.extensionId)}
            onUpdatePolicy={() => setView({ type: "connect", action: "update-policy" })}
            machineGateFor={(connectionId) => extensions.find((e) => e.connectionId === connectionId)?.machineGate}
          />
        )}

        {/* A poppy update is surfaced from WITHIN the poppy too — not only in the catalog — so
            you're told while using it. It leads to the audit review in Poppies (the host owns the
            package lifecycle; a sandboxed poppy can't update its own files). */}
        {view.type === "extension" && updatablePoppies[view.id] && (
          <div className="banner banner-row banner-update">
            <div>
              <strong>{sidebarExtensions.find((e) => e.id === view.id)?.name ?? "This poppy"} has an update</strong>{" "}
              (v{updatablePoppies[view.id]}) — review what it changes before applying.
            </div>
            <button className="btn btn-primary" onClick={() => setView({ type: "directory" })}>
              Review update
            </button>
          </div>
        )}

        {/* Opened extensions stay mounted; only the active one is shown. Keeping the iframe
            alive (rather than unmounting on navigation) preserves any in-progress flow inside
            it — e.g. a deployment's live step list — when you move screens and come back. */}
        {openedExt.map((id) => {
          const isActive = view.type === "extension" && view.id === id;
          return (
            // Keep the INACTIVE extension rendered (visibility:hidden), not display:none. On macOS
            // WKWebView a display:none subtree loses its compositor layers, and WebKit doesn't
            // cleanly resume CSS animations when it reappears — so a poppy's spinners freeze/jank
            // after you leave and come back mid-flow (e.g. a domain setup). visibility:hidden keeps
            // the layer + animation timeline warm; absolute+inset pulls it out of flow so it never
            // disturbs the view on top. Cost: a hidden poppy keeps painting — negligible for a
            // spinner, fine for the 1–2 typically open.
            <div
              key={id}
              className="ext-host"
              style={
                isActive
                  ? { display: "flex" }
                  : { display: "flex", position: "absolute", inset: 0, visibility: "hidden", pointerEvents: "none", zIndex: -1 }
              }
            >
              <ExtensionContainer
                extensionId={id}
                connections={connections}
                runtime={extensions.find((e) => e.extensionId === id) ?? null}
                onAct={act}
                onBack={() => {
                  setView({ type: "list" });
                  void refreshList();
                }}
                onManage={(connId) => setView({ type: "detail", id: connId })}
              />
            </div>
          );
        })}
      </main>
      </div>

      {/* Statusline — an agent-native heartbeat in mono. Quietly reassures the operator that
          the steward is watching: how many poppies, how many held, and account health. */}
      <div className="statusline" role="status" aria-live="off">
        <span className="statusline__brand">▸ agentspoppy</span>
        <span className="statusline__sep">│</span>
        <span>
          {/* Count what the dashboard counts — poppies under watch (non-revoked
              connections) — so the statusline never disagrees with the cards. */}
          {connections.filter((c) => c.status !== "revoked").length}{" "}
          {connections.filter((c) => c.status !== "revoked").length === 1 ? "poppy" : "poppies"}
          {pausedCount > 0 ? ` · ${pausedCount} paused` : ""}
        </span>
        <span className="statusline__sep">│</span>
        <span className={awsHealth === "healthy" ? "statusline__ok" : "statusline__warn"}>{healthWord}</span>
        <span className="statusline__spacer" />
        {region && <span>{region}</span>}
        <span className="statusline__sep">│</span>
        {/* The first place the app has ever told a user which version they are running —
            and the way back into What's new after it has been dismissed. On a Microsoft
            Store install this is the only signal that anything changed at all. */}
        <WhatsNew />
      </div>

      {showSplash && (
        <OnboardingSplash
          connected={connected}
          onConnect={() => {
            setSplashSeen(true);
            setView({ type: "connect" });
          }}
          onClose={() => setSplashSeen(true)}
        />
      )}
    </div>
  );
}

function DetailContainer({
  id,
  onBack,
  onAct,
  onReconnect,
  onOpenExtension,
  blockedExtensionIds,
  onUpdatePolicy,
  machineGateFor,
}: {
  id: string;
  onBack: () => void;
  onAct: (fn: () => Promise<unknown>) => Promise<void>;
  onReconnect: () => void;
  /** Jump to a poppy's own tab (by extension id) — used to re-enable a revoked poppy before teardown. */
  onOpenExtension: (extensionId: string) => void;
  /** Extension ids the host is currently blocking — a blocked poppy can't re-run its cleanup, so the
   *  teardown flow must not steer it through "re-enable first". */
  blockedExtensionIds: string[];
  /** Route to the "update your access policy" panel — the fix when host cleanup is denied. */
  onUpdatePolicy: () => void;
  /** The machine gate's state for a connection, from the live extension list — the only
   *  source the card may graduate a declaration on (docs/specs/machine-gate.md). */
  machineGateFor: (connectionId: string) => "enforced" | "observed" | "none" | undefined;
}) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  // The infra map loads independently of the main detail (its verification can take a
  // moment), so the view renders immediately and the map fills in when ready.
  const [infra, setInfra] = useState<InfraGraph | null>(null);
  const [infraLoading, setInfraLoading] = useState(true);
  // A blanket "can't read this AWS account" (invalid/expired operator creds, or missing read
  // permissions) — surfaced as a banner so a credentials problem never masquerades as an empty map.
  const [infraError, setInfraError] = useState<string | null>(null);
  // The observed register: what this poppy has actually done (CloudTrail, 7-day window).
  // Loads independently and best-effort — LookupEvents is slow and may be unreadable, and
  // neither must hold up or break the detail view. null while loading, "unavailable" on
  // failure: the view must distinguish "quiet" from "could not read the trail".
  const [observed, setObserved] = useState<ConnectionActivityReport | "unavailable" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A one-off result notice (e.g. what a teardown actually removed). Distinct from
  // `error`, which replaces the whole view; this sits inline above the controls.
  const [notice, setNotice] = useState<string | null>(null);
  // A residual sweep after teardown can flag leftovers — render that notice as a warning.
  const [noticeWarn, setNoticeWarn] = useState(false);
  // Leftovers teardown genuinely couldn't remove (host cleanup included) — listed with
  // console links so the user can always finish by hand. Empty = nothing to show.
  const [leftovers, setLeftovers] = useState<ResidualResource[]>([]);
  // Host cleanup hit AccessDenied — the access policy predates the cleanup grants.
  const [cleanupAuthProblem, setCleanupAuthProblem] = useState(false);
  // Teardown now empties buckets + waits for DELETE_COMPLETE, so it can run for a
  // minute or two — drive a busy state so the button reflects that, not a frozen UI.
  const [tearingDown, setTearingDown] = useState(false);

  // Poll-pacing signals: the cloud is "moving" when consecutive reads differ (a deploy
  // provisioning, a teardown draining). Fingerprints of the last reads detect that; the
  // poll effect below runs fast while there's movement and backs off when all is quiet,
  // so an idle open view doesn't hammer AWS with Describe calls all day (which would
  // also pollute the very CloudTrail activity this app shows the user).
  // One-shot per connection: the observed register (slow, informational).
  useEffect(() => {
    let gone = false;
    setObserved(null);
    broker
      .connectionActivity(id)
      .then((r) => { if (!gone) setObserved(r); })
      .catch(() => { if (!gone) setObserved("unavailable"); });
    return () => { gone = true; };
  }, [id]);

  const fingerprints = useRef<Record<string, string>>({});
  const lastChangeAt = useRef(Date.now());
  const tearingDownRef = useRef(false);
  const markIfChanged = (key: string, fp: string) => {
    if (fingerprints.current[key] !== fp) {
      fingerprints.current[key] = fp;
      lastChangeAt.current = Date.now();
    }
  };

  // `silent` is for the background poll: a periodic refresh that blips shouldn't tear the whole
  // view down to an error banner — only the initial/explicit load surfaces failures.
  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      try {
        const [c, inv, a] = await Promise.all([
          broker.getConnection(id),
          broker.inventory(id),
          broker.audit(id),
        ]);
        setConnection(c);
        setInventory(inv);
        setAudit(a);
        setError(null);
        markIfChanged(
          "connection",
          JSON.stringify([
            c?.status,
            inv.stacks.map((s) => [s.stackName, s.stackExists, s.resources.length]),
            a.length,
          ]),
        );
      } catch (e) {
        if (!opts.silent) setError(errMessage(e, "Could not load this poppy."));
      }
    },
    [id],
  );

  // Independent, best-effort: the map is a bonus view, so a slow/failed graph never blocks
  // the detail. Reloaded after any action (e.g. teardown) so it reflects the new state. A
  // `silent` refresh keeps the existing map on screen — no spinner flash, no blanking on a blip.
  const loadInfra = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!opts.silent) setInfraLoading(true);
      try {
        const g = await broker.infra(id);
        setInfra(g);
        setInfraError(null);
        markIfChanged("infra", JSON.stringify(g.nodes.map((n) => [n.id, n.status])));
      } catch (e) {
        // "Account unreadable" is a real, persistent config problem (dead/expired operator creds
        // or missing read perms) — always surface it, even on a silent poll, and drop the stale
        // map. Any other failure stays best-effort: don't blank a working map on a transient blip.
        if (e instanceof ApiError && e.code === "account_unreadable") {
          setInfraError(e.message);
          setInfra(null);
        } else if (!opts.silent) {
          setInfra(null);
        }
      } finally {
        if (!opts.silent) setInfraLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    void load();
    void loadInfra();
  }, [load, loadInfra]);

  // Keep the view live: the cloud changes while the user is watching (a deploy provisions, a
  // teardown drains), so poll the connection + footprint rather than making the user leave and
  // re-enter to see progress. Refreshes are silent (no spinner, no error banner on a transient
  // blip), paused while the window/tab is hidden (no wasted AWS reads), and guarded so calls
  // never pile up if one is slow.
  //
  // ADAPTIVE cadence: fast (5s) while something is actually happening — a teardown running, an
  // action just taken, or the last reads still showing movement — then idle (30s) once the cloud
  // has been quiet for a while. An idle open view otherwise fires Describe calls all day: API
  // chatter, throttling risk, and noise in the user's own CloudTrail feed. A change spotted by
  // an idle poll drops the cadence straight back to 5s.
  useEffect(() => {
    const FAST_MS = 5_000;
    const IDLE_MS = 30_000;
    const ACTIVE_WINDOW_MS = 90_000; // how long after the last observed change we stay fast
    let inFlight = false;
    let lastPollAt = 0;
    const tick = async () => {
      if (inFlight || (typeof document !== "undefined" && document.hidden)) return;
      const active =
        tearingDownRef.current || Date.now() - lastChangeAt.current < ACTIVE_WINDOW_MS;
      // The timer always beats at 5s; an idle tick simply skips until 30s have passed.
      if (!active && Date.now() - lastPollAt < IDLE_MS - FAST_MS / 2) return;
      inFlight = true;
      lastPollAt = Date.now();
      try {
        await Promise.all([load({ silent: true }), loadInfra({ silent: true })]);
      } finally {
        inFlight = false;
      }
    };
    const h = setInterval(() => void tick(), FAST_MS);
    return () => clearInterval(h);
  }, [load, loadInfra]);

  const wrap = async (fn: () => Promise<unknown>) => {
    setNotice(null); // any new action supersedes a previous result notice
    setNoticeWarn(false);
    setLeftovers([]);
    setCleanupAuthProblem(false);
    lastChangeAt.current = Date.now(); // an action means movement — poll fast for a while
    await onAct(fn);
    await load();
    void loadInfra();
  };

  // Teardown deletes real CloudFormation stacks, so it must always report back —
  // a silent no-op on an empty result looks broken. Surface what it removed, or
  // why there was nothing to remove (the footprint is attributed by the
  // `agentspoppy:app` tag; a poppy that deployed nothing — or that manages its own
  // teardown — leaves nothing here for AgentsPoppy to delete).
  const teardown = () =>
    void wrap(async () => {
      setTearingDown(true);
      tearingDownRef.current = true; // pin the poll to its fast cadence for the whole drain
      try {
        const { deletedStacks, removedResiduals = [], residuals, cleanupAuthProblem = false } = await broker.teardown(id);
        // The poppy's own frontend (a hidden-but-mounted iframe on the extension tab)
        // is now showing a footprint that no longer exists. Nudge it to refresh so the
        // user doesn't have to notice a manual "refresh" button when they switch back.
        emitHostEvent({ hostEvent: "connection-changed", connectionId: id, reason: "teardown" });
        const app = connection?.app.name ?? "this poppy";
        // What the host's own cleanup pass removed, mentioned so the user sees the backstop working.
        const hostBit =
          removedResiduals.length > 0
            ? ` AgentsPoppy also directly removed ${removedResiduals.length} leftover resource${removedResiduals.length === 1 ? "" : "s"} tagged as built by ${app}.`
            : "";
        setLeftovers(residuals);
        setCleanupAuthProblem(cleanupAuthProblem);
        if (residuals.length > 0) {
          // Something genuinely couldn't be removed: surface it (with console links below),
          // never a false "done".
          setNoticeWarn(true);
          setNotice(
            `Removed ${deletedStacks.length} stack${deletedStacks.length === 1 ? "" : "s"}.${hostBit} ${residuals.length} resource${residuals.length === 1 ? "" : "s"} tagged as built by ${app} could not be removed — listed below with console links. The tag index can also lag a minute; tear down again to re-check.`,
          );
        } else if (cleanupAuthProblem) {
          // Nothing listed, but cleanup (or the verification sweep) was DENIED — those
          // resources may well still exist. Never show a green "clean" we can't prove.
          setNoticeWarn(true);
          setNotice(
            `Removed ${deletedStacks.length} stack${deletedStacks.length === 1 ? "" : "s"}.${hostBit} But AgentsPoppy wasn't allowed to finish or verify the cleanup, so the account can't be confirmed clean — update the access policy below, then tear down again.`,
          );
        } else {
          setNotice(
            deletedStacks.length > 0 || removedResiduals.length > 0
              ? `Tore down ${deletedStacks.length} stack${deletedStacks.length === 1 ? "" : "s"}${deletedStacks.length > 0 ? `: ${deletedStacks.join(", ")}` : ""}.${hostBit} No resources tagged as built by ${app} remain — your account is clean.`
              : `Nothing for AgentsPoppy to tear down here, and no resources tagged as built by ${app} remain — your account is clean. (If ${app} is still deployed, it may manage its own teardown.)`,
          );
        }
      } finally {
        setTearingDown(false);
        tearingDownRef.current = false;
        lastChangeAt.current = Date.now(); // watch the aftermath closely for a bit
      }
    });

  if (error) {
    return (
      <div className="banner banner-error">
        {error} <button className="btn link" onClick={onBack}>Back</button>
      </div>
    );
  }
  if (!connection || !inventory) return <p className="muted">Loading…</p>;

  return (
    <ConnectionDetailView
      connection={connection}
      machineGate={machineGateFor(connection.id)}
      inventory={inventory}
      audit={audit}
      observed={observed}
      infra={infra}
      infraLoading={infraLoading}
      infraError={infraError}
      onReconnect={onReconnect}
      live
      notice={notice}
      noticeWarn={noticeWarn}
      onDismissNotice={() => {
        setNotice(null);
        setLeftovers([]);
        setCleanupAuthProblem(false);
      }}
      leftovers={leftovers}
      cleanupAuthProblem={cleanupAuthProblem}
      onUpdatePolicy={onUpdatePolicy}
      tearingDown={tearingDown}
      onBack={onBack}
      onPause={() => void wrap(() => broker.pause(id))}
      onResume={() => void wrap(() => broker.resume(id))}
      onRevoke={() => void wrap(() => broker.revoke(id))}
      onBlock={connection ? () => void wrap(() => broker.blockExtension(connection.app.id)) : undefined}
      onToggleSupervise={(supervised) => void wrap(() => broker.setSupervised(id, supervised))}
      onTeardown={teardown}
      onForget={() => {
        // The record is gone after this — go back to the list rather than reloading a 404.
        void onAct(() => broker.forget(id));
        onBack();
      }}
      onReEnable={() => onOpenExtension(connection.app.id)}
      poppyBlocked={blockedExtensionIds.includes(connection.app.id)}
      onApprove={() => void wrap(() => broker.approve(id))}
      onDeny={() => {
        void onAct(() => broker.deny(id));
        onBack();
      }}
    />
  );
}

/**
 * An extension's tab in the container: its monitoring view once active, or the
 * enable / approve step before that. Driven off the connection the host reconciled
 * from the extension's manifest.
 */
function ExtensionContainer({
  extensionId,
  connections,
  runtime,
  onAct,
  onBack,
  onManage,
}: {
  extensionId: string;
  connections: Connection[];
  runtime: ExtensionRuntimeState | null;
  onAct: (fn: () => Promise<unknown>) => Promise<void>;
  onBack: () => void;
  /** Open this poppy's Manage (detail) view — the airlock header's governance jump. */
  onManage: (connectionId: string) => void;
}) {
  const conn = connections.find((c) => c.app.id === extensionId && c.status !== "revoked") ?? null;
  const startingRef = useRef(false);

  // Once the connection is active, bring its backend up. Approving a connection only
  // flips it to active; the backend (sidecar) is spawned by a (re-)start call, which
  // is idempotent and waits until the process is actually listening. This also covers
  // re-opening the app with an already-approved connection whose backend is stopped.
  useEffect(() => {
    if (conn?.status === "active" && runtime?.backend === "stopped" && !startingRef.current) {
      startingRef.current = true;
      void onAct(() => broker.startExtension(extensionId)).finally(() => {
        startingRef.current = false;
      });
    }
  }, [conn?.status, runtime?.backend, extensionId, onAct]);

  const back = (
    <button className="btn link" onClick={onBack}>
      ← Dashboard
    </button>
  );

  if (!conn) {
    return (
      <section>
        {back}
        <p className="muted">This extension isn't enabled yet.</p>
        <button className="btn" onClick={() => void onAct(() => broker.startExtension(extensionId))}>
          Enable
        </button>
      </section>
    );
  }
  if (conn.status === "pending") {
    // The moment right after a directory install — the poppy exists but can't touch
    // anything yet. Show WHO is asking and WHAT it declared (the scoped services +
    // the risk read), and make "review" the primary path when the scope is broad
    // (approving broad access should never be the biggest button on the screen).
    const risk = assessPermissionSet(conn.permissionSet);
    const services = [...new Set(conn.permissionSet.grants.map((g) => g.service))];
    const approve = (
      <button
        className={risk.level === "high" ? "btn" : "btn btn-primary"}
        onClick={() => void onAct(() => broker.approve(conn.id))}
      >
        Approve
      </button>
    );
    const review = (
      <button
        className={risk.level === "high" ? "btn btn-primary" : "btn"}
        onClick={() => onManage(conn.id)}
      >
        Review what it can do
      </button>
    );
    return (
      <section>
        {back}
        <div className="ext-approve">
          <span className="os-avatar" aria-hidden="true">
            {runtime?.iconUrl ? (
              <img src={runtime.iconUrl} alt="" />
            ) : (
              conn.app.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?"
            )}
          </span>
          <h2>{conn.app.name} is asking to use your AWS</h2>
          <p className="muted">
            Nothing has touched your cloud yet. Approving lets {conn.app.name} act only within the
            access it declared below — with scoped, temporary credentials — and you can pause,
            revoke, or tear down everything it builds at any time.
          </p>
          <div className="ext-approve__scope">
            <span className="os-card-sub muted">{services.join(" · ")}</span>
            {risk.level !== "low" && (
              <span
                className={`risk-chip risk-${risk.level}`}
                title="This app requests access beyond its own resources"
              >
                <Icon name="shield" /> {risk.level === "high" ? "Broad access — review before approving" : "Review access"}
              </span>
            )}
          </div>
          <div className="poppy-actions">
            {risk.level === "high" ? (
              <>
                {review}
                {approve}
              </>
            ) : (
              <>
                {approve}
                {review}
              </>
            )}
            <button className="btn link" onClick={() => void onAct(() => broker.deny(conn.id))}>
              Deny
            </button>
          </div>
        </div>
      </section>
    );
  }
  if (conn.status === "paused") {
    // Hard pause stops the backend, so the frontend can't be driven — show the halt
    // plainly (not a dead "Starting…" spinner) and offer a one-click Resume.
    return (
      <section>
        {back}
        <div className="ext-blocked notice notice--warn" role="status">
          <Icon name="pause" />
          <p>
            <strong>{conn.app.name} is paused.</strong> Its backend is stopped, so it can’t run or
            touch your AWS. Resume when you’re ready — it comes back with the same permissions.
          </p>
        </div>
        <div className="poppy-actions">
          <button className="btn" onClick={() => void onAct(() => broker.resume(conn.id))}>
            Resume {conn.app.name}
          </button>
        </div>
      </section>
    );
  }
  // Active: if the shell has served this extension's frontend, render it as a
  // sandboxed tab (the container payoff) — just the app. Governance (capabilities,
  // risks, cloud footprint, controls) lives on the dashboard's "Manage" view, so
  // the tab stays focused on the app itself. Prefer the URL the broker serves the
  // installed frontend from; fall back to a shell-injected override
  // (window.__AGENTSPOPPY_EXTENSION_FRONTENDS__).
  const frontendUrl = runtime?.frontendUrl ?? extensionFrontendUrl(extensionId);
  if (frontendUrl) {
    const bridge = createBrokerHostBridge({
      connectionId: conn.id,
      extensionId,
      openExternal: async (url) => {
        // Hand the URL to the OS browser via the native opener (the Rust side has
        // tauri-plugin-opener + the opener:default capability). window.open is a
        // no-op inside the desktop webview, so without this an extension's external
        // links / attachment URLs silently went nowhere. The dynamic import throws
        // outside Tauri (plain-browser dev), where we fall back to window.open.
        try {
          const { openUrl } = await import("@tauri-apps/plugin-opener");
          await openUrl(url);
        } catch {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      },
      notify: async (n) => {
        // TODO(native approval): route through @tauri-apps/plugin-notification.
        console.info(`[${conn.app.name}] ${n.title}${n.body ? ` — ${n.body}` : ""}`);
      },
    });
    const accent = poppyAccent(conn.app.id);
    return (
      <section className="ext-tab">
        {/* The airlock: a glass supervisory bar owned by AGENTSPOPPY, floating above the
            poppy's own viewport. It carries the poppy's identity, its sandbox status, and
            the host's controls — so the frame around a poppy always says "steward present". */}
        <div className="ext-airlock">
          {/* No navigation control here (founder decision): the sidebar's Dashboard item is
              the one way out, and a button in this bar — arrow or named — kept being read
              as the poppy's own back navigation, which only the poppy itself can own. */}
          <span className="ext-airlock__avatar" style={{ color: accent, borderColor: accent }} aria-hidden="true">
            {runtime?.iconUrl ? <img src={runtime.iconUrl} alt="" /> : (conn.app.name[0] ?? "?").toUpperCase()}
          </span>
          <div className="ext-airlock__id">
            <div className="ext-airlock__name">{conn.app.name}</div>
            <div className="ext-airlock__meta">{conn.app.id} · own resources only</div>
          </div>
          <span className="ext-airlock__sandbox" title="Runs sandboxed: scoped credentials, its own resources only">
            <Icon name="shield" /> Sandboxed
          </span>
          <span className="ext-airlock__spacer" />
          {/* The unstick lever: stop + respawn this poppy's backend. A wedged backend may
              never have filed its approval request (no banner ever appeared) — respawning
              re-runs its bootstrap, which re-files it. Beats switching regions back and
              forth, which is how this failure was first worked around. */}
          <button
            className="btn ext-airlock__btn"
            title="Stop and relaunch this poppy — use this if it seems stuck (e.g. waiting forever, or an approval that never appeared)"
            onClick={() => void onAct(() => broker.restartExtension(extensionId))}
          >
            Restart
          </button>
          <button className="btn ext-airlock__btn" onClick={() => void onAct(() => broker.pause(conn.id))}>
            Pause
          </button>
          <button className="btn ext-airlock__btn" onClick={() => onManage(conn.id)}>
            Manage
          </button>
        </div>
        {runtime?.backend === "running" || runtime?.backend === "none" ? (
          // Keyed by backend port: a Restart respawns the backend on a fresh port, and the
          // key change remounts the frame so the poppy's UI reloads clean instead of
          // keeping whatever stuck state (dead spinner, hung request) prompted the restart.
          <ExtensionFrame
            key={runtime?.port ?? 0}
            connId={conn.id}
            src={frontendUrl}
            title={conn.app.name}
            capabilities={runtime?.capabilities ?? []}
            bridge={bridge}
          />
        ) : runtime?.backend === "blocked" ? (
          // Blocked poppy: the host refuses to spawn its backend, so the frontend would hang on a
          // "Starting…" spinner forever. Say so plainly and point back to the dashboard, where the
          // user can unblock it or tear it down (host-only) — never leave them staring at a spinner.
          <div className="ext-blocked notice notice--warn" role="status">
            <Icon name="shield" />
            <p>
              {conn.app.name} is blocked, so it isn’t running. Open it from <strong>Manage</strong> on
              the dashboard to unblock it, or to tear it down.
            </p>
          </div>
        ) : (
          <p className="muted ext-starting">Starting {conn.app.name}…</p>
        )}
      </section>
    );
  }
  return (
    <section>
      {back}
      <p className="muted">{conn.app.name}'s interface isn't available yet. Manage its access from the dashboard.</p>
    </section>
  );
}
