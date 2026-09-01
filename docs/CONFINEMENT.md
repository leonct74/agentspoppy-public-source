# Backend confinement — what it is, and where it stands

A poppy's backend is code from a third party running on the user's machine. Confinement is the
answer to the obvious question that follows: what stops it reading `~/.aws/credentials`?

## The rule

**Since AgentsPoppy 0.3.5, confinement is the default.** A manifest that says nothing about
`backend.isolation` is confined. Running unconfined requires writing `"isolation": "none"`
deliberately, and that is refused at three independent gates — the manifest validator exits
non-zero, the submissions API rejects the listing server-side (re-reading the manifest from the
uploaded bytes rather than trusting the form), and the mechanical update review refuses a
`strict` → `none` downgrade on an existing listing. If one ever starts anyway, the host logs it.

Before 0.3.5 the field existed but defaulted to `"none"`, so confinement had to be asked for. The
default was flipped once every first-party poppy declared strict explicitly, so nothing depended on
the timing of the change.

## What strict actually does

The backend runs under Node's permission model (`--permission`), with an allowlist of exactly three
places:

| Place | Access |
|---|---|
| The poppy's install directory | read |
| The data directory the host assigns it (`bootstrap.dataDir`) | read + write |
| The OS temp directory | read + write |

Everything else on the machine is denied **by the runtime**, not by convention: the user's home,
their documents, their browser profile, and `~/.aws/credentials` above all. Spawning child processes
is denied outright — otherwise `cat ~/.aws/credentials` walks straight around the allowlist. Worker
threads, native addons and WASI are denied by the same flag.

Strict requires `runtime: "node22"`. A native executable has no runtime of ours inside it to enforce
an allowlist, so the validator rejects that combination rather than pretending it is confined.

## The network half (the machine gate, since 0.3.14)

Node's permission model covers files, not sockets — for a long time the honest sentence was "a
confined poppy still has the network". It has one now: if the manifest declares
`permissionSet.network.machine`, the host arms a gate inside the backend child before the poppy
bundle loads, and every socket connect and DNS query is checked against that declaration
(`docs/specs/machine-gate.md`). Undeclared destinations are refused with `APP_NET_GATE_REFUSED` and
logged; loopback is always allowed; the poppy's tab gets the matching Content-Security-Policy.

The gate depends on the confinement above rather than standing on its own: **no child processes, no
native addons, no worker threads** are exactly the three ways around a patch applied inside the
runtime. That is also why it is *host*-enforced and never described as something the poppy "cannot"
do — the sealed-VPC phase is the only place that word is earned.

A poppy that declares nothing is **observed**: allowed, and each external destination logged once
onto its record. Nothing written before this field breaks.

## The one exception

A named, one-release data migration. A poppy that kept state in the user's home before confinement
cannot move it once confined — the move itself needs the access being removed. Such a release runs
unconfined, says so in its notes, and names the confined successor. It is the only unconfined case
the review process will pass.

## Where the fleet stands

Every first-party poppy with a backend is confined. That was completed on 2026-08-20, ahead of the
default flipping in 0.3.5.

## Verifying it yourself

The claim is checkable without trusting this document:

- `packages/broker/src/extensions/backend-host.ts` — `confinementOptions()` builds the flags;
  `effectiveIsolation()` applies the default in one place, shared with the validator and the spec.
- `packages/extension-sdk/src/manifest.ts` — the field, its default, and the validator.
- On a running install, `ps eww` on a poppy's backend process shows the actual `NODE_OPTIONS`.

Related: [`SECURITY_MECHANISM.md`](./SECURITY_MECHANISM.md) §6.1 for the credential-exposure threat
this closes, and [`RUNTIMES.md`](./RUNTIMES.md) R7 for the listing rule.
