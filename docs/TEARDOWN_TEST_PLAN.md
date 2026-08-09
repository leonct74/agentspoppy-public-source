# Teardown & Poppy-Protection Test Plan

**A repeatable manual acceptance runbook for the most adoption-critical feature in AgentsPoppy:
tearing down a poppy's cloud footprint completely and safely, in every poppy state.**

If teardown ever leaves a user with orphaned, billable AWS resources — or worse, deletes the
wrong thing — trust in AgentsPoppy is gone. This plan exists so that guarantee is verified the
same way every time, by anyone, before any release that touches teardown, credentials, the
deletion engine, or the operator IAM policy.

> **Run this whenever** you change: `packages/broker/src/aws/deletion.ts`, `service.ts` teardown,
> `cloudformation.ts` (findResiduals / deleteStack / emptyBucket), the IAM policy twins
> (`infra/policies/agentspoppy-access-policy.json` + `role-template.ts`), or the teardown UI in
> `app/src/views/ConnectionDetailView.tsx` / `app/src/App.tsx`.

The automated suite (`npm test` across `packages/*` + `app`) already covers the *logic* of every
fix below. This plan covers what unit tests **cannot**: real AWS deletion, the **packaged**
desktop app, real operator credentials, and the adversarial "hostile poppy" cases. Both must pass.

---

## 0. Safety — read first

- **Teardown is irreversible and deletes real data.** It empties S3 buckets (all versions),
  deletes DynamoDB tables and Cognito user pools — including RETAIN-marked ones that survive a
  plain stack delete. **Never run these tests against a poppy you care about** (e.g. your real
  MailPoppy mailbox).
- **Use a throwaway target.** Best: a **scratch AWS account**. Acceptable: your normal account
  but a **throwaway MailPoppy domain / stack** you're happy to destroy. This document calls it
  "the test poppy".
- You run all AWS CLI commands yourself with your own credentials. This repo's tooling never
  performs live AWS mutations on your behalf.

---

## 1. Prerequisites (once per test session)

| # | Step | Why |
|---|------|-----|
| P1 | **Re-copy the operator IAM policy.** In the IAM console, replace the AgentsPoppy customer-managed policy with the current [`infra/policies/agentspoppy-access-policy.json`](../infra/policies/agentspoppy-access-policy.json). | The `HostResidualCleanup` statement (tag-read + delete actions) is new; without it host cleanup gets `AccessDenied`. Test **T7** deliberately checks the *un-updated* state first, so do P1 **after** T7 if you want to see that path. |
| P2 | **Build the packaged app:** `npm run tauri:build`, then launch the built app (not the dev server). | The host-token auth + Tauri opener only work in the packaged app; teardown is management-plane and needs the real host. |
| P3 | **Deploy the test poppy** with a real footprint: connect the throwaway account, deploy the MailPoppy backend, and provision at least one domain so a RETAIN bucket + tables + user pool exist. | You need out-of-stack / RETAINed resources for the deletion engine to actually have something to remove. |
| P4 | **Install the verifier:** `awscli` v2 + `jq`. The ground-truth check is [`scripts/verify-teardown.sh`](../scripts/verify-teardown.sh). | Every teardown test ends by asserting AWS itself holds nothing tagged — independent of what the app's report says. |

The test poppy's app id is **`com.mailpoppy.desktop`** and its attribution tag is
**`agentspoppy:app = com.mailpoppy.desktop`** (used by the verifier).

---

## 2. The ground-truth check (used by every teardown test)

After any teardown, the definition of success is **"AWS holds nothing tagged as the poppy's"** —
not what the UI claims (the tag index can lag or, before the fixes, lie). Run:

```bash
scripts/verify-teardown.sh com.mailpoppy.desktop <your-region>
# exit 0 + "✅ CLEAN"  = pass
# exit 2 + "❌ N resource(s) still tagged" = leftovers; open each ARN in the console
```

**"Still tagged" is a lead, not a verdict — open the ARN.** The tag index is a cache and lags
deletion: CloudFront distributions clear in ~10 minutes, and Cognito user pools have been seen
listed for days after the pool was genuinely gone. The console (or a direct Describe on the
resource) is ground truth. A resource the console reports as non-existent is deleted, however
long the index keeps naming it; re-run the check later for the clean zero. Only a resource the
console still SHOWS is a leftover — and then the teardown is what gets fixed, never the check.
See `AGENTS.md` §4 for the developer-facing version of this rule.

The index is eventually consistent: if it reports leftovers within ~1 min of a teardown, wait and
re-run before treating it as a failure.

---

## 3. Test matrix

Each test lists the fix it protects (commit), preconditions, steps, and the **exact** expected
result. Record PASS/FAIL in the sheet in §5. Re-deploy the test poppy (P3) between destructive
tests.

### T1 — Baseline: teardown of an ACTIVE poppy (the control)
*Protects: the core deletion engine (d682024). If this fails, nothing else is meaningful.*

1. With the test poppy **active** and deployed, open it in the dashboard → **Manage**.
2. Click **“Tear down everything it built.”**
3. In the confirm dialog, type the poppy name exactly, click **“Tear it all down.”**
4. Wait for the busy state to finish (a minute or two).

**Expect:**
- A green notice: *“Tore down N stack(s): … No resources tagged as built by … remain — your
  account is clean.”* (may also read *“AgentsPoppy also directly removed M leftover resource(s)…”*
  — that's the host engine deleting the RETAINed bucket/tables/pool).
- No leftovers panel.
- **Ground truth:** `verify-teardown.sh` → ✅ CLEAN.

### T2 — Hard pause / resume (a paused poppy really stops, and looks it)
*Protects: hard-pause + the visible paused state.*

1. On an active poppy, click **Pause** (Manage view).
2. **In the sidebar:** the poppy's glyph turns into a **pause icon**, a **“Paused”** pill appears
   beside its name, and its status dot is amber. (This is the "can't pause-and-forget" guarantee.)
3. **Open the poppy's tab:** it shows **“{poppy} is paused … Resume”**, not its normal UI.
4. **Prove it actually halted:** while paused, try an action that needs AWS (e.g. create a mailbox
   in MailPoppy). It should **fail / be unavailable** — the backend is stopped, so there's nothing
   to act on cached credentials. *(Before the hard-pause fix, this still worked for up to ~1h.)*
5. Click **Resume** → status **active**, the pause pill/icon clear, the backend respawns, the tab
   loads its normal UI, and AWS actions work again.

**Expect:** pause is an immediate, visible, reversible halt; no teardown involved.

### T3 — Revoke-ordering guard (footprint present)
*Protects: the revoke-before-teardown guard (14f76ed).*

1. On an active poppy **that has a footprint**, click **“Revoke access.”**

**Expect:** it does **not** revoke immediately. A modal **“Delete what … built first?”** appears
with three buttons: **Cancel**, **Revoke access only**, **Tear down first**. (Choosing *Revoke
access only* here sets up **T5**.)

### T4 — Revoke-ordering guard (no footprint)
*Protects: the guard only nags when there's something to strand.*

1. Deploy nothing / tear down first so the poppy has **no footprint**, then click **Revoke
   access.**

**Expect:** it revokes **directly**, no modal.

### T5 — Teardown of a REVOKED poppy (host cleanup completes)
*Protects: the retired hard-gate → recommendation + host backstop (c98034b → d682024).*

1. Revoke the test poppy while it still has a footprint (T3 → *Revoke access only*).
2. Open it → **Manage** → **“Tear down everything it built.”**

**Expect:**
- Teardown is **not blocked**. The dialog shows an amber note that its own cleanup can't run but
  *AgentsPoppy directly removes everything tagged as built by it*, and offers a secondary
  **“Re-enable first (recommended)”** button next to the type-to-confirm field.
- Type the name → **“Tear it all down”** works.
- Green clean notice as in T1.
- **Ground truth:** `verify-teardown.sh` → ✅ CLEAN. *(The RETAINed resources are gone even though
  the poppy never re-ran its own hook — this is the whole point.)*

### T6 — Teardown of a BLOCKED poppy
*Protects: no dead-end for banned poppies (c98034b + d682024).*

1. On the poppy, open **Report** (button beside its name) → tick **Block from loading** → send.
   Its sidebar dot turns red / **“Blocked.”**
2. **Manage** → **“Tear down everything it built.”**

**Expect:**
- Honest blocked copy: *“… is blocked, so its own cleanup can't run … things only it knows about
  (e.g. DNS records it created) **can be left behind** …”* — and **no** “Re-enable first” button
  (re-enabling a blocked poppy is a dead-end, so it isn't offered).
- Type-to-confirm still tears down; host cleanup still removes the tagged RETAINed resources.
- **Ground truth:** `verify-teardown.sh` → ✅ CLEAN (for *tagged* resources; genuinely un-tagged
  leftovers like DNS records are the poppy's own-hook responsibility and out of scope here).

### T7 — Denied cleanup never reads as “clean” (drift detection)
*Protects: the denied-sweep fix + update-policy UX (834bd18). **Run this BEFORE P1** to see it naturally, or temporarily detach the policy.*

1. With the operator policy **missing** the `HostResidualCleanup` actions (i.e. the pre-update
   policy), revoke or block the test poppy so host cleanup must run, then tear it down.

**Expect:**
- **No green “your account is clean.”** Instead a **warning** notice that AgentsPoppy *wasn't
  allowed to finish or verify the cleanup*, plus a leftovers panel with an **“Update access
  policy”** button (routes to the update-policy screen).
- **Ground truth:** `verify-teardown.sh` will show the RETAINed resources **still present** —
  confirming the UI correctly refused to claim success.
- Then do **P1** (update the policy), tear down again → now T1's clean result.

### T8 — Hostile-poppy bucket cannot hang teardown  ⭐ (the high-severity fix)
*Protects: the DeleteObjects per-key-failure infinite-loop fix (834bd18). This is the single most important adversarial case.*

Simulate a malicious poppy that armed its own RETAIN bucket against deletion:

1. Deploy the test poppy (P3). Find its mail bucket name (dashboard infra map, or `verify-teardown.sh`).
2. Put an **explicit Deny** on object deletion for that bucket (you run this — throwaway bucket only):
   ```bash
   aws s3api put-bucket-policy --bucket <MAIL_BUCKET> --policy '{
     "Version":"2012-10-17",
     "Statement":[{"Sid":"DenyDeletes","Effect":"Deny","Principal":"*",
       "Action":["s3:DeleteObject","s3:DeleteObjectVersion"],
       "Resource":"arn:aws:s3:::<MAIL_BUCKET>/*"}]}'
   ```
   (Explicit Deny beats the operator Allow, so per-object deletes fail — exactly the hostile case.)
3. Revoke the poppy, then tear it down.

**Expect:**
- Teardown **finishes** in a minute or two — it does **NOT** hang, and the app does **not** spin
  forever. *(Before the fix this looped on S3 indefinitely.)*
- A **leftovers panel** lists the bucket as *could not be removed*, with an **“Open in console ↗”**
  link; because it's a permissions denial, the **“Update access policy”** hint may also show.
- **Ground truth:** the bucket still exists (expected — you Denied its deletion). Remove the bucket
  policy and tear down / delete by hand to clean up:
  ```bash
  aws s3api delete-bucket-policy --bucket <MAIL_BUCKET>
  ```

### T9 — Wrong-account refusal (optional; needs a 2nd account or profile)
*Protects: the operator-account cross-check (834bd18).*

1. Connect the test poppy against **account A**. Then point the broker's operator credentials at a
   **different account B** (e.g. launch with `AWS_PROFILE=<account-B>`), and attempt teardown.

**Expect:** teardown is **refused** with a message that your credentials belong to a different
account than the poppy is connected to — **nothing is deleted in account B**. Restore account-A
credentials to proceed normally.

### T10 — Re-enable a revoked poppy (access is restorable)
*Protects: the reopen → Enable → Approve restore path.*

1. Revoke the test poppy (keep its footprint). Navigate away to the dashboard, then click the
   poppy again.
2. It shows **“not enabled yet”** → click **Enable** → then **Approve**.

**Expect:** the poppy returns to **active** with a fresh connection; it can run again. (Confirms
revoke isn't terminal for the relationship.)

---

## 4. Cross-reference: what's already covered by automated tests

Don't re-derive these by hand — they run in CI. This plan exists for the rows they can't reach
(real AWS, packaged app, adversarial credentials).

| Behavior | Automated test |
|----------|----------------|
| Type dispatch, tag double-check refusal, NotFound=removed, per-failure isolation | `packages/broker/src/aws/deletion.test.ts` |
| Host cleanup runs / reports / auth-flag; failed-delete unioned into residuals; denied sweep flags auth; **wrong-account refusal**; `hostCleanup:false` skip | `packages/broker/src/service.test.ts` (`teardown host cleanup`) |
| Certification never invokes host cleanup (recording guard) | `packages/broker/src/certify.test.ts` |
| Teardown UI: revoked/blocked copy, re-enable recommendation, leftovers panel + console links, update-policy on auth denial | `app/src/views/ConnectionDetailView.test.tsx` |
| Policy twin lockstep (JSON == role-template) | verify manually: see snippet in §6 |

---

## 5. Result sheet (copy per run)

```
Date: __________   Tester: __________   Commit: __________   App build #: ______
P1 policy updated [ ]   P2 packaged app [ ]   P3 test poppy deployed [ ]   P4 verifier ready [ ]

T1  active teardown → clean ............. PASS / FAIL   notes:
T2  pause / resume ...................... PASS / FAIL   notes:
T3  revoke guard (footprint) ............ PASS / FAIL   notes:
T4  revoke direct (no footprint) ........ PASS / FAIL   notes:
T5  revoked teardown → host clean ....... PASS / FAIL   notes:
T6  blocked teardown → host clean ....... PASS / FAIL   notes:
T7  denied cleanup ≠ "clean" ............ PASS / FAIL   notes:
T8  hostile bucket does NOT hang ⭐ ...... PASS / FAIL   notes:
T9  wrong-account refusal (optional) .... PASS / FAIL / SKIP
T10 re-enable revoked poppy ............. PASS / FAIL   notes:
```

Ship only when T1, T5, T6, T7, T8 are **PASS** (the orphan-freedom core) and the automated suite
is green.

---

## 6. Appendix — policy lockstep check

The customer-managed JSON and the bootstrap template's inline operator policy MUST grant the
identical `HostResidualCleanup` actions. Verify:

```bash
python3 - <<'PY'
import json, re
ja = sorted({s['Sid']: s for s in json.load(open('infra/policies/agentspoppy-access-policy.json'))['Statement']}['HostResidualCleanup']['Action'])
ts = open('packages/broker/src/aws/role-template.ts').read()
ta = sorted(re.findall(r'"([a-z0-9-]+:[A-Za-z]+)"', re.search(r'Sid: "HostResidualCleanup".*?Action: \[(.*?)\]', ts, re.S).group(1)))
print("LOCKSTEP:", "IDENTICAL" if ja == ta else f"MISMATCH {set(ja)^set(ta)}", f"({len(ja)} actions)")
PY
```

Must print `LOCKSTEP: IDENTICAL`.
