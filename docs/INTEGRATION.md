# The Poppy Integration Framework (v1)

How a **poppy** (any app, e.g. MailPoppy) and **AgentsPoppy** (the broker) work together.

`ARCHITECTURE.md` describes the broker's *internals*. This document is the **contract** between
the two apps: the invariants neither side may break, how scoping is achieved per AWS service,
the connection lifecycle, what "connected" vs "disconnected" means for credentials, and how
risk is presented to the user. It is the reference both codebases adhere to.

> **One sentence:** a poppy declares the *minimum* AWS access it needs, scoped to its *own*
> resources; the user approves it in plain language; AgentsPoppy vends short-lived, tag-scoped,
> revocable credentials; everything the poppy creates is attributable and can be torn down in one
> click — and the poppy can **never** touch a resource it did not create.

---

## 1. The two roles and the boundary

| | **AgentsPoppy** (broker) | **A poppy** (e.g. MailPoppy) |
|---|---|---|
| Holds AWS credentials | Yes — the long-lived operator key, locally (0600), never transmitted | Only short-lived, scoped credentials it mints per connection — never the operator key |
| Talks to AWS | Only to **vend** creds (STS AssumeRole) + **govern** (inventory/teardown with operator creds) | Yes — calls AWS **directly** with the vended creds |
| Knows about the other | Agnostic — knows nothing app-specific | Declares its needs + imports `@agentspoppy/client` |
| Decides what's allowed | Enforces the user's approval | Requests; cannot widen its own grant |

**The broker is not in the per-call path.** It vends a short-lived credential; the poppy then
calls AWS itself. This is why scope must be enforced *in the credential* (IAM session policy +
tag conditions), not by inspecting calls. (A future per-call proxy / supervised mode would change
this — see §8.)

**Caller authentication (the local trust boundary).** The broker binds to loopback, but that is
**not** an access-control boundary — every poppy backend is a local process too. So the broker
authenticates each caller by bearer token. A per-run **host token** (held only by the AgentsPoppy
UI, delivered over a channel a spawned backend can't read) is required for the management plane
(list / approve / deny / pause / resume / revoke / teardown, accounts, operator AWS calls). A poppy
backend instead gets a **per-connection credentials token**, injected in its bootstrap, that
authorises **only its own** credential mint — never a sibling's route, never the management plane.
So one poppy can't enumerate, disable, or tear down another. This costs legitimate integration
nothing: "revoke my rival" was never a cooperation primitive.

---

## 2. The invariants (non-negotiable)

These are the promises that make AgentsPoppy worth using. Every change to either app must
preserve all of them.

- **I1 — A poppy may only ever touch what IT created.**
  Pre-existing resources — another app's Cognito pool, DynamoDB table, S3 bucket — are
  **untouchable**. This is the cardinal rule. Deleting App A's user pool because a poppy had a
  broad `cognito-idp:*` grant is exactly the outcome the framework exists to prevent.

- **I2 — Least privilege by declaration.**
  A poppy requests the *specific actions* it needs, *scoped* to its own resources. It never asks
  for `*` on a mutating action it can avoid. Over-asking is a defect: it alarms the user during
  scrutiny and undermines the whole pitch.

- **I3 — Attribution is enforced where tags are the scope.**
  Every resource a poppy creates is expected to carry the three tags
  `agentspoppy:account`, `agentspoppy:app`, `agentspoppy:connection`. They are vended as
  **transitive STS session tags**, and on tag-scoped creates the birth-tag condition
  (`aws:RequestTag`) makes AWS refuse an untagged create outright — which is what makes both
  tag-scoping (I1) and teardown (I6) real there. On grants scoped by a name/ARN pattern, the
  name is the fence and the tags are attribution, not enforcement.

- **I4 — No stored admin; no self-escalation.**
  AgentsPoppy never stores admin and never keeps it: setup asks **once** for a credential able
  to create a role and a user, uses it in memory, and persists only the operator key — the
  setup key minus all IAM permissions. The broker role is a wide-but-fenced role;
  per-connection session policies only ever **narrow** it (intersection, never union). The
  role's deny guardrail blocks IAM-user management, account/org control, CloudTrail tampering,
  and **attaching the account-admin policies** (`AdministratorAccess`, `IAMFullAccess`,
  `PowerUserAccess`) — so a poppy cannot escalate beyond the grants the user approved, and the
  role's guardrails hold even if a grant were written recklessly wide.

- **I5 — Short-lived and revocable.**
  Vended creds live ~1h and auto-rotate. **Pause** / **revoke** stop the next mint; access dies
  within the token TTL. Nothing an *app* receives is long-lived — the one long-lived secret is
  the operator key on the user's own disk, which no poppy receives and which confinement
  (SECURITY_MECHANISM.md §6.1) now denies poppies from reading.

- **I6 — Tear down exactly the footprint.**
  Teardown deletes the connection's CloudFormation stack(s), sweeps its tagged resources, and
  reverses its ledger'd mutations — and **nothing else**. Teardown re-verifies the tag immediately
  before deleting, so a stale/forged stack name can't trick the broker.

- **I7 — Auditable.**
  The code that holds credentials and enforces scope is source-available. A guarantee you can't
  read is just a promise.

---

## 3. How "only its own" is enforced (the scoping matrix)

> Normative spec: [`docs/SECURITY_MECHANISM.md`](./SECURITY_MECHANISM.md) — the single
> source of truth for the delegation mechanism. This section is the developer-facing
> view; if they ever disagree, that document wins.

A grant is one `{ service, actions[], resourceScope }`. `resourceScope` is **enforced** — it is
written verbatim into the vended session policy's `Resource` (`packages/broker/src/aws/policy.ts`).
There are three scoping strategies, chosen by what the AWS service supports:

| Strategy | `resourceScope` | Session-policy `Resource` | Use when |
|---|---|---|---|
| **Tag-scoped** (strongest) | `TAGGED_AS_SELF` (`"tagged-as-self"`) | TWO statements: **creates** (`Create*`/`Request*`) get `"*"` + `Condition: aws:RequestTag/agentspoppy:app == <appId>` — the resource is **born tagged as this app, or not born at all**; **everything else** gets `"*"` + `Condition: aws:ResourceTag/agentspoppy:app == <appId>`. (App tag, not connection: connections are superseded on scope drift, the footprint outlives them.) | The service supports tags **in the create call** (ACM `RequestCertificate`, CloudFront `CreateDistributionWithTags`, …) and `aws:ResourceTag` on later ops. If the create API can't take tags at creation (tagging is a separate later call), tagged-as-self can't authorize the create — use name-scoping for that service instead. |
| **Name-scoped** | a concrete ARN / ARN pattern, e.g. `arn:aws:s3:::mailpoppy*`, `stack/MailpoppyMailStack-*` | the literal pattern | The service has stable, predictable names but weak tag-on-mutate support (S3 buckets, DynamoDB tables, CFN stacks). The poppy can only touch resources whose **name** matches its own prefix. |
| **Unscoped create-only** | `"*"` | `"*"` | A *create* call that has **no ARN to scope to** (e.g. `cognito-idp:CreateUserPool`). Allowed because creating a new resource is **additive** — it cannot harm anything that already exists. Still tagged via I3, so the created resource immediately becomes tag-scopable for every later op. |
| **Unscoped read / no-resource-level** | `"*"` | `"*"` | The service has no resource-level permissions at all (SES `SendEmail`/account ops, Route53 `ChangeResourceRecordSets`, GuardDuty). Documented per service; mutating ones here are the only legitimate `*` mutations and must be justified. |

**The decisive rule for a poppy author:** for any action that **changes or deletes an existing
resource**, the scope MUST be tag-scoped or name-scoped — never `*`. `*` is permitted only for
(a) pure creates with no ARN, or (b) services with no resource-level support. Anything else is an
I1/I2 violation.

### The Cognito example (the case that drove this)

MailPoppy needs to create user pools and manage *its own* mailboxes, but must not be able to
delete another app's pool. So its Cognito grant is **split**:

- `CreateUserPool`, `CreateUserPoolClient`, `Describe*`, `List*`, `TagResource` → `"*"`
  (create/read are additive; tagging is how the new pool gets stamped).
- `DeleteUserPool`, `UpdateUserPool`, `Delete/UpdateUserPoolClient`, `SetUserPoolMfaConfig`,
  `AdminCreateUser`, `AdminSetUserPassword`, `AdminDeleteUser`, `ListUsers` → `TAGGED_AS_SELF`.

Result: MailPoppy can stand up a pool and fully run it, but a pool it didn't create has no
`agentspoppy:app` tag naming it → every delete/modify/admin call against it is denied
(ownership is pinned to the app tag; the connection id is an audit tag). (CloudFormation
propagates the stack's tags to the pool, so pools born via the poppy's stack are tagged
automatically; `cognito-idp:TagResource` covers the direct-create path.)

The canonical declaration lives in MailPoppy at
`apps/desktop/node-sidecar/src/agentspoppyBroker.ts::permissionSet()`, kept in lockstep with its
own `infra/policies/mailpoppy-{deploy,provisioning}-policy.json`.

---

## 4. Connection lifecycle

```
poppy: POST /connections  ─────────────►  pending
                                             │  user reviews plain-language grants + risk
                          approve  ──────────┤
                                             ▼
                                           active  ◄──────── pause/resume
                                             │
                       poppy: POST /connections/:id/credentials
                                             │  (vends scoped, ~1h, tag-tagged creds)
                                             ▼
                          revoke  ─────────► revoked   (next mint refused; TTL kills live token)
                       teardown  ─────────► footprint deleted (stack + tagged + ledger)
```

- **pending** — declared, not yet approved. No creds vend.
- **active** — creds vend on demand.
- **paused** — a hard halt: the poppy's backend is stopped and its credential token killed, so it
  can't act (not even on a cached token). Its deployed AWS resources stay up. One-click reversible.
- **revoked** — permanent. Access dies within the live token's TTL.
- **teardown** — destroys what the poppy built (independent of status).

---

## 5. Credential resolution: connected vs. disconnected

A poppy resolves AWS credentials in this order (MailPoppy:
`apps/desktop/node-sidecar/src/agentspoppyBroker.ts` + `provisioning.ts`):

```
credentials = brokerCredentials()  ??  fromIni({ profile: <poppy's own profile> })
```

| State | What runs | Scope |
|---|---|---|
| **Connected** (connection `active` + broker reachable) | `brokerCredentials()` → the auto-refreshing `@agentspoppy/client` provider | **Tag/name-scoped** — can only touch its own footprint (I1). |
| **Disconnected** (poppy-side `disconnectBroker()` cleared the connection) | falls through to the poppy's **own direct profile** (`~/.aws` `mailpoppy`) | Whatever that IAM user's *own* policies grant. |

**Two distinct "off" actions — do not conflate them:**

- **Disconnect (poppy side).** The poppy clears its cached connection → `brokerCredentials()`
  returns nothing → it falls back to its **own** profile. The poppy works on its own creds again.
- **Revoke / pause (broker side).** The broker stops vending. The poppy's cached connection is
  still "active" from *its* view, so it keeps requesting brokered creds and **fails** — it does
  **not** silently fall back. (This is intentional: if revoking on the broker let the poppy quietly
  resume on its own broader keys, "revoke" would mean nothing — see §6, decision D1.)

### Pre-broker (legacy) resources

A resource created **before** a connection existed has **no** `agentspoppy:app` tag, so
the **brokered** (tag-scoped) creds correctly refuse to manage it — by design, not a bug. Such a
resource is reachable only via the poppy's **own direct profile**, or by **adopting** it
(stamping it with the connection's tags) so it joins the footprint. *(Currently moot for MailPoppy
— it has no pre-broker infrastructure — but it is a permanent rule of the framework.)*

---

## 6. Risk presentation (what the user sees)

The broker rates every grant so the user can scrutinise a poppy honestly
(`packages/core/src/permissions.ts`). Three tiers:

| Colour | Level | Meaning |
|---|---|---|
| 🟢 **green** | `low` | Read-only, **or** confined to its own resources (tag/name) and read-only. |
| 🟡 **amber** | `medium` | Can create/change/delete but **only its own** (tag/name-scoped); **or** can *create new* resources on `*` (additive — can't harm what exists); **or** read-only on `*`. The badge reads **"Its own"** and the copy states it *cannot touch a resource with a different name/tag*. |
| 🔴 **red** | `high` | Can **change or delete existing** resources **beyond its own** (mutating on `*`), or can create an **IAM identity** (privilege escalation). The cardinal sin. |

Key distinctions the model encodes:
- A **wildcard action** (`"*"` or `service:*`) counts as mutating — it can never be mis-rated as
  read-only.
- **Create ≠ destroy.** A pure create on `*` is amber (additive); a delete/modify on `*` is red.
- **Control-plane services** (`iam`, `organizations`, `account`) are red even for "create",
  because creating an identity is escalation.

A correctly-built poppy (everything tag/name-scoped, attribution tags present) rates **amber
overall** and shows **"No risks to other resources identified."**

---

## 7. Supervised mode (optional per-operation approval)

Scoping bounds *what* a poppy can touch (its own footprint). **Supervised mode** adds a second,
optional control over *when* — the user approves each change before it happens, the way an agent
asks before a tool call. It's a per-connection toggle (off by default); the user turns it on for
any poppy they want to keep on a tight leash.

**How it works** (broker `requestCredentials`, client provider, the app's approvals inbox):

- A poppy declares an **operation intent** when it's about to act — a plain-language `summary`
  ("Delete user pool 'acme-users'") plus the exact `grants` the operation needs.
- For a supervised connection, a **mutating** operation (or one with no declared intent) does not
  vend credentials immediately: the broker parks an `ApprovalRequest` and answers the poppy with
  `202 { approvalRequired, approval }`. **Reads stay un-gated** — a read-only declared operation
  vends at once.
- The user sees the pending operation in AgentsPoppy (the approvals inbox, shown above every view,
  with the poppy name + summary) and clicks **Approve** or **Deny**.
- On approve, the poppy's next credential poll vends credentials **narrowed to exactly that
  operation** (the session policy is built from the operation's grants, not the whole permission
  set) — so an approval for "delete pool X" yields creds that can *only* do that. On deny, the
  poll fails with a clear error.

**Two guarantees make this honest, not just a prompt:**
1. **Cred-narrowing** — an approved operation vends only its own grants, short-TTL. The approval
   isn't a blanket "go ahead"; it's scoped to the thing shown.
2. **No widening** — an operation's grants must be a **subset** of the connection's permission set
   (`grantsSubsetOf`); the broker rejects any operation that asks for more. A poppy can't use the
   intent channel to escalate.

A poppy that doesn't declare per-operation intents still works under supervision at **session
granularity**: the first credential need raises one approval ("MailPoppy wants to use its
connection"); approving vends the connection's normal creds for the token's lifetime. MailPoppy's
credential provider speaks this protocol, so toggling supervision on a MailPoppy connection works
today; declaring per-operation intents (so the user sees the specific resource) is the incremental
upgrade for finer-grained prompts.

## 8. The poppy author's checklist

To integrate a new poppy and satisfy this framework:

1. **Declare a `PermissionSet`** mirroring your own IAM policies — specific actions, not `*`.
2. **Scope every mutating-on-existing action** to `TAGGED_AS_SELF` (tag-capable services) or a
   concrete name pattern (others). Reserve `*` for pure creates / no-resource-level services.
3. **Declare all three `requiredTags`** and ensure your CloudFormation stack (or direct creates)
   stamp them, so everything you build is attributable.
4. **Resolve credentials** as `brokerCredentials() ?? fromIni(ownProfile)` and expose a
   **disconnect** that clears the cached connection.
5. **Confirm the rating**: open the connection in AgentsPoppy — it should be amber with no
   beyond-own findings. A red finding means a grant is too broad; tighten it.
6. **Keep the declaration and your real IAM policies in lockstep** (one source, mirrored).
7. **(Optional) declare operation intents** for mutating calls so supervised users get
   per-resource approval prompts (§7) rather than a single session-level one.

---

## 9. Out of scope for v1 (roadmap)

These remain deliberately out of scope. None is required for the v1 loop to be safe — I1–I7, the
scoping matrix (§3), and supervised mode (§7) already bound *and* gate a poppy.

- **Full per-call enforcement proxy.** Supervised mode gates at *credential-vend* time (with
  cred-narrowing), not on every individual API call. A true proxy — AgentsPoppy holding the creds
  and signing/forwarding each request — would let it inspect and approve calls a poppy makes with
  an already-vended token. Bigger architectural change.
- **CloudFormation change-set preview.** A richer supervised prompt for stack ops: show the exact
  resource-level diff (every create/replace/delete + physical IDs) before execute, on top of the
  operation summary.
- **Per-operation intents across all of MailPoppy.** The broker + client support them now; wiring
  every MailPoppy mutation to declare its intent (vs. session-level supervision) is incremental.
- **Spend caps, trusted-apps directory, multi-cloud** (from `ARCHITECTURE.md`).
  *(Caller authentication has since shipped — see §1 and §10 D6 — so it's no longer on this list.)*

---

## 10. Decisions of record

- **D1 — Revoke does not fall back.** When a connection is revoked/paused on the broker side, the
  poppy must **surface the loss of access**, not silently resume on its own broader profile.
  Silent fallback would make "revoke" meaningless. (Disconnect, a poppy-side action, *does* fall
  back — that's the user choosing to go direct.)
- **D2 — Legacy/untagged resources are managed via the direct profile or explicitly adopted**, never
  reachable through brokered creds (§5).
- **D3 — `*` is permitted only for pure creates with no ARN, or services with no resource-level
  permissions.** Every change/delete of an existing resource must be tag- or name-scoped (§3).
- **D4 — Supervised mode is opt-in per connection and gates at vend time with cred-narrowing.**
  An approval authorises exactly the operation shown (not a blanket session), and an operation can
  never request more than its connection grants (§7).
- **D5 — The escalation guardrail lives on the broker role and lands via re-deploy.** Bootstrap
  reconcile re-applies the template on every Deploy, so tightening the guardrail reaches an
  already-bootstrapped account when the user clicks Deploy again.
- **D6 — The broker authenticates its callers; loopback alone is not a trust boundary.** A per-run
  host token gates the management plane (held only by the AgentsPoppy UI); each spawned poppy
  backend gets a per-connection credentials token authorising only its own credential mint. One
  poppy therefore cannot enumerate, revoke, pause, or tear down another (§1).
