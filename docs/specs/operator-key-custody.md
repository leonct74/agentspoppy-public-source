# Operator-key custody, phase 2 — the secret moves into the OS vault

**Status:** approved in direction by the founder (2026-09-01: *"release first the macOS
version so I can test the migration of the secret key to the vault"*); this spec is the
concrete shape. macOS ships first, for the founder's live validation; Windows and Linux
follow in the next release.

**The positioning line, the founder's (2026-09-01):** *it is safer to use AgentsPoppy than
the old way of saving a key on your machine.* Phase 2 is what makes that literally true at
the file level: `aws configure` leaves a secret in a file; AgentsPoppy will not.

## What changes

Today the operator's secret access key lives in `~/.aws/credentials` under the
`[agentspoppy]` profile (0600). Every same-user process can read that file — not poppies
(confined, `AWS_*` stripped), but any npm install script, editor extension, or malware
running as the user.

After phase 2, on macOS:

- the **secret** lives in the **macOS Keychain** (a generic-password item, service
  `AgentsPoppy AWS operator key`, account = the access key id);
- the profile keeps the **key id** plus a comment saying where the secret is — the file
  contains nothing secret;
- the broker resolves credentials as: key id from the profile + secret from the Keychain.

**Scope is one section of one file.** The `[agentspoppy]` profile only — written by
AgentsPoppy, never `default`. Every other profile, and every other use of the AWS CLI,
Terraform or anything else on the machine, is untouched. (Founder's question, answered
against the code: the writer and remover are section-scoped by construction.)

## Migration — verify before you strip

On broker start (and once per start only), macOS, when the profile still holds an inline
secret:

1. write the secret to the Keychain;
2. **read it back and compare** — only an exact match counts;
3. only then rewrite the profile section without the secret.

Any failure at any step leaves the file exactly as it was. The file is never touched until
the Keychain copy is proven readable. Migration of a profile carrying a session token is
skipped (temporary credentials expire on their own; not worth a custody edge case).

New keys pasted in the app go **straight** to the Keychain on macOS — no file secret is
ever written. If the Keychain write fails, the inline write happens as before: key entry
must never brick.

## Resolution and failure

`operatorCredentials()` (the single resolver every broker AWS client shares):

- profile has an inline secret → `fromIni`, exactly as today (legacy / non-macOS);
- profile is keychain-marked → key id from the file, secret from the Keychain, as static
  credentials;
- keychain-marked but the item is GONE → **a loud, specific error** ("reconnect your AWS
  key"), never a silent fall-through to the SDK chain — falling through could resolve a
  DIFFERENT identity and misattribute everything downstream.

The kill switch and "Forget this key" also delete the Keychain item, best-effort, after
revoking in AWS.

## Mechanics (macOS)

The broker is a Node SEA binary, so no native Keychain module: it shells to
`/usr/bin/security`. Writes go through `security -i` (commands on stdin) so the secret
never appears in an argv that `ps` could see; reads use
`find-generic-password -w`. Items created by the `security` CLI are readable by it
without a user prompt, which is what makes headless resolution work. Secret charset is
validated (AWS secrets are `[A-Za-z0-9/+=]`) before being embedded in a command line.

## Honest limits (to be stated in the UI copy, not hidden)

- A process running **as the user** can still ask `security` for the item; macOS may
  gate it with a prompt, but this is a higher bar, not an impossibility. The end state is
  phase 3 (Roles Anywhere — no long-lived secret on the machine at all).
- `aws sts get-caller-identity --profile agentspoppy` stops working — the one CLI trick
  the old file allowed. The app's connection panel is the inspection surface, and it
  gains a custody line ("Secret: in the macOS Keychain").
- This removes, it does not forensically erase: the secret's old blocks may persist on
  the SSD, exactly as the existing remover documents.

## Phase 2b — Windows and Linux (implemented 2026-09-01, Option B: one combined wave)

`vault.ts` dispatches per platform; custody code is platform-blind. Windows goes through
the real CredRead/CredWrite/CredDelete API P/Invoked from PowerShell — the built-in
`cmdkey` can write but cannot READ back, and a readback it cannot do is a verification it
cannot give. Transport is pinned by test: script on stdin, secret in the child's
environment, never argv. Linux uses `secret-tool` (secret on stdin both ways), with the
honest platform truth stated in code: a machine with no unlocked keyring keeps file
custody and nothing breaks — the vault is an upgrade where the desktop provides one,
never a requirement. The custody suite runs on every platform through the vault seam,
and `scripts/vault-smoke.mjs` does the real OS round trip in each CI build (macOS run
live on the founder's machine: PASS).

## What does NOT change

- The assume-only key (v4), the kill switch, backend confinement, `AWS_*` stripping —
  all unchanged. Phase 2 stacks on them.
- No mechanism (§4) file changes: the resolver lives in `credentials.ts`, which is not
  an enforcement point. `SECURITY_MECHANISM.md` §6.1 describes custody and needs a
  follow-up edit — that document is guard-protected, so the edit ships separately with
  the founder's mechanism approval.
