// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
//
// The setup WIZARD — the path most people take (founder direction, 2026-08-11:
// the stepper's five gated steps frustrated real users; even we avoided testing it).
//
// Four full-screen slides (founder redesign, 2026-09-02 — "simple even for
// non-developers"; supersedes the 2026-08-12 region-first order):
//   1. CHOOSE YOUR CLOUD — three big provider marks; AWS alive with a pulsing ring,
//      Google Cloud and Azure greyed "coming soon". Pressing the AWS mark (or
//      "Create an AWS account") opens AWS sign-up; "I already have an account"
//      slides on. The wow lives here and on the finish.
//   2. Create the IAM user — ONE action per card, large type, minimal words, with
//      "stuck?" helpers tucked behind disclosures instead of paragraphs up front.
//   3. Create + paste the access key (ending on AWS's own Done button, because
//      leaving that screen half-finished is how people lose the secret).
//   4. Pick the region — big flags, the closest one suggested from the machine's
//      timezone, and the finish button IS this screen's confirm, so the choice can
//      still never be skipped. Then honest progress → a celebration.
//
// Security shape is identical to the pro path's automated deploy: the pasted key is
// sent to the local broker's /aws/bootstrap, which holds it IN MEMORY ONLY, deploys,
// and persists nothing but the resulting non-admin operator key. We deliberately do
// NOT save the pasted key first (that's what /aws/credentials does) — the elevated
// key must never touch disk.

import { useEffect, useMemo, useRef, useState } from "react";
import type { ConnectedAccount } from "@agentspoppy/core";
import { ApiError, broker, type CallerIdentity } from "../api/broker";
import { Icon } from "../components/Icon";
import { PoppySpinner } from "../components/PoppySpinner";
import {
  ACCESS_POLICY_URL,
  AWS_SIGNUP_URL,
  CopyPolicyButton,
  ExtLink,
  IAM_USERS_URL,
  REGION_CHOICES,
  openExternal,
  suggestRegion,
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
type View = "cloud" | "region" | "policy" | "key" | "oneclick";

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
  // so the wizard starts straight at the console work. A fresh machine starts at
  // the cloud chooser.
  const [view, setView] = useState<View>(linked ? "policy" : "cloud");
  const [slide, setSlide] = useState<"fwd" | "back">("fwd");
  // No default region: choosing is its own screen precisely so it cannot be skipped
  // — and on the paste path it is the LAST screen, so its confirm is the finish.
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

  // The closest region, guessed from the machine's timezone — a labelled suggestion,
  // never an auto-pick (latency argues for closest; residency is the user's call).
  const suggested = useMemo(() => {
    try {
      return suggestRegion(Intl.DateTimeFormat().resolvedOptions().timeZone ?? "");
    } catch {
      return "us-east-1";
    }
  }, []);
  const regionCards = useMemo(() => {
    const s = REGION_CHOICES.find((r) => r.id === suggested);
    return s ? [s, ...REGION_CHOICES.filter((r) => r.id !== suggested)] : REGION_CHOICES;
  }, [suggested]);

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
  const trail: View[] = linked
    ? ["policy", "key"]
    : reuseIdentity
      ? ["cloud", "region", "oneclick"]
      : ["cloud", "policy", "key", "region"];
  const stepLabel = trail.includes(view) ? `Step ${trail.indexOf(view) + 1} of ${trail.length}` : null;

  // Where the top-left Back leads — always WITHIN the flow, never out of it. Null on
  // the flow's first screen (a linked account starts at policy and has no earlier
  // step either). Covers the off-trail detour too: "use a different key" on the
  // one-click path lands in policy/key, whose way back is still well defined.
  const prevView: View | null = (() => {
    switch (view) {
      case "cloud":
        return null;
      case "policy":
        return linked ? null : "cloud";
      case "key":
        return "policy";
      case "region":
        return reuseIdentity ? "cloud" : "key";
      case "oneclick":
        return linked ? null : "region";
    }
  })();

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
      // Land back on the screen the user submitted from — their inputs are intact —
      // and bring the explanation TO the user: the banner renders at the top, and a
      // screen scrolled to the flag grid otherwise reads as a silent refusal
      // (founder field report, 2026-09-02).
      setPhase("form");
      requestAnimationFrame(() => {
        document.querySelector(".wiz-immersive .banner-warn")?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      });
    } finally {
      running.current = false;
    }
  }

  if (phase === "success") {
    return (
      <section className="connect wizard wiz-immersive" aria-live="polite">
        <WizConfetti />
        <div className="wiz-immersive-body">
          <div className="wiz-success wiz-celebrate">
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
          <h2 className="wiz-celebrate-title">Your cloud is ready 🎉</h2>
          <p className="muted wiz-celebrate-sub">
            AgentsPoppy now runs as its own <strong>limited, non-admin</strong> operator in your account
            {/* Only true on the pasted-key path — the one-click path pasted nothing. */}
            {ranWithKeys.current ? <> — the key you pasted was used once and never saved</> : null}.
          </p>
            <button className="btn btn-primary btn-lg" onClick={onDone}>
              Explore the poppies →
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (phase === "deploying" || phase === "verifying") {
    return (
      <section className="connect wizard wiz-immersive" aria-live="polite">
        <div className="wiz-immersive-body">
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
            Safe to leave this running. If it's interrupted, nothing elevated is saved — running setup
            again resumes where AWS got to.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="connect wizard wiz-immersive">
      <div className="wiz-immersive-body">
        <div className="wiz-topbar">
          {/* The top-left button NEVER dumps a first-run user out of the onboarding
              (founder, 2026-09-02: "we cannot afford to let the newbie out"). It walks
              one step back within the flow; on the first screen it disappears for a
              fresh machine — there is nothing behind it a newbie should land in — and
              reads "Exit setup" only when a connected account means the shell behind
              is a real place. */}
          {prevView ? (
            <button className="btn link" onClick={() => goto(prevView, "back")}>
              ← Back
            </button>
          ) : accounts.length > 0 ? (
            <button className="btn link" onClick={onBack}>
              ← Exit setup
            </button>
          ) : (
            <span />
          )}
          {stepLabel && <p className="wiz-stepno muted">{stepLabel}</p>}
        </div>

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
              {view === "cloud" && (
                <div className="wiz-clouds">
                  <h1 className="wiz-hero-title">Choose your cloud</h1>
                  <p className="wiz-hero-sub muted">
                    Everything runs in <strong>your own</strong> account. AgentsPoppy never sees your data
                    and never asks for admin.
                  </p>
                  <div className="wiz-cloud-row">
                    <div className="wiz-cloud wiz-cloud-live">
                      <button
                        type="button"
                        className="wiz-cloud-orb wiz-cloud-aws"
                        aria-label="Create an AWS account"
                        onClick={() => openExternal(AWS_SIGNUP_URL)}
                      >
                        <span className="wiz-cloud-glow" aria-hidden="true" />
                        <span className="wiz-cloud-ring wiz-ring-a" aria-hidden="true" />
                        <span className="wiz-cloud-ring wiz-ring-b" aria-hidden="true" />
                        <span className="wiz-cloud-spark" aria-hidden="true" />
                        <AwsMark />
                      </button>
                      <div className="wiz-cloud-actions">
                        <button
                          className="btn btn-primary btn-lg"
                          type="button"
                          onClick={() => goto(reuseIdentity ? "region" : "policy", "fwd")}
                        >
                          I already have an account →
                        </button>
                        <button className="btn link" type="button" onClick={() => openExternal(AWS_SIGNUP_URL)}>
                          Sign up for AWS — it's free
                        </button>
                      </div>
                    </div>
                    <div className="wiz-cloud wiz-cloud-soon" aria-disabled="true">
                      <span className="wiz-cloud-orb">
                        <GcpMark />
                      </span>
                      <span className="wiz-soon-pill">Coming soon</span>
                    </div>
                    <div className="wiz-cloud wiz-cloud-soon" aria-disabled="true">
                      <span className="wiz-cloud-orb">
                        <AzureMark />
                      </span>
                      <span className="wiz-soon-pill">Coming soon</span>
                    </div>
                  </div>
                  <p className="micro muted wiz-cloud-foot">
                    <Icon name="lock" /> One-time setup · about 3 minutes · nothing leaves this machine
                  </p>
                </div>
              )}

              {view === "region" && (
                <>
                  <h1 className="wiz-hero-title">Where should it live?</h1>
                  <p className="wiz-hero-sub muted">
                    One region in your account holds everything. Closest is fastest — your data stays in
                    that part of the world.
                  </p>
                  <div className="wiz-regions wiz-regions-xl" role="group" aria-label="Choose a region">
                    {regionCards.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        className={`wiz-region${region === r.id ? " selected" : ""}`}
                        aria-label={`${r.place} — ${r.id}`}
                        onClick={() => {
                          setRegion(r.id);
                          // On the one-click path there is nothing left to collect —
                          // picking advances. On the paste path this screen is LAST,
                          // so picking arms the big finish button below — and hands
                          // the eye to it (founder feedback 2026-09-02: the armed
                          // button below the fold read as "it doesn't let me move
                          // forward").
                          if (reuseIdentity && !linked) {
                            goto("oneclick", "fwd");
                          } else {
                            requestAnimationFrame(() => {
                              const nav = document.querySelector("[data-wiz-finish]");
                              nav?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                              nav?.classList.remove("wiz-finish-pulse");
                              void (nav as HTMLElement | null)?.offsetWidth;
                              nav?.classList.add("wiz-finish-pulse");
                            });
                          }
                        }}
                      >
                        {r.id === suggested && <span className="wiz-region-closest">Closest to you</span>}
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
                  {!reuseIdentity && (
                    <div className="wiz-nav" data-wiz-finish>
                      <span className="spacer" />
                      <button
                        className="btn btn-primary btn-lg"
                        type="button"
                        disabled={!region}
                        onClick={() => void runSetup()}
                      >
                        {region
                          ? `Set up in ${REGION_CHOICES.find((r) => r.id === region)?.place ?? region} →`
                          : "Pick a region to finish"}
                      </button>
                    </div>
                  )}
                </>
              )}

              {view === "oneclick" && (
                <>
                  <h1 className="wiz-hero-title">You're already set — no keys to paste</h1>
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
                </>
              )}

              {view === "policy" && (
                <>
                  <h1 className="wiz-hero-title">Give AgentsPoppy its own key-holder</h1>
                  <p className="wiz-hero-sub muted">
                    Two minutes in the AWS console — a user that can run the setup, and{" "}
                    <strong>nothing more</strong>. Never admin.
                  </p>

                  <ol className="wiz-actions">
                    <li className="wiz-action">
                      <span className="wiz-action-n">1</span>
                      <div className="wiz-action-body">
                        <p className="wiz-action-title">Create a user called “agentspoppy”</p>
                        <button className="btn btn-primary" type="button" onClick={() => openExternal(IAM_USERS_URL)}>
                          Open AWS — IAM users <Icon name="external" className="link-ext" />
                        </button>
                        <p className="wiz-action-hint muted">
                          Press <strong>Create user</strong>, type the name, press <strong>Next</strong>.
                        </p>
                        <details className="wiz-help">
                          <summary>Stuck? What is this?</summary>
                          <p>
                            IAM is where AWS keeps its people and permissions. You're adding a member of
                            staff that exists only for AgentsPoppy — you can see everything it does, and
                            fire it any time by deleting the user. Don't tick "console access"; it never
                            needs to sign in.
                          </p>
                        </details>
                      </div>
                    </li>
                    <li className="wiz-action">
                      <span className="wiz-action-n">2</span>
                      <div className="wiz-action-body">
                        <p className="wiz-action-title">Hand it its permissions</p>
                        <CopyPolicyButton primary />
                        <p className="wiz-action-hint muted">
                          Choose <strong>Attach policies directly → Create policy → JSON</strong>, paste,
                          create it, tick it, press <strong>Next → Create user</strong>.
                        </p>
                        <details className="wiz-help">
                          <summary>Stuck? Where do I paste it?</summary>
                          <p>
                            On the user's permissions step, choose <strong>Attach policies directly</strong>,
                            then <strong>Create policy</strong> (it opens a new tab). Pick the{" "}
                            <strong>JSON</strong> tab, select everything in the box, paste what you copied,
                            then <strong>Next → Create policy</strong>. Back in the first tab, refresh the
                            list, tick your new policy, and finish creating the user.
                          </p>
                          <p className="micro">
                            It only allows the one-time setup —{" "}
                            <ExtLink href={ACCESS_POLICY_URL}>read every line</ExtLink>, and revoke it
                            whenever you like.
                          </p>
                        </details>
                      </div>
                    </li>
                  </ol>

                  <div className="wiz-nav">
                    <span className="spacer" />
                    <button className="btn btn-primary btn-lg" type="button" onClick={() => goto("key", "fwd")}>
                      Done — next: its access key →
                    </button>
                  </div>
                </>
              )}

              {view === "key" && (
                <>
                  {/* Result-language, not task-language, and OWNERSHIP-NEUTRAL (founder,
                      2026-09-02): "private cloud" excluded the enterprise admin, who
                      controls a cloud they don't own. "Take the keys" is the control
                      idiom — you take the keys to a company car — and this screen is
                      literally about keys. The action cards below carry the how. */}
                  <h1 className="wiz-hero-title">Take the keys to your cloud</h1>
                  <p className="wiz-hero-sub muted">
                    The last bit of console work: two codes. After this, AgentsPoppy does everything.
                  </p>
                  <ol className="wiz-actions">
                    <li className="wiz-action">
                      <span className="wiz-action-n">1</span>
                      <div className="wiz-action-body">
                        <p className="wiz-action-title">
                          Open your new user → <strong>Security credentials</strong> →{" "}
                          <strong>Create access key</strong>
                        </p>
                        <p className="wiz-action-hint muted">
                          Choose <strong>Command Line Interface (CLI)</strong>, tick the confirmation,
                          create it.
                        </p>
                      </div>
                    </li>
                    <li className="wiz-action">
                      <span className="wiz-action-n">2</span>
                      <div className="wiz-action-body">
                        <p className="wiz-action-title">Copy both values below — then press Done in AWS</p>
                        <p className="wiz-action-hint muted">
                          Copy first: the secret is shown <strong>only once</strong>.
                        </p>
                      </div>
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
                    {linked ? (
                      <button
                        className="btn btn-primary btn-lg"
                        disabled={!keyId.trim() || !keySecret.trim()}
                        onClick={() => void runSetup()}
                      >
                        Connect and set up
                      </button>
                    ) : (
                      <button
                        className="btn btn-primary btn-lg"
                        disabled={!keyId.trim() || !keySecret.trim()}
                        onClick={() => goto("region", "fwd")}
                      >
                        Next: choose where it lives →
                      </button>
                    )}
                    <p className="micro muted">
                      Your key is used <strong>once, in memory,</strong> to create AgentsPoppy's own limited
                      operator — it's never saved to disk and never uploaded. There is no AgentsPoppy
                      server.
                    </p>
                    <details className="wiz-help">
                      <summary>Can't create access keys? (company SSO, temporary credentials)</summary>
                      <p>
                        Some companies sign in to AWS through SSO and don't allow personal access keys.
                        The advanced setup works with the credentials already on this machine instead —
                        every step visible and under your control.{" "}
                        <button className="btn link" type="button" onClick={onProSwitch}>
                          Open the advanced setup
                        </button>
                      </p>
                    </details>
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

                </>
              )}
            </div>
          </div>
        )}

      </div>
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

/** The provider marks, drawn inline so the chooser needs no assets and no network. */
function AwsMark() {
  return (
    <svg className="wiz-mark" viewBox="0 0 120 72" aria-hidden="true">
      <text x="60" y="40" textAnchor="middle" fontSize="38" fontWeight="700" fill="#fff" fontFamily="system-ui, -apple-system, sans-serif" letterSpacing="-1">
        aws
      </text>
      <path d="M22 52c22 14 54 14 76-2" stroke="#f90" strokeWidth="6" fill="none" strokeLinecap="round" />
      <path d="M98 50l6-4-1 9z" fill="#f90" />
    </svg>
  );
}

function GcpMark() {
  return (
    <svg className="wiz-mark" viewBox="0 0 96 76" aria-hidden="true">
      <path d="M63 30l9-9 1-4C57 3 34 5 22 19c-3 4-6 9-7 14l3-1 18-3 2-2c8-9 17-6 25 3z" fill="#ea4335" />
      <path d="M80 33a27 27 0 0 0-8-13l-13 13c5 4 8 10 8 17v2c12 0 12 18 0 18H41l-4 4v11l4 3h26a24 24 0 0 0 13-55z" fill="#4285f4" />
      <path d="M41 88h26v-18H41a9 9 0 0 1-4-1l-13 13 1 3c5 2 11 3 16 3z" fill="#34a853" transform="translate(0 -14)" />
      <path d="M41 40a24 24 0 0 0-14 43l16-15a9 9 0 1 1 12-12l15-16A24 24 0 0 0 41 40z" fill="#fbbc05" transform="translate(0 -14)" />
    </svg>
  );
}

function AzureMark() {
  return (
    <svg className="wiz-mark" viewBox="0 0 96 76" aria-hidden="true">
      <path d="M44 8h16L38 68H10z" fill="#31b0e6" />
      <path d="M62 8 86 68H56l12-14-10-11z" fill="#0f6cbd" />
    </svg>
  );
}

/** The celebration: a one-shot confetti burst, pure CSS pieces — no library, no network. */
function WizConfetti() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 48 }, (_, i) => ({
        left: `${(i * 61) % 100}%`,
        delay: `${((i * 137) % 900) / 1000}s`,
        duration: `${2.4 + ((i * 53) % 14) / 10}s`,
        color: ["#d97757", "#e08a6d", "#f2c14e", "#7dc4a5", "#6d9ee0", "#c78ee0"][i % 6],
        spin: `${(((i * 97) % 2) === 0 ? 1 : -1) * (420 + ((i * 71) % 380))}deg`,
        size: 6 + ((i * 29) % 7),
      })),
    [],
  );
  return (
    <div className="wiz-confetti" aria-hidden="true">
      {pieces.map((p, i) => (
        <span
          key={i}
          className="wiz-confetti-piece"
          style={{
            left: p.left,
            animationDelay: p.delay,
            animationDuration: p.duration,
            background: p.color,
            width: p.size,
            height: p.size * 0.45,
            ["--spin" as string]: p.spin,
          }}
        />
      ))}
    </div>
  );
}
