# Starter prompt — build a poppy with your coding agent

Building an AgentsPoppy extension (a "poppy") is meant to be a **vibe-coding** job: describe what you
want, let your coding agent do the work. This is a ready-made prompt to hand it.

**How to use it:** copy the block below, replace the `WHAT TO BUILD` placeholder with your idea, and
paste it into your coding agent (Claude Code, Cursor, etc.). The prompt points the agent at the
canonical docs and the rules it must follow — you don't need to explain AgentsPoppy yourself.

---

```text
You are building an AgentsPoppy extension (a "poppy") — a small desktop app that, through
AgentsPoppy, gets the user's approval to use a scoped, short-lived slice of THEIR OWN AWS account,
and that the user can pause or tear down at any time.

Before writing any code, read these and follow them exactly:
- The build guide (read it fully — its rules are a hard contract, not style advice):
  https://github.com/leonct74/agentspoppy/blob/main/AGENTS.md
- The clone-and-go example to copy:
  https://github.com/leonct74/agentspoppy/tree/main/examples/hello-poppy
- The SDK reference:
  https://github.com/leonct74/agentspoppy/blob/main/packages/extension-sdk/README.md

Non-negotiable rules (from AGENTS.md):
- Build ON AgentsPoppy; never clone or rebrand it, and never call yours "AgentsPoppy" or plain
  "Poppy" or use its logos. Give your poppy its own brand, and make the display name END in
  "Poppy" — like "MailPoppy" or "Backup-Poppy" — that suffix is the ecosystem convention and is
  required to be listed in the curated directory (directory names must also be unique).
- Give your poppy a face: a square PNG app icon (512×512 source) inside your frontend dir,
  declared as "icon" in the manifest — your own mark, legible at small sizes. Display the same
  icon at the TOP-LEFT of your poppy's UI beside its name; every poppy follows this convention
  (MailPoppy is the reference), and a directory listing requires the icon.
- Your poppy may only ever touch AWS resources IT created. Any grant that changes or deletes an
  existing resource must be scoped to "tagged-as-self" or a name/ARN pattern you own — NEVER "*".
- Least privilege: declare the specific actions you need, not "service:*". Tag everything you
  create so it's attributable and tear-down-able. Never request admin.
- Leave no trace: the user must be able to remove EVERYTHING you build, from AgentsPoppy, in one
  click. Put all your resources in ONE CloudFormation stack and tag them, so deleting the stack
  removes them. If you create anything outside a stack (DNS records, account-level identities), tag
  it AND declare a "teardown" hook (a backend route the host POSTs at teardown). After deploy → use
  → teardown, zero resources tagged with your app id may remain.
- Background + resume: any cloud work (deploy, provision) keeps running server-side, so NEVER block
  navigation. The user will leave and come back — on every load, read the resource's REAL status from
  AWS and resume where they are (re-attach progress to an in-flight deploy; never a dead spinner or a
  lost form).
- Every button must respond — never a dead click (THE #1 recurring poppy defect): any control that
  triggers async work (a backend call, a deploy, a save, a purchase) MUST show an in-flight state ON
  that control the instant it's pressed — a spinner or label swap AND disabled so it can't double-fire
  — then resolve to a result or a plain-language error. Wrap every handler in try/catch/finally so an
  error can never leave a button stuck spinning. Wire every button to a real, working handler and
  CLICK-TEST each one in the running poppy before shipping (reading the code is not the test). Inside
  the host webview, window.alert/confirm/open/prompt can silently no-op — use the host bridge and your
  own in-page dialogs instead. (Different from "resume in-flight work" above: give the clicked button
  a spinner, but never freeze the whole UI or block navigation for long background work.)
- Confirm before you destroy: any control that deletes or irreversibly changes cloud resources
  (remove a domain, drop a table, wipe a bucket, reset everything) needs a deliberate TWO-step
  confirmation that names what will be deleted and says it can't be undone — never a single bare
  click. Don't auto-focus the destructive button. (MailPoppy's per-domain "Danger zone" is the
  reference.)
- Plain language (clear, not dumbed-down): aim so a bright 12-year-old could link their AWS account,
  add your poppy, and set it up without confusion or losing control. NAME the real thing the user
  deals with and explain it (if a step sets up DNS, say "DNS" + one plain line on what it does) — but
  HIDE internal plumbing (vend, assume, roleArn, STS, preflight, CloudFormation stack, Cognito,
  bucket). Errors: what happened + what to do, one calm sentence — never a raw exception, bare status,
  or lone "Error". Don't delete technical depth — relocate it: exact ARNs/IAM/resources/audit live in
  the Dashboard for power users, not in the guided path.
- Reuse before you reinvent: a user with several poppies should feel they're in ONE product. Before
  hand-rolling a stepper, progress map, confirm dialog, banner, or empty state, first reuse the
  host's shared pattern (e.g. the setup stepper, the type-to-confirm teardown panel). Build new only
  when nothing fits — then make it generic enough for the next poppy.
- Build for every desktop AgentsPoppy runs on, not just a Mac: poppies ship one package per
  platform (the directory `packages` map is keyed by platform — `darwin-arm64` today, `win32-x64`
  as AgentsPoppy for Windows rolls out). Keep the backend PORTABLE Node so the Windows build is a
  packaging step, not a rewrite: derive paths with `os.homedir()`/`path.join()` (never hardcode
  `~/Library`, `/tmp`, or other POSIX-only paths), don't spawn macOS-only tools at runtime, and
  keep platform build steps (`codesign`, `lipo`) out of the backend's code paths.
- Show what it costs — with LIVE prices, never hardcoded: if your poppy creates billable AWS
  resources, put the price next to the choice ("t3.large ≈ $0.083/hr") and a run-rate while
  anything is running. Query the AWS Price List API (pricing:GetProducts — read-only, free, no
  resource access; declare it as a plain read grant) with tight filters, and cache per session.
  If the query fails, show an estimate clearly labeled "approx" — never a built-in number posing
  as live. Always explicit currency + units ("$0.017/hr", never "1.7¢"), state what's covered
  ("compute only, on-demand, eu-west-1"), and show the "$0 — nothing running, you're not being
  billed" state. Users love this: the AWS console doesn't show prices in context, and asking
  Google is an answer they forget a minute later. (Account-wide month-to-date spend is the HOST's
  job — never call Cost Explorer ce:* from a poppy; it bills the user per request.)
- No in-poppy paywalls or off-platform steering: NEVER paywall your poppy's features, and never add
  a link or a message telling the user to pay or sign up on an external website to unlock features,
  remove limits, or get a "pro"/"better" version of the poppy. If the user wants to charge for the
  poppy's own features, they do it through AgentsPoppy's in-app purchase (a flat 5% on that checkout
  only) — leave the code free of any external payment prompt. Being in the marketplace is a safety
  promise to users, payments included. (Selling a genuinely SEPARATE product elsewhere is fine — the
  poppy just must not be its in-app upsell funnel.)
- If you sell anything, buyers MUST always be able to cancel + see what they paid: whenever a bought
  feature is owned, a clearly visible "Manage billing" control must be present (it opens the buyer's
  billing portal). If you use the standard AgentsPoppy purchase button you get this for free — it's
  built in and can't be removed. If you build your own purchase UI, YOU must add the Manage control
  (`bridge.manageSubscription(...)`) right where the feature lives — never hidden. A poppy that takes
  money but hides how to cancel is DE-LISTED from the directory; this is not optional.

- MANDATORY (and a hard requirement to be listed in the catalogue — a poppy without it is
  rejected at review): your LAST tab is "Feedback", and you do not design it — the SDK ships it.
  Every poppy has it, so a user always finds the same four things in the same place: rate it 1–5
  stars, ask for a feature, report a bug, support the developer with a donation. Do exactly this:
  (1) declare the "host:openExternal" capability in extension.json (the tab needs no other
  permission, and no change to the AgentsPoppy app); (2) set "bugsUrl" in
  extension.json to the https URL of your PUBLIC issue tracker (e.g.
  https://github.com/you/your-poppy/issues) — bugs belong where everyone, AI included, can read
  them, not in a private inbox; (3) call defineFeedbackTab(bridge) once after your frontend boots
  and render <agentspoppy-feedback poppy="<your.manifest.id>" bugs="<your bugsUrl>"
  name="<YourPoppy>"></agentspoppy-feedback> as the last tab. Don't build your own rating widget, feedback form, or donate button — ratings
  collected this way are what the catalogue listing shows, and donations run through AgentsPoppy
  checkout (minimum $5) so they follow the same rules as any sale. If you sell anything, connect
  Stripe: without it the donate box hides itself.

WHAT TO BUILD:
>>> Describe your poppy here. For example: "A poppy that backs up a folder I choose to a private,
    name-scoped S3 bucket (mybackup-*) in my AWS account, with a button to restore it." <<<

How to do it:
1. Copy examples/hello-poppy as your starting point; rename its id (reverse-DNS) and name
   (your brand + the "…Poppy" suffix).
2. Declare your permissionSet (least-privilege, scoped as above) and ONLY the capabilities you use.
3. Build the frontend (it talks to the host only through the capability-gated bridge). Add a backend
   only if you need server-side AWS work — it receives scoped credentials via the injected
   AGENTSPOPPY_BOOTSTRAP env var, never the user's own keys.
4. Validate the manifest: `npm run validate-manifest -- path/to/extension.json` must pass.
5. Install it (scripts/install-dev-extension.mjs), open it in AgentsPoppy, and confirm it rates
   AMBER or GREEN with "No risks to other resources identified." A RED rating means a grant is too
   broad — tighten the scope until it's gone.
6. Prove it leaves no trace: after deploy → use, run `npm run certify -- --extension . --yes` (or
   "Tear down everything" in AgentsPoppy) and confirm it PASSES — no resources tagged with your app
   id remain. This is the same check the platform re-runs to list your poppy; fix any leftover it
   names before shipping.

Do NOT enter or handle real AWS credentials, and don't make real cloud changes or spend money
without asking me first — I'll do those steps myself.
```

---

When your poppy works, see [`docs/MARKETPLACE.md`](./MARKETPLACE.md) for how to distribute and
(optionally) monetise it — it's entirely your choice, and the in-app checkout is a flat 5% on
platform sales only. To actually add a paid feature, see
[`packages/extension-sdk/README.md`](../packages/extension-sdk/README.md) §4: the standard Buy
button, `commerce:purchase`, and the `target` pattern that lets a purchase in the poppy unlock a
feature in your *own* separate app (e.g. a mobile client).
