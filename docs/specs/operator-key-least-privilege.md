# Spec — operator key least privilege: one guarded door, a kill switch, and machines that actually use the key they were given

**Status:** BUILT & LIVE-VERIFIED · spec 29 August 2026, revised same day after adversarial
review (38 findings, 7 blockers — marked **[review]** where they changed the design, per the
broker-role-v2 precedent); implemented + live-verified 30 August 2026 (see Verification —
one further correction, marked **[live]**, came out of the real-app click-through).
**Closes:** the stored operator key's second, ungoverned identity — direct account-wide delete
powers that none of the five guardrails bind — plus the field-found state where a machine's
standing credential is the elevated *setup* key and the restricted operator key was never
minted at all. Also closes, structurally, the pre-minted-session hole that would have made any
key revocation non-terminal.
**Type:** app + CloudFormation template change (TEMPLATE_VERSION 3 → 4). Every existing user
re-applies setup once, through the banner and update screen shipped in 0.3.8.
**Mirror:** withheld from the public mirror (`scripts/export-denylist.txt`) until template v4
and the step-0 key switch ship; the denylist entry is removed in that same change.

---

## The problem, in two halves

### Half 1 — the key on disk is two doors, and only one has a guard

The five Deny guardrails live on the **broker role** `AgentsPoppyBroker` (in its inline policy
`AgentsPoppyBrokeredAccess`) and are repeated on the boundary. They do not exist on the
operator user. The operator's inline policy (`AgentsPoppyOperatorAccess`, `role-template.ts`)
grants, directly and unconditioned:

- `cloudformation:DeleteStack` on `*` — any stack in the account, not just poppy stacks;
- the residual-cleanup delete set on `*`: S3 buckets/objects/versions, DynamoDB tables,
  Cognito pools, Lambda functions, log groups, SES identities/rule sets, EventBridge rules;
- `sts:AssumeRole` into the broker role.

So a thief holding only the `~/.aws/credentials` file has **two independent powers**: direct
destruction *as the user*, where no guardrail applies, and near-admin *through the role*,
where they all do. Every control we have or plan — the guardrails, the staleness banner, a
kill switch, anomaly detection, per-device revocation — watches the role door. The user door
cannot get a watcher: a Deny on the user would bind the app and a thief alike, because they
present the same key — the guard has to live behind an AssumeRole boundary, not on the key
itself. **[review]** (An earlier draft claimed a template "cannot" put Denys on its own user;
it can — the real reason is the indistinguishability above.)

The deletes are not attacker-only surface. They are the **host residual-cleanup engine** —
the guarantee that teardown completes even for a revoked or broken poppy. The engine is
needed; its *placement on the key* is the fault.

### Half 2 — a machine can run forever on the setup key instead

Field report, 29 August 2026, the founder's own machine: the `[agentspoppy]` profile held the
**elevated setup key** (the hand-attached access-policy user), not the operator key. The
`AgentsPoppyOperator` user existed — recreated with the eu-west-1 stack on 28 August — with
**zero access keys**. Cause: the 0.3.8 recovery flow asks the user to paste a key and stores
whatever was pasted; the stack had been created out-of-band, so the one code path that mints
the operator key and swaps the profile (`runBootstrap` step 2/3) never ran; and the
`updateOnly` fix — correct in itself — guarantees update runs never touch keys.

The app *already computes* the tell: `connectedIsOperator`
(`app/src/views/ConnectAwsView.tsx:123`) — used only to vary copy and to force the paste-key
form on re-apply (`mustPasteForRedeploy`, :124/:483). Nothing detects or remedies a machine
standing on the setup key. Such a machine holds the **most powerful credential in the
architecture** as its everyday key: the access policy can update the setup stack itself,
i.e. rewrite the guardrails and the boundary, then assume the role over a clean ceiling.
Everyone who recovered through the 0.3.8 reconnect flow is plausibly in this state.

Half 1's fix is worthless on a machine in half 2's state — which is why they ship together.

## The fix — five pieces, one release

### 1. Step 0: put every machine on the operator key

On connect and on app start (same cadence as the staleness banner), when **all four** hold —
identity is known (`sts:GetCallerIdentity`, which needs no permissions), the identity is not
`AgentsPoppyOperator`, the setup stack is present, and the operator user exists — surface the
switch banner. **[review]** When the identity is known and non-operator but the stack/user
presence *cannot be read* with the standing key, a softer variant still surfaces — "you're
connected with a non-operator key, and AgentsPoppy can't verify your setup with it" — routing
to the paste-your-setup-key flow. Silence is not an option for exactly the population this
step exists for.

The action is a **keys-first** `runBootstrap` mode, passing the standing credential as
`setup`. **[review]** The existing reconcile applies the template *before* touching keys
(`bootstrap.ts` ensureStack → mint), which would strand a machine whose template update rolls
back — precisely the old-access-policy population the 0.3.8 banner targets — with no key
switch at all, and a failure between the two phases would leave a setup key facing a v4
account. Step 0 therefore mints first and treats the subsequent template re-apply as
independently fallible (`setupNotUpdated`, the 0.3.8 vocabulary).

**Mint / verify / write ordering, precisely.** **[review]**

1. If the operator user is **under** the two-key limit: mint the new key.
2. If **at** the limit: never evict silently — show which key would be evicted (id + age) and
   require an explicit confirmation, mirroring the deploy flow's `evictedAccessKeyId` note.
   An evicted key may be another live machine's; the one-click copy must say so.
3. Verify the fresh key can `sts:AssumeRole` the broker role **in memory**, with a retry
   matcher for the *not-yet-active key* wordings (`InvalidClientTokenId` / "security token …
   is invalid") in the style of — not reusing — `sts.ts::retryOnPolicyPropagation`, whose
   matcher only covers managed-policy propagation and would never retry this case.
4. Only then `writeProfile`. This machine's *own* previous key (if it was an operator key) is
   deleted **after** the successful write, never before.
5. On verify failure: delete the just-minted key, leave the profile untouched, report.

**Where the powerful key actually was matters.** **[review]** `writeProfile` upserts only the
`[agentspoppy]` section. If the standing credential resolved from there, the overwrite removes
the elevated secret from disk in the same write and the banner may say so. If it resolved from
the default provider chain — `[default]`, environment, SSO — the app must **not** edit those,
and the completion copy instead names the source and tells the user the powerful key still
lives there and should be removed by them. Claiming removal that didn't happen is the exact
class of fault this spec closes.

If the standing key lacks `iam:CreateAccessKey`, the action degrades to the existing
paste-your-setup-key flow with an explanation.

### 2. Template v4: shrink the operator to assume-only, plus exactly one more thing

The operator inline policy becomes three statements:

```
AssumeBrokerRole   Allow  sts:AssumeRole, sts:SetSourceIdentity   on the broker role ARN
WhoAmI             Allow  sts:GetCallerIdentity                   on *
SelfRevoke         Allow  iam:DeleteAccessKey                     on its own user ARN
```

`MonitorAndTeardown` and `HostResidualCleanup` are **deleted from the user** and become the
inline **session policy** of a new host-maintenance hop-1 session, leaving the host's
effective *permissions* unchanged: the role ceiling (`Allow *:*`) covers every action and none
collides with a Deny guardrail (both verified). The behavioral deltas are the ≤1-hour session
lifetime and the new dependency on AssumeRole succeeding — see Risks. **[review]** (An earlier
draft said "provably unchanged"; permissions are, behavior is not.)

**The size limit that actually bites is the packed one.** **[review]** The two statements are
1,059 plaintext characters — comfortably under the 2,048 inline cap — but STS's *packed*
(compressed) budget is the binding constraint, documented in this codebase by CrewPoppy's 157%
rejection at 1,690 chars (`sts.ts:139-150`). At 33 actions this policy extrapolates to the
edge of that budget. `maintenanceSession()` therefore reuses the vend path's existing
`isPackedPolicyError` → managed-`PolicyArns` fallback, and the live verification measures the
actual packed percentage before the claim "it fits inline" is made anywhere.

**Who migrates, exactly.** **[review]** `operatorCredentials()` has eight consumers. Six
housekeeping modules move to the cached, auto-refreshing `maintenanceSession()` (hop-1,
3,600 s, fixed `RoleSessionName` outside the poppy prefix, **no SourceIdentity in this
release** — see below): `tagging.ts`, `existence.ts`, `cloudformation.ts` (all three of its
clients), `deletion.ts`, `cloudtrail.ts`, and the **read side only** of `bootstrap.ts`'s
gateway — `readSetupStack` / the staleness read. Two consumers **stay direct-signed by
design**, and a later auditor should find this sentence rather than a missed migration:
`sts.ts` (the hop-1 vend itself) and `identity.ts` (GetCallerIdentity) — they *are* the
retained v4 powers. And the gateway's **mutation side** (CreateStack/UpdateStack, key mint) —
keeps standing/pasted setup credentials: through the role, `iam:*` on the AgentsPoppy
principals is denied by `CannotTamperWithAgentsPoppy`, and a role session applying the stack
that defines the role would be wrong in principle anyway.

**No SourceIdentity yet.** **[review]** Stamping a source identity on hop-1 requires
`sts:SetSourceIdentity` in the role's **trust policy**, which only arrives with v4 — an
app that stamped it unconditionally would get AccessDenied against every existing v3 account
on day one, breaking feed, teardown, cleanup *and* the staleness read everywhere. This
release: the maintenance session never sends SourceIdentity; the v4 trust policy adds the
action so a later release (and phase 3's Roles Anywhere, which requires it) can turn it on.

**Reading a failed AssumeRole honestly.** **[review]** A failed hop-1 is *not* one signal;
the 0.3.8 rules (never cry wolf; an unreadable stack is never "absent") apply:

- role not found / stack absent → **absent** (the loud setup path);
- `InvalidClientTokenId` → **this machine's key is dead** → the kill-switch recovery path;
- `AccessDenied` with a non-operator caller identity → **step 0**, not the setup path — this
  is a v4 account met by a setup-key machine, and the remedy is the key switch;
- throttling / network → **unknown**, honest "couldn't check", no banner state change.

One drift case gets named because a no-op "fix" would loop forever: **role deleted while the
stack is CREATE_COMPLETE**. Re-applying an identical template is a CloudFormation no-op
reported as success, and CFN does not recreate drift-deleted resources on a no-op. The repair
path must detect role-absent-with-stack-present and force real change (delete + recreate, or
a changeset that touches the role).

**The activity feed.** `classifyActor` (`packages/core/src/activity.ts:87`) gains a **new
branch**: a broker-role session whose `RoleSessionName` equals the fixed host-maintenance name
classifies as `agentspoppy`. **[review]** A rename alone fixes nothing — any non-poppy-prefix
role session currently falls through to `external`. The same sweep fixes the existing
`agentspoppy-verify` session (`identity.ts:95`), which sits *inside* the poppy prefix today
and is mis-attributed as a poppy named "verify". The pinning test enumerates **all**
host-originated session names against both the poppy prefix and the new branch.

`SelfRevoke` is the **one** remaining direct-signed IAM call, and it must stay direct: through
the role it would be refused by `CannotTamperWithAgentsPoppy` (Deny `iam:*` on the operator
ARN) — correct and unchanged. The guardrails and boundary are **not** reshaped by this spec.

### 3. Trust policy: who may enter, stated three ways

Today the broker role trusts `arn:aws:iam::<account>:root` — any principal in the account
that IAM separately allows may assume it, with no conditions. v4 keeps that Principal (naming
principals directly converts to unique IDs internally, so a deleted-and-recreated principal —
which has already happened once by hand — would brick the trust permanently) and splits the
statement in two:

```
HopOne:  Principal account root
         Action  sts:AssumeRole, sts:TagSession, sts:SetSourceIdentity
         Condition ArnEquals aws:PrincipalArn = arn:aws:iam::<acct>:user/AgentsPoppyOperator
                   Null      aws:TokenIssueTime = true

HopTwo:  Principal account root
         Action  sts:AssumeRole, sts:TagSession, sts:SetSourceIdentity
         Condition ArnEquals aws:PrincipalArn = arn:aws:iam::<acct>:role/AgentsPoppyBroker
```

**Why the role ARN, not a session ARN.** **[review]** The first draft matched hop 2 with
`arn:aws:sts::<acct>:assumed-role/AgentsPoppyBroker/*` — and AWS documents the opposite: for
an assumed-role session, `aws:PrincipalArn` evaluates to the **IAM role ARN**, with an
explicit "do not specify the assumed role session ARN" warning. As first drafted, v4 would
have denied hop 2 and killed every poppy credential vend in the account. The role-ARN form is
the documented one; widening from "this session" to "any session of the broker role" is safe
because the tag-conditioned `PoppySessionCannotReAssumeTheBrokerRole` Deny (retained,
unchanged) is what actually stops tagged poppy sessions from re-entering.

**Why `Null: aws:TokenIssueTime`.** **[review]** Without it, the kill switch is not terminal:
`sts:GetSessionToken` needs no permission and cannot be denied by policy ("you cannot use
policies to control authentication operations"), so a thief can pre-mint up to 36 hours of
IAM-user session credentials that *survive access-key deletion* and are explicitly allowed to
call `sts:AssumeRole` under the user's live policy. `aws:TokenIssueTime` exists only for
temporary credentials, so `Null … = true` restricts HopOne to the **long-term key itself**:
delete the key and there is nothing left that can enter. A pre-minted session then can do
nothing at all — its IAM calls need MFA it doesn't have, and its only granted STS power is
the hop this condition now refuses it.

Consequence, deliberate: after v4 the **setup key can no longer assume the broker role** (its
`sts:AssumeRole` line is removed from the shipped access policy in the same change — inert
either way). The setup key keeps its own CloudFormation and IAM powers — it must, to run the
re-apply — but the *app* reads the stack only through the role, so a machine standing on the
setup key against a v4 account drops to the step-0 path (whose `iam:CreateAccessKey` remedy
still works). **[review]** (First draft claimed such a machine "can neither assume the role
nor read the stack" — the second half was an app property misstated as an IAM one.)

### 4. The kill switch

A danger-zone action in ConnectAwsView: **"Revoke this computer's key."** Preconditions and
failure taxonomy, all reviewed-in: **[review]**

- **Gate on `connectedIsOperator`.** A non-operator identity routes to step 0 instead — on a
  half-2 machine the locally-recorded key id can be the *setup* key's, and a caller-inferred
  delete could destroy the user's admin key, the very credential recovery depends on.
- The call is a direct `iam:DeleteAccessKey` with **`UserName=AgentsPoppyOperator` explicit**
  and the locally-recorded key id.
- `NoSuchEntity` → **success** (the key is already dead — evicted by another machine's
  re-setup, or console-deleted): clean the profile and local record.
- `AccessDenied` (template still v3) → "re-apply setup first", profile untouched.
- Any other failure → profile untouched. Forgetting a key that is still live in AWS would
  invert the audit finding this closes.

Copy honesty: it revokes **this computer's** key; it takes effect *usually within seconds —
IAM is eventually consistent, allow minutes*; already-issued role sessions live out their
remaining ≤1 hour; and with HopOne's `TokenIssueTime` condition, nothing pre-minted survives
beyond that. Delete, not deactivate — not because a thief session could re-activate (every
surviving session class is already denied `iam:*` here) but because deactivation would
require granting the operator `iam:UpdateAccessKey`, which the *other* machine's key (same
user) could then use to re-activate, and it leaves a restorable credential behind; delete is
terminal and needs no new grant. **[review]** A thief holding the second operator key can at
worst delete this machine's key — denial of service against AgentsPoppy itself, never
escalation.

*Considered and deferred, recorded:* a destruction-only `iam:DeleteRolePolicy` carve-out
would drop in-flight role sessions within seconds (deleting the sole inline policy removes
the Allow ceiling; nothing can re-add it). Sound per review, but it reshapes
`CannotTamperWithAgentsPoppy` asymmetrically between role and boundary — that machinery
belongs with the fault-F guardrail work.

### 5. Hygiene and the rotation nudge

- **Permissions re-enforced on every broker touch** of the credentials file: best-effort
  `chmod` 0600/0700 (warn, never block; POSIX only — on Windows this is a no-op and the
  documented story remains inherited `%USERPROFILE%` ACLs; skipped entirely when
  `AWS_SHARED_CREDENTIALS_FILE` points somewhere non-default, as the test rigs do).
- **"Forget this key" / Disconnect removes the profile section** — keeping a non-secret local
  record of the access-key **id**, because that id is how a later re-setup recognises *this
  machine's* key instead of evicting another live machine's at the two-key limit.
- **`devOpen` refused in packaged builds**: the auth bypass (`auth.ts:79`) becomes inert when
  `require('node:sea').isSea()` is true — a property of the artifact, not a build flag.
- **Key age**: record mint time locally at `CreateAccessKey`; show it; past ~90 days an amber
  dismissible nudge offers the elevated-creds rotation (the step-0 flow, re-run). No standing
  self-rotation: granting the operator `iam:CreateAccessKey` on itself would let a thief mint
  a second key we don't know about — evaluated and rejected.
- *Considered and rejected:* symlink refusal (dotfile managers use them legitimately; the
  attacker it stops has simpler paths), `ExternalId` (a full-disk thief holds it too),
  `aws:SourceIp` (home IPs), MFA on hop-1 (unattended broker).

## The ordering constraint

1. **The app release carries everything and runs against template v3 unchanged** — true only
   because of two review corrections now baked in: the maintenance session sends **no
   SourceIdentity** (v3's trust policy would deny it), and its packed-size fallback keeps the
   session policy deliverable. The role ceiling covers the session-policy actions and no
   guardrail blocks them, so every machine switches to role-routed housekeeping on app
   update, before any template changes.
2. **Template v4 rides the same release**, reaching each account when its user presses
   re-apply, driven by the 0.3.8 staleness banner and update screen. (A console-applied v4 is
   possible and lands as ordering §4's skew, not a new state.)
3. **The update screen switches the key first, then re-applies — and this reverses one 0.3.8
   behavior deliberately.** **[review]** Today redeploy always sends `updateOnly:true` and the
   line-409 branch tells a non-operator identity "nothing to re-enter" — on a v4 release that
   exact path would apply the template with the stored elevated key, print success, and leave
   the machine unable to vend or read the stack. v4's update flow: `connectedIsOperator` →
   `updateOnly` as today; non-operator → the step-0 keys-first reconcile (mint-then-verify
   standing in for the disconnection bug `updateOnly` originally fixed), then the template.
   The line-409 copy and the `isAssumeRoleDenied` remediation text (which currently says
   "the role trusts your whole account… fix the user's policy" — untrue under v4) are
   rewritten in the same change.
4. **Known, accepted skew — two populations, named:** **[review]** an old-app machine still
   standing on a *setup key* against a v4 account loses hop-1 outright — poppies stop
   working until the app updates and step 0 runs. An old-app machine on an *operator key*
   keeps poppies working but its direct staleness read is denied → the 0.3.8 banner shows a
   standing "couldn't check" on a current account until the app updates. Both go in the
   release notes; the in-app re-apply only exists in the new app, which bounds how a v4
   account normally comes to be.

## Consent and policy surface

- **Poppies: zero change.** No manifest, no grant, no re-consent; hop-2 vending untouched.
- **The access policy** changes: `sts:AssumeRole` removed (inert after v4).
  `iam:PutUserPolicy` / `iam:UpdateAssumeRolePolicy` / `iam:DeleteUserPolicy` are already
  present and cover exactly what v4's UpdateStack modifies — **but the existing
  access-policy-covers-template tripwire does not gate them** (it asserts create-path actions
  only). **[review]** The tripwire is extended in this release to assert the update-path
  actions for every mutable property the template carries, so a future trim cannot silently
  strand least-privilege users in a rollback. The policy twins stay byte-equal under the
  existing release check; users on the least-privilege policy re-copy once via the 0.3.8
  update-policy panel.

## Verification

**Status: LIVE-VERIFIED 2026-08-30** on a throwaway sandbox account (11/11 harness
assertions + the full app click-through — see "What the live pass proved" below). One
implementation correction came out of it, recorded here per the house rule:

- **[live]** The one-click keys-first switch initially reported *"the setup template could
  NOT be re-applied"* on every run that reused connected credentials. Cause: the bootstrap
  gateway re-resolved credentials **per call**, so after the profile was overwritten
  mid-run, the template half signed with the brand-new operator key — which by design
  cannot touch the stack. The scripted harness could never see this (it holds its own
  clients); only the real-app click-through did. Fix: a bootstrap run now **pins the
  credentials it started with** for its whole lifetime (`sdkBootstrapGateway` resolves
  once per gateway, to static values — a `fromIni` provider re-reads the file on every
  invocation, so memoising the provider alone would not pin anything). Re-run: clean
  single-pass "Done".

**What the live pass proved** (a throwaway sandbox account, eu-west-1, stack upgraded
v1→v4 — the oldest possible starting version, and left in place at v4):

1. the v1→v4 `UpdateStack` reached `UPDATE_COMPLETE` — AWS accepts the conditioned trust
   policy on the real upgrade path;
2. hop-1 with the operator's long-term key: admitted;
3. hop-2 vend through the real shipped vend path (tags + session policy): a poppy
   connection received scoped credentials — the role-ARN `aws:PrincipalArn` semantics
   hold;
4. a pre-minted `GetSessionToken` session: **refused** hop-1 (`TokenIssueTime`) — the
   kill switch is terminal;
5. a direct `cloudformation:DeleteStack` with the operator key: **AccessDenied** —
   assume-only holds;
6. the maintenance session, bounded by the real session policy: works;
7. `SelfRevoke`: the operator deleted its own key;
8. app click-through: the step-0 banner appeared for a setup-key machine, one click
   switched it (identity → operator, elevated secret gone from the profile, template
   applied in the same pass), and the kill switch deleted the key in AWS, wiped the local
   state, and routed the disconnected app to the reconnect flow.

The original plan (unit + rig, then live on real AWS — founder approval per step):

1. **v3 + new app:** feed, tag sweep, teardown, residual cleanup via the maintenance session —
   including the explicit case *maintenance session against v3 sends no SourceIdentity*;
   CloudTrail shows broker-role sessions; the feed classifies them (and `agentspoppy-verify`)
   as AgentsPoppy, not external. Measure and record the session policy's **packed** size.
2. **Step 0 on the founder's machine** — the authentic field state: banner appears, keys-first
   switch, `GetCallerIdentity` reports the operator, the elevated secret's fate reported
   truthfully for its actual source, the app works end to end. Doubles as the release's user
   test.
3. **v4 re-apply:** `UPDATE_COMPLETE`; with operator creds a direct
   `cloudformation:DeleteStack` and `s3:DeleteBucket` are AccessDenied; hop-1 succeeds; hop-2
   vend for the largest-grant poppy (MailPoppy) succeeds — **the trust-condition semantics
   (`aws:PrincipalArn` = role ARN for hop 2, `TokenIssueTime` null for hop 1) are the single
   most load-bearing thing this release must prove live**; a `GetSessionToken` session minted
   from the operator key must FAIL hop-1; a third principal with its own `sts:AssumeRole`
   allow must be denied by the condition.
4. **Kill switch:** press it; poll until a fresh hop-1 with the dead key fails (typically
   seconds, allow minutes); a pre-minted `GetSessionToken` session also fails hop-1; recovery
   re-setup mints a new key; on a v3 account the button says "re-apply first"; `NoSuchEntity`
   path cleans up as success.
5. **Failure-taxonomy drill:** dead local key → recovery path; non-operator vs v4 →
   step 0 (not "setup absent"); throttle → unknown; role-deleted-stack-present → repair
   forces real change, not a no-op update.

## Risks

- **Sessions cap at one hour.** A CloudFormation operation outliving its session can fail
  mid-flight; poppy stacks delete in minutes and the session auto-refreshes between
  operations. Stated limit, not mitigated further.
- **Packed-policy headroom** is measured, with the managed-policy fallback as the net.
- **Old-app/new-template skew** (ordering §4) — accepted, documented, both populations named.
- **Step 0 asks users to use a powerful key one more time.** It uses the credential already
  on their disk, adds no new exposure, and ends with that credential either overwritten or
  honestly reported as still present at its source.
