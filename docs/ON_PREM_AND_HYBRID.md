# AgentsPoppy — On-premises, hybrid, and other clouds (design note)

> Status: **analysis, not a commitment.** Nothing here is built. It exists to answer a question
> that keeps coming up in customer conversations — *"we still run our own servers, can we use
> this?"* — with something better than a yes or a no, and to record why the obvious answer
> (mirror IAM on-prem) is the wrong first move.

---

## 1. What the guarantee actually rests on

The broker's promise is not "our software is careful". It is **"the platform refuses"**. Three
primitives compose into the self-enforcing attribution loop (see `SECURITY_MECHANISM.md`):

1. **Short-lived credentials** minted per task from the provider's own token service (STS).
2. **A session policy** applied at mint time, narrowing that credential to what was approved.
3. **Transitive session tags** — resources the poppy creates inherit its identity, and the policy
   only permits mutating resources already carrying that tag.

A misbehaving poppy is not stopped by the broker's good manners; the cloud rejects the API call.
That is the whole reason the claim is defensible, and it is what any port has to preserve.

So the question for any target environment is **not** "can we mirror the API surface?" It is:

> **Does this environment have an authorization plane we can push the rule *into*?**

If it does not, the broker must enforce by proxying calls itself. That is a categorically weaker
product and must never share a name with the real thing:

| Mode | Enforcement | If the poppy misbehaves | If our code has a bug |
|---|---|---|---|
| **Platform-enforced** | The provider's own policy engine | Provider refuses | Provider still refuses |
| **Broker-enforced (proxy)** | Our proxy | Proxy refuses — *if it is in the path* | **Total bypass** |

Any on-prem offering must state which mode a customer is getting, in those words.

---

## 2. Target-by-target assessment

### ✅ AWS Outposts / Local Zones — works today, unmodified
Outposts is AWS hardware installed in the customer's own building; Local Zones are AWS-owned
deployments placed near a metro area. In both cases the **control plane stays in the parent
region**: IAM, STS, session policies and tags are identical. Only the data plane is local.

**A poppy provisioning to an Outpost needs no changes at all.** For the customer who says "it must
be in our building", this is the entire answer, and it costs us nothing.

*Caveats to state honestly:* not every AWS service is offered on Outposts (verify current
coverage), and control-plane operations — including credential minting — depend on a healthy link
to the parent region. Running workloads survive a link outage; new mints do not. It is also
expensive and a long procurement, so it is enterprise-only in practice.

### ✅ On-premises Kubernetes / OpenShift — the only faithful port
The one environment with real equivalents of all three primitives:

| Broker primitive | Kubernetes equivalent |
|---|---|
| Short-lived credentials | `TokenRequest` — audience-bound, time-bound ServiceAccount tokens |
| Session policy | RBAC role bound per connection |
| Transitive tags + tag-conditioned mutation | **Labels** + an admission controller (OPA/Gatekeeper, Kyverno) enforcing *"you may only modify objects carrying your own app label"* |

The admission controller is the load-bearing piece: it makes the attribution rule **platform-
enforced**, exactly as the tag condition does in AWS. Teardown by label selector is the direct
analogue of teardown by tag.

**If we ever build an on-prem port, this is the first and possibly only target.**

### ✅ MinIO (and S3-compatible stores) — the storage plane ports directly
MinIO implements S3-compatible STS (`AssumeRole`) and policy conditions, so the storage half of a
poppy can be pointed at it with modest work. Useful as a component of a Kubernetes port rather
than as a product on its own.

### ⚠️ vSphere / Proxmox / Nutanix — proxy only
Roles and tags exist, but there is no session-policy or credential-minting equivalent. We would be
proxying the API and enforcing scope ourselves — **broker-enforced**, with the weaker guarantee
above. Possible; should not be sold as the same product.

### ❌ Bare Linux / Docker with no orchestrator
No API-level authorization plane to hook. Isolation would be OS-level (namespaces, seccomp,
containers) — a different security model, not this one. Out of scope.

---

## 3. Other clouds

Azure and Google are **stronger candidates than on-premises**, because both have the primitives:

| Primitive | AWS | Azure | Google Cloud |
|---|---|---|---|
| Short-lived credentials | STS `AssumeRole` | Entra ID tokens; managed identities | Service-account impersonation / short-lived tokens |
| Narrowing at mint time | Session policy | Scoped tokens; ABAC conditions | **Credential Access Boundaries** (`downscoped tokens`) — a close analogue |
| Attribution + conditioned mutation | Transitive tags + `aws:ResourceTag` | Resource tags + ABAC role conditions | Labels + IAM Conditions/tags |

Google's **credential access boundary** is the closest thing to a session policy outside AWS, and
Azure's ABAC conditions cover the attribution half. Neither is a like-for-like mapping — the
**transitive** property (created resources automatically inheriting the caller's identity) is the
part that needs the most design work on both, and it is also the part the patent turns on. Expect
per-cloud research, not a translation layer.

**Sequencing view:** a second cloud broadens the market more than on-prem does and preserves the
guarantee. On-prem Kubernetes should follow it, not precede it.

---

## 4. The hybrid cases — and why they need almost none of the above

Two scenarios raised repeatedly by prospects:

### (a) On-premises primary, cloud as the contingency plan
**Needs no on-prem work at all.** The cloud side is precisely what a poppy already does well:
provision the standby environment on demand, attributed, and remove it completely afterwards with
proof.

This unlocks something more valuable than the DR environment itself:

> **Disaster-recovery plans are famously never tested**, because standing the environment up is
> expensive, risky, and someone has to be paid to babysit it. A poppy that builds the whole
> environment, proves it works, and then tears it down provably turns an annual paper exercise
> into something a team can run monthly for a few hours of compute — and *"here is the evidence it
> was fully removed"* is exactly the question an auditor asks.

Everything needed for this already exists: provisioning, attribution, certify (leaves-no-trace),
one-click teardown, and the resource inventory. **Recommended as a first-party poppy** (see
`ROADMAP.md` step 9 backlog) — it is arguably a stronger candidate than several already listed,
and requires no new architecture.

### (b) Cloud primary, on-premises as the fallback
This one genuinely needs the on-prem control plane, so it is the expensive direction — and
Outposts already serves the subset of customers who care most. Defer.

---

## 4a. A correction worth recording: multi-admin already works

A recurring internal mis-statement is that AgentsPoppy is "one person, one machine" and therefore
unfit for a company. **That is wrong, and it inverts a genuine selling point.**

The broker holds no state that matters — the infrastructure, the tags and the stack live in the
cloud account. So several administrators each install the app, each connect with **their own**
credentials, and each work on the same infrastructure:

- **Cover during absence:** any colleague with equivalent cloud permissions can act.
- **Handover / leavers:** disable the leaver's cloud access as normal; the successor uses their own.
  Nothing is stranded, because nothing of value lived on the leaver's machine.
- **Work-account sign-in:** already handled where it belongs. Companies using IAM Identity Center
  sign in with their corporate identity at the cloud layer, and the broker reads that credential
  chain directly.

**The selling point:** AgentsPoppy introduces **no second account system**. Whoever administers the
cloud today is already an AgentsPoppy user, and offboarding is unchanged — revoke cloud access and
that desk can mint nothing. Every enterprise tool that invents its own identity silo becomes an
audit problem later; this one does not.

**Central visibility already exists too** — this was also mis-stated internally and is worth nailing
down. `ActivityView` is a filterable timeline of **account-wide CloudTrail management events, read
across regions**, attributed into three buckets: *outside AgentsPoppy · through a poppy · by
AgentsPoppy* (`core/activity.ts::classifyActor` resolves the assumed-role session name back to the
connection). Because the source is the cloud's own audit log rather than a local one, it covers
**every administrator** — and changes made outside AgentsPoppy entirely. `providers.ts` explicitly
handles the multi-admin case (*"users connect with their own IAM user, not the canonical name"*).
Combined with mandatory tagging, the full history is discoverable in the cloud's own logs.

**So before claiming any enterprise gap, check the code.** Access continuity, corporate sign-in
(via IAM Identity Center) and account-wide attributed activity are all present. Anything still
missing should be identified by reading `app/src/views/` and `packages/broker/src/`, not inferred
from the fact that the broker runs locally.

## 5. Recommendation

1. **Say yes to Outposts/Local Zones today.** It is free, it is honest, and it answers the
   residency objection for the enterprise buyers most likely to raise it.
2. **Build the DR/contingency poppy.** Highest value per unit of work of anything in this note;
   needs no new architecture; sells against a pain (untested DR) that every auditor already names.
3. **Second cloud before on-prem.** Azure or GCP preserves the platform-enforced guarantee and
   opens more market than any on-prem stack.
4. **If on-prem, then Kubernetes only** — it is the one place the guarantee survives intact.
5. **Never ship a proxy mode under the same promise.** If vSphere or similar is ever built, label
   it broker-enforced and say plainly what that means.

⚠️ **Ask counsel before writing on-prem or multi-cloud code.** The provisionals are drafted around
cloud primitives (transitive session tags, session policies). A Kubernetes or Azure/GCP variant may
fall outside their scope, and the non-provisional is the moment to decide how wide the claims should
reach. See [[agentspoppy-patent]] notes.
