# Building an AgentsPoppy extension — guide for coding agents

You are (probably) an AI coding agent, asked to build an app that runs inside **AgentsPoppy**.
This file is your entry point. Read it fully before writing code — the rules here are not style
preferences, they are the contract that lets a user trust the thing you ship.

**We love vibe-developers.** AgentsPoppy is built for people (and the coding agents they direct) who
turn an idea into a working poppy fast — and we want to help you ship it and, if you choose, get paid
for it, with the least friction and the smallest fee we can manage, in a collaborative ecosystem. See
[`docs/MARKETPLACE.md`](./docs/MARKETPLACE.md) for how poppies are distributed and monetised.

If you only remember three things:

1. **Build _on_ AgentsPoppy, don't clone it.** (See [Licensing](#0-the-boundary-read-first).)
2. **An extension may only ever touch the AWS resources it itself created.** Never request a
   permission that can change or delete a resource it didn't make. (See [Security rules](#3-the-security-rules-non-negotiable).)
3. **The contract is the manifest.** `extension.json` is the single source of truth; the host
   reads it and enforces it. Get it right and most of your job is done.

> **Fastest start:** copy [`examples/hello-poppy`](./examples/hello-poppy) — a complete, **zero-build**
> extension (a static frontend + a tiny Node backend) you can install and run in minutes, then edit
> into your own.
>
> **Vibe-coding?** Hand your coding agent the copy-paste prompt in
> [`docs/STARTER_PROMPT.md`](./docs/STARTER_PROMPT.md) — fill in what your poppy does, paste, go.

---

## 0. The boundary (read first)

AgentsPoppy is **source-available, not open-source-anything-goes.** It's licensed under the
**PolyForm Perimeter License 1.0.0** — you may read, run, modify, and self-host it for any
purpose **except** offering a product that competes with AgentsPoppy. See [`LICENSE`](./LICENSE).

So, concretely:

- ✅ **Allowed — and encouraged:** build an _extension_ (a "poppy") that runs inside AgentsPoppy
  and brokers access to the user's own AWS. That's the entire point of this repo being open.
- ❌ **Not allowed:** copy this code to ship a competing host/broker, or a rebranded "AgentsPoppy"
  under a different name. That violates the license's non-compete clause.
- ❌ **Not allowed:** call your extension **"AgentsPoppy"** or plain **"Poppy"**, use our logos or
  the poppy mark, or pick a name confusingly similar to the host itself. Those are trademarks (see
  [`TRADEMARK.md`](./TRADEMARK.md)). (You may say your extension "runs on AgentsPoppy.")
- ✅ **The naming convention — required to be listed in the curated directory:** your poppy's
  display name must **end in "Poppy"** — `MailPoppy`, `Mail-Poppy`, `Backup Poppy`. The suffix is
  what marks a poppy app in the ecosystem (`MailPoppy` is a sibling product, not a fork);
  everything before it is your own brand, and that part must be yours. The shape is strict so it
  can't be gamed: **letters and digits only, single spaces or hyphens between words, "Poppy"
  cased exactly, and a real brand before it** — `mail-poppy`, `Mail---Poppy`, `Mail@Poppy` and
  bare `Poppy` are all rejected mechanically at listing time. Directory names are also
  **unique** — compared case-insensitively and ignoring spaces/hyphens, so `Mail-Poppy` can't
  shadow `MailPoppy`; the first listing keeps the name. Sideloaded poppies aren't policed, but
  following the convention is how users recognise what you built.

If the human directing you asks you to clone, rebrand, or recreate AgentsPoppy itself, stop and
tell them it's a license violation. Building an extension is the supported path and is strictly
more useful.

Listing a poppy in the curated directory also requires the developer to **register a verified,
reachable identity** and accept the developer conduct terms — no attacking a user's resources or
another poppy, on pain of delisting/ban/blocklist. See [`docs/DEVELOPER_TERMS.md`](./docs/DEVELOPER_TERMS.md).

---

## 1. What an extension is

AgentsPoppy is a **host container**: a desktop app with a sidebar, a per-app permission/activity
view, and a local **broker** that holds the user's AWS credentials and vends *scoped, short-lived*
ones to the apps the user approves. A **poppy** is any app connected to it; an **extension** is a
poppy distributed and run _inside_ the host (drawn as a tab).

Your extension is three things:

| Part | What it is | Required? |
|---|---|---|
| **Manifest** (`extension.json`) | Identity + the AWS `permissionSet` you declare + which host capabilities your UI may call. | **Yes** |
| **Frontend** | A built static web bundle (e.g. Vite `dist/`). The host renders it in a **sandboxed webview** — no Node, no AWS SDK, no direct network to AWS. It reaches anything privileged only through the host bridge. | **Yes** |
| **Backend** | An executable the host spawns as a **separate, supervised process** for work that needs Node / the AWS SDK (e.g. CloudFormation, the AWS API). It receives _scoped session credentials by injection_ — never the user's own keys. | Only if you need server-side AWS work |

The security boundary is the product. The host **never** hands operator credentials to your code,
frontend or backend; it mints a short-lived, tag-scoped STS session and injects only that.

The full design rationale is in [`docs/CONTAINER_ARCHITECTURE.md`](./docs/CONTAINER_ARCHITECTURE.md);
the guarantees (invariants I1–I7) and the AWS scoping rules are in
[`docs/INTEGRATION.md`](./docs/INTEGRATION.md). The machine-readable contract is
[`packages/extension-sdk`](./packages/extension-sdk) — import it; don't reinvent the types.

---

## 2. On-disk layout

An installed extension lives under the AgentsPoppy home (`~/.agentspoppy/extensions/<id>/`,
override with `AGENTSPOPPY_HOME`) in exactly this shape — the broker discovers it at startup:

```
~/.agentspoppy/extensions/com.example.app/
├── extension.json                 # the manifest
├── frontend/                      # your built UI (the dir that contains the entry HTML)
│   ├── index.html                 # = manifest.frontend.entry, relative to the extension root
│   └── assets/…
└── backend/                       # only if you declare a backend
    └── app-sidecar-<target>       # the executable, = manifest.backend.entry
```

Paths in the manifest (`frontend.entry`, `backend.entry`, `icon`) are **relative to the extension
root**. You don't write into `~/.agentspoppy` by hand — the dev installer
([§8](#8-build--install--run-the-dev-loop)) lays this out for you from your source tree.

---

## 3. The security rules (non-negotiable)

These are the invariants that make AgentsPoppy worth using. The host and broker enforce them;
your job is to declare a manifest that _earns a clean rating_. Full text:
[`docs/INTEGRATION.md` §2–3](./docs/INTEGRATION.md). The delegation mechanism itself is
specified normatively in [`docs/SECURITY_MECHANISM.md`](./docs/SECURITY_MECHANISM.md) —
platform patches touching its enforcement points are checked against that document.

- **Only its own.** Your extension may only touch resources _it_ created. For any action that
  **changes or deletes an existing resource**, the grant's `resourceScope` MUST be either
  `"tagged-as-self"` (services that support `aws:ResourceTag`) or a concrete **name/ARN pattern**
  you own (e.g. `arn:aws:s3:::myapp*`). **Never `*`** on a mutate-existing action.
  Creates inside a `tagged-as-self` grant are **birth-tag enforced**: the session policy
  conditions `Create*`/`Request*` on `aws:RequestTag/agentspoppy:app`, so the resource is born
  carrying your tag or the call is refused — IAM enforces "every create carries the attribution
  tags", it's no longer just this document asking. Requires the service to accept tags in the
  create call itself (CloudFormation stack tags do this for you); if it can't, that service
  belongs in a name-scoped grant, not tagged-as-self.

  > **The non-taggable sub-resource create (Cognito is the canonical case — three poppies
  > found this live before it was written down).** Some `Create*` actions make a *child* of an
  > existing resource, and their APIs take **no tags at all** — `cognito-idp:CreateUserPoolClient`,
  > `cognito-idp:CreateGroup`. Inside a tagged-as-self grant the birth-tag condition can then
  > never match, and nothing local catches it: the manifest validates, the rating is clean, the
  > parent pool even creates fine — then the very next resource dies at the real vend with
  > *"…is not authorized to perform: cognito-idp:CreateUserPoolClient … because no session policy
  > allows…"* and the stack rolls back (MailPoppy, CrewPoppy 2026-07-30, TrafficPoppy 2026-08-04 —
  > each rediscovered this on a live deploy). The usual escape — a name-scoped grant — is closed
  > when the parent's ARN embeds a generated id (`…:userpool/eu-west-1_AbCdEfGhI`: nothing for a
  > `MyApp*` pattern to match). The recipe, tightest known (TrafficPoppy):
  > - Keep the **parent's** create birth-tag enforced by passing tags **inside the create call**
  >   (`UserPoolTags` in the template properties) — the pool cannot be born untagged. Don't rely
  >   on stack-tag propagation for Cognito: CloudFormation's handler applies stack tags in a
  >   SEPARATE `TagResource` call *after* birth, which both breaks the birth-tag condition and
  >   needs `TagResource` granted or the deploy rolls back on it (CrewPoppy's live failure).
  > - Move **only the non-taggable child creates** into their own grant scoped to the parent's
  >   resource type — `"resourceScope": "arn:aws:cognito-idp:*:*:userpool/*"` — with a `reason`
  >   field saying why the scope can't be narrower.
  > - Keep every read/update/delete/admin action in the `tagged-as-self` grant. Then the wide
  >   grant's whole blast radius is "could add a child to a pool it doesn't own" — it can never
  >   read, change or delete anything foreign.
- **`*` is allowed only for** (a) pure **creates** that have no ARN to scope to (e.g.
  `cognito-idp:CreateUserPool`) — creating is additive, it can't harm what exists — or (b) services
  with **no resource-level permissions at all** (e.g. SES `SendEmail`, Route53
  `ChangeResourceRecordSets`). Reads on `*` are fine.
- **Least privilege.** Declare the _specific actions_ you need, not `service:*`. Over-asking is a
  defect — it alarms the user reviewing your extension and it's a code-review failure.

  > **The STS packed-policy budget (every wide poppy hits this — read before you debug).** STS
  > enforces TWO limits on the session policy your grants become: the visible 2048-char plaintext
  > cap, and an invisible **packed** (compressed) budget shared with the session tags. The packed
  > size grows with *action count*, so a wide-but-compact set — many short actions across many
  > services, typical of any poppy that deploys a Lambda platform (CloudFormation + DynamoDB + S3
  > + Lambda + IAM + Logs) — can sit well under 2048 chars yet be rejected at credential time
  > with **`Packed policy consumes NNN% of allotted space`** (VM-Poppy: 31 actions ≈ 118%;
  > CrewPoppy: 42 actions / 1690 chars ≈ 157%). What to do:
  > - **Nothing, usually.** The broker auto-promotes any scope that won't fit — by plaintext or
  >   by packed rejection — to per-connection **managed session policies** (`PolicyArns`), which
  >   have no packed budget and scope the session identically. A wide-but-legitimate permission
  >   set deploys fine.
  > - **Don't pad, don't over-trim.** Never work around this by bloating the policy to force the
  >   managed route, and don't delete actions your deploy genuinely calls (a missing action fails
  >   the stack with `AccessDenied` mid-create). The least-privilege rule above is still the bar:
  >   declare what you call, and re-add an action in the release that ships the feature needing it.
  > - **If you still see the error**, your AgentsPoppy build predates the automatic fallback
  >   (broker `sts.ts`, `isPackedPolicyError`) — update/rebuild the host, then retry.
- **Collection APIs can't be resource-scoped — and `Fn::GetAtt` can make CloudFormation call one.**
  Some actions authorise against a *set* rather than one resource (`logs:DescribeLogGroups`,
  most `Describe*`/`List*` plurals). IAM evaluates them before it knows which resources come back,
  so a narrow `resourceScope` **denies them outright**. The trap is that you rarely call them
  yourself — CloudFormation does, on your behalf, to resolve an attribute: `Fn::GetAtt
  [MyLogGroup, "Arn"]` costs a `logs:DescribeLogGroups`, and the whole stack rolls back with
  *"Unable to retrieve Arn attribute for AWS::Logs::LogGroup… Access denied"*. It passes every
  local check and only fails on a real deploy (CrewPoppy P0 lost a deploy to exactly this).
  - **Preferred fix: don't make the call.** If you named the resource yourself, **construct** the
    ARN instead of reading it back — `{"Fn::Sub": "arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/MyFn:*"}`.
    No API call, no extra grant, scope stays tight. (`GetAtt` on *single-resource* reads is fine:
    a table ARN costs `dynamodb:DescribeTable`, a role ARN `iam:GetRole` — both scope cleanly.)
  - **If you genuinely need the collection read**, give it its **own read-only grant** on a broad
    but concrete pattern (`arn:aws:logs:*:*:log-group:*`) — never widen the mutating grant. Reads
    may be broad; deletes may not.
- **Attribution.** Everything you create must carry the connection tag so it's attributable and
  tear-down-able. Put `"agentspoppy:connection"` in `permissionSet.requiredTags`, include the
  relevant `TagResource` actions in your grants, and stamp your CloudFormation stack / direct
  creates with the connection's tags (the host vends them as transitive STS session tags).
- **No admin, ever.** The broker role can never manage IAM users, touch account/org settings,
  disable CloudTrail, or attach admin policies — and per-connection scoping only ever _narrows_ it.
  Don't design around this; you can't escalate, by construction.

- **Say why, whenever you reach beyond your own resources — REQUIRED.** Any grant that is not
  confined (`"*"`, or a pattern that matches everything of its type) MUST carry a `reason`: plain
  language, for the user deciding whether to install you, not for a reviewer. `npm run
  validate-manifest` **fails** until every one has it.

  Why this is a rule and not a nicety: the approval screen has three registers, and only one of
  them can come from you.

  | the user sees | where it comes from |
  |---|---|
  | what this permission would allow **if you were malicious** | computed from your grant, by us |
  | **what you actually use it for** | **your `reason` — nothing else can supply it** |
  | what your poppy **has actually done** | AWS CloudTrail, attributed to your connection |

  Without the middle one, a user reading HostingPoppy's DNS grant is told *"can change and delete
  any DNS record in any domain you host"* — true about the permission, and a bad description of an
  app that writes one record for the domain they typed. Write the sentence that closes that gap.
  If the honest reason is *"it could be narrower, I didn't"*, **narrow it instead**.

  ```jsonc
  {
    "service": "route53",
    "actions": ["ChangeResourceRecordSets"],
    "resourceScope": "*",
    "reason": "Points the address you typed at your site. AWS does not let record changes be limited to one domain, so this permission covers every zone you host — HostingPoppy only ever writes the record you asked for, and shows you what is there first."
  }
  ```

- **Know which kind of "its own" you have.** These are not the same guarantee, and the screen is
  being changed to stop calling them the same thing:
  - `"tagged-as-self"` — **ownership is proven.** Anything you create is born carrying your tag or
    AWS refuses to create it (I3), and you cannot stamp that tag on someone else's resource.
    *"Only the ones it created"* is enforced. **Prefer this wherever the service supports it.**
  - a **name pattern** (`arn:aws:s3:::yourpoppy*`) — **a bounded namespace.** Real confinement: you
    genuinely cannot reach `/production/*`. But nothing enforces that you *created* what sits under
    that name, so if the user puts something there, you can touch it. Use it when tag-scoping is
    impossible, not as the default.
  - `"*"` — everything of that type. Needs a `reason`, always.

- **Split a mixed grant.** Some AWS actions cannot be narrowed at all: AWS publishes no resource
  types for them, so `"*"` is the only Resource that authorises them and scoping one *denies* it.
  `ec2:Describe*`, `sts:GetCallerIdentity`, `pricing:GetProducts`, most of the SES receipt-rule API.
  Those are fine at `"*"` and the screen now says so on your behalf — *"AWS offers no way to narrow
  this"*.

  **The trap is putting narrowable actions in the same grant.** They inherit the `"*"` and the
  explanation covers them, so a permission that could have been pinned to one resource silently
  reads as forced. MailPoppy has five grants in this state — its SES grant mixes 13 genuinely
  forced actions with six that scope to a single verified identity, `SendEmail` among them.
  **Two grants, not one:** the forced actions at `"*"`, everything else scoped. Check each action
  against AWS's published service reference (`https://servicereference.us-east-1.amazonaws.com/` —
  an action listed with no resource types is a forced one) rather than assuming.

- **Write `permissionSet.description` for the user, not the reviewer.** It is what the approval
  screen shows as *what this poppy is for*, next to the permissions it explains. Say what you build
  and where you put it. HostingPoppy's is the reference; AffiliatePoppy's is close behind.

**The acceptance test.** Install your poppy and open its permission screen. Do NOT chase a colour —
the previous version of this line told you to, and it was wrong on three counts: the text it quoted
no longer exists, six of the eight shipped poppies are red, and red does not mean what it said. A
grant confined to roles named `YourPoppy*` rates red because creating a role is creating an
identity, which is true however tightly you scope it. That is not a defect you can fix.

What you must be able to answer, for every line on that screen:

1. **Does it reach beyond your own resources?** If yes, is that genuinely unavoidable? Look for the
   half you could have narrowed — a mixed grant is the common case, and it hides behind the half
   that AWS really does force (below).
2. **Does the line name the right service and the right scope?** If the screen describes a reach
   you do not have, that is a platform bug — report it. If it describes one you DO have and you
   are surprised, that is your manifest.
3. **Does every unconfined grant carry a `reason` a user could act on?** `npm run
   validate-manifest` fails until they all do.

---

## 4. Teardown — your poppy MUST leave no trace

The promise that makes a "bring your own cloud" tool trustworthy is that the user can remove
**everything** your poppy built — from AgentsPoppy, in one click — and verify nothing remains. A
poppy that leaves resources behind (that the user then has to hunt down in the AWS console) breaks
that promise for the _whole_ ecosystem. So clean teardown is **non-negotiable, and it is verified**:
after a deploy → use → teardown, a tag sweep for your `agentspoppy:app` id must return **nothing**.
If it doesn't, your poppy isn't shippable.

**What AgentsPoppy does when the user tears your poppy down**, in order:

1. **Your teardown hook** (if you declare one) — for out-of-stack cleanup (see below).
2. **Deletes your CloudFormation stack(s)** — first emptying S3 buckets and deactivating SES
   receipt rule sets for you (the two resources CloudFormation refuses to delete while in use),
   then waiting for `DELETE_COMPLETE` and surfacing the real status if it fails.
3. **A tag sweep** (Resource Groups Tagging API, filtered by `agentspoppy:app`) that finds anything
   still tagged as yours, then **host residual cleanup**: the HOST itself deletes what the sweep
   found (type-aware: buckets emptied incl. versions, tables, user pools, functions, log groups,
   SES identities/rule sets — each re-checked for your live tag right before deletion). This is
   the backstop that makes teardown complete even when your hook can't run — a revoked, blocked,
   or uninstalled poppy. Whatever the host can't remove is listed to the user with console links.

> **The host backstop is NOT a licence to skip your hook.** Certification runs teardown with host
> cleanup **off** — your leaves-no-trace certificate measures what *your* code cleans up. And the
> host can only see what's **tagged**: your un-tagged/un-taggable leftovers (DNS records, resources
> created without tags) are invisible to it and will orphan without your hook.

### The easy path — do this and you're compliant

- **Put everything in ONE CloudFormation stack.** If every resource you create lives in your stack
  and carries your tags, deleting the stack removes it — _no teardown code needed_. Prefer a
  declarative template over imperative `Create*` calls.
- **Tag every resource** with the connection tags (§3 Attribution). The host vends them as
  transitive STS session tags, so anything you create through your scoped creds is taggable —
  use it. **Untagged = invisible to the sweep = a leak that fails the leaves-no-trace check.**
- **Don't make resources undeletable.** Don't set `DeletionPolicy: Retain` on data buckets.
  CloudFormation can't delete a non-empty S3 bucket or an active SES receipt rule set — the host
  handles both for you — but if you use another "can't-delete-while-in-use" resource (a Cognito
  user-pool **domain**, an **ECR** repo holding images, a table with **deletion protection** on),
  either avoid it or remove it in your teardown hook.

### If you create resources OUTSIDE your stack

Some things can't live in a stack — Route 53 records in a zone you don't own, an account-level SES
domain identity, anything made with a direct `Create*` call. For those you MUST (a) **tag them**, and
(b) declare a **teardown hook**: a backend route the host POSTs at the _start_ of teardown so you can
delete them.

```jsonc
  "teardown": { "endpoint": "/teardown" }   // a backend route; requires a backend (see §6)
```

Your hook MUST be **idempotent** (it may run more than once, including after a partial teardown) and
remove everything the stack delete won't. MailPoppy's is the reference — it empties its bucket,
deactivates its SES rule set, deletes the stack, and removes its DNS records + SES identities:
[`provisioning.ts`](https://github.com/leonct74/mailpoppy/blob/main/apps/desktop/node-sidecar/src/provisioning.ts).

> **Rule of thumb:** deploy your poppy, use it (so its buckets/tables actually hold data), tear it
> down from AgentsPoppy, then check the AWS console (or Resource Groups → Tag Editor for
> `agentspoppy:app`). **Zero** of your resources should remain. That round-trip is the
> leaves-no-trace check every poppy is held to.

### Prove it: `npm run certify`

You don't have to eyeball the console — run the harness. After you've **deployed and used** your
poppy (so it actually created tagged resources), point `certify` at it:

```bash
npm run certify -- --extension path/to/your/poppy --yes
```

It performs the **real** teardown for you — runs your teardown hook, deletes your stack(s), empties
buckets, deactivates SES — then sweeps for your `agentspoppy:app` tag and **passes only if nothing
remains**. On success it writes a `leaves-no-trace.cert.json`; on failure it lists exactly which
resources leaked and why, so you know what to fix. (It's destructive, so it won't run without
`--yes`; run it against the account where you deployed — ideally a throwaway dev account.)

This is the **same harness the platform re-runs and signs** when you submit to the curated directory
(see [`docs/MARKETPLACE.md`](./docs/MARKETPLACE.md) M7) — passing it locally is how you know your
poppy is listable. Your local run is self-signed (`issuer: "self"`); the platform issues the trusted,
signed certificate.

**AWS deletion lag is normal and is NOT a failure.** Several services confirm a delete before it
becomes visible everywhere — the Resource Groups tag index can keep listing a resource for minutes
after it's gone, and some resources (Cognito user pools are a known one) linger in their own
console list for a while too. The harness already accounts for this: a tagged resource the sweep
can see in the index but cannot confirm actually exists is reported as a **⚠️ warning**, not a
leftover, and the run still **passes**. Seeing that warning — or seeing a just-deleted resource
still in the AWS console — is not a showstopper for certification or approval. If you want the
clean zero, re-run certify a few minutes later; what you must NEVER do is "fix" the warning by
weakening your teardown. A real leak looks different: the certificate FAILS and names the exact
resource that still exists.

**How long the lag really is, and how to check in one minute.** Measured on live teardowns:
CloudFront distributions typically clear the tag index in ~10 minutes; **Cognito user pools have
been seen listed for days** after the pool was genuinely deleted. So "still listed" tells you
nothing on its own — go and look. Both the teardown result and the certify output **name every
resource and link straight to its console page**, so verifying is a click each:

1. Open each linked resource in the AWS console. Gone / "does not exist" ⇒ it really is deleted,
   whatever the index says. The resource is the authority; the index is a cache.
2. Tear down again (or re-run certify) a few minutes later to get the clean zero on the record.
3. Only if the console still SHOWS the resource do you have a real leak — fix the teardown.

The dashboard's verify state already explains this to users; developers get the same rule here.
And the directory judges it the same way — **a verify/⚠️ state is never on its own a reason to
reject a submission** (founder rule, 2026-08-05): reviewers open the linked resources, and if AWS
no longer holds them the poppy is approved. You are judged on what the account actually holds
after teardown, never on how fast AWS's own listings caught up.

**Certify's own gotchas** (each cost real time):
- **certify performs the teardown itself.** Don't tear the poppy down first — the run needs a
  deployed, used connection to snapshot, tear down and sweep.
- **Pass no `--extension` when you run it through your poppy's own npm script** — that script
  already passes `--extension $PWD`, and a second one wins and resolves against the *agentspoppy*
  directory (`ENOENT … agentspoppy/extension.json`). Just `npm run certify -- --yes`.
- **The certificate is only written when the run passes.** A run that trips over deletion lag
  leaves you with no certificate, so you must deploy and use the poppy again before re-certifying.
  Plan the order: certify first, then rebuild for real — not the reverse.
- The shell needs no AWS credentials: certify uses the operator credentials the broker stores.
  (Which also means CLI checks like `aws cloudformation describe-stack-events` may fail with
  `InvalidClientTokenId` in the same terminal — use the console links instead.)

### Destructive actions need a deliberate confirmation — never one bare click

Any control in **your** UI that **deletes or irreversibly changes cloud resources** — removing a
domain, dropping a database, wiping a bucket, deleting a user pool, "reset everything" — MUST require
an explicit, informed confirmation. A single stray click can never destroy a user's infrastructure.
This is non-negotiable for the same reason leave-no-trace is: one poppy that nukes someone's account
by accident poisons trust in the _whole_ ecosystem.

What "a deliberate confirmation" means, concretely:

- **Two distinct steps.** The first click opens a confirm dialog; a **second**, clearly-labelled
  action in that dialog actually performs the deletion. Never wire destruction to a single button.
- **Name the blast radius.** Spell out _what_ gets deleted (the buckets and their contents, the
  tables, the user pools…) and that it **can't be undone** — in the dialog, in plain language. Don't
  hide it behind a generic "Are you sure?".
- **Don't make the dangerous button the easy default.** Style it as the danger action, and don't
  auto-focus it (focus Cancel) so an accidental Enter/double-click can't trigger it.
- **Match the ceremony to the blast radius.** A reversible toggle needs none; a scoped delete needs
  the two-step dialog above; **wiping a whole footprint deserves type-to-confirm** — make the user
  type the poppy's (or resource's) name before the destroy button unlocks, so they can't do it on
  autopilot.

The host already does this for the **full** "Tear down everything" action: the dialog renders a
**live preview of exactly what will be deleted** — a count + per-service breakdown of the real
footprint (the same data the infra map is drawn from) and the stacks it'll drop — and **only arms
the destroy button once the user types the poppy's name.** Showing the actual blast radius (not just
prose) is the gold standard for "name the blast radius." MailPoppy's **per-domain "Danger zone"** is
the reference for a scoped destructive control _inside_ a poppy — it confirms, names the
consequences, then removes that one domain's stack + DNS. Mirror these patterns for every destroy
path you ship.

---

## 5. Cloud work runs in the background, and the user can always resume

A cloud workflow — a deploy, a stack update, DNS/domain provisioning, anything that calls `Create*`
or waits on AWS — can take minutes. The user **will** navigate away, switch to another poppy, or
close the window while it runs. When they come back, your poppy MUST pick the work back up and show
its **real, current** status — never a frozen spinner, a blank form, or lost progress. A poppy that
traps the user on a "please wait" screen, or forgets a deploy the moment they leave, ships exactly
the broken UX that makes "bring your own cloud" feel unsafe — and that reputation damage lands on
the _whole_ ecosystem, not just you. This is **non-negotiable**, and two facts make it easy:

- **The work already runs in the background.** CloudFormation, SES, ACM, etc. run server-side — they
  keep going whatever your UI does. So **never block navigation to "protect" a deploy**: it protects
  nothing, it only cages the user while the real work happens elsewhere. (Concretely: don't disable
  nav, don't trap focus, don't `beforeunload`-guard a deploy.)
- **Reconstruct state from the cloud, not from memory.** On mount, query the actual resource
  (`DescribeStacks`, an SES identity's status, …) and derive where the user is from what's **really
  there** — never from in-memory state or `localStorage`, which a remount, refresh, or restart
  wipes. If the work is mid-flight, drop the user back onto its live progress and re-attach your
  poller. If it finished, show finished. If it failed, show the failure + a retry.

### The easy path — do this and you're compliant

- **Make progress derivable.** Persist only enough to find the resource again (the stack name, the
  domain); read its live status on every mount. The cloud status is the source of truth, not a flag.
- **Resume in-flight work automatically.** If the resource is `*_IN_PROGRESS` when your UI loads,
  re-enter the "working" view and re-start polling — don't make the user re-trigger it.
- **Say so.** While long work runs, tell the user it continues in the background and they can leave
  and come back. Reassurance is part of the contract, not decoration.

> **Rule of thumb:** start a deploy, navigate away (another tab, another poppy, close the window),
> come back. You should land on the **live status**, and it should finish on its own. A dead
> spinner, a reset form, or "nothing happened" is a bug — and it's not shippable. MailPoppy's setup
> wizard is the reference: it reconstructs every step from real AWS state and resumes an in-flight
> deploy on return.

---

## 6. The manifest (`extension.json`)

The complete schema is `ExtensionManifest` in
[`packages/extension-sdk/src/manifest.ts`](./packages/extension-sdk/src/manifest.ts), with a
validator (`validateManifest` / `parseManifest`) that reports _every_ problem at once. The real,
production example to copy from is MailPoppy's:
[`mailpoppy/apps/desktop/extension.json`](https://github.com/leonct74/mailpoppy/blob/main/apps/desktop/extension.json).

A minimal frontend-only manifest:

```jsonc
{
  "id": "com.example.app",              // stable reverse-DNS id
  "name": "ExamplePoppy",               // shown in the sidebar/tab; "…Poppy" suffix = the naming convention
  "version": "0.1.0",                   // semver
  "description": "What it does, one line.",
  "icon": "frontend/icon.png",          // your app icon — square PNG inside the frontend dir (see "Your identity" below)
  "permissionSet": {
    "id": "example-backend",
    "name": "Example backend",
    "requiredTags": ["agentspoppy:connection"],
    "grants": [
      {
        "service": "s3",
        "actions": ["CreateBucket", "PutBucketTagging", "ListBucket"],
        "resourceScope": "arn:aws:s3:::example-app*"      // name-scoped to what you own
      },
      {
        "service": "s3",
        "actions": ["GetObject", "PutObject", "DeleteObject"],
        "resourceScope": "arn:aws:s3:::example-app*/*"
      },
      {
        "service": "s3",
        "actions": ["ListAllMyBuckets"],
        "resourceScope": "*",                            // AWS publishes no resource type for this one
        "reason": "Lists bucket NAMES only, never contents — it is how \"Remove everything\" proves nothing of ours is left behind. AWS offers no narrower form of this permission."
      }
    ],
    "limits": null
  },
  "frontend": { "entry": "frontend/index.html" },
  "capabilities": ["connection:read"]   // declare ONLY what your UI calls (see §7)
}
```

Add a backend only if you need server-side AWS work:

```jsonc
  "backend": {
    "entry": "backend/example-sidecar-aarch64-apple-darwin",
    "transport": "http"                 // "http" (host assigns a loopback port) | "stdio"
  },
```

And — **only if you create resources outside your CloudFormation stack** — declare a teardown hook
(§4) so the host can ask you to clean them up:

```jsonc
  "teardown": { "endpoint": "/teardown" }  // backend route POSTed at the start of teardown; needs a backend
```

Each grant is one `{ service, actions[], resourceScope, reason? }` — `reason` is REQUIRED on any
grant that is not confined to your own resources (§3), and `validate-manifest` fails without it. The host re-reads this on every load and
**reconciles** the connection to it — change your declared scope and the host revokes + recreates
the connection for the user to re-approve. So the manifest can never silently drift from what you
actually ask for. Keep it in lockstep with your real IAM deploy policy (mirror one from the other).

**Validate it before you install** — the same structural check the host runs, reporting every
problem at once (exit 1 on failure, so it's CI-friendly):

```bash
npm run validate-manifest -- path/to/extension.json
```

---

## 7. Capabilities & the host bridge

Your sandboxed frontend has no powers of its own. Everything privileged is a **capability** it
declares in the manifest and calls over the **host bridge**. The host refuses any bridge call whose
capability you didn't declare — so request the minimum.

| Capability | Lets the frontend… | Bridge method(s) |
|---|---|---|
| `aws:credentials` | Trigger (and await) the user-approved mint of scoped creds. Creds go to your **backend**, never the frontend. | `ensureAccess()` |
| `connection:read` | Read its own connection: permission set, status, audit, cloud inventory (to render its permissions/activity view). | `getConnection()`, `getAudit()`, `getInventory()` |
| `backend:invoke` | Call its own backend; the host proxies to the child process. | `invokeBackend()` |
| `host:openExternal` | Ask the host to open a URL in the system browser. | `openExternal()` |
| `host:notify` | Surface a notification/toast via the host. | `notify()` |
| `commerce:purchase` | Sell your own products through AgentsPoppy checkout and read what the user owns. | `purchaseInfo()`, `buyProduct()`, `isPurchased()`, `manageSubscription()` |

The vocabulary is closed and small (`packages/extension-sdk/src/capabilities.ts`); each entry ships
consent copy the host shows the user. The typed surface is `HostBridge` in
[`host-api.ts`](./packages/extension-sdk/src/host-api.ts); build a client with
`createHostBridgeClient(transport)` from [`bridge.ts`](./packages/extension-sdk/src/bridge.ts) over
your webview's message channel. See the SDK's [`README`](./packages/extension-sdk/README.md) for a
code sketch.

**Backend credentials.** When the host spawns your backend it injects a `BackendBootstrap`
(`connectionId`, a loopback `credentialsUrl` to mint scoped creds on demand, a `credentialsToken`
you present when minting, the `port` to listen on for an `"http"` backend, and the resolved
`account`). Your backend mints short-lived, auto-rotating, tag-scoped credentials by POSTing to
`credentialsUrl` **with `Authorization: Bearer <credentialsToken>`** — it never sees the operator's
own keys, and never hunts for a fixed port. The host also strips the entire `AWS_*` namespace from
your environment before starting you: there is no `AWS_PROFILE` or `AWS_ACCESS_KEY_ID` to fall back
on, by design. See `BackendBootstrap` in `host-api.ts`.

**Where to keep your files: `bootstrap.dataDir`.** The host creates a directory for you under its
own state directory and hands you the path. Write your state there — **not** `~/.<yourname>/`. To
give a file to the *user*, don't write to their Downloads folder either: serve the bytes from a
one-shot `/local-download/<token>` route and let the host's browser save it, which is both the
native-feeling path and the one that survives confinement.

**Confinement — `backend.isolation: "strict"`.** You get this without asking: since AgentsPoppy
0.3.5 it is the default, so a manifest that omits `isolation` is confined, and only an explicit
`"isolation": "none"` opts out — which the validator, the submissions API and the update review each
refuse. Under it the host runs your backend under the runtime's permission model, allowed to read your install directory, read and write `dataDir` and
the OS temp directory, and *nothing else on the machine*. `~/.aws/credentials`, the user's documents
and their browser profile all return `ERR_ACCESS_DENIED`, and spawning child processes is denied
outright (otherwise `cat ~/.aws/credentials` walks around the whole thing). Requires
`runtime: "node22"` — a native executable has no runtime of ours inside it to enforce an allowlist,
so the manifest validator rejects the combination rather than pretending.

**Declaring it is a listing requirement (RUNTIMES.md R7, 2026-08-20)** — a backend without
`"isolation": "strict"` is rejected at review, with one sanctioned exception: a named, one-release
data migration whose confined successor is already identified (state created before confinement can
only be moved out of the user's home by an unconfined run). Your listing must also pin
`minHost: "0.3.1"` or newer — an older AgentsPoppy ignores the flag and would run you unconfined,
which is worse than not claiming it. Until a poppy declares strict, the honest description of its
backend is that it can read whatever the user can read — and that is what the user's audit prompt
now tells their AI agent to flag. One trap to build for: under the permission model,
`fs.existsSync` on a DENIED path THROWS instead of returning false — wrap existence probes in
try/catch.

**The broker authenticates callers.** Loopback is *not* a trust boundary — every poppy's backend is
a local process too — so the broker checks a bearer token on every request. Two classes: a per-run
**host token** (held only by the AgentsPoppy desktop UI, delivered over a channel a spawned backend
can't read) gates the whole management plane — listing connections, revoke, pause, teardown, and so
on; and your per-backend **`credentialsToken`**, which authorises **only your own** connection's
credential mint. Your token is rejected on any other connection's route and on the management plane,
and is revoked when the host stops you — so you can mint your own scoped creds but can never
enumerate, disable, or tear down another poppy. The only routes that take no token are the static
frontend assets (`/ext-ui/*`) and one-shot local downloads (`/ext-dl/*`). This costs legitimate
poppy-to-poppy integration nothing: "revoke my rival" is not a cooperation primitive.

**Vending depends on the user's AWS connection being healthy.** The host mints your scoped creds by
assuming a broker role with the user's own single least-privilege AWS credential
([`agentspoppy-access-policy.json`](./infra/policies/agentspoppy-access-policy.json) — one policy,
one IAM user, no operator-key juggling). If that credential lapses, or a newer AgentsPoppy needs a
permission the user's policy doesn't yet grant, **vending pauses** — your `credentialsUrl` calls will
fail until they fix it. Don't treat that as fatal: the host detects it, shows the user an always-on
health panel with a one-click **Reconnect / update-policy** fix, and vending resumes once they're
healthy. So surface a calm "waiting for AWS access" state, not a crash — and never ask the user for
keys yourself.

---

## 8. Build → install → run (the dev loop)

1. **Build the frontend** to static assets (e.g. `vite build` → `dist/`).
2. **Build the backend** (if any) to a self-contained executable at the path your `backend.entry`
   names (MailPoppy builds a Node SEA into `src-tauri/binaries/…`).
3. **Install into AgentsPoppy** with the dev installer — it reads your `extension.json`, then copies
   your built frontend → `frontend/` and your binary → `backend/` under
   `~/.agentspoppy/extensions/<id>/`:
   ```bash
   node scripts/install-dev-extension.mjs --src <your-extension-source-dir>
   #   defaults: --frontend <src>/dist   --backend <src>/src-tauri/binaries/<manifest backend name>
   ```
4. **Relaunch AgentsPoppy.** The broker discovers extensions from disk at startup, so a relaunch
   re-reads your manifest and re-serves the new frontend (`npm run -w @agentspoppy/app tauri:dev`).
5. **Open your tab, approve the connection, verify the rating** ([§3](#3-the-security-rules-non-negotiable)).

> A **frontend-only** change just needs steps 1 + 3 + 4 — skip the backend build.

---

## 9. Look & feel — the poppy design kit (contract, not suggestion)

Your frontend is rendered _inside_ the host console, and users must always be able to tell the
host's voice from a poppy's. So poppies ship on the **poppy design kit**: a token sheet derived
from the host's Warm Graphite & Clay theme, plus a short contract. **Read and follow
[`packages/extension-sdk/DESIGN.md`](./packages/extension-sdk/DESIGN.md)** — it is written to be
followed mechanically, including by an AI coding agent. The short version:

- Vendor [`packages/extension-sdk/poppy.css`](./packages/extension-sdk/poppy.css) and build every
  colour/font/radius from its `--poppy-*` tokens. **No raw hex, no framework palette colours.**
- Set `--poppy-accent` to **your assigned accent** — `poppyAccent(appId)` from the SDK; the same
  colour the host paints your sidebar avatar with. It's your ONE identity colour.
- **No clay** (`#d97757` — the host's reserved accent) and **no `backdrop-filter`** (glass is
  host-only supervision chrome). These are impersonation-resistance rules, not taste.
- System sans for UI, mono for data (ARNs, ids, timestamps, logs). No webfonts.
- The host frame can be **narrow** (the content area is a few hundred px wide). Design responsive,
  single-column-friendly layouts — don't assume a wide three-pane desktop.
- Reference implementation: MailPoppy's desktop frontend (`mailpoppy/apps/desktop`) — its whole
  Tailwind `@theme` block maps onto the kit.

### Your identity: an icon, worn in the same two places every poppy wears it

- **Ship an app icon.** A square PNG (512×512 source, transparency welcome) inside your frontend
  dir, declared in the manifest as `icon`. The host shows it everywhere your poppy appears — the
  Poppies catalog card, the sidebar, the AWS-approval screen, your tab — and draws the rounded
  corners itself, so ship it square, not pre-rounded. Keep it legible at 24px: a bold, simple
  mark, not a screenshot or a wall of text. It must be your own — imitating another poppy's mark
  (or AgentsPoppy's) is grounds for delisting.
- **Display the same icon at the top-left of your own UI, beside your poppy's name.** That's the
  convention every poppy follows, so a user always knows which app they're inside — the icon they
  tapped in Poppies is the icon that greets them. MailPoppy is the reference implementation.
- A directory listing additionally embeds a 128×128 data-URI copy of the icon in its catalog
  entry (the submit page explains the format; `review-submission.mjs --icon` builds it for you).

### Plain language — clear, not dumbed-down

North star: **a non-technical person — picture a bright 12-year-old — can link their AWS account, add
your poppy, and set it up without pain, confusion, or ever feeling they've lost control.** Plain
language is how you get there. It does NOT mean hiding what things are — it means saying them clearly.

- **Name the real thing when the user actually deals with it, and explain it in context.** If a step
  sets up DNS, say "DNS" — and add one plain line on what it does and what's about to happen. Same for
  "your AWS account", "an IAM user", "a mailbox", "a domain". Never assume prior knowledge; never make
  the user feel they should already know.
- **Hide the internal plumbing they never need to think about** — `vend`, `assume`, `roleArn`, `STS`,
  `preflight`, `provision`, `CloudFormation stack`, `Cognito user pool`, `bucket`. Say what it means
  _for the user_: _"your apps can't get the temporary access they need"_, not _"the broker can't assume
  the role to vend scoped credentials"_.
- **Errors say what happened + what to do, in one calm sentence.** Never a raw exception, a bare HTTP
  status, or a lone word like "Error".
- **Layer the depth — relocate technical detail, don't delete it.** The guided path stays simple; the
  full technical + security detail (exact ARNs, the IAM policy, every resource, the audit trail) lives
  where a technical user looks for it — the host **Dashboard** or a "details"/"advanced" disclosure —
  so power users get everything and newcomers aren't drowned. Both audiences, one product.
- A genuinely necessary token (a DNS record to paste, an account id) belongs in a monospace chip
  wrapped in plain explanation — never as the whole message.

Test: read every screen as that 12-year-old. Do they always know what's happening, why, and that
they're in control? And if a technical user wants the depth, is it one click away in the Dashboard?

### The helper prompt — onboarding is a prompt, not a manual (REQUIRED, founder 2026-07-30)

Every poppy has a surface where the user must compose or configure something non-trivial — an
agent's brief, a mailbox setup, a VM spec. **That surface MUST offer a "Copy the helper prompt"
button.** The prompt is the poppy's training, packaged: the user pastes it into whatever AI they
already use, adds one sentence about what they want, and gets back exactly what to type and tick
in your form. Each thing they create this way teaches them your poppy as a side effect — no
manual, no tutorial, no prior knowledge.

The four rules that make a compliant helper prompt (reference implementation: CrewPoppy,
`frontend/src/helper-prompt.ts` + its test):

1. **Generated, never hand-written.** Build the prompt at runtime from the same option catalogue
   your form renders — labels, explanations and caution notes in the form's own words. A
   hand-maintained parallel text WILL drift, and a helper that recommends options your form
   doesn't have is worse than none.
2. **States your non-negotiables as constraints to plan within** (approval gates, hard caps,
   scoping rules) — so the outside AI designs within your safety model, never around it.
3. **Demands a fixed answer shape** whose items map one-to-one onto your form's fields, and asks
   the AI to pose at most a few clarifying questions first.
4. **Ends mid-sentence** ("MY AGENT SHOULD: ", "MY MAILBOX SETUP: ") so the user's next words are
   the goal — zero prompt-writing skill required.

The button, in the kit's three sizes — pick per surface, same behaviour everywhere (pulse until
first used, still under `prefers-reduced-motion`, "Copied ✓" feedback):

- **Banner** — a `banner info` strip with one explaining sentence + a `btn btn-primary
  poppy-helper-pulse` button. For your PRIMARY creation form. This is the default.
- **Inline** — `btn btn-sm btn-primary poppy-helper-pulse`, no strip. For narrow frames and
  secondary editors.
- **Quiet** — `btn btn-ghost btn-sm` with the ✨ label, no pulse. For toolbars and places the
  user has already been onboarded (e.g. an edit view).

If your poppy composes with a sibling poppy (as CrewPoppy's email needs MailPoppy), the prompt
must SAY so — naming the sibling and the exact step — honestly scoped to when it's really needed.

### Every button must respond — a click always gives feedback

**This is the single most common defect in shipped poppies, and it's not acceptable.** A button
that *looks dead*: the user clicks "Deploy", "Save", "Send", "Buy" — and for the seconds the request
is in flight, nothing on screen changes. No spinner, no disabled state, no message. So the user
assumes it's broken and clicks again (now you've double-fired), or gives up. Either way the poppy
feels broken, and that distrust lands on the whole ecosystem. **Every control that triggers async
work MUST react the instant it's pressed** — no exceptions.

- **Show a pending state on the control itself, immediately.** The moment an `onClick` starts
  awaiting anything — a backend call, `ensureAccess()`, a purchase, any `fetch` — put *that button*
  into a visible in-flight state (a spinner, or a label swap like "Deploying…") AND disable it so it
  can't be fired twice. Re-enable it only when the work resolves.
- **Always resolve the state — success OR error, never limbo.** Wrap every handler in
  `try / catch / finally` and clear the pending state in `finally`, so a thrown error can never leave
  a button stuck spinning forever. On success show a concrete result or confirmation; on failure show
  one calm line (see *Plain language* above). **Never a silent no-op, never a swallowed `catch {}`.**
- **Actually wire it, and prove it by clicking — not by reading.** A button with no handler, a
  handler that calls a method you never declared a capability for, or a fire-and-forget promise
  nobody awaits, is a dead button. Before you ship, *click every control in the running poppy* and
  watch it do its thing. Reading the code is not the test.
- **Beware webview no-ops.** Inside the host's webview `window.alert`, `window.confirm`,
  `window.open` and `window.prompt` may silently do nothing — so a button whose whole job is one of
  those looks broken. Use the host bridge instead (`openExternal`, `notify`) and render any
  confirmation/dialog as your own in-page UI (the type-to-confirm panel in §4 is the pattern).
- **Don't confuse this with caging the app (§5).** Giving the *clicked button* an immediate spinner
  is required. Freezing the *whole UI* or blocking navigation to "protect" long cloud work is the
  opposite mistake: for a minutes-long deploy, transition into the background-resumable progress view
  (§5) — don't trap the user behind a modal spinner. "A button that never spins" and "a spinner that
  never resolves" are both bugs.

> **Test:** click every button on a slow/throttled network. Within ~100 ms each one must either show
> it's working (spinner + disabled) or show a result — it must never sit there looking
> pressed-but-dead, and a second click must never get through while the first is still running.
> MailPoppy's action buttons (Deploy, Send, Save) are the reference.

## 9a. The Feedback tab — mandatory in every poppy (founder 2026-08-07)

**Every poppy ships a tab called "Feedback", and it is the LAST tab.** It is a **hard requirement
to be listed in the catalogue** — a submission without it is rejected at review. Not optional, not
"if you have time": a user who installs any poppy must always find the same four things in the same place —
rate it, ask for a feature, report a bug, support the developer. That consistency is the point;
it's what makes the rating on a catalogue listing mean something, and what stops each poppy from
inventing its own feedback form, its own bug flow, and its own way of asking for money.

**You do not build it, and it needs nothing new from the host.** The SDK ships the whole tab as one
standard element, exactly like the purchase button — same reason: a fixed, shadow-rooted look
nobody can restyle into something misleading. It talks to the AgentsPoppy feedback API from your
own frontend and asks the host for exactly one thing it can't do itself, `openExternal` — a
capability you already declare. So adding the Feedback tab needs **no new AgentsPoppy release**.

```ts
import { defineFeedbackTab } from "@agentspoppy/extension-sdk";
defineFeedbackTab(bridge);          // once, after your frontend boots — bridge = your host object
```
```html
<agentspoppy-feedback poppy="com.you.your-poppy"
                      bugs="https://github.com/you/your-poppy/issues"
                      name="YourPoppy"></agentspoppy-feedback>
```

What the element does, so you don't have to:

| The user… | What happens |
|---|---|
| **Rates 1–5 stars** | Saved against this install (anonymous — a random id the tab keeps in local storage, shared across the poppies on that machine), changeable any time, and shown as the star rating on your catalogue listing. |
| **Asks for a feature** (≤500 chars) | Lands in your developer dashboard. The copy tells them to include their email **if** they'd like you to write back — never required. |
| **Reports a bug** | Opens your **public** issue tracker in the system browser. Bugs belong where everyone — including an AI reading your repository — can see the problem and the fix, not in a private inbox. |
| **Donates** (from $5, optional ≤100-char message) | An ordinary AgentsPoppy checkout, so the platform's commission applies exactly as it does to a sale. The message asks for their email so you can thank them directly. |

The three things you must do:

1. **Declare `host:openExternal`** in your manifest's `capabilities` (most poppies already do) —
   it's what opens your issue tracker and the donation checkout in the system browser.
2. **Set `bugsUrl`** in your manifest — an https URL to your public issue tracker — and pass it to
   the element as `bugs`. Without it the tab says plainly that there's no public tracker rather
   than dead-ending on a button that does nothing.
3. **Put the tab LAST.** After everything your poppy does, never competing with it.

Donations need somewhere to land: a third-party developer must have connected Stripe (the same
account that receives sales). If you haven't, the tab hides the donate box instead of failing at
checkout — so connect it before you list.

### Reuse the host's shared components before building your own

Someone who installs three poppies should feel they're in **one** product, not three. Before you
hand-roll a stepper, a progress map, a confirm dialog, a destructive-action panel, an empty state or
a banner, **first check whether the host or another extension already provides one, and reuse it** —
matching components remove the friction of adopting each new poppy.

- Canonical example: the **setup stepper / progress map** (a compact horizontal step rail + a single
  "current step" line, pinned at the top). If your poppy has a multi-step setup, adopt that pattern
  rather than inventing a different one.
- Likewise the **type-to-confirm teardown** panel (§4) and the **background-resume** pattern (§5) —
  they're shared on purpose; reuse beats re-deriving.
- Build something new only when nothing fits — then build it generic enough that the next poppy can
  reuse _it_.

### Show the money — live AWS prices, never hardcoded

If your poppy creates resources that bill by the hour/GB/request, **show the user what they cost** —
a price next to the choice ("t3.large — ≈ $0.083/hr") and a live run-rate while anything is running
("Running now: 2 boxes ≈ $0.10/hr"). This is one of the most-appreciated things a poppy can do: the
AWS console itself doesn't show prices in context, and "ask Google / ask an agent" is friction whose
answer the user has forgotten a minute later. Put the number where the decision happens.

- **Never hardcode prices.** They differ by region, OS and purchase option, and they drift. Query the
  AWS **Price List API** — `pricing:GetProducts` with tight filters (service + instance type + region
  + OS) — it's read-only, **free**, touches no resources (amber-safe; declare it as a plain read
  grant), and its endpoints live in `us-east-1` / `eu-central-1` regardless of where the user works.
  Cache per session; don't hammer it.
- **Degrade honestly.** If the live query fails, show an estimate clearly labeled *approx* — never
  silently hide the cost, and never present a built-in number as if it were live.
- **Explicit units and currency.** `$0.017/hr`, never `1.7¢` (cents of what?). Say what the number
  covers and assumes: "compute only, on-demand, eu-west-1 — disk adds ~$1.60/mo".
- **Celebrate the $0 state.** "Nothing running — you're not being billed" is the single most
  reassuring sentence a cost-anxious user can read. Make reaching $0 visible and one action away.
- **Division of labour:** your poppy quotes and totals **its own** resources. The account-wide
  "month-to-date spend" view is the **host's** job (Cost Explorer) — don't call `ce:*` from a poppy:
  it's account-wide data, and every request bills the user.

---

## 10. Checklist for an extension you ship

- [ ] `extension.json` validates — `npm run validate-manifest -- <path>` is green; `id` is
      reverse-DNS, `version` is semver.
- [ ] Every **mutate-existing** grant is `tagged-as-self` or a concrete name/ARN you own; `*` only
      on pure creates / no-resource-level services.
- [ ] Every `Create*` in a `tagged-as-self` grant accepts tags **in the create call itself**;
      non-taggable child creates (e.g. `CreateUserPoolClient`) sit in their own parent-type-scoped
      grant with a `reason` ([§3](#3-the-security-rules-non-negotiable)'s sub-resource block).
- [ ] Specific actions, never `service:*`.
- [ ] `requiredTags` includes `agentspoppy:connection`; your creates/stack stamp it; you hold the
      matching `TagResource` actions.
- [ ] `capabilities` lists **only** what your frontend actually calls.
- [ ] Manifest scope is in lockstep with your real IAM deploy policy.
- [ ] Installed, the extension rates **amber/green** with no beyond-own findings.
- [ ] **Leaves no trace** ([§4](#4-teardown--your-poppy-must-leave-no-trace)): `npm run certify --
      --extension <path> --yes` passes — after deploy → use → tear down, **zero** resources tagged
      `agentspoppy:app=<id>` remain. Out-of-stack resources are tagged AND removed by a declared
      `teardown` hook.
- [ ] **Background + resumable** ([§5](#5-cloud-work-runs-in-the-background-and-the-user-can-always-resume)):
      every cloud workflow keeps running if the user leaves, and reopening reconstructs live status
      from AWS — no dead spinners, no lost progress, no blocked navigation.
- [ ] **Destructive actions confirm** ([§4](#4-teardown--your-poppy-must-leave-no-trace)): every
      control that deletes/irreversibly changes resources takes a deliberate two-step confirmation
      that names the blast radius — never a single bare click.
- [ ] Backend (if any) gets creds via the injected `BackendBootstrap` — no fixed ports, no operator
      keys, presents its `credentialsToken` as `Authorization: Bearer` when minting, never attempts
      management-plane calls (host-only), killed by the host on disable/revoke/teardown.
- [ ] Frontend works in a narrow tab and never assumes Node/AWS/filesystem access.
- [ ] **Helper prompt** ([§9](#9-look--feel)): the primary creation/configuration surface offers
      "Copy the helper prompt" — generated from the live option catalogue, stating the poppy's
      hard rules, fixed answer shape, ends mid-sentence for the user's goal.
- [ ] **Feedback tab** ([§9a](#9a-the-feedback-tab--mandatory-in-every-poppy-founder-2026-08-07)):
      the LAST tab is "Feedback", rendered by `<agentspoppy-feedback>` — `host:openExternal` is
      declared and `bugsUrl` points at your public issue tracker. A poppy without it is not
      listable.
- [ ] **Plain language** ([§9](#9-look--feel)): the guided path is clear enough for a non-technical
      person to follow — real things named *and explained*, internal plumbing hidden, every error one
      calm sentence (what happened + what to do); deeper technical/security detail lives in the
      Dashboard, not the flow.
- [ ] **Reuses shared patterns** ([§9](#9-look--feel)): stepper/progress, confirm-teardown, banners
      and empty states match the host's components rather than bespoke reinventions.
- [ ] **Costs are visible and live** ([§9](#9-look--feel)): every billable choice shows a price and
      running resources show a run-rate — fetched via `pricing:GetProducts`, **never hardcoded**;
      failures degrade to an *approx*-labeled estimate; explicit currency and units (`$0.017/hr`,
      not `1.7¢`); the "$0 — nothing running, nothing billing" state is shown, not implied.
- [ ] Naming: your own brand + the **"…Poppy" suffix** (required for a directory listing, unique
      across the directory) — never "AgentsPoppy" or plain "Poppy" ([§0](#0-the-boundary-read-first)).
- [ ] **Ships by the book** ([docs/RELEASING-POPPY.md](./docs/RELEASING-POPPY.md)): first listing
      and every later update follow the release runbook — version-bump discipline (the version
      string is the entire update signal), package-live-and-sha-verified BEFORE the catalog entry,
      no runtimes in the package (R1), and never widening the permission set as a side effect.

---

## 11. Where to look in this repo

| You need… | Look at |
|---|---|
| **A clone-and-go scaffold** | [`examples/hello-poppy`](./examples/hello-poppy) — a complete, zero-build minimal extension + its README |
| The machine-readable contract (import it) | [`packages/extension-sdk`](./packages/extension-sdk) — `manifest.ts`, `capabilities.ts`, `host-api.ts`, `bridge.ts` |
| The SDK quickstart | [`packages/extension-sdk/README.md`](./packages/extension-sdk/README.md) |
| The guarantees + AWS scoping rules | [`docs/INTEGRATION.md`](./docs/INTEGRATION.md) |
| **Releasing + updating a listed poppy** | [`docs/RELEASING-POPPY.md`](./docs/RELEASING-POPPY.md) — first listing vs. shipping an update |
| The host/extension architecture | [`docs/CONTAINER_ARCHITECTURE.md`](./docs/CONTAINER_ARCHITECTURE.md) |
| How poppies are distributed & monetised | [`docs/MARKETPLACE.md`](./docs/MARKETPLACE.md) — your choice of monetisation; optional 5% in-app checkout |
| **Sell a feature (in-app purchases)** | [`packages/extension-sdk/README.md`](./packages/extension-sdk/README.md) §4 — the standard Buy button + `commerce:purchase` capability + the `target` cross-app pattern (buy in the poppy → unlock your *own* mobile app / backend). **REQUIRED:** if you sell, buyers must always have a visible "Manage billing" control to cancel / see what they paid — free with the standard button, mandatory (and enforced by de-listing) if you roll your own checkout. Full model: [`docs/IN_APP_PURCHASES.md`](./docs/IN_APP_PURCHASES.md) |
| The broker internals | [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) |
| A real, production manifest | MailPoppy: [`apps/desktop/extension.json`](https://github.com/leonct74/mailpoppy/blob/main/apps/desktop/extension.json) |
| Validate a manifest from the shell | `npm run validate-manifest -- <path>` → [`scripts/validate-manifest.ts`](./scripts/validate-manifest.ts) |
| The dev installer | [`scripts/install-dev-extension.mjs`](./scripts/install-dev-extension.mjs) |
| Licensing & trademark | [`LICENSE`](./LICENSE), [`TRADEMARK.md`](./TRADEMARK.md) |
