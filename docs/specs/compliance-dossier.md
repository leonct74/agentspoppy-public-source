# Compliance dossier — every poppy ships its slice of the customer's audit

**Status:** phases A and B APPROVED by the founder and BUILT the same day (2026-09-01:
*"proceed"*). Origin: the founder's observation that Vanta sells SOC 2 readiness at
$10k–30k+/yr, and the question *"what about be also natively soc2 compliance in the sense
that every poppy in the catalogue also ship his part of soc2 documentation?"* Phases C
(the in-app live connection export) and D (CAIQ/SIG mappings) remain design, not
commitment.

**As built** (two deviations from the draft below, both deliberate):
- The dossier lives at **`agentspoppy.com/poppies/<slug>/dossier`** (+ `dossier.json`
  beside it), not at `/dossier/<id>@<version>` — it hangs off the listing page users
  already share, and the document states the version and package sha256 it describes.
- Generation runs on the catalogue site, driven by the **sha-pinned staged manifests**
  (the same provenance as the listing pages' approval preview: the exact bytes the
  review saw), with core's `network.ts` and `guarantees.ts` vendored verbatim so the
  dossier's wording can never drift from the app's engines. The naming law and the
  machine-gate wording law are pinned by tests.
- The `compliance` manifest block is validated in `@agentspoppy/extension-sdk`
  (`validateManifest`) and REQUIRED by the catalogue's mechanical review — turned on
  only after all seven first-party poppies' repos declared it (the corrected order,
  same day). MailPoppy pilots the subprocessor case (the vendor Hub: domain +
  entitlement, never mail content); the other six declare an empty list.

## The idea in plain words

When a company pursues SOC 2, its auditor asks two questions about every tool with access
to its systems: *what can it do, and prove it* (logical access, monitoring, change
management), and *who is the vendor and what do they do with our data* (vendor
management). Companies pay Vanta-class products five figures a year mostly to **collect
evidence** that controls exist across their stack.

On AgentsPoppy the controls are not something to collect evidence *about* — they are the
architecture, and they are already machine-readable. The manifest is the access-control
documentation. The broker's guarantees are the logical-access controls. The signed,
content-addressed releases are the change-management record. The tamper-proof record is
the monitoring. So the per-poppy compliance documentation is a **rendering of things the
platform already enforces or already displays** — near-zero developer burden, generated in
platform words, and impossible for the marketing department to inflate.

The enterprise pitch this buys: **the only agent platform where every extension comes with
audit-ready vendor documentation.** Enterprise procurement currently chokes on AI tools
precisely because nobody can answer the security questionnaire. This answers it with a
download.

## The naming law (first, because overselling here is fatal)

A poppy can never *be* "SOC 2 compliant" and the platform never writes those words. SOC 2
attests to an **organization's** controls, over an audit period, signed by a licensed CPA
firm — Vanta cannot issue one either. What a poppy ships is its **slice of the customer's
audit**: evidence and vendor documentation that plug into the customer's own SOC 2 (or
ISO 27001, or vendor-risk review). Approved vocabulary:

- **"compliance dossier"** / **"vendor security package"** — the artifact;
- **"audit-ready"** / **"evidence for your SOC 2 audit"** — what it is for;
- **"mapped to the SOC 2 Trust Services Criteria"** — the structure.

Forbidden: "SOC 2 compliant", "SOC 2 certified", any phrasing where the platform appears
to attest. Same discipline as the machine gate's "the host refuses" vs "cannot connect":
the words never outrun the mechanism.

## What the dossier contains

Two registers, kept visually and structurally apart — the same separation the permission
screen already enforces between computed boundary lines and developer `reason` claims.

### Platform-generated (the bulk — no developer action)

Derived from the SAME engines the permission screen uses (`permissions.ts`, `network.ts`,
`enforcementCard.ts`, `guarantees.ts` constants). **The dossier is a compression, never a
second opinion** — a hand-written parallel copy would drift, and a drifted compliance
document is worse than none.

| Section | Source | Register |
|---|---|---|
| Identity & provenance — id, version, artifact sha256, signed release, public source repo, declared (never shipped) runtime | catalogue record + release asset | enforced facts |
| Access — every grant with service, actions, scope; tag confinement; permissions boundary; sessions ≤ 1h; no stored keys; kill switch | `permissionSet` + guarantees | enforced facts |
| Network — the three doors, each in its own sentence, with the gate state | `network.ts` + host report | enforced where armed, declared elsewhere — the honest-chip law applies verbatim |
| Change management — re-consent on any grant change, mechanical review on every listing and update, content-addressed artifacts | catalogue rules | enforced facts |
| Monitoring & record — everything it does in the cloud recorded, record not switchable off by the poppy | guarantees | enforced facts |
| Exit — one-click teardown, tag sweep, leaves-no-trace certificate when issued | certification record | enforced facts |
| Platform governance — delisting rules, deceptive-declaration blocklist, the audit clause for developer-operated services | dev policy pages | standing rules |

### Developer-declared (three fields, and only three)

New **top-level manifest block** (not under `permissionSet` — this is documentation, not
scope; the host parses the full manifest anyway, so the live export can still read it):

```json
"compliance": {
  "dataHandled": "Mail content and metadata, stored only in your own AWS account.",
  "subprocessors": [
    { "name": "mailpoppy.com", "operator": "Olly Digital", "purpose": "mobile-access configuration", "dataShared": "domain name and entitlement status — never mail content" }
  ],
  "securityContact": "security@example.com"
}
```

- `dataHandled` — one or two sentences, prose, length-capped like grant `reason`.
- `subprocessors` — third parties or developer-operated services user data can reach.
  Empty array = the strongest label in the dossier: **"No subprocessors — no user data
  leaves your cloud."** Entries must be consistent with the network declaration and the
  privacy-policy flow declarations; the mechanical review cross-checks what it can (a
  named subprocessor host should appear in `machine`/`egress` where the code calls it).
- `securityContact` — where a customer's security team reports a vulnerability.

These render in the developer's-own-words register — attributed, reviewed at listing,
never in the platform's voice. The platform's checkout/entitlement APIs are pre-declared
platform-side and never count as the poppy's subprocessors.

## The SOC 2 mapping (what makes it a dossier and not a brochure)

Each dossier section carries its Trust Services Criteria references, so an auditor can
file evidence without translating:

| TSC | Criterion (short) | Platform mechanism |
|---|---|---|
| CC1/CC2 | Control environment, communication | catalogue rules, permission screen disclosure, re-consent on change |
| CC3/CC4 | Risk assessment, monitoring of controls | mechanical review + risk rating; reproducible-build verification |
| CC5 | Control activities | the broker: scoped short-lived sessions, supervised approvals |
| **CC6** | Logical access | grants, tag confinement, permissions boundary, no stored keys, kill switch |
| **CC7** | System operations | the record, egress gate logs, optional GuardDuty |
| **CC8** | Change management | signed content-addressed releases, public source, review on every update |
| **CC9** | Vendor management / risk mitigation | this dossier itself, subprocessor declaration, the audit clause |

Plus a generated **CUEC section** (complementary user entity controls — the controls the
*customer* must operate for ours to hold, which auditors expect listed): keep supervision
on for production accounts, review the record, approve grant changes deliberately, keep
CloudTrail enabled account-wide, restrict who can install poppies.

## The two artifacts

1. **Catalogue dossier** — per poppy, per version. Generated by `agentspoppy-web` from the
   submission record; a rendered page and a JSON document at a stable URL
   (`/dossier/<id>@<version>`), linkable in a procurement email. Static once a version is
   listed, because it describes the reviewed artifact.
2. **Connection evidence export** — per install, live, generated by the host in-app: the
   grants *as approved in this account*, supervision on/off, machine gate armed or
   observing, boundary attached or not, where the record lives, export date. This is the
   file the customer's auditor actually puts in the evidence folder, because auditors need
   "operating effectively in *this* environment", not the brochure. Same honesty source as
   the enforcement card: live facts come only from the running host's report.

## Rollout — the egress lesson, applied in the right order this time

The 0.3.14 sequencing mistake (the screen judged declarations before any declared poppy
existed, so seven first-party poppies read as warnings) is the anti-pattern. Order:

- **Phase A — generate, zero new fields.** Everything platform-derivable ships for every
  listed poppy at once. No developer action, no manifest change, nothing can read as a
  warning. The dossier URL and page go live.
- **Phase B — declare, then require.** The first-party fleet ships manifests carrying the
  `compliance` block. ONLY THEN the mechanical review requires it on new listings and
  updates (the exact mirror of network phase 1c). A missing block before that day renders
  as "packaged before the declaration existed", never as a red flag.
- **Phase C — the live connection export** in the app (the auditor-export button on a
  connection).
- **Phase D — questionnaire mappings** (CAIQ v4, SIG Lite auto-answers derived from the
  same data) and cross-links to CompliancePoppy when it exists. Separate decisions.

**Cost: zero.** Rendering, a JSON route, three manifest fields, one review rule. No AWS
changes, no new grants, no re-consent wave.

## What this spec deliberately does not claim

- It is **not certification** and never uses the word. The customer's CPA firm audits; we
  hand them organized, mechanism-backed evidence.
- It does **not** cover the customer's own AWS estate beyond poppies — that is
  CompliancePoppy (separate product, separate design, wide read-only grants, AWS Audit
  Manager/Config/Security Hub in the customer's own account).
- It does **not** make AgentsPoppy-the-vendor SOC 2 — enterprises will eventually ask for
  ours; the BYO-cloud model keeps that audit's scope small, and it is a business decision
  for later.
- A dossier is **not a security audit of the poppy's code**. It documents the cage, not
  the animal: what the poppy *can* do and what the platform enforces — the open repo and
  the review exist for the code itself, and the dossier links to both.
- Cloud egress (`network.egress`) remains a declaration until the sealed-VPC phase, and
  the dossier says so in the same words the permission screen does. Precision about the
  unenforceable is what makes the enforced claims credible to an auditor.

## Pilot

MailPoppy — deliberately the hardest case, so the schema is proven against reality:
`dataHandled` = mail in the user's own AWS only; `subprocessors` = the mailpoppy.com Hub
(mobile-access configuration — domain + entitlement, never mail content); a real
`securityContact`. A poppy with an empty subprocessor list (VM-Poppy) pilots the
"No subprocessors" label the same week, because that label is the one most poppies will
carry and the one enterprises most want to see.
