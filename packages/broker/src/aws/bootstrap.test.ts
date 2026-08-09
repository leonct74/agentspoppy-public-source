// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { runBootstrap, type BootstrapGateway, type DescribedStack } from "./bootstrap";
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
} = {}): BootstrapGateway & { log: string[]; created: AwsKeyInput[]; deletedKeys: string[] } {
  const timeline = [...(opts.initialStacks ?? [null])];
  let current: DescribedStack | null = timeline.shift() ?? null;
  // Creation order = array order (older first), matching IAM's CreateDate semantics.
  let keys = (opts.existingKeyIds ?? []).map((id, i) => ({ accessKeyId: id, createDate: new Date(2020, 0, i + 1) }));
  const log: string[] = [];
  const created: AwsKeyInput[] = [];
  const deletedKeys: string[] = [];
  let keyCounter = 0;

  const advance = () => {
    if (timeline.length) current = timeline.shift()!;
  };

  return {
    log,
    created,
    deletedKeys,
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
      current = COMPLETE;
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
      return k;
    },
    async findExistingBrokerResources() {
      return opts.existingNamed ?? { role: false, user: false };
    },
    async findSetupStackRegion() {
      return opts.originRegion ?? null;
    },
    async describeStackInRegion(r) {
      log.push(`describeStackInRegion:${r}`);
      return opts.originStack ?? null;
    },
  };
}

const noSleep = async () => {};
// Every test opts out of reading the developer's real ~/.aws profile.
const baseOpts = { sleep: noSleep, readLocalKeyId: () => null };

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

  it("evicts only the OLDEST key when the operator is at IAM's 2-key limit", async () => {
    // Two keys we can't identify as ours (no local profile): keep the newer (it may belong to
    // another machine), retire the oldest to free the slot, mint ours.
    const gw = fakeGateway({ initialStacks: [COMPLETE], existingKeyIds: ["AKIAOLD1", "AKIAOLD2"] });
    const res = await runBootstrap(gw, { setup: SETUP, region: "eu-west-1" }, { ...baseOpts, writeProfile: () => {} });
    expect(gw.deletedKeys).toEqual(["AKIAOLD1"]);
    expect(gw.created).toHaveLength(1);
    expect(res.evictedAccessKeyId).toBe("AKIAOLD1");
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
    expect(gw.log).not.toContain("updateStack"); // the origin machine owns template upgrades
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

  it("explains (no raw AccessDenied) when setup re-runs where the stack already exists but the key can't update it", async () => {
    // The user switched to us-east-1 (where the setup already lives) and pressed Deploy. The
    // operator key can't UpdateStack — but it's already set up here, so say that plainly.
    const gw = fakeGateway({
      initialStacks: [COMPLETE],
      callerArn: `arn:aws:iam::${ACCOUNT}:user/AgentsPoppyOperator`,
      denyWrites: true,
      originRegion: "us-east-1",
    });
    await expect(
      runBootstrap(gw, { setup: SETUP, region: "us-east-1" }, { ...baseOpts, writeProfile: () => {} }),
    ).rejects.toThrow(/already set up and running in us-east-1.*don't need to run setup/is);
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
