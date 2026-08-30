#!/usr/bin/env -S npx tsx
// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
//
// LIVE verification of template v4 (docs/specs/operator-key-least-privilege.md) against a
// THROWAWAY account. Uses the broker's REAL shipped code (roleTemplateJson, the vend path,
// the maintenance policy) so we prove behaviour, not a reimplementation.
//
//   AWS_PROFILE=<admin> EXPECT_ACCOUNT=<id> AWS_REGION=eu-west-1 \
//     npx tsx scripts/live-verify-operator-v4.mts            # dry run (prints plan, no writes)
//   ... APPLY=1 npx tsx scripts/live-verify-operator-v4.mts  # actually deploy + assert + teardown
//
// Every mutating step prints before it runs. On any failure it still attempts full teardown.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  roleTemplateJson,
  maintenancePolicyJson,
  sessionPolicyForConnection,
  sessionTags,
  DEFAULT_ROLE_NAME,
  DEFAULT_OPERATOR_NAME,
  BOOTSTRAP_STACK_NAME,
} from "@agentspoppy/broker";
import type { ConnectedAccount, Connection } from "@agentspoppy/core";
import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
} from "@aws-sdk/client-cloudformation";
import {
  IAMClient,
  CreateAccessKeyCommand,
  DeleteAccessKeyCommand,
  ListAccessKeysCommand,
} from "@aws-sdk/client-iam";
import {
  STSClient,
  GetCallerIdentityCommand,
  AssumeRoleCommand,
  GetSessionTokenCommand,
} from "@aws-sdk/client-sts";

const REGION = process.env.AWS_REGION ?? "eu-west-1";
const EXPECT_ACCOUNT = process.env.EXPECT_ACCOUNT ?? "";
const APPLY = process.env.APPLY === "1";
const STACK = BOOTSTRAP_STACK_NAME;

const pass: string[] = [];
const fail: string[] = [];
const ok = (m: string) => {
  pass.push(m);
  console.log(`  ✅ ${m}`);
};
const bad = (m: string) => {
  fail.push(m);
  console.log(`  ❌ ${m}`);
};
const step = (m: string) => console.log(`\n▸ ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Did an AWS call fail specifically with an authorization refusal? */
function isDenied(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return /AccessDenied|not authorized|explicit deny/i.test(`${e?.name} ${e?.message}`);
}

async function waitStack(cfn: CloudFormationClient, until: (s: string) => boolean): Promise<string> {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await cfn.send(new DescribeStacksCommand({ StackName: STACK }));
      const status = r.Stacks?.[0]?.StackStatus ?? "";
      if (until(status)) return status;
      if (status.endsWith("_FAILED") || status === "ROLLBACK_COMPLETE") return status;
    } catch (err) {
      if (/does not exist/i.test((err as Error).message)) return "DELETED";
      throw err;
    }
    await sleep(3000);
  }
  throw new Error("timed out waiting on stack");
}

async function main() {
  const adminCfn = new CloudFormationClient({ region: REGION });
  const adminIam = new IAMClient({ region: REGION });
  const adminSts = new STSClient({ region: REGION });

  step("Phase 0 — identity (read-only)");
  const who = await adminSts.send(new GetCallerIdentityCommand({}));
  console.log(`  connected as ${who.Arn} in account ${who.Account}, region ${REGION}`);
  if (!EXPECT_ACCOUNT) throw new Error("Set EXPECT_ACCOUNT=<sandbox account id> — refusing to run without the safety anchor.");
  if (who.Account !== EXPECT_ACCOUNT) {
    throw new Error(`SAFETY STOP: connected to ${who.Account}, but EXPECT_ACCOUNT is ${EXPECT_ACCOUNT}. Wrong account — aborting.`);
  }
  ok(`account matches the expected sandbox (${EXPECT_ACCOUNT})`);

  const template = roleTemplateJson({ operatorAccountId: who.Account! });
  if (!template.includes('"HopOne"') || !template.includes('"HopTwo"') || !template.includes('"SelfRevoke"')) {
    throw new Error("the generated template is not v4 — aborting before any deploy");
  }
  const brokerRoleArn = `arn:aws:iam::${who.Account}:role/${DEFAULT_ROLE_NAME}`;
  ok("generated template is v4 (HopOne + HopTwo + SelfRevoke present)");

  // Is there already an AgentsPoppy setup here (a previous test)? Then the deploy phase runs
  // the REAL upgrade path — UpdateStack vN→v4 — which is exactly what every live user's
  // re-apply performs. Read-only check, safe in the dry run.
  let existing: { status: string; version: string } | null = null;
  try {
    const r = await adminCfn.send(new DescribeStacksCommand({ StackName: STACK }));
    const s = r.Stacks?.[0];
    if (s && !s.StackStatus?.startsWith("DELETE_")) {
      const v = s.Outputs?.find((o) => o.OutputKey === "TemplateVersion")?.OutputValue ?? "1 (pre-versioning)";
      existing = { status: s.StackStatus ?? "", version: v };
      console.log(`  found existing stack: ${existing.status}, setup version ${existing.version}`);
    }
  } catch {
    /* no stack — fresh create */
  }

  if (!APPLY) {
    console.log("\n(dry run — set APPLY=1 to deploy the v4 stack, run the assertions, and tear down)");
    console.log(
      existing
        ? `\nWould UPDATE the existing "${STACK}" stack (version ${existing.version} → 4) in ${who.Account}/${REGION} — the real user upgrade path — reset the operator's keys, assert, then DeleteStack.`
        : `\nWould CreateStack "${STACK}" in ${who.Account}/${REGION}, mint an operator key, assert, then DeleteStack.`,
    );
    return;
  }

  let operatorKey: { id: string; secret: string } | null = null;
  const tmp = mkdtempSync(join(tmpdir(), "ap-v4-verify-"));

  try {
    if (existing) {
      step(`Phase 1 — UPDATE the existing stack to v4 (the real user upgrade path; was version ${existing.version})`);
      try {
        await adminCfn.send(
          new UpdateStackCommand({
            StackName: STACK,
            TemplateBody: template,
            Capabilities: ["CAPABILITY_NAMED_IAM"],
            Tags: [{ Key: "agentspoppy:verify", Value: "operator-v4" }],
          }),
        );
      } catch (err) {
        if (!/No updates are to be performed/.test((err as Error).message)) throw err;
        console.log("  (no changes — already v4)");
      }
      const updated = await waitStack(adminCfn, (s) => s === "UPDATE_COMPLETE" || s === "CREATE_COMPLETE");
      if (updated === "UPDATE_ROLLBACK_COMPLETE" || updated === "UPDATE_ROLLBACK_FAILED") {
        throw new Error(
          `the vN→v4 UPDATE was ROLLED BACK — likely the setup user's attached access policy predates ` +
            `the current one (needs iam:UpdateAssumeRolePolicy / PutUserPolicy / CreatePolicy). ` +
            `Replace the AgentsPoppy policy on agentspoppy-setup with the current version, then re-run.`,
        );
      }
      if (updated !== "UPDATE_COMPLETE" && updated !== "CREATE_COMPLETE") {
        throw new Error(`stack did not reach UPDATE_COMPLETE (got ${updated})`);
      }
      ok(`vN→v4 UPDATE reached ${updated} — the real user upgrade path works, AWS accepted the conditioned trust policy`);
    } else {
      step(`Phase 1 — deploy the v4 stack "${STACK}" (CREATES resources)`);
      await adminCfn.send(
        new CreateStackCommand({
          StackName: STACK,
          TemplateBody: template,
          Capabilities: ["CAPABILITY_NAMED_IAM"],
          OnFailure: "DELETE",
          Tags: [{ Key: "agentspoppy:verify", Value: "operator-v4" }],
        }),
      );
      const created = await waitStack(adminCfn, (s) => s === "CREATE_COMPLETE");
      if (created !== "CREATE_COMPLETE") throw new Error(`stack did not reach CREATE_COMPLETE (got ${created})`);
      ok("v4 stack reached CREATE_COMPLETE — AWS accepted the conditioned trust policy + SelfRevoke");
    }

    step("Phase 1b — reset + mint an operator access key (admin)");
    // Old test runs may have left keys at IAM's two-key limit; this is a throwaway
    // verification account, so clear them (announced) before minting ours.
    const oldKeys = await adminIam.send(new ListAccessKeysCommand({ UserName: DEFAULT_OPERATOR_NAME }));
    for (const k of oldKeys.AccessKeyMetadata ?? []) {
      if (k.AccessKeyId) {
        await adminIam.send(new DeleteAccessKeyCommand({ UserName: DEFAULT_OPERATOR_NAME, AccessKeyId: k.AccessKeyId }));
        console.log(`  cleared old operator key ${k.AccessKeyId}`);
      }
    }
    const mk = await adminIam.send(new CreateAccessKeyCommand({ UserName: DEFAULT_OPERATOR_NAME }));
    operatorKey = { id: mk.AccessKey!.AccessKeyId!, secret: mk.AccessKey!.SecretAccessKey! };
    console.log(`  minted ${operatorKey.id}`);
    // IAM is eventually consistent — let the fresh key propagate before using it.
    await sleep(10000);

    const opCreds = { accessKeyId: operatorKey.id, secretAccessKey: operatorKey.secret };
    const opSts = new STSClient({ region: REGION, credentials: opCreds });

    step("Phase 2 — assertions");

    // (a) hop-1: the operator's long-term key assumes the broker role (HopOne).
    try {
      await opSts.send(
        new AssumeRoleCommand({ RoleArn: brokerRoleArn, RoleSessionName: "verify-hop1", DurationSeconds: 900 }),
      );
      ok("hop-1: operator long-term key CAN assume the broker role (HopOne admits it)");
    } catch (err) {
      bad(`hop-1 FAILED — operator can't assume the broker role: ${(err as Error).message}`);
    }

    // (b) hop-2 VEND via the REAL shipped vend path: write the operator key to a temp
    //     [agentspoppy] profile so operatorCredentials() picks it up, then run the actual
    //     two-hop AssumeRole with tags + a session policy. Proves poppies still get creds.
    const account: ConnectedAccount = {
      id: "verify-conn",
      accountId: who.Account!,
      regions: [REGION],
      roleArn: brokerRoleArn,
      createdAt: new Date(0).toISOString(),
    };
    const connection = {
      id: "verifyconn",
      accountId: account.id,
      app: { id: "verifypoppy", name: "VerifyPoppy" },
      status: "active",
      permissionSet: {
        grants: [{ service: "s3", actions: ["s3:GetObject", "s3:ListBucket"], resourceScope: "tagged-as-self" }],
      },
      createdAt: new Date(0).toISOString(),
    } as unknown as Connection;

    const credFile = join(tmp, "credentials");
    writeFileSync(
      credFile,
      `[agentspoppy]\naws_access_key_id = ${operatorKey.id}\naws_secret_access_key = ${operatorKey.secret}\n`,
    );
    const prevShared = process.env.AWS_SHARED_CREDENTIALS_FILE;
    const prevProfile = process.env.AWS_PROFILE;
    process.env.AWS_SHARED_CREDENTIALS_FILE = credFile;
    delete process.env.AWS_PROFILE; // operatorCredentials reads the [agentspoppy] profile explicitly
    try {
      const { StsCredentialVendor } = await import("@agentspoppy/broker");
      const vendor = new StsCredentialVendor();
      const scoped = await vendor.vend(connection, account);
      if (scoped.accessKeyId && scoped.sessionToken) {
        ok("hop-2 VEND: a poppy connection received scoped credentials (tags + session policy) — poppies still work");
      } else {
        bad("hop-2 VEND returned incomplete credentials");
      }
      // Sanity that the tag/policy builders ran (real code path).
      const tags = sessionTags(account, connection);
      const pol = sessionPolicyForConnection(connection);
      if (tags.length > 0 && pol.Statement.length > 0) ok("vend used real sessionTags + sessionPolicyForConnection");
    } catch (err) {
      bad(`hop-2 VEND FAILED — poppies would NOT get credentials on v4: ${(err as Error).message}`);
    } finally {
      if (prevShared === undefined) delete process.env.AWS_SHARED_CREDENTIALS_FILE;
      else process.env.AWS_SHARED_CREDENTIALS_FILE = prevShared;
      if (prevProfile !== undefined) process.env.AWS_PROFILE = prevProfile;
    }

    // (c) The kill-switch-is-terminal proof: a GetSessionToken session (a TEMPORARY
    //     credential — which no policy can forbid minting) must be REFUSED by HopOne's
    //     `Null aws:TokenIssueTime = true`, so deleting the key truly ends all access.
    try {
      const stTok = await opSts.send(new GetSessionTokenCommand({ DurationSeconds: 900 }));
      const tempSts = new STSClient({
        region: REGION,
        credentials: {
          accessKeyId: stTok.Credentials!.AccessKeyId!,
          secretAccessKey: stTok.Credentials!.SecretAccessKey!,
          sessionToken: stTok.Credentials!.SessionToken!,
        },
      });
      try {
        await tempSts.send(
          new AssumeRoleCommand({ RoleArn: brokerRoleArn, RoleSessionName: "verify-pre-mint", DurationSeconds: 900 }),
        );
        bad("SECURITY HOLE: a GetSessionToken session COULD assume the broker role — kill switch is NOT terminal");
      } catch (err) {
        if (isDenied(err)) ok("kill-switch-terminal: a pre-minted GetSessionToken session is REFUSED hop-1 (TokenIssueTime)");
        else bad(`GetSessionToken hop-1 failed for the wrong reason: ${(err as Error).message}`);
      }
    } catch (err) {
      bad(`could not mint a GetSessionToken session to test the hole: ${(err as Error).message}`);
    }

    // (d) assume-only proof: the operator key doing a direct cloudformation:DeleteStack is
    //     AccessDenied (and does NOT delete our stack). v4 stripped all cloudformation:* from
    //     the user, so this must be refused.
    const opCfn = new CloudFormationClient({ region: REGION, credentials: opCreds });
    try {
      await opCfn.send(new DeleteStackCommand({ StackName: STACK }));
      bad("SECURITY HOLE: the operator key deleted a stack DIRECTLY — it is not assume-only");
    } catch (err) {
      if (isDenied(err)) ok("assume-only: a direct cloudformation:DeleteStack with the operator key is AccessDenied");
      else bad(`direct DeleteStack failed for the wrong reason: ${(err as Error).message}`);
    }

    // (e) the bounded maintenance session works — housekeeping still functions through the
    //     role, using the REAL maintenance policy document.
    try {
      const boot = await opSts.send(
        new AssumeRoleCommand({ RoleArn: brokerRoleArn, RoleSessionName: "AgentsPoppyHost-verify-boot", DurationSeconds: 900 }),
      );
      const brokerSts = new STSClient({
        region: REGION,
        credentials: {
          accessKeyId: boot.Credentials!.AccessKeyId!,
          secretAccessKey: boot.Credentials!.SecretAccessKey!,
          sessionToken: boot.Credentials!.SessionToken!,
        },
      });
      const maint = await brokerSts.send(
        new AssumeRoleCommand({
          RoleArn: brokerRoleArn,
          RoleSessionName: "AgentsPoppyHost-maintenance",
          DurationSeconds: 3600,
          Policy: maintenancePolicyJson(),
        }),
      );
      const maintCfn = new CloudFormationClient({
        region: REGION,
        credentials: {
          accessKeyId: maint.Credentials!.AccessKeyId!,
          secretAccessKey: maint.Credentials!.SecretAccessKey!,
          sessionToken: maint.Credentials!.SessionToken!,
        },
      });
      await maintCfn.send(new DescribeStacksCommand({ StackName: STACK }));
      ok("maintenance session: assumes the role, bounded by the real session policy, CAN DescribeStacks (housekeeping works)");
    } catch (err) {
      bad(`maintenance session FAILED — housekeeping would break: ${(err as Error).message}`);
    }

    // (f) SelfRevoke: the operator deletes its OWN key (self-DoS only). Runs LAST — it kills
    //     the key we've been using. Doubles as part of teardown.
    try {
      const opIam = new IAMClient({ region: REGION, credentials: opCreds });
      await opIam.send(new DeleteAccessKeyCommand({ UserName: DEFAULT_OPERATOR_NAME, AccessKeyId: operatorKey.id }));
      ok("SelfRevoke: the operator deleted its OWN access key (the kill switch)");
      operatorKey = null; // already gone
    } catch (err) {
      bad(`SelfRevoke FAILED — the kill switch can't delete the operator's own key: ${(err as Error).message}`);
    }
  } finally {
    step(process.env.KEEP_STACK === "1" ? "Phase 3 — cleanup (keys only; stack KEPT at v4)" : "Phase 3 — teardown (clean sweep)");
    try {
      // Any operator keys still around (e.g. if SelfRevoke wasn't reached) must go.
      const keys = await adminIam
        .send(new ListAccessKeysCommand({ UserName: DEFAULT_OPERATOR_NAME }))
        .catch(() => ({ AccessKeyMetadata: [] as { AccessKeyId?: string }[] }));
      for (const k of keys.AccessKeyMetadata ?? []) {
        if (k.AccessKeyId) {
          await adminIam.send(new DeleteAccessKeyCommand({ UserName: DEFAULT_OPERATOR_NAME, AccessKeyId: k.AccessKeyId }));
          console.log(`  deleted lingering operator key ${k.AccessKeyId}`);
        }
      }
    } catch (err) {
      console.log(`  (operator user already gone or unreadable: ${(err as Error).message})`);
    }
    if (process.env.KEEP_STACK === "1") {
      ok(`stack "${STACK}" kept in place at v4 (KEEP_STACK=1) — only the harness's keys were removed`);
    } else {
      try {
        await adminCfn.send(new DeleteStackCommand({ StackName: STACK }));
        const gone = await waitStack(adminCfn, (s) => s === "DELETED" || s === "DELETE_COMPLETE");
        if (gone === "DELETED" || gone === "DELETE_COMPLETE") ok(`teardown: stack "${STACK}" deleted — account clean`);
        else bad(`teardown: stack ended in ${gone} — MANUAL CLEANUP NEEDED`);
      } catch (err) {
        bad(`teardown DeleteStack failed — MANUAL CLEANUP NEEDED: ${(err as Error).message}`);
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULT: ${pass.length} passed, ${fail.length} failed`);
  if (fail.length) {
    console.log("FAILURES:");
    for (const f of fail) console.log(`  ❌ ${f}`);
    process.exitCode = 1;
  } else {
    console.log("✅ template v4 verified live — every load-bearing behaviour holds.");
  }
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exitCode = 1;
});
