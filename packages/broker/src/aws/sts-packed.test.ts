// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

// Regression: STS's PACKED (compressed) session-policy budget is separate from the
// 2048-char plaintext cap the inline threshold guards. A wide-but-compact scope (many
// short actions across many services — first hit by CrewPoppy: 1690 chars / 42 actions
// → "Packed policy consumes 157% of allotted space") passes the plaintext check, goes
// inline, and STS rejects it. The vend must fall back to the managed-policy route
// instead of failing the poppy's deploy.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isPackedPolicyError,
  isPolicyNotYetVisibleError,
  retryOnPolicyPropagation,
  sdkAssumeRole,
  type AssumeRoleParams,
} from "./sts";

/** A sleep that returns immediately — lets the retry loop run with no wall-clock wait. */
const noSleep = async () => {};

const state = vi.hoisted(() => ({
  /** every STS AssumeRole input, in call order */
  assumeInputs: [] as Record<string, unknown>[],
  /** every IAM CreatePolicy input */
  createdPolicies: [] as Record<string, unknown>[],
  /** what the inline (Policy-bearing) AssumeRole should throw, if anything */
  inlineError: null as Error | null,
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
      if (cmd.input.Policy) {
        if (state.inlineError) throw state.inlineError;
        return creds("ASIAINLINE");
      }
      return creds("ASIAMANAGED");
    }
  }
  return { STSClient, AssumeRoleCommand };
});

vi.mock("@aws-sdk/client-iam", () => {
  class CreatePolicyCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  // The scope-policy read-back (fault C) imports these two as well. Here every name
  // is free, so CreatePolicy always succeeds and neither is ever sent — but the
  // import itself must resolve. Their behaviour is covered by sts-scope-policy.test.ts.
  class GetPolicyCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class GetPolicyVersionCommand {
    constructor(public input: Record<string, unknown>) {}
  }
  class IAMClient {
    async send(cmd: CreatePolicyCommand) {
      state.createdPolicies.push(cmd.input);
      return {};
    }
  }
  return { IAMClient, CreatePolicyCommand, GetPolicyCommand, GetPolicyVersionCommand };
});

const PACKED_ERROR = Object.assign(
  new Error("Packed policy consumes 157% of allotted space, please use smaller policy."),
  { name: "ValidationError" },
);

/** A compact policy — well under the 2000-char inline threshold. */
const params: AssumeRoleParams = {
  roleArn: "arn:aws:iam::123456789012:role/AgentsPoppy",
  sessionName: "agentspoppy-conn-abc",
  policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Sid: "G0", Effect: "Allow", Action: ["s3:CreateBucket"], Resource: "arn:aws:s3:::crewpoppy-*" }],
  }),
  tags: [],
  transitiveTagKeys: [],
  durationSeconds: 3600,
  region: "eu-west-1",
  accountId: "123456789012",
  connectionId: "conn-abc",
};

/** The exact STS wording when a just-created PolicyArn hasn't propagated yet. */
const POLICY_NOT_VISIBLE = Object.assign(
  new Error("At least one Policy ARN in the PolicyArns parameter does not match an existing IAM Managed Policy ARN."),
  { name: "InvalidParameterValue" },
);

beforeEach(() => {
  state.assumeInputs = [];
  state.createdPolicies = [];
  state.inlineError = null;
});

describe("isPackedPolicyError", () => {
  it("matches STS's packed-budget rejection", () => {
    expect(isPackedPolicyError(PACKED_ERROR)).toBe(true);
  });
  it("does not match other STS failures", () => {
    expect(isPackedPolicyError(new Error("AccessDenied: not authorized"))).toBe(false);
    expect(isPackedPolicyError(undefined)).toBe(false);
  });
});

describe("isPolicyNotYetVisibleError", () => {
  it("matches the real STS wording for a not-yet-propagated PolicyArn", () => {
    // The exact production message — this is the bug the retry loop failed to catch.
    expect(isPolicyNotYetVisibleError(POLICY_NOT_VISIBLE)).toBe(true);
  });
  it("matches other IAM-propagation wordings", () => {
    expect(isPolicyNotYetVisibleError(new Error("The policy arn:... does not exist"))).toBe(true);
    expect(isPolicyNotYetVisibleError(new Error("No such managed policy"))).toBe(true);
  });
  it("does not match unrelated STS failures", () => {
    expect(isPolicyNotYetVisibleError(new Error("AccessDenied: not authorized"))).toBe(false);
    expect(isPolicyNotYetVisibleError(PACKED_ERROR)).toBe(false);
    expect(isPolicyNotYetVisibleError(undefined)).toBe(false);
  });
});

describe("sdkAssumeRole packed-policy fallback", () => {
  it("still vends inline when the packed budget is happy", async () => {
    const creds = await sdkAssumeRole(params);
    expect(creds.accessKeyId).toBe("ASIAINLINE");
    expect(state.createdPolicies).toHaveLength(0);
  });

  it("falls back to the managed-policy route when STS rejects the packed size", async () => {
    state.inlineError = PACKED_ERROR;
    const creds = await sdkAssumeRole(params);
    expect(creds.accessKeyId).toBe("ASIAMANAGED");

    // The scope was preserved via a content-addressed managed policy…
    expect(state.createdPolicies).toHaveLength(1);
    expect(String(state.createdPolicies[0]!.PolicyName)).toMatch(/^AgentsPoppyScope-conn-abc-/);
    expect(state.createdPolicies[0]!.PolicyDocument).toBe(params.policy);

    // …and the final AssumeRole used PolicyArns, not an inline Policy.
    const last = state.assumeInputs[state.assumeInputs.length - 1]!;
    expect(last.Policy).toBeUndefined();
    expect(last.PolicyArns).toEqual([
      { arn: expect.stringMatching(/^arn:aws:iam::123456789012:policy\/AgentsPoppyScope-conn-abc-/) },
    ]);
  });

  it("does NOT swallow non-packed STS failures", async () => {
    state.inlineError = Object.assign(new Error("AccessDenied: not authorized"), { name: "AccessDenied" });
    await expect(sdkAssumeRole(params)).rejects.toThrow(/AccessDenied/);
    expect(state.createdPolicies).toHaveLength(0);
  });

});

describe("retryOnPolicyPropagation", () => {
  // Regression: STS says "…does not match an existing IAM Managed Policy ARN" while the
  // just-created policy is still propagating. The retry must recognise it and wait, not 500.
  it("retries until the just-created policy propagates, then returns", async () => {
    let calls = 0;
    const creds = await retryOnPolicyPropagation(async () => {
      if (++calls <= 2) throw POLICY_NOT_VISIBLE; // first two attempts: not yet visible
      return "ok" as const;
    }, noSleep);
    expect(creds).toBe("ok");
    expect(calls).toBe(3); // failed twice, succeeded on the third
  });

  it("surfaces a persistently bad PolicyArn after exhausting the retry budget", async () => {
    let calls = 0;
    await expect(
      retryOnPolicyPropagation(async () => {
        calls++;
        throw POLICY_NOT_VISIBLE; // never propagates
      }, noSleep, 6),
    ).rejects.toThrow(/does not match an existing/);
    expect(calls).toBe(6); // tried the full budget
  });

  it("does not retry an unrelated error", async () => {
    let calls = 0;
    await expect(
      retryOnPolicyPropagation(async () => {
        calls++;
        throw new Error("AccessDenied: not authorized");
      }, noSleep),
    ).rejects.toThrow(/AccessDenied/);
    expect(calls).toBe(1); // surfaced immediately, no retry
  });
});
