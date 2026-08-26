// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

// Fault C (adversarial review, 16 August 2026) — the broker must not trust a scope
// policy because of its NAME.
//
// A large scope is written into IAM as a managed policy whose name embeds a hash of the
// document, and referenced by ARN at AssumeRole. `ensureScopePolicyDoc` used to swallow
// EntityAlreadyExists on the assumption that an existing policy at that name must be an
// identical document. Nothing checked it. Every input to the name is known to the poppy
// in advance — the host hands it its own connection id at backend start, and the document
// compiles deterministically from the poppy's own manifest — so a poppy holding a policy
// write can plant `Allow *:*` at that name and have its NEXT vend bound to a document it
// wrote itself. The remaining ceiling is the broker role: near-admin.
//
// Two properties are load-bearing and pull in opposite directions, which is why they are
// tested together:
//   - a document that is not ours must REFUSE the vend (never overwrite: delete is racy,
//     and destroying a customer's IAM policy on a false positive is worse than stopping);
//   - a document that IS ours, re-serialised by IAM (URL-encoded, whitespace and key order
//     its own), must still be reused — a byte comparison here would reject our own policy
//     on every second vend and turn a security check into an outage.
//
// The read leaves a narrow time-of-check race that only the role-template guardrail closes
// (see docs/specs/scope-policy-and-rating.md). These tests cover the read, not the race.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { policyDocumentsMatch, sdkAssumeRole, type AssumeRoleParams } from "./sts";

// The fixture below is deliberately large enough to SPLIT across two managed policies
// (MailPoppy's real scope does exactly this), so the mock has to answer per policy
// name rather than pretend there is a single document. A mock with one global
// document could not represent "our own policy" for either chunk.
const state = vi.hoisted(() => ({
  assumeInputs: [] as Record<string, unknown>[],
  createdPolicies: [] as Record<string, unknown>[],
  /** null = every name is free. Otherwise, what already sits at the name we want. */
  squat: null as { defaultVersionId: string; docFor: (name: string, versionId: string) => string } | null,
  /** Every document the broker TRIED to write, by policy name — so a test can serve
   *  back the broker's own document (re-serialised) without knowing the chunking. */
  attempted: {} as Record<string, string>,
  getPolicyVersionCalls: [] as Record<string, unknown>[],
  /** Forces the read-back itself to fail, to prove an unverifiable policy is refused. */
  readFails: false,
}));

vi.mock("./credentials", () => ({
  operatorCredentials: async () => ({ accessKeyId: "op", secretAccessKey: "op-secret" }),
}));

vi.mock("@aws-sdk/client-sts", () => {
  class AssumeRoleCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class STSClient {
    async send(cmd: AssumeRoleCommand) {
      state.assumeInputs.push(cmd.input);
      const creds = (id: string) => ({
        Credentials: {
          AccessKeyId: id,
          SecretAccessKey: "secret",
          SessionToken: "token",
          Expiration: new Date("2026-01-01T01:00:00Z"),
        },
      });
      if (String(cmd.input.RoleSessionName).endsWith("-boot")) return creds("ASIABOOT");
      return creds("ASIAMANAGED");
    }
  }
  return { STSClient, AssumeRoleCommand };
});

vi.mock("@aws-sdk/client-iam", () => {
  class CreatePolicyCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class GetPolicyCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class GetPolicyVersionCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  const nameOf = (arn: unknown) => String(arn).split("/").pop() ?? "";
  class IAMClient {
    async send(cmd: { input: Record<string, unknown> }) {
      if (cmd instanceof CreatePolicyCommand) {
        state.attempted[String(cmd.input.PolicyName)] = String(cmd.input.PolicyDocument);
        if (state.squat) {
          throw Object.assign(new Error("A policy called ... already exists."), {
            name: "EntityAlreadyExistsException",
          });
        }
        state.createdPolicies.push(cmd.input);
        return {};
      }
      if (cmd instanceof GetPolicyCommand) {
        if (state.readFails) throw Object.assign(new Error("AccessDenied"), { name: "AccessDeniedException" });
        if (!state.squat) throw Object.assign(new Error("NoSuchEntity"), { name: "NoSuchEntityException" });
        return { Policy: { DefaultVersionId: state.squat.defaultVersionId } };
      }
      if (cmd instanceof GetPolicyVersionCommand) {
        state.getPolicyVersionCalls.push(cmd.input);
        if (!state.squat) throw Object.assign(new Error("NoSuchEntity"), { name: "NoSuchEntityException" });
        const vid = String(cmd.input.VersionId);
        const doc = state.squat.docFor(nameOf(cmd.input.PolicyArn), vid);
        // IAM returns the document URL-encoded, exactly as the real API does.
        return { PolicyVersion: { Document: encodeURIComponent(doc), VersionId: vid } };
      }
      throw new Error("unexpected IAM command");
    }
  }
  return { IAMClient, CreatePolicyCommand, GetPolicyCommand, GetPolicyVersionCommand };
});

/** The document the broker intends to write — deliberately over the inline threshold so
 *  the managed-policy route is taken. */
const SCOPE_DOC = JSON.stringify({
  Version: "2012-10-17",
  Statement: Array.from({ length: 40 }, (_, i) => ({
    Sid: `G${i}`,
    Effect: "Allow",
    Action: ["s3:CreateBucket", "s3:PutObject", "s3:GetObject"],
    Resource: `arn:aws:s3:::mailpoppy-bucket-number-${i}-with-a-long-enough-name/*`,
  })),
});

const params: AssumeRoleParams = {
  roleArn: "arn:aws:iam::123456789012:role/AgentsPoppy",
  sessionName: "agentspoppy-conn-abc",
  policy: SCOPE_DOC,
  tags: [],
  transitiveTagKeys: [],
  durationSeconds: 3600,
  region: "eu-west-1",
  accountId: "123456789012",
  connectionId: "conn-abc",
};

/** What an attacker plants: unrestricted, at the name the broker is about to use. */
const HOSTILE_DOC = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{ Sid: "Everything", Effect: "Allow", Action: "*", Resource: "*" }],
});

/** Our own document as IAM would hand it back: same meaning, different bytes. */
function reserialised(doc: string): string {
  const parsed = JSON.parse(doc) as { Version: string; Statement: Record<string, unknown>[] };
  return JSON.stringify(
    {
      Statement: parsed.Statement.map((s) => ({
        Resource: s.Resource,
        Action: s.Action,
        Effect: s.Effect,
        Sid: s.Sid,
      })),
      Version: parsed.Version,
    },
    null,
    4,
  );
}

/** What a test means by "the policy already there is ours, as IAM would return it". */
const OURS = { defaultVersionId: "v1", docFor: (name: string) => reserialised(state.attempted[name]!) };
/** …and by "someone else's document is sitting at our name". */
const HOSTILE = { defaultVersionId: "v1", docFor: () => HOSTILE_DOC };

beforeEach(() => {
  state.assumeInputs = [];
  state.createdPolicies = [];
  state.squat = null;
  state.attempted = {};
  state.getPolicyVersionCalls = [];
  state.readFails = false;
});

describe("ensureScopePolicyDoc — a policy is trusted by its CONTENTS, not its name", () => {
  it("creates and uses the policy when the name is free (unchanged behaviour)", async () => {
    const creds = await sdkAssumeRole(params);
    expect(creds.accessKeyId).toBe("ASIAMANAGED");
    expect(state.createdPolicies.length).toBeGreaterThan(0);
  });

  // The attack. A different document at our name must stop the vend dead.
  it("REFUSES to vend when the existing document is not the one we intended", async () => {
    state.squat = HOSTILE;

    await expect(sdkAssumeRole(params)).rejects.toThrow();

    // Nothing may be handed out: no scoped credentials, and no AssumeRole carrying the
    // squatted ARN. (The bootstrap hop is expected; a PolicyArns assume is not.)
    const scopedAssume = state.assumeInputs.find((i) => i.PolicyArns !== undefined);
    expect(scopedAssume).toBeUndefined();
  });

  it("names the offending policy so an operator can go and look at it", async () => {
    state.squat = HOSTILE;
    await expect(sdkAssumeRole(params)).rejects.toThrow(/AgentsPoppyScope-conn-abc-/);
  });

  // The outage regression. Our own policy comes back URL-encoded with IAM's own
  // whitespace and key order; a byte comparison would reject it and break every vend
  // after the first.
  it("reuses our own policy when IAM returns it re-serialised", async () => {
    state.squat = OURS;

    const creds = await sdkAssumeRole(params);
    expect(creds.accessKeyId).toBe("ASIAMANAGED");
    const scopedAssume = state.assumeInputs.find((i) => i.PolicyArns !== undefined);
    expect(scopedAssume).toBeDefined();
  });

  // The quiet path: CreatePolicyVersion(SetAsDefault) leaves the broker's policy object
  // intact and swaps only the version STS actually dereferences. Reading v1, or merely
  // confirming a policy exists, would miss it entirely.
  it("reads the DEFAULT version, not the first one", async () => {
    // v1 is still ours; v2 is theirs, and v2 is what STS would dereference.
    state.squat = {
      defaultVersionId: "v2",
      docFor: (name, vid) => (vid === "v1" ? state.attempted[name]! : HOSTILE_DOC),
    };

    await expect(sdkAssumeRole(params)).rejects.toThrow();
    expect(state.getPolicyVersionCalls.map((c) => c.VersionId)).toContain("v2");
  });
  // Unverifiable is treated exactly like hostile: refusing costs one failed vend,
  // while proceeding would bind a session to a document nobody has read.
  it("REFUSES to vend when the existing policy cannot be read back", async () => {
    state.squat = OURS;
    state.readFails = true;
    await expect(sdkAssumeRole(params)).rejects.toThrow(/could not read/i);
    expect(state.assumeInputs.find((i) => i.PolicyArns !== undefined)).toBeUndefined();
  });
});

describe("policyDocumentsMatch — semantic, not byte-for-byte", () => {
  it("accepts the same document re-serialised and URL-encoded", () => {
    expect(policyDocumentsMatch(encodeURIComponent(reserialised(SCOPE_DOC)), SCOPE_DOC)).toBe(true);
  });

  it("accepts a document IAM collapsed to a scalar action", () => {
    const arrayForm = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: "*" }] });
    const scalarForm = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }] });
    expect(policyDocumentsMatch(scalarForm, arrayForm)).toBe(true);
  });

  it("rejects a document that differs anywhere that matters", () => {
    expect(policyDocumentsMatch(HOSTILE_DOC, SCOPE_DOC)).toBe(false);
  });

  // A document we cannot read is one we cannot vouch for.
  it("rejects an unparseable document rather than throwing", () => {
    expect(policyDocumentsMatch("not json at all", SCOPE_DOC)).toBe(false);
  });

  // Decoding BEFORE trying raw JSON would rewrite "%20" into a space inside our own
  // document, so it would no longer match what IAM echoes back — refusing our own
  // policy on every vend. An outage reached through a security check.
  it("does not mangle a document that legitimately contains a percent escape", () => {
    const withEscape = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::b/a%20b" }],
    });
    expect(policyDocumentsMatch(withEscape, withEscape)).toBe(true);
    expect(policyDocumentsMatch(encodeURIComponent(withEscape), withEscape)).toBe(true);
  });
});
