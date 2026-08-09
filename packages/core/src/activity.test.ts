// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import {
  classifyActor,
  describePrincipal,
  shortService,
  summarizeActivity,
  type ActivityEvent,
  type AttributionContext,
} from "./activity";

const ctx: AttributionContext = { brokerRoleName: "AgentsPoppyBroker", operatorName: "AgentsPoppyOperator" };

describe("classifyActor", () => {
  it("attributes a brokered session to its connection via the session name", () => {
    const r = classifyActor(
      { type: "AssumedRole", roleName: "AgentsPoppyBroker", sessionName: "agentspoppy-conn-123", arn: "arn:..." },
      ctx,
    );
    expect(r).toEqual({ kind: "poppy", connectionId: "conn-123" });
  });

  it("does not treat a same-named session on a DIFFERENT role as a poppy", () => {
    const r = classifyActor(
      { type: "AssumedRole", roleName: "SomeOtherRole", sessionName: "agentspoppy-conn-123" },
      ctx,
    );
    expect(r.kind).toBe("external");
  });

  it("recognises the operator as AgentsPoppy itself (by user name or arn)", () => {
    expect(classifyActor({ type: "IAMUser", userName: "AgentsPoppyOperator" }, ctx).kind).toBe("agentspoppy");
    expect(
      classifyActor({ type: "IAMUser", arn: "arn:aws:iam::123:user/AgentsPoppyOperator" }, ctx).kind,
    ).toBe("agentspoppy");
  });

  it("flags any other principal as external", () => {
    expect(classifyActor({ type: "IAMUser", userName: "deploy-bot" }, ctx).kind).toBe("external");
    expect(classifyActor({ type: "Root" }, ctx).kind).toBe("external");
  });

  it("recognises a custom-named operator via the live identity (name + exact arn)", () => {
    // Real users connect with their own IAM user (e.g. "acmepoppy-3"), not the
    // canonical name — the live identity must win or the broker's own calls read
    // as external activity.
    const live: AttributionContext = {
      brokerRoleName: "AgentsPoppyBroker",
      operatorName: "acmepoppy-3",
      operatorArn: "arn:aws:iam::123:user/acmepoppy-3",
    };
    expect(classifyActor({ type: "IAMUser", userName: "acmepoppy-3" }, live).kind).toBe("agentspoppy");
    // Exact-ARN match carries it even when the record has no userName field.
    expect(classifyActor({ type: "IAMUser", arn: "arn:aws:iam::123:user/acmepoppy-3" }, live).kind).toBe(
      "agentspoppy",
    );
    // A pathed operator ARN still matches by its final (bare-name) segment.
    expect(classifyActor({ type: "IAMUser", arn: "arn:aws:iam::123:user/team/acmepoppy-3" }, live).kind).toBe(
      "agentspoppy",
    );
    // A different IAM user in the same account stays external.
    expect(
      classifyActor({ type: "IAMUser", userName: "deploy-bot", arn: "arn:aws:iam::123:user/deploy-bot" }, live)
        .kind,
    ).toBe("external");
  });

  it("does NOT swallow prefix-colliding sibling users into the operator bucket", () => {
    // "acmepoppy-30" contains "acmepoppy-3" — a substring match would misattribute a
    // genuinely external user's changes to AgentsPoppy itself.
    const live: AttributionContext = {
      brokerRoleName: "AgentsPoppyBroker",
      operatorName: "acmepoppy-3",
      operatorArn: "arn:aws:iam::123:user/acmepoppy-3",
    };
    expect(
      classifyActor({ type: "IAMUser", userName: "acmepoppy-30", arn: "arn:aws:iam::123:user/acmepoppy-30" }, live)
        .kind,
    ).toBe("external");
    expect(classifyActor({ type: "IAMUser", arn: "arn:aws:iam::123:user/acmepoppy-3-ci" }, live).kind).toBe(
      "external",
    );
    expect(classifyActor({ type: "IAMUser", arn: "arn:aws:iam::123:user/acmepoppy-3x/bob" }, live).kind).toBe(
      "external",
    );
  });

  it("always recognises the canonical bootstrap operator alongside the live identity", () => {
    const live: AttributionContext = {
      brokerRoleName: "AgentsPoppyBroker",
      operatorName: "acmepoppy-3",
      operatorArn: "arn:aws:iam::123:user/acmepoppy-3",
      canonicalOperatorName: "AgentsPoppyOperator",
    };
    // e.g. a bootstrap deploy ran as AgentsPoppyOperator earlier in the lookback
    // window; it must not read as an external change.
    expect(
      classifyActor(
        { type: "IAMUser", userName: "AgentsPoppyOperator", arn: "arn:aws:iam::123:user/AgentsPoppyOperator" },
        live,
      ).kind,
    ).toBe("agentspoppy");
  });
});

describe("describePrincipal / shortService", () => {
  it("labels external principals", () => {
    expect(describePrincipal({ type: "IAMUser", userName: "deploy-bot" })).toBe("IAM user deploy-bot");
    expect(describePrincipal({ type: "Root" })).toBe("Account root");
    expect(describePrincipal({ type: "AssumedRole", roleName: "CI" })).toBe("Role CI");
  });

  it("shortens an eventSource", () => {
    expect(shortService("s3.amazonaws.com")).toBe("s3");
    expect(shortService("iam.amazonaws.com")).toBe("iam");
  });
});

describe("summarizeActivity", () => {
  it("counts events by attribution bucket", () => {
    const ev = (kind: ActivityEvent["actor"]["kind"]): ActivityEvent => ({
      id: Math.random().toString(), time: "t", service: "s3", action: "X", actor: { kind, label: kind },
    });
    const s = summarizeActivity([ev("external"), ev("external"), ev("poppy"), ev("agentspoppy")]);
    expect(s).toEqual({ total: 4, external: 2, throughPoppies: 1, byAgentsPoppy: 1 });
  });
});
