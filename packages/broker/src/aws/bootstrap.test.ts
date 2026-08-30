// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { readSetupStack, runBootstrap, type BootstrapGateway, type DescribedStack } from "./bootstrap";
import { TEMPLATE_VERSION } from "./role-template";
import type { AwsKeyInput } from "./credentials";

const SETUP: AwsKeyInput = { accessKeyId: "AKIASETUP", secretAccessKey: "setup-secret" };
const ACCOUNT = "123456789012";
const denied = (action: string) =>
  Object.assign(new Error(`User: arn:aws:iam::${ACCOUNT}:user/AgentsPoppyOperator is not authorized to perform: ${action}`), {
    name: "AccessDenied",
  });
const COMPLETE: DescribedStack = {
  status: "CREATE_COMPLETE",
  outputs: { BrokerRoleArn: `arn:aws:iam::${ACCOUNT}:role/AgentsPoppyBroker`, OperatorUserName: "AgentsPoppyOperator" },
};

/**
 * In-memory CFN+IAM the orchestrator drives. `stackTimeline` lets a test feed a
 * sequence of describeStack() answers (one per call) to model an interruption
 * mid-create; once exhausted it sticks on the last value.
 */
function fakeGateway(opts: {
  accountId?: string;
  initialStacks?: (DescribedStack | null)[];
  existingKeyIds?: string[];
  /** Pretend the account-global IAM resources already exist (a prior setup in another region). */
  existingNamed?: { role: boolean; user: boolean };
  /** Who the setup credentials belong to (e.g. the operator user — proof setup already ran). */
  callerArn?: string;
  /** Region the existing setup stack lives in (for the "already set up" message). */
  originRegion?: string | null;
  /** What describeStackInRegion(originRegion) finds there (null = unreadable → no join). */
  originStack?: DescribedStack | null;
  /** Model a key that can't create/update stacks (e.g. the operator/runtime key). */
  denyWrites?: boolean;
  /** Model CloudFormation accepting UpdateStack and then failing ASYNCHRONOUSLY. */
  updateRollsBackTo?: DescribedStack;
  /** What DescribeStackEvents reports for the failure (null = can't read it). */
  failureReason?: string | null;
  /** Model credentials that may not update the stack where it lives (cross-region re-apply). */
  denyOriginUpdate?: boolean;
  /** What the origin stack settles to after a cross-region re-apply. */
  originStackAfterUpdate?: DescribedStack;
  /** Make the freshly-minted key fail verification (never assumable) — mint-then-verify guard. */
  failKeyVerify?: boolean;
} = {}): BootstrapGateway & {
  log: string[];
  created: AwsKeyInput[];
  deletedKeys: string[];
  verified: string[];
} {
  const timeline = [...(opts.initialStacks ?? [null])];
  let current: DescribedStack | null = timeline.shift() ?? null;
  // Creation order = array order (older first), matching IAM's CreateDate semantics.
  let keys = (opts.existingKeyIds ?? []).map((id, i) => ({ accessKeyId: id, createDate: new Date(2020, 0, i + 1) }));
  const log: string[] = [];
  const created: AwsKeyInput[] = [];
  const deletedKeys: string[] = [];
  const verified: string[] = [];
  let keyCounter = 0;
  let originCurrent: DescribedStack | null = opts.originStack ?? null;

  const advance = () => {
    if (timeline.length) current = timeline.shift()!;
  };

  return {
    log,
    created,
    deletedKeys,
    verified,
    async whoAmI() {
      const acct = opts.accountId ?? ACCOUNT;
      return { accountId: acct, arn: opts.callerArn ?? `arn:aws:iam::${acct}:user/admin`, userId: "U" };
    },
    async describeStack() {
      const snapshot = current;
      advance();
      return snapshot;
    },
    async createStack() {
      if (opts.denyWrites) throw denied("cloudformation:CreateStack");
      log.push("createStack");
      current = COMPLETE;
    },
    async updateStack() {
      if (opts.denyWrites) throw denied("cloudformation:UpdateStack");
      log.push("updateStack");
      // The real failure shape: the API call succeeds, then CFN rolls back on its own.
      current = opts.updateRollsBackTo ?? COMPLETE;
    },
    async describeFailureReason() {
      return opts.failureReason ?? null;
    },
    async updateStackInRegion(r: string) {
      if (opts.denyOriginUpdate) throw denied("cloudformation:UpdateStack");
      log.push(`updateStackInRegion:${r}`);
      originCurrent = opts.originStackAfterUpdate ?? originCurrent;
    },
    async deleteStack() {
      log.push("deleteStack");
      current = null;
    },
    async listAccessKeys() {
      return keys;
    },
    async deleteAccessKey(_user, id) {
      deletedKeys.push(id);
      keys = keys.filter((k) => k.accessKeyId !== id);
    },
    async createAccessKey() {
      const k = { accessKeyId: `AKIANEW${keyCounter++}`, secretAccessKey: "fresh-secret" };
      created.push(k);
      keys = [...keys, { accessKeyId: k.accessKeyId, createDate: new Date(2030, 0, keyCounter) }];
      return k;
    },
    async verifyOperatorKey(_roleArn, key) {
      verified.push(key.accessKeyId);
      if (opts.failKeyVerify) throw new Error("InvalidClientTokenId: the security token is invalid");
    },
    async findExistingBrokerResources() {
      return opts.existingNamed ?? { role: false, user: false };
    },
    async findSetupStackRegion() {
      return opts.originRegion ?? null;
    },
    async describeStackInRegion(r) {
      log.push(`describeStackInRegion:${r}`);
      return originCurrent;
    },
  };
}

const noSleep = async () => {};
// Every test opts out of reading the developer's real ~/.aws profile.
const baseOpts = { sleep: noSleep, readLocalKeyId: () => null, recordKey: () => {} };

describe("runBootstrap", () => {
  it("creates the stack, mints a fresh operator key, and writes ONLY that key", async () => {
    const gw = fakeGateway();
    const written: AwsKeyInput[] = [];
    const res = await runBootstrap(gw, { setup: SETUP, region: "eu-west-1", expectedAccountId: ACCOUNT }, {
      ...baseOpts,
      writeProfile: (k) => written.push(k),
    });

    expect(gw.log).toContain("createStack");
    expect(res.brokerRoleArn).toContain(":role/AgentsPoppyBroker");
    expect(res.accountId).toBe(ACCOUNT);
    // only the freshly minted operator key is persisted — never the setup creds
    expect(written).toHaveLength(1);
    expect(written[0]!.accessKeyId).toMatch(/^AKIANEW/);
    expect(written).not.toContainEqual(SETUP);
  });

  it("refuses to deploy into the wrong account", async () => {
    const gw = fakeGateway({ accountId: "999999999999" });
    await expect(
      runBootstrap(gw, { setup: SETUP, region: "eu-west-1", expectedAccountId: ACCOUNT }, { ...baseOpts, writeProfile: () => {} }),
    ).rejects.toThrow(/999999999999/);
    expect(gw.log).not.toContain("createStack"); // bailed before touching anything
  });

  it("redeploys: re-applies the template on an already-complete stack (no recreate)", async () => {
    const gw = fakeGateway({ initialStacks: [COMPLETE] });
    const res = await runBootstrap(gw, { setup: SETUP, region: "eu-west-1" }, { ...baseOpts, writeProfile: () => {} });
    expect(gw.log).not.toContain("createStack");
    // Drift (e.g. a tightened guardrail) lands by re-applying the template, not recreating.
    expect(gw.log).toContain("updateStack");
    expect(res.brokerRoleArn).toContain("AgentsPoppyBroker");
  });

  it("resumes: waits out an in-progress create, then finishes", async () => {
    const gw = fakeGateway({
      initialStacks: [{ status: "CREATE_IN_PROGRESS", outputs: {} }, COMPLETE],
    });
    const res = await runBootstrap(gw, { setup: SETUP, region: "eu-west-1" }, { ...baseOpts, writeProfile: () => {} });
    expect(gw.log).not.toContain("createStack"); // it was already being created
    expect(res.operatorUserName).toBe("AgentsPoppyOperator");
  });

  it("recovers: deletes a rolled-back shell, then recreates", async () => {
    const gw = fakeGateway({
      initialStacks: [{ status: "ROLLBACK_COMPLETE", outputs: {} }],
    });
    const res = await runBootstrap(gw, { setup: SETUP, region: "eu-west-1" }, { ...baseOpts, writeProfile: () => {} });
    expect(gw.log).toEqual(["deleteStack", "createStack"]);
    expect(res.brokerRoleArn).toContain("AgentsPoppyBroker");
  });

  it("refuses to evict another machine's key without explicit consent", async () => {
    // Two keys we can't identify as ours, at IAM's 2-key limit: deleting one may disconnect
    // a live machine, so the run stops and NAMES the key instead of silently retiring it
    // (docs/specs/operator-key-least-privilege.md). Nothing is deleted, nothing minted.
    const gw = fakeGateway({ initialStacks: [COMPLETE], existingKeyIds: ["AKIAOLD1", "AKIAOLD2"] });
    await expect(
      runBootstrap(gw, { setup: SETUP, region: "eu-west-1" }, { ...baseOpts, writeProfile: () => {} }),
    ).rejects.toThrow(/AKIAOLD1/);
    expect(gw.deletedKeys).toEqual([]);
    expect(gw.created).toHaveLength(0);
  });

  it("evicts only the OLDEST key when the operator is at the 2-key limit and eviction is confirmed", async () => {
    // Same state, but the UI confirmed: keep the newer (it may belong to another machine),
    // retire the oldest to free the slot, mint ours.
    const gw = fakeGateway({ initialStacks: [COMPLETE], existingKeyIds: ["AKIAOLD1", "AKIAOLD2"] });
    const res = await runBootstrap(
      gw,
      { setup: SETUP, region: "eu-west-1", allowEviction: true },
      { ...baseOpts, writeProfile: () => {} },
    );
    expect(gw.deletedKeys).toEqual(["AKIAOLD1"]);
    expect(gw.created).toHaveLength(1);
    expect(res.evictedAccessKeyId).toBe("AKIAOLD1");
  });

  it("verifies a freshly-minted key BEFORE writing it, and rolls back on failure", async () => {
    // Mint-then-verify-then-write: a key that can't assume the role must never reach disk
    // (docs/specs/operator-key-least-privilege.md §1).
    const written: AwsKeyInput[] = [];
    const gw = fakeGateway({ initialStacks: [COMPLETE], failKeyVerify: true });
    await expect(
      runBootstrap(gw, { setup: SETUP, region: "eu-west-1" }, { ...baseOpts, writeProfile: (k) => written.push(k) }),
    ).rejects.toThrow(/could not assume the broker role|security token/i);
    expect(gw.verified).toHaveLength(1); // it tried
    expect(written).toHaveLength(0); // …but nothing was written
    expect(gw.deletedKeys).toContain(gw.created[0]!.accessKeyId); // the bad key was cleaned up
  });

  it("keys-first (step 0): switches the key against an existing stack, template best-effort", async () => {
    // A machine standing on a setup key: mint+verify+write the operator key first; the template
    // re-apply is secondary and its failure must NOT undo the key switch.
    const written: AwsKeyInput[] = [];
    const recorded: string[] = [];
    const gw = fakeGateway({ initialStacks: [COMPLETE] });
    const res = await runBootstrap(
      gw,
      { setup: SETUP, region: "eu-west-1", keysFirst: true },
      { ...baseOpts, writeProfile: (k) => written.push(k), recordKey: (id) => recorded.push(id) },
    );
    expect(written).toHaveLength(1);
    expect(recorded).toEqual([res.operatorAccessKeyId]);
    expect(gw.verified).toEqual([res.operatorAccessKeyId!]);
    expect(res.brokerRoleArn).toContain("AgentsPoppyBroker");
  });

  it("keys-first still switches the key when the template re-apply rolls back", async () => {
    // The 0.3.8-recovery population: their stack update rolls back (old access policy), but the
    // key switch is the important half and must complete — the template failure is reported.
    const written: AwsKeyInput[] = [];
    const gw = fakeGateway({
      initialStacks: [COMPLETE],
      updateRollsBackTo: { ...COMPLETE, status: "UPDATE_ROLLBACK_COMPLETE" },
      failureReason: "AgentsPoppyBoundary: not authorized to perform: iam:CreatePolicy",
    });
    const res = await runBootstrap(
      gw,
      { setup: SETUP, region: "eu-west-1", keysFirst: true },
      { ...baseOpts, writeProfile: (k) => written.push(k) },
    );
    expect(written).toHaveLength(1); // the key WAS switched
    expect(res.setupNotUpdated).toBe(true);
    expect(res.setupUpdateError).toMatch(/iam:CreatePolicy|rolled back/i);
  });

  it("replaces only THIS machine's key — another computer's key survives a re-setup", async () => {
    // The Mac holds AKIAMAC; this machine re-runs setup holding AKIAMINE. Only AKIAMINE
    // is replaced — deleting all keys would silently brick the Mac.
    const gw = fakeGateway({ initialStacks: [COMPLETE], existingKeyIds: ["AKIAMAC", "AKIAMINE"] });
    const res = await runBootstrap(gw, { setup: SETUP, region: "eu-west-1" }, {
      ...baseOpts,
      readLocalKeyId: () => "AKIAMINE",
      writeProfile: () => {},
    });
    expect(gw.deletedKeys).toEqual(["AKIAMINE"]);
    expect(gw.created).toHaveLength(1);
    expect(res.evictedAccessKeyId).toBeUndefined();
  });

  it("JOINS a setup that lives in another region: reuses its stack, creates nothing", async () => {
    // Second computer, region on eu-west-1, setup lives in us-east-1 → reuse it and just
    // mint this machine's key. The other machine's key (1 existing) is untouched.
    const written: AwsKeyInput[] = [];
    const gw = fakeGateway({
      initialStacks: [null],
      existingNamed: { role: true, user: true },
      originRegion: "us-east-1",
      originStack: COMPLETE,
      existingKeyIds: ["AKIAMAC"],
    });
    const res = await runBootstrap(gw, { setup: SETUP, region: "eu-west-1" }, {
      ...baseOpts,
      writeProfile: (k) => written.push(k),
    });
    expect(gw.log).toContain("describeStackInRegion:us-east-1");
    expect(gw.log).not.toContain("createStack");
    // Joining re-applies the template WHERE THE STACK LIVES. It used to leave it untouched
    // ("the origin machine owns template upgrades"), which meant a user whose region differed
    // from their stack's had NO in-app path to their own guardrails — and was told the
    // re-apply had succeeded. Nothing new is created either way.
    expect(gw.log).toContain("updateStackInRegion:us-east-1");
    expect(res.setupNotUpdated).toBeUndefined();
    expect(res.joinedExistingSetupIn).toBe("us-east-1");
    expect(res.brokerRoleArn).toContain("AgentsPoppyBroker");
    expect(gw.deletedKeys).toEqual([]); // the Mac's key survives
    expect(written).toHaveLength(1);
  });

  it("explains the cross-region collision when the JOIN can't read the origin stack", async () => {
    // Role + user exist and we know the origin region, but describeStackInRegion finds nothing
    // readable there (e.g. the pasted creds can't read CFN in us-east-1) → guidance, no create.
    const gw = fakeGateway({
      initialStacks: [null],
      existingNamed: { role: true, user: true },
      originRegion: "us-east-1",
      originStack: null,
    });
    await expect(
      runBootstrap(gw, { setup: SETUP, region: "eu-west-1" }, { ...baseOpts, writeProfile: () => {} }),
    ).rejects.toThrow(/already set up.*lives in us-east-1.*couldn.t read it in us-east-1/is);
    expect(gw.log).toContain("describeStackInRegion:us-east-1"); // the join WAS attempted
    expect(gw.log).not.toContain("createStack"); // never attempted the create we know would fail
  });

  it("still gives clear guidance when the origin region can't be found", async () => {
    const gw = fakeGateway({ initialStacks: [null], existingNamed: { role: true, user: true }, originRegion: null });
    await expect(
      runBootstrap(gw, { setup: SETUP, region: "eu-west-1" }, { ...baseOpts, writeProfile: () => {} }),
    ).rejects.toThrow(/already set up in this account.*in another region/is);
  });

  it("still creates when the names are free (no false positive)", async () => {
    const gw = fakeGateway({ initialStacks: [null], existingNamed: { role: false, user: false } });
    await runBootstrap(gw, { setup: SETUP, region: "eu-west-1" }, { ...baseOpts, writeProfile: () => {} });
    expect(gw.log).toContain("createStack");
  });

  // The re-apply-denied message used to be a flat "there's nothing to set up". That is true
  // for someone re-running setup out of caution and FALSE for someone who followed the
  // "your broker role is out of date" banner here — they were reassured while nothing
  // changed. The answer now depends on the deployed version, because that's the question.
  it("tells a user whose setup is STALE what the re-apply actually needs", async () => {
    const gw = fakeGateway({
      initialStacks: [COMPLETE], // no TemplateVersion output → pre-v2 → outdated
      callerArn: `arn:aws:iam::${ACCOUNT}:user/AgentsPoppyOperator`,
      denyWrites: true,
      originRegion: "us-east-1",
    });
    const err = await runBootstrap(
      gw,
      { setup: SETUP, region: "us-east-1" },
      { ...baseOpts, writeProfile: () => {} },
    ).catch((e: Error) => e);
    expect(err.message).toMatch(/needs updating/i);
    expect(err.message).toMatch(/version 1/);
    expect(err.message).toMatch(/admin keys|access policy/i);
    // The old, reassuring translation must NOT come back.
    expect(err.message).not.toMatch(/nothing to set up/i);
  });

  it("still says 'nothing to set up' when the deployed setup is actually current", async () => {
    const gw = fakeGateway({
      initialStacks: [{ ...COMPLETE, outputs: { ...COMPLETE.outputs, TemplateVersion: String(TEMPLATE_VERSION) } }],
      callerArn: `arn:aws:iam::${ACCOUNT}:user/AgentsPoppyOperator`,
      denyWrites: true,
      originRegion: "us-east-1",
    });
    await expect(
      runBootstrap(gw, { setup: SETUP, region: "us-east-1" }, { ...baseOpts, writeProfile: () => {} }),
    ).rejects.toThrow(/already set up in us-east-1 and up to date.*nothing to set up/is);
  });

  it("explains it (no raw AccessDenied) when run with the operator key, which can't read IAM", async () => {
    // Signed in AS AgentsPoppyOperator → proof setup already ran, even though this key can't probe
    // IAM or CreateStack. Must give the friendly guidance, not attempt the doomed create.
    const gw = fakeGateway({
      initialStacks: [null],
      callerArn: `arn:aws:iam::${ACCOUNT}:user/AgentsPoppyOperator`,
      existingNamed: { role: false, user: false }, // probe would say "free" — identity must win
    });
    await expect(
      runBootstrap(gw, { setup: SETUP, region: "eu-west-1" }, { ...baseOpts, writeProfile: () => {} }),
    ).rejects.toThrow(/already set up in this account/i);
    expect(gw.log).not.toContain("createStack");
  });
});

// The staleness read. Its whole job is to be honest about which of four situations it is
// in, because three of them look identical from the outside ("no version came back").
describe("readSetupStack", () => {
  it("returns the outputs of a complete stack in this region", async () => {
    const gw = fakeGateway({ initialStacks: [COMPLETE] });
    await expect(readSetupStack(gw, "eu-west-1")).resolves.toEqual({ ok: true, outputs: COMPLETE.outputs });
  });

  it("reports a stack that is mid-deploy as pending, not as stale", async () => {
    const gw = fakeGateway({ initialStacks: [{ status: "UPDATE_IN_PROGRESS", outputs: {} }] });
    await expect(readSetupStack(gw, "eu-west-1")).resolves.toEqual({ ok: false, kind: "pending" });
  });

  it("reports a genuinely missing stack as absent, so it never nags", async () => {
    const gw = fakeGateway({ initialStacks: [null], originRegion: null });
    await expect(readSetupStack(gw, "eu-west-1")).resolves.toEqual({ ok: false, kind: "absent" });
  });

  // Setup is account-global but its stack is regional: "not here" is not "not set up".
  it("finds the stack when it lives in another region", async () => {
    const gw = fakeGateway({ initialStacks: [null], originRegion: "us-east-1", originStack: COMPLETE });
    await expect(readSetupStack(gw, "eu-west-1")).resolves.toEqual({ ok: true, outputs: COMPLETE.outputs });
  });

  // Fail safe, and in plain words — the reason is shown to the user verbatim.
  it("reports a denied read as unreadable, never as absent", async () => {
    const gw = fakeGateway({ initialStacks: [COMPLETE] });
    gw.describeStack = async () => {
      throw denied("cloudformation:DescribeStacks");
    };
    const r = await readSetupStack(gw, "eu-west-1");
    expect(r).toEqual({ ok: false, kind: "unreadable", reason: expect.stringContaining("aren't allowed to read") });
  });

  it("ignores a deleted shell rather than reading its stale outputs", async () => {
    const gw = fakeGateway({ initialStacks: [{ status: "DELETE_COMPLETE", outputs: COMPLETE.outputs }], originRegion: null });
    await expect(readSetupStack(gw, "eu-west-1")).resolves.toEqual({ ok: false, kind: "absent" });
  });
});

// The population this whole change is aimed at: users who followed the least-privilege
// advice. Their ATTACHED IAM policy predates the boundary, so `iam:CreatePolicy` is missing —
// but `cloudformation:UpdateStack` IS granted, so the API call succeeds and CloudFormation
// fails asynchronously. UPDATE_ROLLBACK_COMPLETE lives in COMPLETE (a fine state to FIND a
// stack in), which used to make a failed update resolve as success: "updated" → still v1 →
// banner returns → forever, with the real cause never surfaced.
describe("a re-apply that CloudFormation rolls back", () => {
  const ROLLED_BACK: DescribedStack = { status: "UPDATE_ROLLBACK_COMPLETE", outputs: COMPLETE.outputs };

  it("fails loudly instead of reporting a successful setup", async () => {
    const gw = fakeGateway({ initialStacks: [COMPLETE], updateRollsBackTo: ROLLED_BACK });
    await expect(
      runBootstrap(gw, { setup: SETUP, region: "eu-west-1" }, { ...baseOpts, writeProfile: () => {} }),
    ).rejects.toThrow(/rolled back.*nothing changed/is);
  });

  it("names the missing permission, so the user can actually fix it", async () => {
    const gw = fakeGateway({
      initialStacks: [COMPLETE],
      updateRollsBackTo: ROLLED_BACK,
      failureReason: "AgentsPoppyBoundary: API: iam:CreatePolicy User is not authorized to perform: iam:CreatePolicy",
    });
    const err = await runBootstrap(
      gw,
      { setup: SETUP, region: "eu-west-1" },
      { ...baseOpts, writeProfile: () => {} },
    ).catch((e: Error) => e);
    expect(err.message).toContain("iam:CreatePolicy");
    expect(err.message).toMatch(/access policy/i); // the actual remedy, not just the symptom
  });

  // Fail safe: an unreadable event log must still produce actionable guidance, because the
  // likeliest cause is known even when the specific reason is not.
  it("still names the likeliest cause when the failure reason can't be read", async () => {
    const gw = fakeGateway({ initialStacks: [COMPLETE], updateRollsBackTo: ROLLED_BACK, failureReason: null });
    const err = await runBootstrap(
      gw,
      { setup: SETUP, region: "eu-west-1" },
      { ...baseOpts, writeProfile: () => {} },
    ).catch((e: Error) => e);
    expect(err.message).toContain("iam:CreatePolicy");
    expect(err.message).toContain("AgentsPoppyBoundary");
  });

  // It must stay a legitimate state to FIND a stack in — only the verdict on an update we
  // just started counts as failure.
  it("still accepts a previously rolled-back stack as a usable starting point", async () => {
    const gw = fakeGateway({ initialStacks: [ROLLED_BACK] });
    const r = await runBootstrap(gw, { setup: SETUP, region: "eu-west-1" }, { ...baseOpts, writeProfile: () => {} });
    expect(r.brokerRoleArn).toContain("AgentsPoppyBroker");
    expect(gw.log).toContain("updateStack");
  });
});

// The state the staleness banner sends people into when their configured region isn't the
// region their setup stack lives in — reachable via the region switcher, or by a second
// machine choosing a different region at setup. "Update setup" used to join the existing
// stack, apply nothing, and report success, so the banner re-fired forever and no path
// through the app could ever update those guardrails.
describe("re-applying when the setup stack lives in another region", () => {
  const V1: DescribedStack = { status: "UPDATE_COMPLETE", outputs: COMPLETE.outputs };
  const V2: DescribedStack = {
    status: "UPDATE_COMPLETE",
    outputs: { ...COMPLETE.outputs, TemplateVersion: String(TEMPLATE_VERSION) },
  };

  const join = (over: Parameters<typeof fakeGateway>[0] = {}) =>
    fakeGateway({
      initialStacks: [null],
      existingNamed: { role: true, user: true },
      originRegion: "us-east-1",
      originStack: V1,
      ...over,
    });

  it("applies the template where the stack actually is", async () => {
    const gw = join({ originStackAfterUpdate: V2 });
    const res = await runBootstrap(gw, { setup: SETUP, region: "eu-west-1" }, { ...baseOpts, writeProfile: () => {} });
    expect(gw.log).toContain("updateStackInRegion:us-east-1");
    expect(res.joinedExistingSetupIn).toBe("us-east-1");
    expect(res.setupNotUpdated).toBeUndefined(); // it really was updated
  });

  // A second computer whose credentials can't update the stack still needs its own operator
  // key, so this degrades rather than blocking — but it must NOT read as a successful update.
  it("still connects the machine when it may not update, and says nothing was applied", async () => {
    const gw = join({ denyOriginUpdate: true });
    const res = await runBootstrap(gw, { setup: SETUP, region: "eu-west-1" }, { ...baseOpts, writeProfile: () => {} });
    expect(res.brokerRoleArn).toContain("AgentsPoppyBroker");
    expect(res.setupNotUpdated).toBe(true);
  });

  // A poll that never settles must not silently resolve to the PRE-update stack — that is
  // "success by default" for an update whose outcome we never learned.
  it("times out loudly rather than reporting the old template as the outcome", async () => {
    const gw = join({ originStackAfterUpdate: { status: "UPDATE_IN_PROGRESS", outputs: V1.outputs } });
    await expect(
      runBootstrap(gw, { setup: SETUP, region: "eu-west-1" }, { ...baseOpts, writeProfile: () => {} }),
    ).rejects.toThrow(/timed out waiting for the setup stack in us-east-1/i);
  });

  it("reports a cross-region update that rolled back, rather than resolving", async () => {
    const gw = join({
      originStackAfterUpdate: { status: "UPDATE_ROLLBACK_COMPLETE", outputs: COMPLETE.outputs },
      failureReason: "AgentsPoppyBoundary: not authorized to perform: iam:CreatePolicy",
    });
    await expect(
      runBootstrap(gw, { setup: SETUP, region: "eu-west-1" }, { ...baseOpts, writeProfile: () => {} }),
    ).rejects.toThrow(/rolled back/i);
  });
});

// The 2026-08-28 field report: a successful re-apply came back with the user DISCONNECTED,
// because the update path ran onboarding's key reconciliation afterwards — minted a fresh
// operator key, overwrote the machine's working profile with it (a just-minted IAM key takes
// seconds to go live), and evicted the oldest key, potentially breaking another machine.
describe("update-only runs touch the stack and nothing else", () => {
  it("updates without minting, deleting, or writing any credential", async () => {
    const written: AwsKeyInput[] = [];
    const gw = fakeGateway({ initialStacks: [COMPLETE], existingKeyIds: ["AKIAOLD1", "AKIAOLD2"] });
    const res = await runBootstrap(
      gw,
      { setup: SETUP, region: "eu-west-1", updateOnly: true },
      { ...baseOpts, writeProfile: (k) => written.push(k) },
    );
    expect(gw.log).toContain("updateStack");
    expect(res.brokerRoleArn).toContain("AgentsPoppyBroker");
    expect(res.operatorAccessKeyId).toBeUndefined();
    expect(gw.created).toHaveLength(0); // no key minted
    expect(gw.deletedKeys).toEqual([]); // nothing evicted
    expect(written).toHaveLength(0); // the machine's stored credential is untouched
  });

  // The one legitimate exception: the stack had to be CREATED, so the operator user is brand
  // new and a key genuinely must be minted or the machine ends up with a dead credential.
  it("still mints when the run had to create the stack", async () => {
    const written: AwsKeyInput[] = [];
    const gw = fakeGateway({ initialStacks: [null], existingNamed: { role: false, user: false } });
    const res = await runBootstrap(
      gw,
      { setup: SETUP, region: "eu-west-1", updateOnly: true },
      { ...baseOpts, writeProfile: (k) => written.push(k) },
    );
    expect(gw.log).toContain("createStack");
    expect(res.operatorAccessKeyId).toBeTruthy();
    expect(written).toHaveLength(1);
  });

  it("skips the key phase on a cross-region re-apply too", async () => {
    const gw = fakeGateway({
      initialStacks: [null],
      existingNamed: { role: true, user: true },
      originRegion: "us-east-1",
      originStack: COMPLETE,
      existingKeyIds: ["AKIAMAC"],
    });
    const written: AwsKeyInput[] = [];
    const res = await runBootstrap(
      gw,
      { setup: SETUP, region: "eu-west-1", updateOnly: true },
      { ...baseOpts, writeProfile: (k) => written.push(k) },
    );
    expect(gw.log).toContain("updateStackInRegion:us-east-1");
    expect(res.joinedExistingSetupIn).toBe("us-east-1");
    expect(written).toHaveLength(0);
    expect(gw.deletedKeys).toEqual([]);
  });
});
