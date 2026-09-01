# The machine gate — a poppy on this machine connects only where it declared

**Status:** approved in direction by the founder (2026-09-01, "proceed") — build plan
steps 1–3 BUILT the same day: the backend gate (armed in the child, fail-closed,
observe mode for undeclared manifests, proven end-to-end on the real child path —
undeclared fetch and DNS refused with APP_NET_GATE_REFUSED, loopback untouched,
process.binding poisoned), the frontend CSP on every /ext-ui response, and the
registry's `machineGate` report driving the card's honest "Host-enforced" graduation
(a dev-path host reports "none" for backend poppies — its spawns are ungated and the
chip must not lie even to developers). Step 4 landed the same
day: the gate's stderr lines are piped through the broker (still forwarded to its own
logs), parsed by the same module that emits them (mutation-tested agreement), and
recorded on the connection's trail as "network-refused"/"network-observed" audit
entries — capped at 50 per process run, since the line arrives over poppy-adjacent
stderr and a forger should only ever flood its own record. The release ride remains. This is the detailed
design for the phase `network-egress.md` names as next: *"block the poppy sandbox to
egress [from the user's machine], unless a specific network request is declared."*

**What it delivers, in one sentence:** a poppy's code on the user's machine — frontend
tab and confined backend both — can open a connection only to destinations in its
manifest's `network.machine` declaration, plus its own loopback plumbing; everything
else is refused by the host and logged.

**Correction before release (2026-09-01), and the reason it matters:** the gate first
keyed on `network.egress`. That field describes the poppy's CLOUD code — the wording is
"its cloud code connects only to…" on every screen — and enforcing it on the desktop
half turned out to break real, legitimate traffic that no declaration was ever about.
Three findings, all from reading the shipped poppies rather than the design:

1. **Every poppy's mandatory Feedback tab** (AGENTS.md §9a) calls `agentspoppy.com` from
   the poppy's own frontend, by explicit design ("THE HOST IS NOT INVOLVED"). Under a
   compiled CSP, the first poppy to declare would have had the platform's own required
   tab refused by the platform's own gate.
2. **MailPoppy's desktop half** — the declared pilot — calls its vendor Hub
   (`mailpoppy.com`) for mobile access and `agentspoppy.com` for checkout, and its IMAP
   import connects to **whatever mail server the user types**. Its `"aws-only"` cloud
   declaration is true of its Lambdas and false of its laptop process.
3. **AffiliatePoppy's backend** calls `api.stripe.com`.

So the two planes are now two fields: `egress` (door 1, the cloud, unchanged and still
unenforced) and **`machine` (door 3, this machine, what the gate enforces)**. One
vocabulary, two populations of connections. Absent `machine` = observe, which is where
every poppy shipped to date sits, so the release enforces nothing on anybody until a
poppy opts in — and a cloud declaration can never light the "Host-enforced" chip,
because it says nothing about this plane. The platform's own API is exempt on the
FRONTEND only, for the reason in (1): plumbing the poppy did not choose is never
collateral. A backend reaching the platform declares it like any other host.

## The two surfaces, and their mechanisms

### 1. The frontend tab — browser-enforced (the strong one)

The host serves every poppy frontend from its own origin (per-poppy-origins.md) and can
attach a Content-Security-Policy to those responses. The gate compiles the declaration
into it:

- `connect-src`: the poppy's own origin + its backend's loopback port + **the platform's
  own API** (the mandated Feedback tab calls it from the poppy's page) + the declared
  destinations (`"aws-only"` → `https://*.amazonaws.com`; a domain list → exactly those
  hosts; `"none"` → nothing external).
- `img-src` and `form-action` are gated the same way — an image URL is the oldest
  data-beacon channel there is, and a form post is an exfil channel with a submit button.
- Fonts, styles, scripts: the poppy's own origin only (they already ship in the package).

This half is enforced by the webview engine itself. It also directly covers the
founder's "user navigation data" concern: a tab that cannot call home cannot report
browsing.

### 2. The confined backend — host-enforced (honest about being so)

The host runs `node22` backends on its own runtime, so it injects a gate module before
any poppy code loads (`--require`, alongside the existing `--permission` flags). The
gate patches the runtime's network layer — socket connects, TLS connects, and DNS
resolution — and checks every outbound destination against the declaration:

- **Always allowed:** loopback to the broker's port and the backend's own host-assigned
  port. The plumbing that makes a poppy a poppy is never collateral.
- **`"aws-only"`:** hostnames under `amazonaws.com` (and nothing else).
- **Domain list:** exactly the declared hostnames.
- **`"none"`:** loopback only.
- **IP literals** that are not loopback are refused outright — declarations name hosts,
  and a raw-IP connect is how a gate gets walked around.
- **DNS is gated too:** resolving an undeclared name is refused, because encoding data
  into DNS queries is the classic quiet exit (the Gemini review named it, correctly).

Why an in-runtime gate holds here when it usually would not: strict confinement already
denies the three ways around it — no child processes, no native addons, no workers. The
gate additionally poisons the runtime's known internal escape hatches at startup. This
is **host-enforced, not physics**: the screen wording stays "the host refuses undeclared
connections", and "physically cannot" remains reserved for the sealed cloud VPC.

## Behaviour decisions (the ones worth the founder's eyes)

1. **Undeclared poppies: observe, don't break.** A poppy with no `network.machine`
   declaration gets NO blocking — every external connection is logged instead.
   Blocking would break every pre-declaration poppy's AWS calls on day one; and the
   catalogue already forces a declaration at their next update. Log-only also produces
   the evidence to check declarations against before hard enforcement.
2. **Fail closed on gate failure.** If the gate module cannot arm, the backend does not
   start. A security layer that silently degrades to open is the boundary fail-open bug
   again, and we do not ship that class twice.
3. **Every refusal is observed-register material:** poppy, destination, timestamp — the
   user can see what their poppy TRIED. A refusal is rendered as a fact, not an alarm
   (rule 6): most refusals will be a developer's stray telemetry SDK, not an attack.
4. **The screen graduates only against the running host.** The card's "Data exits" chip
   moves from "Declared" to "Host-enforced" only when the broker reports the gate armed
   for this connection — never from the manifest, never from the host version string.
   Same law as every other tick.
5. **One vocabulary, two planes.** `network.machine` takes exactly the values
   `network.egress` takes — `"none"` / `"aws-only"` / `"user-directed"` / a host list —
   validated by the same code in core, the same code in the catalogue's mechanical
   review, and rendered by the same screen. What it does NOT share is the population of
   connections it describes, which is why it is a second field and not a second reading
   of the first. The drift this decision originally feared (two lists claiming the same
   thing) cannot happen: neither field claims anything about the other's plane, and the
   screen shows both sentences side by side.

## What this deliberately does not claim

- A `native`-runtime backend cannot carry the gate (no runtime of ours inside it) —
  unchanged from confinement, and unconfined backends are already unlistable.
- The gate does not inspect payloads, only destinations. A poppy declaring
  `api.example.com` can send anything there; the declaration is the user's visibility,
  the catalogue review is the judgment.
- Door 2 infrastructure (the user's VMs, sites, mail) is out of scope by definition —
  its egress is its purpose, governed by the AGENTS.md no-siphoning listing rule.

## Build plan (after approval)

1. `net-gate` preload module in the broker package + arm/verify handshake in
   backend-host (fail closed), unit tests with an injected fake network layer.
2. CSP compilation in the per-poppy-origins server path, tests over emitted headers.
3. Broker reports gate state per connection; the enforcement card's "Data exits" chip
   and sentence graduate on it; screen tests pin that a manifest alone can never
   produce "Host-enforced".
4. Refusal events into the observed register.
5. The dev rig proves it live (a seeded poppy attempting an undeclared fetch → refused,
   logged, visible), then the release rides the normal runbook.

## Proven, on the real child path (2026-09-01)

Re-run after the door-3 correction, through `serve.ts --poppy-backend` (the path the
packaged host actually takes), with a stub poppy resolving four hosts:

| `machine` | telemetry.example.com | agentspoppy.com | sts.amazonaws.com | 127.0.0.1 |
|---|---|---|---|---|
| `"aws-only"` | REFUSED | REFUSED | allowed | allowed |
| `["agentspoppy.com"]` | REFUSED | allowed | REFUSED | allowed |
| `"none"` | REFUSED | REFUSED | REFUSED | allowed |
| observe (absent) | allowed + logged | allowed + logged | allowed + logged | allowed |

A malformed config (`egress: 42`) printed *"failed to arm — refusing to start the
backend"* and the poppy never loaded: fail-closed, as decision 2 requires.

Note the second row: the platform-API exemption is the FRONTEND's, not the backend's —
a backend that wants `agentspoppy.com` names it.
