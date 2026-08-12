// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ConnectedAccount } from "@agentspoppy/core";
import { ApiError, broker, brokerBaseUrl, type CallerIdentity, type RoleProbeResult } from "../api/broker";
import { accountLabel } from "../lib/format";
import { Disclosure } from "../components/Disclosure";
import { Icon } from "../components/Icon";
import { PoppySpinner } from "../components/PoppySpinner";
import { SetupWizard } from "./SetupWizard";
import {
  ACCESS_POLICY_URL,
  AWS_CLI_URL,
  AWS_FREE_TIER_URL,
  COMMON_REGIONS,
  CopyPolicyButton,
  ExtLink,
  IAM_USERS_URL,
  openExternal,
} from "./connectShared";

function msg(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

type StepState = "done" | "active" | "locked";

/** The verify step failed because the connected IAM user can't assume the broker role. The role
 *  trusts the whole account (Principal :root), so assumption is gated by the USER's own IAM policy
 *  — a permission gap on the user, not a broken setup. Detect it so we can show a fix, not a raw STS error. */
function isAssumeRoleDenied(reason: string): boolean {
  return /not authorized to perform:\s*sts:AssumeRole/i.test(reason) || /\bAccessDenied\b/i.test(reason);
}


export interface ConnectAwsViewProps {
  accounts: ConnectedAccount[];
  onBack: () => void;
  onChanged: () => void;
  /** Deep-link from the home "Manage AWS connection" panel: open straight into an action. */
  initialAction?: "change-creds" | "redeploy" | "update-policy";
}

/**
 * The one-time bootstrap: a focused, gated stepper (the "why is this safe"
 * narrative lives on the splash, not here). It creates a broker role plus a
 * dedicated NON-admin operator — AgentsPoppy never asks for or uses admin.
 */
export function ConnectAwsView({ accounts, onBack, onChanged, initialAction }: ConnectAwsViewProps) {
  // WIZARD is the default (founder direction 2026-08-11: the five-step stepper frustrated
  // most users — even we avoided testing it). Pro is the landing mode only for management
  // deep-links (change-creds / redeploy / update-policy) and for accounts already fully set
  // up; either way the two modes stay one click apart in both directions.
  const [mode, setMode] = useState<"wizard" | "pro">(() =>
    initialAction || accounts[0]?.roleArn ? "pro" : "wizard",
  );
  // True when the user ASKED for the wizard (banner switch, "use a different account").
  // The wizard's completed-account handoff is suppressed then: right after an unlink the
  // accounts prop is momentarily stale (still carrying the old roleArn), and the handoff
  // would bounce the user straight back to the pro view they just left.
  const [wizardExplicit, setWizardExplicit] = useState(false);
  const [identity, setIdentity] = useState<CallerIdentity | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [awsTab, setAwsTab] = useState<"new" | "have">("new");

  const [linkAlias, setLinkAlias] = useState("");
  const [linkRegion, setLinkRegion] = useState("us-east-1");

  const [roleArn, setRoleArn] = useState("");
  const [template, setTemplate] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [verify, setVerify] = useState<RoleProbeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // In-app key entry (the "I'd rather not touch a terminal" path).
  const [keyId, setKeyId] = useState("");
  const [keySecret, setKeySecret] = useState("");
  const [keyToken, setKeyToken] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [savingKeys, setSavingKeys] = useState(false);
  const [keysError, setKeysError] = useState<string | null>(null);
  // Reveal the key form when ALREADY connected, to switch which AWS user AgentsPoppy runs as.
  const [changeCreds, setChangeCreds] = useState(false);

  // Step 3: AUTOMATED (let AgentsPoppy deploy) vs MANUAL (deploy it yourself).
  const [setupMode, setSetupMode] = useState<"auto" | "manual">("auto");
  const [setupKeyId, setSetupKeyId] = useState("");
  const [setupKeySecret, setSetupKeySecret] = useState("");
  const [setupKeyToken, setSetupKeyToken] = useState("");
  const [showSetupSecret, setShowSetupSecret] = useState(false);
  // When AWS is already connected we deploy with those creds; this opts into
  // pasting a *different* (e.g. more privileged) key just for the deploy.
  const [useOwnKeys, setUseOwnKeys] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  // "Reused your existing setup" note after a cross-region join (second computer).
  const [deployNote, setDeployNote] = useState<string | null>(null);
  // Re-run the deploy on an ALREADY-set-up account (e.g. to apply a tightened role
  // guardrail). The bootstrap reconcile updates the existing stack in place.
  const [redeploy, setRedeploy] = useState(false);

  const probe = useCallback(() => {
    setChecking(true);
    setIdentityError(null);
    broker
      .awsIdentity()
      .then((id) => {
        setIdentity(id);
        setIdentityError(null);
      })
      .catch((e) => {
        setIdentity(null);
        setIdentityError(msg(e, "No AWS credentials found on this machine."));
      })
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    probe();
  }, [probe]);

  // Deep-link from the home Manage panel: open straight into change-creds / re-apply.
  useEffect(() => {
    if (initialAction === "change-creds") setChangeCreds(true);
    if (initialAction === "redeploy") setRedeploy(true);
  }, [initialAction]);

  // A returning user whose credentials lapsed is RECONNECTING, not signing up — start Step 1 on
  // the "I already have AWS" path (re-enter credentials), never "I'm new to AWS / create an account".
  useEffect(() => {
    if (accounts.length > 0) setAwsTab("have");
  }, [accounts.length]);

  const account = accounts[0] ?? null;
  const region = account?.regions[0] ?? linkRegion;

  useEffect(() => {
    if (account?.roleArn) setRoleArn(account.roleArn);
  }, [account?.roleArn]);

  async function run(fn: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(msg(e, "Something went wrong."));
    } finally {
      setBusy(false);
    }
  }

  async function saveKeys(): Promise<void> {
    setSavingKeys(true);
    setKeysError(null);
    try {
      const id = await broker.setAwsCredentials({
        accessKeyId: keyId.trim(),
        secretAccessKey: keySecret.trim(),
        sessionToken: keyToken.trim() || undefined,
      });
      setIdentity(id);
      setIdentityError(null);
      setKeySecret("");
      setKeyToken("");
      setChangeCreds(false); // collapse the "change credentials" form on success
    } catch (e) {
      setKeysError(msg(e, "AWS didn't accept those keys. Double-check the Access Key ID and Secret."));
    } finally {
      setSavingKeys(false);
    }
  }

  /** The reusable in-app key-entry form (fields + Connect), shared by first-run and "change credentials". */
  function keyEntryForm(): ReactNode {
    return (
      <>
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
              disabled={savingKeys}
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
                disabled={savingKeys}
              />
              <button type="button" className="btn ghost" onClick={() => setShowSecret((s) => !s)}>
                {showSecret ? "Hide" : "Show"}
              </button>
            </span>
          </label>
          <label className="field-label">
            Session token <span className="field-hint">only for temporary (STS) keys</span>
            <input
              className="field"
              placeholder="optional"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={keyToken}
              onChange={(e) => setKeyToken(e.target.value.trim())}
              disabled={savingKeys}
            />
          </label>
        </div>
        {keysError && <p className="inline-error">{keysError}</p>}
        <button
          className="btn btn-primary"
          disabled={savingKeys || !keyId.trim() || !keySecret.trim()}
          onClick={() => void saveKeys()}
        >
          {savingKeys ? "Connecting…" : "Connect"}
        </button>
        <p className="micro muted">
          Saved only on this Mac, to a dedicated <code>agentspoppy</code> profile in{" "}
          <code>~/.aws/credentials</code> (owner-only) — never your <code>default</code> profile, never
          uploaded. There is no AgentsPoppy server.
        </p>
      </>
    );
  }

  async function deployBootstrap(): Promise<void> {
    setDeploying(true);
    setDeployError(null);
    setDeployNote(null);
    try {
      // Reuse the already-connected credentials unless the user opted to paste a
      // different (e.g. more privileged) key just for the deploy. Omitting creds
      // also covers the fresh-machine case: the broker derives + links the account.
      // (A re-apply reuses them too; if they're the non-admin operator the deploy
      // fails and the user can switch to "different credentials".)
      const pasteKeys = useOwnKeys || !hasIdentity;
      const { brokerRoleArn, joinedExistingSetupIn, evictedAccessKeyId } = await broker.deployBootstrap(
        account?.id ?? null,
        pasteKeys
          ? {
              accessKeyId: setupKeyId.trim(),
              secretAccessKey: setupKeySecret.trim(),
              sessionToken: setupKeyToken.trim() || undefined,
            }
          : undefined,
      );
      // Any pasted setup creds are done with — drop them from the form too.
      setSetupKeySecret("");
      setSetupKeyToken("");
      if (joinedExistingSetupIn) {
        setDeployNote(
          `This computer reused your existing setup (it lives in ${joinedExistingSetupIn}) — nothing new was created; ` +
            `this computer just received its own key.` +
            (evictedAccessKeyId
              ? " The oldest previous key was retired to make room (AWS allows two) — if another computer was still using it, run setup there again."
              : ""),
        );
      }
      setRoleArn(brokerRoleArn);
      setRedeploy(false); // re-apply done → back to the "setup complete" state
      onChanged(); // pull the account back with its new roleArn
      // Deliberately do NOT re-probe identity here: the operator key was just created
      // and can take a second or two to go active (IAM eventual consistency). A probe
      // that fails would wrongly flip step 1 back to "not done" and re-expand it. Step 1
      // stays complete; the new operator key is exercised by the verify step instead.
    } catch (e) {
      setDeployError(
        msg(e, "Setup didn't finish. Nothing elevated was saved — click Deploy to resume."),
      );
    } finally {
      setDeploying(false);
    }
  }

  function downloadTemplate(): void {
    if (!template || !account) return;
    // WKWebView silently ignores `<a download>`/blob clicks, so we let the broker
    // serve the template with Content-Disposition: attachment and open that loopback
    // URL in the system browser, which saves it cleanly. (Mirrors MailPoppy's webview
    // download handoff.)
    openExternal(`${brokerBaseUrl()}/accounts/${encodeURIComponent(account.id)}/role-template/download`);
  }

  const hasIdentity = !!identity;
  const hasAccount = !!account;
  const hasRole = !!account?.roleArn;
  const verified = verify?.ok === true;

  const states: StepState[] = [
    hasIdentity ? "done" : "active",
    hasAccount ? "done" : hasIdentity ? "active" : "locked",
    hasRole ? "done" : hasAccount ? "active" : "locked",
    hasRole ? "done" : hasAccount ? "active" : "locked",
    // Verifying the connection needs working operator credentials, so if they've lapsed
    // (step 1 not done) keep this LOCKED — otherwise a reconnect shows two "active" steps
    // (re-enter creds AND verify) and it's unclear which to act on.
    verified ? "done" : hasRole && hasIdentity ? "active" : "locked",
  ];
  const doneCount = states.filter((s) => s === "done").length;
  const pct = Math.round((doneCount / states.length) * 100);

  const cfnUrl = `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/create`;

  if (mode === "wizard") {
    return (
      <SetupWizard
        accounts={accounts}
        identity={identity}
        checking={checking}
        onChanged={onChanged}
        onBack={onBack}
        onDone={onBack}
        onProSwitch={() => setMode("pro")}
        completedHandsOffToPro={!wizardExplicit}
      />
    );
  }

  return (
    <section className="connect">
      <button className="btn link" onClick={onBack}>
        ← Back
      </button>

      <header className="connect-hero">
        <h2>Connect your AWS</h2>
        <p className="lead">
          One-time setup. You create the access; AgentsPoppy only ever <em>assumes</em> a role you made —
          it never receives a key, and never asks for or uses admin.
        </p>
        <span className="noadmin-badge">
          <Icon name="lock" /> AgentsPoppy never asks for or uses admin access
        </span>
      </header>

      {/* The escape hatch the field reports asked for: anyone tangled in the pro steps can
          hand the rest to the wizard — it resumes from wherever the account actually is.
          Hidden once setup is complete (re-running the wizard there would just rotate the
          operator key for nothing) and on management deep-links. */}
      {!initialAction && !hasRole && (
        <div className="banner wiz-return">
          Feeling lost? The <strong>setup wizard</strong> can do all of this automatically.{" "}
          <button
            className="btn link"
            type="button"
            onClick={() => {
              setWizardExplicit(true);
              setMode("wizard");
            }}
          >
            Switch to the wizard
          </button>
        </div>
      )}

      {/* Landed here from a detected policy gap (e.g. after an update that needs a new permission):
          hand the user the exact current policy to copy + a one-click re-check, so the fix is
          "replace your IAM user's policy with this" — nothing to rebuild. */}
      {initialAction === "update-policy" && (
        <div className="banner banner-warn policy-update">
          <strong>Update your AWS policy.</strong> AgentsPoppy needs a permission your IAM user's current policy
          doesn't grant — this happens when an update adds one. Replace the policy with the latest and you're done:
          your account, role and region all stay exactly as they are.
          <ol className="substeps">
            <li>
              <CopyPolicyButton /> — or{" "}
              <ExtLink href={ACCESS_POLICY_URL}>
                open it on GitHub <Icon name="external" className="link-ext" />
              </ExtLink>
              .
            </li>
            <li>
              In AWS: <strong>IAM → Users → your user</strong> → open the AgentsPoppy policy, <strong>replace</strong>{" "}
              it with what you copied, and save.
            </li>
            <li>
              Come back and press <strong>Re-check</strong>.
            </li>
          </ol>
          <div className="policy-update__actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !account}
              onClick={() => void run(async () => setVerify(await broker.verifyAccount(account!.id)))}
            >
              {busy ? "Checking…" : "Re-check"}
            </button>
            {verify?.ok ? (
              <span className="ok">
                <Icon name="check" /> Access restored — you're all set.
              </span>
            ) : verify && !verify.ok ? (
              <span className="micro muted">Still blocked — save the policy on your IAM user, then try again.</span>
            ) : null}
          </div>
        </div>
      )}

      <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="progress-label muted">
        {doneCount} of {states.length} steps complete
      </p>

      {hasAccount && hasRole && !hasIdentity && !checking && (
        <div className="banner banner-warn">
          <strong>Reconnecting — you don't need to start over.</strong> Your AWS account is already linked and
          set up (steps 2–4 stay done). Re-enter your credentials in <strong>Step&nbsp;1</strong> below — or, if you
          don't have them anymore, follow Step&nbsp;1's guide to create a fresh key (a new IAM user is fine). Your
          existing setup still works either way, because it's tied to your AWS account, not to any one user.
        </div>
      )}

      {error && <p className="inline-error">{error}</p>}

      <ol className="stepper">
        <Step n={1} state={states[0]!} title="Get your AWS ready">
          {checking ? (
            <p className="muted probing">
              <PoppySpinner size={15} /> Looking for your AWS on this machine…
            </p>
          ) : identity ? (
            <>
              <p className="kv">
                <Icon name="check" className="kv-check" /> Reached AWS as <code>{identity.arn}</code>
              </p>
              <p className="muted">AWS account {identity.accountId}</p>
              {changeCreds ? (
                <div className="panel">
                  <p className="muted">
                    Paste another AWS user's key to switch which user AgentsPoppy runs as. It replaces the current
                    one in the dedicated <code>agentspoppy</code> profile — your other AWS profiles are untouched.
                  </p>
                  {keyEntryForm()}
                  <button className="btn link" type="button" disabled={savingKeys} onClick={() => setChangeCreds(false)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button className="btn" type="button" onClick={() => setChangeCreds(true)}>
                  Use a different AWS user / change credentials
                </button>
              )}
            </>
          ) : (
            <div className="noaws">
              <p className="kv">No AWS credentials found on this machine.</p>
              <p className="muted">
                AgentsPoppy runs on your <em>own</em> AWS account, reading the credentials already on this
                Mac — the same ones the AWS CLI uses. You never paste anything here.
              </p>
              <div className="segmented" role="tablist">
                <button
                  className={`seg${awsTab === "new" ? " active" : ""}`}
                  role="tab"
                  aria-selected={awsTab === "new"}
                  onClick={() => setAwsTab("new")}
                >
                  I'm new to AWS
                </button>
                <button
                  className={`seg${awsTab === "have" ? " active" : ""}`}
                  role="tab"
                  aria-selected={awsTab === "have"}
                  onClick={() => setAwsTab("have")}
                >
                  I already have AWS
                </button>
              </div>

              {awsTab === "new" ? (
                <div className="panel">
                  <p>
                    Creating an AWS account is free. AWS has a <strong>generous Free Tier</strong>: many
                    services are free for your first 12 months, and several stay free forever. You'll enter a
                    card for identity verification, but Free-Tier usage isn't charged.
                  </p>
                  <ExtLink className="btn btn-primary" href={AWS_FREE_TIER_URL}>
                    Create a free AWS account <Icon name="external" className="link-ext" />
                  </ExtLink>
                  <p className="micro muted">Opens {AWS_FREE_TIER_URL} in your browser.</p>
                  <p className="muted">
                    Once your account is ready, switch to <em>“I already have AWS”</em> to make it reachable
                    from this Mac.
                  </p>
                  <Disclosure title="What does the Free Tier actually cover?">
                    <ul>
                      <li>AWS Lambda — 1M requests every month, always free.</li>
                      <li>Amazon DynamoDB — 25 GB of storage, always free.</li>
                      <li>Amazon S3 — 5 GB for the first 12 months.</li>
                      <li>Plus dozens more services with always-free or 12-month allowances.</li>
                    </ul>
                    <p>
                      Exact limits change over time — see the{" "}
                      <ExtLink href={AWS_FREE_TIER_URL}>AWS Free Tier page</ExtLink> for the current details.
                    </p>
                  </Disclosure>
                </div>
              ) : (
                <div className="panel">
                  <p>
                    Create a dedicated, least-privilege key in the{" "}
                    <ExtLink href={IAM_USERS_URL}>
                      AWS Console → IAM → Users <Icon name="external" className="link-ext" />
                    </ExtLink>{" "}
                    — easier and safer than the terminal, and never your account root:
                  </p>
                  <ol className="substeps">
                    <li>
                      Add a user and attach the scoped AgentsPoppy access policy —{" "}
                      <CopyPolicyButton /> or{" "}
                      <ExtLink href={ACCESS_POLICY_URL}>
                        view it on GitHub <Icon name="external" className="link-ext" />
                      </ExtLink>{" "}
                      (or use <strong>AdministratorAccess</strong>, if you prefer) — the scoped one lets the one-time
                      setup create AgentsPoppy's own role + operator and nothing else, and you can revoke it any
                      time.
                    </li>
                    <li>
                      Open <strong>Security credentials → Create access key → Command Line Interface (CLI)</strong>.
                    </li>
                    <li>
                      Copy the <strong>Access Key ID</strong> and <strong>Secret Access Key</strong> — the secret is
                      shown only once.
                    </li>
                  </ol>
                  <p>Then paste them here:</p>

                  {keyEntryForm()}

                  <Disclosure title="Prefer the AWS CLI?">
                    <p>You can configure the AWS CLI directly instead of using the form above:</p>
                    <ol className="substeps">
                      <li>
                        Open the <strong>Terminal</strong> and run{" "}
                        <code>aws configure --profile agentspoppy</code>.
                      </li>
                      <li>
                        Paste the two values at the <code>AWS Access Key ID</code> and{" "}
                        <code>AWS Secret Access Key</code> prompts. For <code>Default region name</code> enter e.g.{" "}
                        <code>us-east-1</code>; for <code>Default output format</code> press Enter.
                      </li>
                    </ol>
                    <p className="micro muted">
                      No <code>aws</code> command yet? Install the{" "}
                      <ExtLink href={AWS_CLI_URL}>
                        AWS CLI <Icon name="external" className="link-ext" />
                      </ExtLink>{" "}
                      first. Prefer AWS SSO? Run <code>aws configure sso --profile agentspoppy</code>.
                    </p>
                  </Disclosure>

                  <p className="micro muted">
                    The next step creates a dedicated <strong>non-admin operator</strong>; you'll point
                    AgentsPoppy at that, so it never runs as admin.
                  </p>
                  <Disclosure title="Where are my keys stored?">
                    <p>
                      <strong>Only on this Mac</strong> — saved to a dedicated <code>agentspoppy</code> profile in{" "}
                      <code>~/.aws/credentials</code> (owner-only, exactly like <code>aws configure</code>), never your{" "}
                      <code>default</code> profile. AgentsPoppy reads them only at the moment it makes an AWS call.
                      They are <strong>never uploaded</strong>, and there is <strong>no AgentsPoppy server</strong> to
                      send them to.
                    </p>
                  </Disclosure>
                  <Disclosure title="Do I need admin?">
                    <p>
                      Only to <em>deploy</em> the one-time setup, and only in your browser console. AgentsPoppy
                      itself is never given admin — the credential it uses day-to-day is the limited operator
                      created in the next step.
                    </p>
                    <p>
                      Prefer not to use admin even for the deploy? Attach the scoped{" "}
                      <ExtLink href={ACCESS_POLICY_URL}>
                        AgentsPoppy access policy <Icon name="external" className="link-ext" />
                      </ExtLink>{" "}
                      to an IAM user instead — it can create only AgentsPoppy's own role and operator, nothing else.
                    </p>
                  </Disclosure>
                </div>
              )}

              <button className="btn btn-primary" disabled={checking} onClick={probe}>
                {checking ? "Checking…" : "I've set it up — check again"}
              </button>
              {identityError && <p className="micro muted">Last check: {identityError}</p>}
            </div>
          )}
        </Step>

        <Step n={2} state={states[1]!} title="Link your AWS account">
          {account ? (
            <>
              <p className="kv">
                <Icon name="check" className="kv-check" /> Linked <code>{accountLabel(account)}</code>
                {account.regions.length > 0 && <span className="muted"> · {account.regions.join(", ")}</span>}
              </p>
              {hasIdentity && identity && identity.accountId !== account.accountId && (
                <p className="inline-error">
                  This links AWS account <code>{account.accountId}</code>, but you're signed in as{" "}
                  <code>{identity.accountId}</code>. Unlink to connect the account you're signed in to.
                </p>
              )}
              <button
                className="btn btn-danger"
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await broker.unlinkAccount(account.id);
                    setRoleArn("");
                    setUseOwnKeys(false);
                    onChanged();
                    // Connecting a DIFFERENT account is onboarding again — hand it to the
                    // wizard, the default surface for that. Pro stays one click away there.
                    setWizardExplicit(true);
                    setMode("wizard");
                  })
                }
              >
                Unlink / use a different account
              </button>
            </>
          ) : (
            <>
              <p className="muted">
                AgentsPoppy tracks everything per AWS account. Give this one a name and pick the region you
                mainly use.
              </p>
              <div className="field-grid">
                <label className="field-label">
                  AWS account (detected)
                  <input className="field" value={identity?.accountId ?? "…"} readOnly tabIndex={-1} />
                  <span className="field-hint">From your AWS login above — you don't enter this.</span>
                </label>
                <label className="field-label">
                  Name (optional)
                  <input
                    className="field"
                    placeholder="Personal AWS"
                    value={linkAlias}
                    onChange={(e) => setLinkAlias(e.target.value)}
                    disabled={!hasIdentity}
                  />
                </label>
                <label className="field-label">
                  Primary region
                  <select
                    className="field"
                    value={linkRegion}
                    onChange={(e) => setLinkRegion(e.target.value)}
                    disabled={!hasIdentity}
                  >
                    {COMMON_REGIONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button
                className="btn btn-primary"
                disabled={!hasIdentity || busy}
                onClick={() =>
                  void run(async () => {
                    await broker.createAccount({
                      accountId: identity!.accountId,
                      alias: linkAlias.trim() || undefined,
                      regions: [linkRegion],
                    });
                    onChanged();
                  })
                }
              >
                Link this account
              </button>
            </>
          )}
        </Step>

        <Step n={3} state={states[2]!} title="Create the broker role + operator">
          <p className="muted">
            This one-time setup lets AgentsPoppy hand your apps <strong>limited, temporary</strong> AWS access
            and tidy up after them — <strong>never as an admin</strong>. You set it up yourself, so it can't
            give itself anything, and you can switch it off whenever you like.
          </p>
          <div className="segmented" role="tablist">
            <button
              className={`seg${setupMode === "auto" ? " active" : ""}`}
              role="tab"
              aria-selected={setupMode === "auto"}
              onClick={() => setSetupMode("auto")}
            >
              Automated
            </button>
            <button
              className={`seg${setupMode === "manual" ? " active" : ""}`}
              role="tab"
              aria-selected={setupMode === "manual"}
              onClick={() => setSetupMode("manual")}
            >
              Manual (expert)
            </button>
          </div>

          {setupMode === "auto" ? (
            hasRole && !redeploy ? (
              <>
                <p className="kv">
                  <Icon name="check" className="kv-check" /> Setup complete — the broker role and non-admin
                  operator are ready.
                </p>
                {deployNote && <p className="muted">{deployNote}</p>}
                <button className="btn" type="button" onClick={() => setRedeploy(true)}>
                  Re-apply setup (update the broker role)
                </button>
              </>
            ) : (
              <div className="panel">
                {redeploy && (
                  <p className="muted">
                    Re-applies the latest setup template to your existing <code>AgentsPoppy</code> stack — e.g. to
                    pick up new role guardrails. It uses the credentials you have connected; if those are the
                    non-admin operator (which can't modify the stack), click{" "}
                    <strong>Use different credentials</strong> and paste an admin or access-policy key.
                  </p>
                )}
                {hasIdentity && !useOwnKeys ? (
                  <>
                    <p>
                      AgentsPoppy will use the AWS credentials you already connected
                      {identity ? (
                        <>
                          {" "}
                          (<code>{identity.arn}</code>)
                        </>
                      ) : null}{" "}
                      — <strong>just this once</strong> — to create the broker role + non-admin operator, then
                      switch to that operator and stop using the elevated access.
                    </p>
                    <button className="btn btn-primary" disabled={deploying} onClick={() => void deployBootstrap()}>
                      {deploying ? (
                        <>
                          <PoppySpinner size={15} tone="current" /> Deploying setup…
                        </>
                      ) : (
                        "Deploy setup"
                      )}
                    </button>
                    <button className="btn link" type="button" disabled={deploying} onClick={() => setUseOwnKeys(true)}>
                      Use different credentials for this step
                    </button>
                  </>
                ) : (
                  <>
                    <p>
                      Paste credentials allowed to create the role <strong>once</strong> — your admin keys, or a
                      user carrying the scoped{" "}
                      <ExtLink href={ACCESS_POLICY_URL}>
                        AgentsPoppy access policy <Icon name="external" className="link-ext" />
                      </ExtLink>
                      . AgentsPoppy deploys the stack, then keeps <strong>only</strong> the resulting non-admin
                      operator key.
                    </p>
                    <p className="muted">
                      These setup keys are used here just to deploy — they're{" "}
                      <strong>held in memory, never written to disk, and never sent anywhere</strong>. There is no
                      AgentsPoppy server.
                    </p>
                    <div className="field-grid">
                      <label className="field-label">
                        Access Key ID
                        <input
                          className="field"
                          placeholder="AKIA…"
                          autoCapitalize="off"
                          autoCorrect="off"
                          spellCheck={false}
                          value={setupKeyId}
                          onChange={(e) => setSetupKeyId(e.target.value.trim())}
                          disabled={deploying}
                        />
                      </label>
                      <label className="field-label">
                        Secret Access Key
                        <span className="field-row">
                          <input
                            className="field"
                            type={showSetupSecret ? "text" : "password"}
                            placeholder="••••••••••••••••••••"
                            autoCapitalize="off"
                            autoCorrect="off"
                            spellCheck={false}
                            value={setupKeySecret}
                            onChange={(e) => setSetupKeySecret(e.target.value.trim())}
                            disabled={deploying}
                          />
                          <button type="button" className="btn ghost" onClick={() => setShowSetupSecret((s) => !s)}>
                            {showSetupSecret ? "Hide" : "Show"}
                          </button>
                        </span>
                      </label>
                      <label className="field-label">
                        Session token <span className="field-hint">only for temporary (STS) keys</span>
                        <input
                          className="field"
                          placeholder="optional"
                          autoCapitalize="off"
                          autoCorrect="off"
                          spellCheck={false}
                          value={setupKeyToken}
                          onChange={(e) => setSetupKeyToken(e.target.value.trim())}
                          disabled={deploying}
                        />
                      </label>
                    </div>
                    <button
                      className="btn btn-primary"
                      disabled={deploying || !setupKeyId.trim() || !setupKeySecret.trim()}
                      onClick={() => void deployBootstrap()}
                    >
                      {deploying ? (
                        <>
                          <PoppySpinner size={15} tone="current" /> Deploying setup…
                        </>
                      ) : (
                        "Deploy setup"
                      )}
                    </button>
                    {hasIdentity && (
                      <button
                        className="btn link"
                        type="button"
                        disabled={deploying}
                        onClick={() => setUseOwnKeys(false)}
                      >
                        Use the credentials I already connected
                      </button>
                    )}
                  </>
                )}
                {deployError && <p className="inline-error">{deployError}</p>}
                <p className="micro muted">
                  Safe to interrupt: nothing elevated is stored. If it stops partway, just click Deploy again — it
                  picks up from wherever AWS actually got to.
                </p>
              </div>
            )
          ) : (
            <>
              <button
                className="btn"
                disabled={!hasAccount || busy}
                onClick={() =>
                  void run(async () => {
                    setTemplate((await broker.roleTemplate(account!.id)).templateJson);
                    setCopied(false);
                  })
                }
              >
                Generate setup template
              </button>

              {template && (
            <div className="template">
              <div className="code-toolbar">
                <code className="muted">agentspoppy-setup.json</code>
                <span className="spacer" />
                <button
                  className="btn ghost"
                  onClick={() => {
                    void navigator.clipboard?.writeText(template);
                    setCopied(true);
                  }}
                >
                  <Icon name="copy" /> {copied ? "Copied" : "Copy"}
                </button>
                <button className="btn ghost" onClick={downloadTemplate}>
                  <Icon name="download" /> Download
                </button>
              </div>
              <textarea className="code-block" readOnly rows={9} value={template} />
              <ol className="substeps">
                <li>
                  Open the{" "}
                  <ExtLink href={cfnUrl}>
                    CloudFormation console <Icon name="external" className="link-ext" />
                  </ExtLink>{" "}
                  → <strong>Create stack</strong> → <strong>With new resources</strong> →{" "}
                  <strong>Upload a template file</strong>, and pick the file you downloaded.
                </li>
                <li>
                  Name the stack <code>AgentsPoppy</code>, tick the box acknowledging it creates IAM
                  resources, and <strong>Submit</strong>. <span className="muted">(This is the one step that needs
                  elevated permissions — and it happens in your browser, not in AgentsPoppy.)</span>
                </li>
                <li>
                  Rather not use admin for this? Attach the scoped{" "}
                  <ExtLink href={ACCESS_POLICY_URL}>
                    AgentsPoppy access policy <Icon name="external" className="link-ext" />
                  </ExtLink>{" "}
                  to an IAM user and deploy as that user — it can create <em>only</em> the{" "}
                  <code>AgentsPoppyBroker</code> role and <code>AgentsPoppyOperator</code> user, nothing else.
                </li>
                <li>
                  When it's <code>CREATE_COMPLETE</code>, open <strong>IAM → Users → AgentsPoppyOperator →
                  Security credentials → Create access key</strong>. This user is <strong>not</strong> admin.
                </li>
                <li>
                  Point AgentsPoppy at that operator key (not your admin key) by running{" "}
                  <code>aws configure --profile agentspoppy</code> in the Terminal — so AgentsPoppy runs as the
                  limited operator.{" "}
                  <span className="muted">
                    (Don't want the Terminal? Switch to <strong>Automated</strong> above — it creates the operator
                    key and stores it for you.)
                  </span>
                </li>
                <li>
                  Finally, open the stack's <strong>Outputs</strong> tab and copy the{" "}
                  <strong>BrokerRoleArn</strong> value for the next step.
                </li>
              </ol>
            </div>
              )}
            </>
          )}

          <Disclosure title="What will this role be allowed to do?">
            <p>
              It's broad enough that apps work without re-deploying — but it carries a hard guardrail: it can
              <strong> never</strong> manage IAM users, change account settings, disable your CloudTrail audit
              logging, or alter AgentsPoppy itself. So no app (or bug) can ever lock you out, become admin, or
              hide its tracks from your activity log.
            </p>
            <p>
              And each app only ever receives the exact slice it asked for — AgentsPoppy narrows the role per
              app every time it hands out keys.
            </p>
          </Disclosure>
          <Disclosure title="Why do I create this instead of AgentsPoppy?">
            <p>
              Control and auditability. You review the template and deploy it in your own account, and you
              can delete the stack anytime to sever everything. AgentsPoppy is never given permission to
              create roles, create users, or change your account — it has no admin, by design.
            </p>
          </Disclosure>
        </Step>

        <Step n={4} state={states[3]!} title="Paste the Broker Role ARN">
          <div className="field-row">
            <input
              className="field"
              placeholder="arn:aws:iam::123456789012:role/AgentsPoppyBroker"
              value={roleArn}
              onChange={(e) => setRoleArn(e.target.value)}
              disabled={!hasAccount}
            />
            <button
              className="btn btn-primary"
              disabled={!hasAccount || busy || !roleArn.trim()}
              onClick={() =>
                void run(async () => {
                  await broker.setAccountRole(account!.id, roleArn.trim());
                  setVerify(null);
                  onChanged();
                })
              }
            >
              Save
            </button>
          </div>
          {hasRole && (
            <p className="ok">
              <Icon name="check" /> Saved <code>{account!.roleArn}</code>
            </p>
          )}
          <Disclosure title="Where do I find it?">
            <p>
              In the CloudFormation stack you deployed, open the <strong>Outputs</strong> tab — it's the value
              labelled <code>BrokerRoleArn</code>, starting with <code>arn:aws:iam::</code>.
            </p>
          </Disclosure>
        </Step>

        <Step n={5} state={states[4]!} title="Verify the connection">
          <p className="muted">
            A safe check: AgentsPoppy assumes the role once (as the operator) to confirm everything lines up.
            Nothing is created or changed.
          </p>
          <button
            className="btn"
            disabled={!hasRole || busy}
            onClick={() => void run(async () => setVerify(await broker.verifyAccount(account!.id)))}
          >
            Verify connection
          </button>
          {verify?.ok && (
            <p className="ok">
              <Icon name="check" /> Role is assumable — <code>{verify.assumedArn}</code>
            </p>
          )}
          {verify && !verify.ok &&
            (isAssumeRoleDenied(verify.reason) ? (
              <div className="inline-error">
                <strong>This user's policy is missing a permission.</strong>
                <p>
                  The AWS user you connected isn't allowed to assume AgentsPoppy's broker role — the role trusts your
                  whole account, so this is an <em>IAM policy</em> on the user, not a re-setup. Replace its policy with
                  the current one:
                </p>
                <ol className="substeps">
                  <li>
                    <CopyPolicyButton /> — or{" "}
                    <ExtLink href={ACCESS_POLICY_URL}>
                      open it on GitHub <Icon name="external" className="link-ext" />
                    </ExtLink>
                    .
                  </li>
                  <li>
                    In AWS: <strong>IAM → Users → your user</strong> → open the AgentsPoppy policy, <strong>replace</strong>{" "}
                    it with what you copied, and save.
                  </li>
                  <li>Come back and Verify again.</li>
                </ol>
                <p className="micro muted">AWS said: {verify.reason}</p>
              </div>
            ) : (
              <p className="inline-error">Couldn't assume the role: {verify.reason}</p>
            ))}
        </Step>
      </ol>

      {verified && (
        <div className="done-banner">
          <span className="done-burst">
            <Icon name="shield" />
          </span>
          <div>
            <strong>Your AWS is connected.</strong>
            <p className="muted">
              Apps can now request access — each appears on your home screen for approval. You stay in
              control: pause, revoke, or tear down anything they build, anytime. And nothing here can lock
              you out.
            </p>
          </div>
          <button className="btn btn-primary" onClick={onBack}>
            Done
          </button>
        </div>
      )}
    </section>
  );
}

function Step({
  n,
  state,
  title,
  children,
}: {
  n: number;
  state: StepState;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className={`step step-${state}`}>
      <div className="step-marker">
        {state === "done" ? <Icon name="check" /> : state === "locked" ? <Icon name="lock" /> : n}
      </div>
      <div className="step-content">
        <h3 className="step-title">{title}</h3>
        {children}
      </div>
    </li>
  );
}
