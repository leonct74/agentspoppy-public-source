// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import {
  MAINTENANCE_POLICY_STATEMENTS,
  MAINTENANCE_SESSION_NAME,
  classifyAssumeFailure,
  maintenancePolicyJson,
} from "./maintenance";
import { HOST_SESSION_PREFIX } from "@agentspoppy/core";
import { splitPolicyDocument } from "./sts";

describe("maintenance session policy", () => {
  it("carries exactly the two statements template v4 removes from the operator user", () => {
    const sids = MAINTENANCE_POLICY_STATEMENTS.map((s) => s.Sid);
    expect(sids).toEqual(["MonitorAndTeardown", "HostResidualCleanup"]);
  });

  it("names its session with the HOST prefix so the activity feed attributes it to AgentsPoppy", () => {
    expect(MAINTENANCE_SESSION_NAME.startsWith(HOST_SESSION_PREFIX)).toBe(true);
    // Never the poppy prefix — that would make classifyActor read it as a connection.
    expect(MAINTENANCE_SESSION_NAME.startsWith("agentspoppy-")).toBe(false);
  });

  it("is a valid, narrowing-only policy document (every statement Allow-only)", () => {
    const doc = JSON.parse(maintenancePolicyJson()) as { Version: string; Statement: { Effect: string }[] };
    expect(doc.Version).toBe("2012-10-17");
    for (const s of doc.Statement) expect(s.Effect).toBe("Allow");
  });

  it("splits cleanly under the managed-policy budget if it ever overflows the packed one", () => {
    // The packed budget is the real risk (sts.ts). If the inline path is ever rejected, the
    // module falls back to managed session policies via splitPolicyDocument — which must not
    // itself explode past AssumeRole's 10-policy cap for this document.
    const chunks = splitPolicyDocument(maintenancePolicyJson());
    expect(chunks.length).toBeLessThanOrEqual(10);
    for (const c of chunks) expect(() => JSON.parse(c)).not.toThrow();
  });
});

describe("classifyAssumeFailure", () => {
  it("reads a dead/propagating key as dead-key", () => {
    expect(classifyAssumeFailure(new Error("InvalidClientTokenId: The security token included is invalid"))).toBe(
      "dead-key",
    );
    expect(classifyAssumeFailure(new Error("The security token included in the request is expired"))).toBe(
      "dead-key",
    );
  });

  it("reads an authorization refusal as denied", () => {
    expect(classifyAssumeFailure(new Error("User: ... is not authorized to perform: sts:AssumeRole"))).toBe(
      "denied",
    );
    expect(classifyAssumeFailure(new Error("AccessDenied"))).toBe("denied");
  });

  it("reads anything else (throttle, network) as transient", () => {
    expect(classifyAssumeFailure(new Error("Rate exceeded"))).toBe("transient");
    expect(classifyAssumeFailure(new Error("socket hang up"))).toBe("transient");
    expect(classifyAssumeFailure(undefined)).toBe("transient");
  });
});
