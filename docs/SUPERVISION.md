# Supervision — how AgentsPoppy gates an app's access to your cloud

This explains, for **users**, exactly what "Supervised", "Unsupervised", and a "Current session
expires in… / expired" mean on a connection — and what each one does and doesn't allow. The short
version: **an expired session is the safe state, not a gap.** The detail is below.

## The model in one picture

An app (a "poppy") never holds your AWS keys and never gets standing access. Every time it needs to
touch AWS, it asks AgentsPoppy for **short-lived, scope-limited credentials**, which AgentsPoppy
**mints on demand** by assuming a role in *your* account. Two independent controls bound what it can
do:

| Control | What it guarantees | When it's checked |
|---|---|---|
| **Scope** (least privilege) | The app can only ever touch resources its permission set allows — baked into *every* credential as it's minted. | Always — there is no credential that exceeds the scope. |
| **Supervision** | A human (you) approves before AgentsPoppy mints credentials for a **change**. | At each credential **mint**, re-evaluated every request. |

Scope is always on. Supervision is the optional human gate on top.

## Supervised vs Unsupervised

- **Supervised** — AgentsPoppy holds the connection's credentials and **you approve each time the app
  needs to make a change** (a create/update/delete). The app can't alter anything in your cloud until
  you say yes. A connection is supervised automatically when its permission set can reach **beyond its
  own resources** (e.g. an unscoped `*` on a mutating service), and you can turn it on for any app.
- **Unsupervised** — the app vends credentials on demand **within its approved scope** without a
  per-change prompt. Scope is still fully enforced (it's inside every credential); supervision just
  isn't adding the extra human gate.

**Reads are always allowed without a prompt**, even when supervised — read-only calls vend
automatically. Supervision is specifically about approving **changes**.

## What "approve" actually gates

Supervision gates the **minting of credentials for a mutating operation**. When the app requests
creds for a change:

1. AgentsPoppy checks the request is **within the connection's permission set** (an operation can
   never ask for more than you granted).
2. If supervised, it returns **"approval required"** and shows you the request in plain language.
3. Only after you approve does it **mint scope-limited, short-lived credentials** and hand them to the
   app's backend (never to the UI, never your operator keys).

So you approve the **grant of credentials**, not every individual API call. Once granted, the app
holds those scoped credentials for the short session window and can act **within that scope** until
they expire — this is the deliberate trade-off: **approve-per-mint, not approve-per-call.**

## Sessions are short-lived — and "expired" is the safe state

The credentials AgentsPoppy mints carry an expiry (typically up to an hour). The connection panel
shows a live countdown — *"Current session expires in 4:58"* — and when it lapses, *"expired —
renews on next use."* Here's what each means:

- **Counting down** — the app currently holds live, scope-limited credentials and can act within its
  scope (and, if supervised, within what you last approved) until the timer hits zero.
- **Expired** — the app holds **no usable credentials at all.** AWS itself rejects expired temporary
  credentials, so the app can do **nothing** in your cloud. To act again it must request fresh creds,
  which re-runs the gate above — meaning a supervised app **re-asks for your approval** for the next
  change.

So expiry doesn't weaken supervision; it's the moment supervision **re-asserts**. An idle connection
sitting at "expired" is locked out, which is exactly what you want.

### How do I refresh a session?

You don't, and there's no button to — **by design.** Credentials re-mint **on demand** the next time
the app needs AWS (deploy, manage a mailbox, tear down…), with your approval if it's a change. A
manual "renew" would just mint credentials that sit idle and expire again, which fights the
short-lived model. The expired state is the intended resting state between actions.

## Teardown

When you click **"Tear down everything it built,"** that action *is* your consent to remove
everything. So a supervised app's **cleanup credentials vend without a further per-operation
approval** for the duration of the teardown — the app's teardown hook can run headless to remove what
it created. An expired session is no obstacle: teardown mints what it needs when it runs. (Most of
teardown runs through your **operator** role deleting the CloudFormation stack, independent of the
app's session.)

## Why it's built this way

- **No standing access.** The app never holds long-lived keys; access stops within the hour even if
  you do nothing.
- **You're the gate for changes.** Nothing mutates your account without either your per-change
  approval (supervised) or a scope you explicitly granted (unsupervised).
- **Scope is non-negotiable.** Independent of all the above, every credential is tag/permission
  scoped, so an app can never exceed its permission set — supervised or not, live or expired.

In short: **Supervised + expired = the app has zero access right now and must get your approval to
regain any.** That's the system working as intended.
