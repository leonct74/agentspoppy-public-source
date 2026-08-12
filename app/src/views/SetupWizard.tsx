// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
//
// The setup WIZARD — the path most people take (founder direction, 2026-08-11:
// the stepper's five gated steps frustrated real users; even we avoided testing it).
//
// Three sliding steps (founder refinement, 2026-08-12):
//   1. Pick the region — FIRST, so it can't be skipped, with the flag + place name a
//      newcomer actually recognises. Picking advances on its own.
//   2. Create the IAM user and attach the bundled policy (the console work we can't
//      do for them).
//   3. Create the access key — ending on AWS's own Done button, because leaving that
//      screen half-finished is how people lose the secret — then paste both values
//      and press ONE button. Everything after is automatic: deploy the role +
//      non-admin operator, link the account, verify — honest progress, then a
//      success animation. Every step has a way back to the previous one.
//
// Security shape is identical to the pro path's automated deploy: the pasted key is
// sent to the local broker's /aws/bootstrap, which holds it IN MEMORY ONLY, deploys,
// and persists nothing but the resulting non-admin operator key. We deliberately do
// NOT save the pasted key first (that's what /aws/credentials does) — the elevated
// key must never touch disk.

import { useEffect, useRef, useState } from "react";
import type { ConnectedAccount } from "@agentspoppy/core";
import { ApiError, broker, type CallerIdentity } from "../api/broker";
import { Icon } from "../components/Icon";
import { PoppySpinner } from "../components/PoppySpinner";
import {
  ACCESS_POLICY_URL,
  AWS_FREE_TIER_URL,
  CopyPolicyButton,
  ExtLink,
  IAM_USERS_URL,
  REGION_CHOICES,
} from "./connectShared";

/** How long we keep re-trying the final verify. A freshly minted access key takes a
 *  few seconds to go active (IAM eventual consistency) — failing the wizard over that
 *  would be failing over AWS being AWS. */
const VERIFY_TIMEOUT_MS = 60_000;

/**
 * The verify phase giving up is ITS OWN failure, never routed through friendlyError():
 * the raw reason usually contains InvalidClientTokenId (the fresh OPERATOR key still
 * propagating), and the generic mapping would tell the user to re-copy the key THEY
 * pasted — wrong key, wrong fix.
 */
class VerifyTimeout extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

type Phase = "form" | "deploying" | "verifying" | "success";

/** The wizard's screens. `oneclick` replaces steps 2–3 when working credentials
 *  already exist on this machine — nothing to create, nothing to paste. */
type View = "region" | "policy" | "key" | "oneclick";

/** Translate the usual AWS failures into words; the raw text stays visible below. */
export function friendlyError(raw: string): string {
  if (/InvalidClientTokenId|security token.+invalid/i.test(raw)) {
    return "AWS didn't recognize that Access Key ID. Re-copy it from the console — and if you just created it, give it a few seconds and try again.";
  }
  if (/SignatureDoesNotMatch/i.test(raw)) {
    return "The Secret Access Key doesn't match. Re-copy it — it's only shown once, so if it's lost, create a new access key.";
  }
  if (/not authorized|AccessDenied/i.test(raw)) {
    return "That user isn't allowed to run the setup — its policy is missing or incomplete. Go back one step, attach the AgentsPoppy policy, then try again.";
  }
  if (/ExpiredToken/i.test(raw)) {
    return "Those credentials have expired. Create a fresh access key and try again.";
  }
  return "Setup didn't finish. Nothing elevated was saved — it's safe to just try again.";
}

export interface SetupWizardProps {
  accounts: ConnectedAccount[];
  /** The identity already resolvable on this machine (if any) — lets a returning user
   *  set up with one click instead of pasting keys again. */
  identity: CallerIdentity | null;
  checking: boolean;
  onChanged: () => void;
  /** Leave without finishing (form phase only — mid-setup there's nothing to go back to). */
  onBack: () => void;
  onDone: () => void;
  /** "I want full visibility / my case is special" → the pro stepper. */
  onProSwitch: () => void;
  /** Test hook: the gap between verify retries. */
  verifyDelayMs?: number;
  /** Test hook: how long verification may keep retrying before giving up. */
  verifyTimeoutMs?: number;
  /**
   * When a COMPLETED account surfaces under a pristine wizard, hand over to pro
   * (the accounts-list race — see the effect below). The parent turns this OFF when
   * the user chose the wizard explicitly (banner switch, "use a different account"):
   * there the accounts prop can be momentarily stale and the handoff would bounce
   * them straight back to the view they just left.
   */
  completedHandsOffToPro?: boolean;
}

export function SetupWizard({
  accounts,
  identity,
  checking,
  onChanged,
  onBack,
  onDone,
  onProSwitch,
  verifyDelayMs = 2500,
  verifyTimeoutMs = VERIFY_TIMEOUT_MS,
  completedHandsOffToPro = true,
}: SetupWizardProps) {
  const linked = accounts[0] ?? null;

  const [phase, setPhase] = useState<Phase>("form");
  // A linked account already fixed its region — that choice can't be re-made here,
  // so the wizard starts straight at the console work.
  const [view, setView] = useState<View>(linked ? "policy" : "region");
  const [slide, setSlide] = useState<"fwd" | "back">("fwd");
  // No default region: choosing is step 1 precisely so it cannot be skipped.
  const [region, setRegion] = useState<string | null>(null);
  const [keyId, setKeyId] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  // A returning user with working credentials can skip the paste entirely; this
  // opts back into pasting a different key.
  const [usePastedKeys, setUsePastedKeys] = useState(false);
  // Re-entrancy guard: React state is stale inside the same event tick, so a
  // double-click could fire the bootstrap twice and race two deploys server-side.
  const running = useRef(false);
  // Whether the run that just succeeded consumed pasted keys — the success copy
  // about "the key you pasted" must not appear on the one-click path.
  const ranWithKeys = useRef(false);

  const reuseIdentity = !!identity && !usePastedKeys;

  // A COMPLETED setup surfacing under a pristine wizard means we were routed here
  // before the account list had loaded (or another window finished setup meanwhile).
  // Re-running the wizard there isn't harmless: it rotates the operator key, and under
  // IAM's two-key limit that can evict the key another computer still uses. Hand over
  // to the pro view, which renders a completed setup as exactly that. Never fires
  // mid-run (phase), after a failure (error + keys are the user's retry context), or
  // once anything is typed.
  useEffect(() => {
    if (completedHandsOffToPro && phase === "form" && !error && !keyId && !keySecret && linked?.roleArn) {
      onProSwitch();
    }
  }, [completedHandsOffToPro, phase, error, keyId, keySecret, linked?.roleArn, onProSwitch]);

  function goto(next: View, direction: "fwd" | "back") {
    setSlide(direction);
    setView(next);
  }

  /** The numbered trail for the current flow, for the "Step n of m" label. */
  const trail: View[] = linked ? ["policy", "key"] : ["region", "policy", "key"];
  const stepLabel = trail.includes(view) ? `Step ${trail.indexOf(view) + 1} of ${trail.length}` : null;

  async function runSetup(): Promise<void> {
    if (running.current) return;
    running.current = true;
    ranWithKeys.current = !reuseIdentity;
    setError(null);
    setErrorDetail(null);
    setPhase("deploying");
    try {
      // One call does the heavy lifting: deploy the broker role + non-admin operator,
      // link the account, record the role ARN. Idempotent — a retry resumes.
      const { account } = await broker.deployBootstrap(
        linked?.id ?? null,
        reuseIdentity
          ? linked || !region
            ? undefined
            : { region } // reuse the connected creds, still honour the region choice
          : {
              accessKeyId: keyId.trim(),
              secretAccessKey: keySecret.trim(),
              ...(linked || !region ? {} : { region }),
            },
      );
      onChanged();

      // The operator key was written a moment ago; IAM can take a few seconds to
      // activate it. Retry quietly instead of surfacing AWS's timing to the user.
      setPhase("verifying");
      const started = Date.now();
      for (;;) {
        let reason = "";
        try {
          const v = await broker.verifyAccount(account.id);
          if (v.ok) break;
          reason = v.reason;
        } catch (e) {
          reason = e instanceof ApiError ? e.message : String(e);
        }
        if (Date.now() - started > verifyTimeoutMs) {
          throw new VerifyTimeout(reason);
        }
        await new Promise((r) => setTimeout(r, verifyDelayMs));
      }

      // Done — the pasted key is gone (it never left the broker's memory), the
      // operator key is on disk, and the role answered an assume call.
      setKeySecret("");
      setKeyId("");
      onChanged();
      setPhase("success");
    } catch (e) {
      if (e instanceof VerifyTimeout) {
        // The deploy itself finished — retelling this as a bad pasted key would send
        // the user to fix the wrong thing.
        setError(
          "The setup finished, but AWS hasn't confirmed the connection yet. Give it a minute, then press the button again — everything already created is reused, nothing gets duplicated.",
        );
        setErrorDetail(e.reason);
      } else {
        const raw = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
        setError(friendlyError(raw));
        setErrorDetail(raw);
      }
      // Land back on the screen the user submitted from — their inputs are intact.
      setPhase("form");
    } finally {
      running.current = false;
    }
  }

  if (phase === "success") {
    return (
      <section className="connect wizard" aria-live="polite">
        <div className="wiz-success">
          <span className="wiz-success-mark" role="img" aria-label="Success">
            <svg viewBox="0 0 52 52" aria-hidden="true">
              <circle className="wiz-success-circle" cx="26" cy="26" r="24" fill="none" />
              <path className="wiz-success-check" fill="none" d="M14 27l8 8 16-17" />
            </svg>
            <span className="wiz-petal p1" />
            <span className="wiz-petal p2" />
            <span className="wiz-petal p3" />
            <span className="wiz-petal p4" />
            <span className="wiz-petal p5" />
            <span className="wiz-petal p6" />
          </span>
          <h2>Your AWS is connected</h2>
          <p className="muted">
            AgentsPoppy now runs as its own <strong>limited, non-admin</strong> operator in your account
            {/* Only true on the pasted-key path — the one-click path pasted nothing. */}
            {ranWithKeys.current ? <> — the key you pasted was used once and never saved</> : null}. Install
            a poppy to get started.
          </p>
          <button className="btn btn-primary" onClick={onDone}>
            Done
          </button>
        </div>
      </section>
    );
  }

  if (phase === "deploying" || phase === "verifying") {
    return (
      <section className="connect wizard" aria-live="polite">
        <header className="connect-hero">
          <h2>Setting up your AWS</h2>
          <p className="lead">Sit back — everything from here is automatic.</p>
        </header>
        <ol className="wiz-progress">
          <WizStage
            state={phase === "deploying" ? "active" : "done"}
            title="Creating AgentsPoppy's role and non-admin operator"
            hint="About a minute — AWS is doing the work in your account."
          />
          <WizStage
            state={phase === "verifying" ? "active" : "todo"}
            title="Verifying the connection"
            hint="Waiting for AWS to activate the new key…"
          />
        </ol>
        <p className="micro muted">
          Safe to leave this running. If it's interrupted, nothing elevated is saved — running setup again
          resumes where AWS got to.
        </p>
      </section>
    );
  }

  return (
    <section className="connect wizard">
      <button className="btn link" onClick={onBack}>
        ← Back
      </button>
      <header className="connect-hero">
        <h2>Connect your AWS</h2>
        <p className="lead">
          A couple of minutes in the AWS console, then AgentsPoppy sets everything up for you — as its
          own limited operator, <em>never</em> as admin.
        </p>
        <span className="noadmin-badge">
          <Icon name="lock" /> AgentsPoppy never asks for or uses admin access
        </span>
      </header>

      {error && (
        <div className="banner banner-warn">
          <strong>{error}</strong>
          {errorDetail && <p className="micro muted">AWS said: {errorDetail}</p>}
        </div>
      )}

      {checking ? (
        <p className="muted probing">
          <PoppySpinner size={15} /> Looking for your AWS on this machine…
        </p>
      ) : (
        <div className="wiz-pane" key={view + slide}>
          <div className={`wiz-slide-${slide}`}>
            {stepLabel && <p className="wiz-stepno muted">{stepLabel}</p>}

            {view === "region" && (
              <>
                <h3 className="wiz-step-title">Where should your poppies live?</h3>
                <p className="muted">
                  Everything AgentsPoppy sets up runs in <strong>your</strong> AWS account, in one region.
                  Pick the closest to you — your apps respond faster, and your data stays in that part of
                  the world.
                </p>
                <div className="wiz-regions" role="group" aria-label="Choose a region">
                  {REGION_CHOICES.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className={`wiz-region${region === r.id ? " selected" : ""}`}
                      aria-label={`${r.place} — ${r.id}`}
                      onClick={() => {
                        setRegion(r.id);
                        goto(reuseIdentity ? "oneclick" : "policy", "fwd");
                      }}
                    >
                      <span className="wiz-region-flag" aria-hidden="true">
                        {r.flag}
                      </span>
                      <span>
                        <span className="wiz-region-place">{r.place}</span>
                        <span className="wiz-region-code mono muted">{r.id}</span>
                      </span>
                    </button>
                  ))}
                </div>
                <p className="micro muted">
                  No AWS account yet? <ExtLink href={AWS_FREE_TIER_URL}>Create one free</ExtLink> first,
                  then come back.
                </p>
              </>
            )}

            {view === "oneclick" && (
              <>
                <h3 className="wiz-step-title">You're already set — no keys to paste</h3>
                <div className="panel">
                  <p className="kv">
                    <Icon name="check" className="kv-check" /> AWS access found on this Mac —{" "}
                    <code>{identity!.arn}</code>
                  </p>
                  <p className="muted">One click and AgentsPoppy sets itself up with it.</p>
                  <button className="btn btn-primary btn-lg" onClick={() => void runSetup()}>
                    Set up my AWS now
                  </button>
                  <button
                    className="btn link"
                    type="button"
                    onClick={() => {
                      setUsePastedKeys(true);
                      goto("policy", "fwd");
                    }}
                  >
                    Use a different key instead
                  </button>
                </div>
                {!linked && (
                  <button className="btn link" type="button" onClick={() => goto("region", "back")}>
                    ← Previous step
                  </button>
                )}
              </>
            )}

            {view === "policy" && (
              <>
                <h3 className="wiz-step-title">Create the user AgentsPoppy will set up with</h3>
                <ol className="wiz-steps">
                  <li>
                    Open{" "}
                    <ExtLink href={IAM_USERS_URL}>
                      IAM → Users <Icon name="external" className="link-ext" />
                    </ExtLink>{" "}
                    → <strong>Create user</strong> → name it <code>agentspoppy</code> or a name you'll
                    remember → <strong>Next</strong>.
                  </li>
                  <li>
                    Choose <strong>Attach policies directly → Create policy → JSON</strong>, paste this
                    policy — <CopyPolicyButton primary /> — then create it and select it for the user.{" "}
                    <span className="micro muted">
                      (It only lets the one-time setup run — you can{" "}
                      <ExtLink href={ACCESS_POLICY_URL}>read it</ExtLink> and revoke it any time.)
                    </span>
                  </li>
                </ol>
                <div className="wiz-nav">
                  {!linked && (
                    <button className="btn link" type="button" onClick={() => goto("region", "back")}>
                      ← Previous step
                    </button>
                  )}
                  <span className="spacer" />
                  <button className="btn btn-primary" type="button" onClick={() => goto("key", "fwd")}>
                    Next: create its access key →
                  </button>
                </div>
              </>
            )}

            {view === "key" && (
              <>
                <h3 className="wiz-step-title">Create the access key and paste it here</h3>
                <ol className="wiz-steps">
                  <li>
                    Open the user you just created → <strong>Security credentials → Create access key</strong>.
                  </li>
                  <li>
                    Choose <strong>Command Line Interface (CLI)</strong> → tick the confirmation →{" "}
                    <strong>Create access key</strong>.
                  </li>
                  <li>
                    Copy <strong>both values</strong> below, then press <strong>Done</strong> in AWS to
                    finish the key screen.{" "}
                    <span className="micro muted">
                      Copy first — the secret is shown only once, and it's gone after Done.
                    </span>
                  </li>
                </ol>

                <div className="panel">
                  <div className="field-grid">
                    <label className="field-label">
                      Access Key ID
                      <input
                        className="field"
                        placeholder="AKIA…"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        value={keyId}
                        onChange={(e) => setKeyId(e.target.value.trim())}
                      />
                    </label>
                    <label className="field-label">
                      Secret Access Key
                      <span className="field-row">
                        <input
                          className="field"
                          type={showSecret ? "text" : "password"}
                          placeholder="••••••••••••••••••••"
                          autoCapitalize="off"
                          autoCorrect="off"
                          spellCheck={false}
                          value={keySecret}
                          onChange={(e) => setKeySecret(e.target.value.trim())}
                        />
                        <button type="button" className="btn ghost" onClick={() => setShowSecret((s) => !s)}>
                          {showSecret ? "Hide" : "Show"}
                        </button>
                      </span>
                    </label>
                  </div>
                  <button
                    className="btn btn-primary btn-lg"
                    disabled={!keyId.trim() || !keySecret.trim()}
                    onClick={() => void runSetup()}
                  >
                    Connect and set up
                  </button>
                  <p className="micro muted">
                    Your key is used <strong>once, in memory,</strong> to create AgentsPoppy's own limited
                    operator — it's never saved to disk and never uploaded. There is no AgentsPoppy server.
                  </p>
                  {identity && (
                    <button
                      className="btn link"
                      type="button"
                      onClick={() => {
                        setUsePastedKeys(false);
                        goto("oneclick", "back");
                      }}
                    >
                      Use the AWS access already on this Mac
                    </button>
                  )}
                </div>

                <button className="btn link" type="button" onClick={() => goto("policy", "back")}>
                  ← Previous step
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <p className="wiz-pro-switch micro muted">
        Want to see and control each step — or using SSO / temporary keys?{" "}
        <button className="btn link" type="button" onClick={onProSwitch}>
          Use the pro setup
        </button>
      </p>
    </section>
  );
}

function WizStage({ state, title, hint }: { state: "done" | "active" | "todo"; title: string; hint: string }) {
  return (
    <li className={`wiz-stage wiz-stage-${state}`}>
      <span className="wiz-stage-marker">
        {state === "done" ? <Icon name="check" /> : state === "active" ? <PoppySpinner size={16} /> : null}
      </span>
      <span>
        <span className="wiz-stage-title">{title}</span>
        {state === "active" && <span className="wiz-stage-hint muted">{hint}</span>}
      </span>
    </li>
  );
}
