// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { StubAwsBootstrap } from "./identity";

describe("StubAwsBootstrap", () => {
  it("returns the stub identity by default", async () => {
    const id = await new StubAwsBootstrap().getCallerIdentity();
    expect(id.accountId).toBe("123456789012");
  });

  it("simulates a new user: failing the first N probes, then succeeding", async () => {
    const stub = new StubAwsBootstrap(undefined, 1);
    await expect(stub.getCallerIdentity()).rejects.toThrow(/No AWS credentials/);
    const id = await stub.getCallerIdentity();
    expect(id.accountId).toBe("123456789012");
  });

  it("verifyRole echoes an assumed ARN", async () => {
    const res = await new StubAwsBootstrap().verifyRole("arn:aws:iam::1:role/AP", "us-east-1");
    expect(res).toEqual({ ok: true, assumedArn: "arn:aws:iam::1:role/AP/agentspoppy-verify" });
  });
});
