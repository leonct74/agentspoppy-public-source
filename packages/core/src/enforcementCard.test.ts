// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
import { describe, expect, it } from "vitest";
import { enforcementCard } from "./enforcementCard";
import { TAGGED_AS_SELF } from "./types";
import type { PermissionSet } from "./types";

const ps = (grants: PermissionSet["grants"], over: Partial<PermissionSet> = {}): PermissionSet => ({
  id: "p", name: "P", description: "",
  grants,
  requiredTags: ["agentspoppy:account", "agentspoppy:app", "agentspoppy:connection"],
  limits: null,
  ...over,
});
const confined = { service: "dynamodb", actions: ["CreateTable"], resourceScope: TAGGED_AS_SELF };
const wideGrant = { service: "route53", actions: ["ChangeResourceRecordSets"], resourceScope: "*" };
const compute = { service: "lambda", actions: ["CreateFunction"], resourceScope: TAGGED_AS_SELF };

describe("enforcementCard — the nutrition-label rules", () => {
  it("fixed rows, fixed order, on every poppy — comparability is the point", () => {
    const order = ["keys", "reach", "egress", "approval", "exit", "record", "limits"];
    expect(enforcementCard(ps([confined]), { supervised: true }).map((r) => r.id)).toEqual(order);
    expect(enforcementCard(ps([wideGrant, compute]), { supervised: false }).map((r) => r.id)).toEqual(order);
  });

  it("reach: fully-confined earns 'enforced'; anything wide states the honest count", () => {
    const all = enforcementCard(ps([confined]), { supervised: true }).find((r) => r.id === "reach")!;
    expect(all.state).toBe("enforced");
    const some = enforcementCard(ps([confined, wideGrant]), { supervised: true }).find((r) => r.id === "reach")!;
    expect(some.state).toBe("partial");
    expect(some.sentence).toContain("1 of its 2 permissions");
  });

  it("egress: declares stays a declaration; undeclared with compute says so; no cloud code says that", () => {
    const declared = enforcementCard(ps([compute], { network: { egress: "aws-only", infrastructure: "email" } }), { supervised: true })
      .find((r) => r.id === "egress")!;
    expect(declared.state).toBe("declared");
    expect(declared.sentence).toContain("Declares its cloud code connects only to AWS");
    expect(declared.sentence).toContain("mail system");
    // The card never upgrades a declaration to an enforced fact.
    expect(declared.stateWord).not.toBe("Enforced");
    const un = enforcementCard(ps([compute]), { supervised: true }).find((r) => r.id === "egress")!;
    expect(un.state).toBe("undeclared");
    const none = enforcementCard(ps([confined]), { supervised: true }).find((r) => r.id === "egress")!;
    expect(none.sentence).toContain("Runs no cloud code of its own");
  });

  it("approval and exit reflect this connection, not the brochure", () => {
    const off = enforcementCard(ps([confined]), { supervised: false }).find((r) => r.id === "approval")!;
    expect(off.state).toBe("off");
    const exit = enforcementCard(ps([confined, wideGrant]), { supervised: true }).find((r) => r.id === "exit")!;
    expect(exit.state).toBe("partial"); // a wide mutating grant means labelling is not AWS-enforced
  });
});

describe("the Host-enforced graduation (machine-gate.md wording law)", () => {
  const row = (p: PermissionSet, armed?: boolean) =>
    enforcementCard(p, { supervised: true, machineGateArmed: armed }).find((r) => r.id === "egress")!;

  it("user-directed can never wear Host-enforced — log-only by nature, whatever any flag says", () => {
    const ud = ps([compute], { network: { egress: "user-directed", machine: "user-directed" } });
    expect(row(ud, true).stateWord).toBe("Declared");
    expect(row(ud, true).sentence).toContain("only under your request");
  });

  // The plane law: `egress` describes LAMBDAS in the user's cloud, which no host can
  // police. Only `machine` — the poppy's own code on this machine — can graduate.
  it("a cloud-only declaration never graduates, however armed the host says it is", () => {
    const cloudOnly = ps([compute], { network: { egress: "aws-only" } });
    expect(row(cloudOnly, true).state).toBe("declared");
    expect(row(cloudOnly, true).stateWord).toBe("Declared");
    expect(row(cloudOnly, true).sentence).not.toMatch(/refuses/);
  });

  const declared = ps([compute], { network: { egress: "aws-only", machine: ["agentspoppy.com"] } });

  it("graduates ONLY on the live host's report — a manifest alone never earns the chip", () => {
    expect(row(declared).stateWord).toBe("Declared");
    expect(row(declared).sentence).toContain("Declares it connects only to agentspoppy.com from your machine");
    const armed = row(declared, true);
    expect(armed.state).toBe("enforced");
    expect(armed.stateWord).toBe("Host-enforced");
    expect(armed.sentence).toContain("The host refuses connections from this machine that it did not declare.");
    // The tick must not be readable onto the cloud sentence, which it does not cover.
    expect(armed.sentence).toContain("Declares its cloud code connects only to AWS.");
    // the wording law: host-refuses, never cannot-connect
    expect(armed.sentence).not.toMatch(/cannot connect|physically/i);
  });
});
