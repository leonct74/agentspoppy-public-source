# @agentspoppy/extension-sdk

The contract between an **AgentsPoppy extension** and the host container: pure TypeScript types +
validators, imported by both sides. No transport, no IO, no AWS — just the shape of the agreement.

> New here? Read [`AGENTS.md`](../../AGENTS.md) first — it's the full guide to building an extension.
> This README is the SDK reference for programming against the contract.

## What it gives you

| Module | Exports | Use it to… |
|---|---|---|
| `manifest` | `ExtensionManifest`, `validateManifest`, `parseManifest` | Type and **validate** your `extension.json`. |
| `capabilities` | `CAPABILITIES`, `Capability`, `isCapability`, `capabilityInfo` | Know the closed set of host powers + their consent copy. |
| `host-api` | `HostBridge`, `METHOD_CAPABILITY`, `BackendBootstrap`, `HostRequest`/`HostResponse` | Program against the typed host surface; the wire envelope; the backend bootstrap (incl. the per-backend `credentialsToken`, see §3). |
| `bridge` | `createHostBridgeClient`, `handleHostRequest`, `BridgeTransport` | Build the guest client (frontend) / service requests on the host. |
| `design` | `poppyAccent`, `POPPY_ACCENTS` + [`poppy.css`](./poppy.css) + [`DESIGN.md`](./DESIGN.md) | Skin your poppy on the shared token kit; compute your assigned accent. **DESIGN.md is a contract** — read it before styling anything. |

```ts
import { parseManifest, CAPABILITIES, createHostBridgeClient } from "@agentspoppy/extension-sdk";
```

## 1. Validate your manifest

`parseManifest` returns the typed manifest or throws with **every** problem at once — wire it into
your build so a broken `extension.json` fails fast:

```ts
import { readFileSync } from "node:fs";
import { parseManifest } from "@agentspoppy/extension-sdk";

const manifest = parseManifest(readFileSync("extension.json", "utf8"));
// throws: invalid extension.json:
//   - id must be a reverse-DNS string, e.g. com.example.app
//   - permissionSet.grants must be a non-empty array
```

Or check a file straight from the shell (it wraps this same validator, exit 1 on failure):

```bash
npm run validate-manifest -- path/to/extension.json
```

See [`AGENTS.md` §4](../../AGENTS.md#4-the-manifest-extensionjson) for the field-by-field guide and a
minimal example.

## 2. Call the host from your frontend

Your frontend is sandboxed (no Node, no AWS, no direct network to AWS). It reaches anything
privileged through the **host bridge**, gated by the `capabilities` your manifest declares. The host
embeds your built UI in an iframe and services calls over `postMessage`, so the guest transport is:

```ts
import { createHostBridgeClient, type BridgeTransport, type HostResponse } from "@agentspoppy/extension-sdk";

const transport: BridgeTransport = {
  post: (msg) => window.parent.postMessage(msg, "*"),
  subscribe: (handler) => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent) return;          // only trust the host frame
      handler(e.data as HostResponse);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  },
};

const host = createHostBridgeClient(transport);

// Render your permissions/activity view (needs "connection:read"):
const connection = await host.getConnection();

// Ask the user (via the host) to approve brokered AWS access (needs "aws:credentials"):
const state = await host.ensureAccess();               // "granted" | "pending" | "denied"

// Call your own backend (needs "backend:invoke"); the host proxies to the child process:
const result = await host.invokeBackend({ method: "POST", path: "/deploy", body: { region: "eu-west-1" } });
```

Each `HostBridge` method maps to exactly one capability (`METHOD_CAPABILITY`); the host **refuses**
any call whose capability your manifest didn't list. Declare the minimum.

## 3. Receive credentials in your backend

If you declare a `backend`, the host **spawns it as a separate process** and injects a
`BackendBootstrap` — the connection id, a loopback `credentialsUrl` to mint **scoped, short-lived**
credentials on demand, a **`credentialsToken`** you present when minting, the `port` to listen on
(for an `"http"` backend), and the resolved `account`. Your backend never sees the operator's own
keys and never hunts for a fixed port:

```ts
import type { BackendBootstrap } from "@agentspoppy/extension-sdk";

// The host passes these in (env / argv / stdio — per your backend's launch convention).
const boot: BackendBootstrap = getBootstrap();

// Mint scoped creds against boot.credentialsUrl whenever you call AWS; they auto-rotate (~1h TTL)
// and are tag-scoped to this connection's own resources. You MUST present credentialsToken:
const res = await fetch(boot.credentialsUrl, {
  method: "POST",
  headers: { Authorization: `Bearer ${boot.credentialsToken}` },
});
```

### Authenticating the credentials mint

The broker authenticates every caller (loopback is **not** a trust boundary — every poppy's backend
is a local process too). So the mint above **requires** the `Authorization: Bearer
${boot.credentialsToken}` header. That token:

- authorises **only your own** connection's `POST /connections/<your-id>/credentials` — the broker
  rejects it on any other connection's route **and** on the whole management plane (list, revoke,
  pause, teardown, …), so you can never touch another poppy;
- is **revoked** the moment the host stops your backend (disable / revoke / teardown).

You never need — and can't obtain — the host's own token (the one the desktop UI uses to drive the
management plane); it's held only by the host and delivered over a channel a spawned backend can't
read. `credentialsToken` is typed optional purely for back-compat against a pre-auth broker; a
current host always injects it, and a current broker requires it. This closes the hole where one
installed poppy could have enumerated and revoked/torn down a competitor — and costs legitimate
poppy-to-poppy integration nothing, since "revoke my rival" was never a cooperation primitive.

## 4. Sell a feature — in-app purchases

Most poppies are **free** — you can't sensibly charge someone to run infrastructure in their own
cloud — so you monetise by selling **features** *inside* a free poppy (one-time or subscription)
through AgentsPoppy's checkout: a flat **5%**, and you stay the merchant of record. Price each product
in the developer dashboard, then reference it by id from your poppy.

**Declare the capability** in `extension.json`:

```json
{ "capabilities": ["commerce:purchase"] }
```

**Drop in the standard button.** It's **host-rendered** — you can't restyle or fake it, which is
exactly what makes users trust *this* button across every poppy. Call `definePurchaseButton` once
after your frontend boots (pass the bridge client from §2), then use the element anywhere:

```ts
import { definePurchaseButton, createHostBridgeClient } from "@agentspoppy/extension-sdk";
definePurchaseButton(createHostBridgeClient(transport)); // `transport` from §2
```
```html
<agentspoppy-purchase product="pro"></agentspoppy-purchase>
```

- Attributes: **`product`** (required — the product id you priced in the dashboard), **`target`**
  (optional — see below), **`label`** (optional — overrides the default "Buy · $X").
- It renders the live price, flips to **Owned** once bought, and on success fires a bubbling
  `purchased` CustomEvent (`detail: { product, target }`) you listen for to unlock the feature:

```ts
document.addEventListener("purchased", () => unlockProFeature());
```

- Once **Owned**, the button **always** shows a **"Manage"** link → the host opens the buyer's Stripe
  billing portal (cancel a subscription, update the card, see invoices/receipts). You get it for free —
  nothing to build. *(One-time setup: activate the customer portal once in your Stripe dashboard,
  Settings → Billing → Customer portal.)*

> ### ⚠️ REQUIRED: buyers must always be able to cancel / see what they paid
> This is a **platform rule**, not a nicety — an app that takes money but hides how to cancel destroys
> trust in *every* poppy's checkout. So:
> - **Use the standard button and you're compliant** — the "Manage" link above is rendered by the SDK
>   and can't be dropped. Nothing to do.
> - **Roll your own purchase UI** (custom button / direct API) and **YOU must** put a clearly visible
>   "Manage billing" control (calling `bridge.manageSubscription(...)`) wherever the bought feature
>   lives — present the moment it's owned, not buried. (MailPoppy is the reference.)
> - **Omitting it is grounds for removal from the directory.** A poppy that sells a subscription with
>   no obvious way to cancel will be **de-listed**, and the checkout can be disabled for it.

**Or drive it yourself** via the bridge (same `commerce:purchase` capability):

```ts
const info = await bridge.purchaseInfo("pro");   // { name, price: {amountMinor,currency,kind,…}|null, owned }
if (await bridge.isPurchased("pro")) unlock();    // the gate — check on load and after `purchased`
await bridge.buyProduct("pro");                   // opens checkout, resolves { owned }
await bridge.manageSubscription("pro");           // opens the billing portal (cancel / update card)
```

`isPurchased` is the gate. The host verifies ownership **server-side** — never trust a client-only
flag for anything valuable.

### `target` — charge per instance, and unlock your *other* apps

Every method (and the element) takes an optional **`target`**: a string *you* choose that scopes the
purchase to a specific thing — a domain, a project, or **a user in your own system**. It's the bridge
that lets a purchase made *in the poppy* activate a feature in your **separate app** (e.g. your mobile
client):

```ts
// In the poppy — buy scoped to the paying user's identity in YOUR system:
await bridge.buyProduct("pro", { target: userIdInYourApp });
```
```
// In your app's BACKEND — check the same key (no poppy, no per-install buyerId needed):
GET https://agentspoppy.com/api/entitlement?poppyId=<your.poppy.id>&productId=pro&target=<userIdInYourApp>
→ { "entitled": true }        // activate the feature for that user
```

The entitlement **is** the activation — there's no separate step. Pick a `target` that identifies the
**same user on both sides**: a signed-in **account id / email** (recommended for apps with logins), a
**domain** (MailPoppy's per-domain model), or a **license code** you issue at purchase. Do the check
**server-side** — the endpoint returns a public boolean; the real gate is your server enforcing it.
Full model + data shapes: [`docs/IN_APP_PURCHASES.md`](../../docs/IN_APP_PURCHASES.md).

### Get notified the instant a purchase completes (webhook)

Polling `/api/entitlement` is fine, but if you want to **provision the moment someone pays** (activate
a domain, flip a user to pro, issue a license) set a **purchase-notification URL** for your poppy in
the developer dashboard. AgentsPoppy then POSTs a signed JSON to it on every completed buy:

```http
POST https://your-backend.example.com/agentspoppy/purchase
X-AgentsPoppy-Event: purchase
X-AgentsPoppy-Signature: t=1700000000,v1=<hex hmac-sha256>
Content-Type: application/json

{ "type":"purchase", "poppyId":"com.acme.notespoppy", "productId":"pro",
  "target":"acme.com", "buyerId":"…", "kind":"one_time",
  "status":"active", "entitled":true, "occurredAt":1700000000000 }
```

**Verify the signature** before trusting it — the header is `t=<unix-seconds>,v1=<hmac>` where the
HMAC-SHA256 is over `` `${t}.${rawBody}` `` keyed by the **signing secret** the dashboard showed you
once (Stripe's scheme). Reject if the mac doesn't match or `t` is older than a few minutes (replay
guard). Then `target` tells you **who** to activate. It's best-effort and at-least-once (retries
possible) — so keep your handler **idempotent**, and treat `/api/entitlement` as the source of truth
if a notification is ever missed.

## 5. The Feedback tab — required, and already built

**Every poppy's LAST tab is "Feedback".** It is mandatory (AGENTS.md §9a) and you don't design it:
the SDK ships the whole tab as one element, so a user finds the same four things in every poppy
they install — rate it, ask for a feature, report a bug, support the developer.

It needs **nothing new from the host**: the tab calls the AgentsPoppy feedback API from your own
frontend and uses one capability you already have, `host:openExternal`, to open your issue tracker
and the donation checkout in the system browser. Adding it needs no new AgentsPoppy release.

Declare that capability and where bugs go:

```jsonc
{ "capabilities": ["host:openExternal"],
  "bugsUrl": "https://github.com/you/your-poppy/issues" }
```

Then mount it, last:

```ts
import { defineFeedbackTab } from "@agentspoppy/extension-sdk";
defineFeedbackTab(createHostBridgeClient(transport)); // `transport` from §2
```
```html
<agentspoppy-feedback poppy="com.you.your-poppy"
                      bugs="https://github.com/you/your-poppy/issues"
                      name="YourPoppy"></agentspoppy-feedback>
```

| The user… | What happens | Where it lands |
|---|---|---|
| Rates 1–5 stars | One rating per install (a random local id — nobody is identified), changeable any time | The star rating on your catalogue listing |
| Asks for a feature (≤500) | Copy invites — never requires — their email | Your developer dashboard |
| Reports a bug | Opens your **public** issue tracker in the browser | Your repository, readable by anyone (AI included) |
| Donates (from $5, ≤100-char message) | An ordinary AgentsPoppy checkout | Your Stripe account; dashboard shows the message |

Nothing here needs an account: the tab mints one anonymous id per install and keeps it in local
storage, so your poppy never learns who rated it. Donations need a connected Stripe account —
without one the donate box explains that rather than failing at checkout.

## Notes

- **Write the backend portable — Windows is coming.** A poppy ships one package per platform
  (`packages` keyed `darwin-arm64` today; `win32-x64` as AgentsPoppy for Windows rolls out). Use
  `os.homedir()`/`path.join()` instead of hardcoded POSIX paths, avoid spawning macOS-only tools at
  runtime, and keep signing steps out of backend code — then a Windows release is just re-packaging
  the same code with a win32 Node SEA binary.
- **Pure & dependency-light.** This package is types + validators (it depends only on
  `@agentspoppy/core` for the grant/permission shapes). Both the host and your extension import it,
  so the contract can't drift between them.
- The host-side counterpart (`handleHostRequest`) and the iframe wiring live in the app at
  `app/src/extensions/` — you don't need them to build an extension, but they show the other half of
  the bridge.

Source-available under the **PolyForm Perimeter License 1.0.0** — see [`LICENSE`](../../LICENSE). Build extensions on AgentsPoppy;
don't ship a competing host.
