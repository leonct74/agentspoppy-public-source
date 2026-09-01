// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, expect, it } from "vitest";
import { serviceStake } from "./serviceStakes";

describe("the per-service stake sentences", () => {
  // Every service that appears in a stake section across the eight shipped poppies
  // (measured 2026-09-01 with the live assessor over the real manifests). A new poppy
  // bringing a new service into a stake section should extend BOTH the table and this list.
  const FLEET_STAKE_SERVICES = [
    "iam", "cognito-idp", "ses", "route53", "guardduty", "amplify",
    "ec2", "s3", "sts", "cloudformation", "pricing", "bedrock",
  ];

  it("covers every service the fleet's stake sections actually show", () => {
    for (const s of FLEET_STAKE_SERVICES) {
      expect(serviceStake(s), s).toBeTruthy();
    }
  });

  it("matches however the caller cases the service", () => {
    expect(serviceStake("SES")).toBe(serviceStake("ses"));
    expect(serviceStake("Route53")).toBe(serviceStake("route53"));
  });

  it("returns undefined for an uncovered service — nothing must render, never filler", () => {
    expect(serviceStake("workspaces")).toBeUndefined();
    expect(serviceStake("")).toBeUndefined();
  });

  it("describes the service, never the caller — no sentence may pre-judge a poppy", () => {
    for (const s of FLEET_STAKE_SERVICES) {
      const t = serviceStake(s)!;
      expect(t, s).not.toMatch(/this poppy|the poppy|it will|malicious/i);
    }
  });
});
