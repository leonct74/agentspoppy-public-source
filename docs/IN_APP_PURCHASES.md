# In-App Purchases — design (products + the standardised buy button)

*Status: design for review (2026-07-11). Extends the commerce plane already built in
`agentspoppy-web` (Stripe Connect, flat 5%, entitlement, webhooks). See `MARKETPLACE.md` for the
business model and `DEVELOPER_TERMS.md §2` for the anti-steering rule this enforces.*

## 1. The model (corrected)

AgentsPoppy commerce is **not** "buy the poppy." It's a purchase button a developer can place
**anywhere inside their poppy**, for **any feature or service they choose to charge for**. The
poppy's baseline is usually free — the user could often build the plumbing themselves — so the
developer monetises the *creative value they add on top*, and decides **which parts, and how many
things, carry a buy/subscribe button**.

- **MailPoppy** — backend free → pay to unlock a domain's client access.
- **A VM poppy** — deploy/teardown free → pay for "auto-install this software+config stack on every
  deploy."

So it's **granular, developer-defined products**, keyed per product — not one price per poppy. This
also dissolves the per-domain-vs-per-poppy question: it's neither; the developer decides what a
*product* is (a feature, a tier, a service, or a per-instance unit like a domain).

## 2. Data model (Firestore, in the commerce plane)

```
products/{poppyId}__{productId}
  { poppyId, productId, developerUid, stripeAccountId,
    name, description?, pricing (one_time|subscription), stripeProductId, stripePriceId,
    active, updatedAt }

entitlements/{buyerId}__{poppyId}__{productId}[__{target}]
  { buyerId, poppyId, productId, target?, kind, status, currentPeriodEnd?, updatedAt }
```

- **A poppy has many products.** `productId` is developer-chosen (e.g. `domain-access`, `pro`,
  `auto-config`), stable, reverse-DNS-free (scoped under the poppy).
- **Per-instance via `target` (optional).** For "charge per X" (per domain, per VM), the buy call
  carries a `target` (e.g. `acme.com`) and entitlement is keyed with it. No `target` ⇒ one
  entitlement for the whole product (a simple unlock). This is how MailPoppy gets per-domain without
  a special "per-domain mode."
- **Migration:** today's single per-poppy `listing` becomes a product with `productId = "default"`.

## 3. API (evolves what exists)

| Today | Becomes |
|---|---|
| `POST /api/listings` (one price/poppy) | `POST /api/products` — define/price a product; creates the Stripe Price on the connected account |
| — | `GET /api/products/:poppyId` — a poppy's products + prices (for display) |
| `POST /api/checkout {poppyId, buyerId}` | `+ productId, target?` — direct charge for THAT product's price (+5% fee) |
| `GET /api/entitlement {poppyId, buyerId}` | `+ productId, target?` → `{ entitled }` |
| — | `GET /api/entitlement {poppyId, productId, target}` (NO buyerId) → **cross-app** rollup: is this shared key entitled by ANY buyer? |
| webhook | entitlement keyed by `(poppyId, productId, target)` via checkout metadata |

Everything under the hood — Standard Connect direct charges, the flat 5% application fee, the
entitlement rules (one-time = permanent, subscription = active/grace), the signature-verified
webhook — is **unchanged**; only the key gains `productId` (+ optional `target`).

### 3a. Cross-app entitlement — the majority pattern (✅ built)

Most poppies are **free to install** (you can't sensibly charge someone to run infrastructure in
their own AWS) and monetise **special features, usually consumed in the developer's *other* app** (a
mobile client, a marketplace/social integration). The purchase happens via the in-poppy button; the
*unlock* must be readable by that external app.

The bridge is a **shared key** (`target`) both sides know — a domain, or an id in the developer's own
system. The buy is scoped to it; the external app checks it **without** the anonymous per-install
`buyerId`:

```
GET /api/entitlement?poppyId=com.mailpoppy.desktop&productId=domain-access&target=acme.com
→ { entitled: true }        # ANY active purchase of that (poppy, product, target) counts
```

`entitlement.ts::pickEntitled` (pure, unit-tested) does the "entitled if any buyer's record is
active" rollup; `store.ts::getTargetEntitlement` runs the equality-only Firestore query (no composite
index). This mirrors the MailPoppy Hub's domain gate exactly — the boolean is a public unlock flag,
never account/payment detail. Buyer-scoped (`buyerId`) queries are unchanged, so the in-poppy button
keeps working as-is.

## 4. The standardised purchase button (the important part)

A **host-rendered** button the poppy embeds but cannot restyle or fake. It's the *only* legitimate
way to charge inside a poppy — which is precisely what makes the anti-steering rule enforceable: a
user learns to trust *this* button across every poppy (like Apple's Buy / a Stripe element), so any
*other* "pay here" prompt is instantly suspect.

**Developer surface (extension SDK):**
```ts
// declare products in the manifest, then reference them by id:
const p = await agentspoppy.purchases.get("domain-access", { target: domain });
// → { name, price, kind, owned }

if (!p.owned) {
  // host-rendered, standardised button — poppy supplies id + optional target + a slot:
  agentspoppy.purchases.button({ product: "domain-access", target: domain, mount: el });
}

// gate the feature on entitlement (verified server-side; the poppy just asks):
if (await agentspoppy.purchases.entitled("domain-access", { target: domain })) {
  // unlock
}
```

- **The button** shows: the AgentsPoppy purchase mark, the price, one-time vs subscription, and an
  **Owned** state once entitled. Fixed look, host-drawn.
- **On click** → the host opens Stripe Checkout (system browser), polls entitlement, and flips the
  button to Owned + fires an `entitlement-changed` event the poppy listens on to unlock.
- **`buyerId`** is the stable per-install id already built (localStorage in the host).
- Entitlement is **verified server-side** (commerce plane); the poppy trusts the host bridge, never
  its own claim.

**Manifest:** a poppy declares its products (id, name, so the host knows what's purchasable and can
show "has in-app purchases" in the directory) — actual prices stay server-side (set in the dashboard).

## 5. Developer dashboard

"Set your price" (one price) becomes **"Products"**: add N purchasable items, each `productId` +
name + pricing (one-time/subscription). Each maps to a Stripe Price on the connected account. The
developer references the `productId` in their poppy code.

## 5a. First-party products — one checkout for the platform's own apps (✅ built)

First-party poppies (MailPoppy + future OllyDigital apps) sell through the **same** checkout as
everyone else, but there's no separate connected account to charge — OllyDigital can't Stripe-connect
to itself. So a first-party product is created + charged on the **platform's own account at 0%**
(`fee.ts` already returns 0; `platform.ts` + the first-party branches in `/api/products` and
`/api/checkout`). Pricing them is **admin-only**, done in `/admin` → "First-party products" (not the
per-developer dashboard). One operational note: because these charges fire on the platform's own
account, the webhook accepts events from a second **"Your account"** Stripe destination too
(`webhookSigningSecrets` tries every configured secret) — the connected-accounts webhook only carries
third-party direct charges. The handler acts on `checkout.session.completed` +
`checkout.session.async_payment_succeeded` (delayed local methods) + `customer.subscription.*` (incl.
`paused`/`resumed`) + `account.updated`; unrecognised events are harmless (`default:break`).

## 5b. Purchase-notification webhook (✅ built)

A developer can set a **notify URL** for their poppy (dashboard, or `/admin` for first-party). On every
completed buy AgentsPoppy POSTs a **signed** `PurchaseNotification` (`notify.ts`:
`{poppyId, productId, target, buyerId, kind, status, entitled, occurredAt}`, `X-AgentsPoppy-Signature:
t=…,v1=hmac`) so the developer provisions instantly instead of polling. Best-effort + at-least-once →
verify the signature, stay idempotent, treat `/api/entitlement` as the source of truth. SDK docs:
README §4 "Get notified the instant a purchase completes".

## 6. MailPoppy as the reference (✅ migrated)

- Defines a first-party product `domain-access`, **per-domain via `target = <domain>`**. The gate is a
  boolean, so one-time-vs-subscription is just the dashboard price shape — no code fork (the `§20`
  pricing decision is now a config choice, not a blocker; MailPoppy's "pay once per domain" → one-time).
- The desktop's external "unlock domain → mailpoppy.com/activate" paywall CTA now starts the
  **AgentsPoppy checkout** (`apps/desktop/src/lib/commerce.ts` → `/api/checkout`, `target = domain`).
- The Hub's `/api/resolve` gate reads entitlement from the commerce plane (source of truth):
  `domains/{domain}.agentspoppyEntitled` is a mirror set by the **purchase webhook**
  (`POST /api/agentspoppy/purchase`, signature-verified) with a **live `/api/entitlement` fallback**
  on a negative gate (self-heals a missed webhook) → **one paywall to manage**, and MailPoppy finally
  models its own anti-steering rule. The legacy per-domain Stripe path stays as a fallback during
  cutover.

## 7. Build phases

1. **Core IAP rails** — Stripe Connect, 5% fee, entitlement, webhook. *(built; validating live via
   the DemoPoppy/TestPoppy Buy test — the rails are identical, so this de-risks everything below.)*
2. **Products** — data model `(poppyId, productId[, target])`, `POST /api/products` +
   `GET /api/products/:poppyId`, checkout/entitlement/webhook keyed by product; dashboard "Products".
3. **SDK + standardised button** — `agentspoppy.purchases.*` bridge + the host-rendered button;
   manifest product declarations; directory "has in-app purchases" badge.
   *(cross-app target-only entitlement lookup — §3a — is built here: `pickEntitled` +
   `getTargetEntitlement` + the buyerId-less `/api/entitlement`.)*
4. **MailPoppy migration** — ✅ define `domain-access` (first-party, on the platform account at 0%),
   route the desktop paywall CTA at `/api/checkout`, and point `/api/resolve` at the commerce
   entitlement (mirror + live §3a cross-app lookup keyed on the domain) + a signed purchase webhook.
   *(No longer gated on `§20`: the gate is a boolean, so the pricing shape is a dashboard choice.)*
5. **First-party checkout + purchase-notification webhook** — ✅ 0%-on-platform charges for the
   platform's own apps (§5a) and the signed developer notification (§5b).

## 8. Compatibility

The current per-poppy path stays working as a `productId = "default"` product, so the DemoPoppy Buy
test and anything shipped on the v1 rails keep functioning while phases 2–4 land.
