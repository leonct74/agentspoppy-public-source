# The poppy design contract

Poppies run *inside* the AgentsPoppy console. Users must experience one coherent,
premium product — and must always be able to tell the **host's** voice (approvals,
supervision, teardown) from a **poppy's** UI at a glance. That second property is
a security affordance, not taste: a poppy that looks like host chrome can phish
an approval.

So the deal is simple: **you get a complete dark theme for free, and you don't
get to deviate from it.** This document is the contract. It is written to be
followed mechanically — including by an AI coding agent building a poppy from a
prompt. If you are that agent: treat every rule below as a hard constraint, the
same way you'd treat a failing type check.

## Setup

1. Vendor [`poppy.css`](./poppy.css) from this package into your frontend and
   import it **before any other stylesheet**. (When the SDK is published to npm
   you can `@import "@agentspoppy/extension-sdk/poppy.css";` instead.)
2. Set `--poppy-accent` to **your assigned accent**: the host assigns each app id
   one colour from a fixed six-colour palette, deterministically —
   `poppyAccent(appId)` exported by this SDK. Compute it once and pin it:

   ```css
   :root {
     /* Assigned accent for com.example.myapp — poppyAccent("com.example.myapp"). */
     --poppy-accent: #c9b8e8;
   }
   ```

   This is the same colour the host paints your sidebar avatar and airlock
   header with. When they match, your poppy has ONE identity everywhere.

## The rules

1. **Tokens only.** Every colour in your UI comes from a `--poppy-*` token, or a
   `color-mix()` of tokens. No raw hex / rgb() / hsl() literals, and no CSS
   framework palette colours (`amber-400`, `slate-800`, `text-white`, …) — map
   your framework's semantic tokens onto the kit instead (see the MailPoppy
   reference below).
2. **One accent.** `--poppy-accent` is your only identity colour: primary
   buttons, active nav, focus rings, links. Status colours (`--poppy-ok`,
   `--poppy-warn`, `--poppy-danger`) mean status, never branding.
3. **No clay.** `#d97757` and its neighbours are the host's reserved accent.
   Never use clay in any form or approximation — it is how users tell
   AgentsPoppy's own actions from yours.
4. **No glass.** `backdrop-filter` is host-reserved material for chrome that
   floats *above* a poppy (airlock, approval dialogs). Your modals and scrims
   are solid: e.g. `color-mix(in srgb, var(--poppy-surface-0) 75%, transparent)`.
5. **No font overrides.** UI text uses `--poppy-font` (the native system sans);
   *data* — ids, ARNs, email addresses, timestamps, logs, code — uses
   `--poppy-font-mono`. Do not load webfonts.
6. **Elevation by surface, not shadow-hue.** Backgrounds climb the
   `--poppy-surface-0…3` ramp; borders are `--poppy-border(-strong)`; corners
   are `--poppy-radius`.
7. **Wear your icon top-left.** Your app icon (the same square PNG your
   manifest declares as `icon`) sits at the top-left of your UI, beside your
   poppy's name — the convention every poppy follows, so the icon a user tapped
   in Poppies is the face that greets them inside. Keep it legible at 24px.

## Allowed exceptions (each must stay contained)

- **Brand mark.** Your logo/wordmark may keep its true brand colours as an
  *asset* (SVG/image or an equivalent app-local token used by the logo
  component only). It must never leak into UI chrome — buttons, nav, text.
- **Foreign-content islands.** Content authored elsewhere (HTML email bodies,
  PDF pages, web previews) may render on a white "paper" surface for fidelity.
  Define it once as an app-local semantic token (e.g. `--color-paper: #fff`)
  with a comment, and use it only for the content island itself.

## Self-check (run these before you ship)

From your frontend source directory — all four should come back empty:

```sh
grep -rEn "#[0-9a-fA-F]{3,8}" src --include='*.tsx' --include='*.ts'   # no hex in components
grep -rn  "backdrop-" src                                              # no glass
grep -rin "d97757\|e08a6d" src                                         # no clay, ever
grep -rn  "font-family\|@font-face\|fonts.googleapis" src | grep -v poppy-font  # no font overrides
```

(Token *definitions* — your framework's theme block mapping onto `--poppy-*`,
your brand-mark token, your paper token — live in your theme stylesheet and are
the only place a literal may appear, each with a comment saying what it is.)

## Reference implementation

MailPoppy's desktop frontend (`mailpoppy/apps/desktop`) is the canonical
example: a Tailwind v4 app whose entire `@theme` block maps the semantic
Material-style tokens onto `--poppy-*`, with the brand mark and the email/PDF
paper islands as the only two exceptions, each declared and commented in the
theme block.
