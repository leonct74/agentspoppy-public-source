// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Panel 1's floor (docs/specs/permission-presentation.md). The danger here runs the
 * reassuring way: a conditional guarantee printed as universal is an overstatement nobody
 * presses on, because it is a green line. So the tests concentrate on `holds` flipping for
 * the three conditional guarantees, and on the unconditional floor never flipping.
 */
import { describe, expect, it } from "vitest";
import { ATTRIBUTION_TAG_KEYS } from "./permissions";
import { brokerGuarantees } from "./guarantees";
import { TAGGED_AS_SELF } from "./types";
import type { PermissionSet } from "./types";

const ps = (over: Partial<PermissionSet> = {}): PermissionSet => ({
  id: "p", name: "P", description: "",
  grants: [{ service: "s3", actions: ["CreateBucket"], resourceScope: TAGGED_AS_SELF }],
  requiredTags: [...ATTRIBUTION_TAG_KEYS],
  limits: null,
  ...over,
});

const byId = (ps2: PermissionSet, supervised: boolean) =>
  Object.fromEntries(brokerGuarantees(ps2, { supervised }).map((g) => [g.id, g]));

describe("the unconditional floor", () => {
  it("holds for every poppy, however bad its manifest", () => {
    const worst = ps({
      grants: [{ service: "iam", actions: ["*"], resourceScope: "*" }],
      requiredTags: [],
    });
    const g = byId(worst, false);
    for (const id of [
      "temporary-credentials", "narrowing-only", "no-identity-control",
      "no-admin-escalation", "no-audit-tampering", "ownership-outlives-connection",
      "audit-trail", "kill-switch",
    ]) {
      expect(g[id]?.holds, id).toBe(true);
    }
  });

  it("every guarantee names where it is enforced — a claim nobody can check is just a claim", () => {
    for (const g of brokerGuarantees(ps(), { supervised: true })) {
      expect(g.pin.length, g.id).toBeGreaterThan(10);
    }
  });
});

describe("the conditional guarantees say when they do not hold", () => {
  it("born-tagged holds only when some grant is tag-scoped", () => {
    expect(byId(ps(), true)["born-tagged"].holds).toBe(true);
    const named = ps({ grants: [{ service: "s3", actions: ["CreateBucket"], resourceScope: "arn:aws:s3:::x*" }] });
    const g = byId(named, true)["born-tagged"];
    expect(g.holds).toBe(false);
    // The absence explains name-scoping honestly: bounded, but ownership unproven.
    expect(g.absent).toMatch(/naming its resources/);
  });

  it("sweepable holds on what AWS ENFORCES, not on what the manifest declares", () => {
    // The bug this replaced: keyed on hasAttributionTags — a manifest claim — it put a green
    // tick reading "everything it makes is labelled as its own" in the ENFORCED-FLOOR panel
    // for poppies where almost no create is IAM-enforced. Labelling is enforced only on
    // tagged-as-self creates (I3's aws:RequestTag condition).
    expect(byId(ps(), true)["sweepable"].holds).toBe(true); // sole mutating grant is tag-scoped

    // declares all three labels, but its mutating grant is NAME-scoped: not enforced
    const named = ps({ grants: [{ service: "s3", actions: ["CreateBucket"], resourceScope: "arn:aws:s3:::x*" }] });
    expect(byId(named, true)["sweepable"].holds).toBe(false);

    // one tag-scoped grant does not carry the others
    const mixed = ps({
      grants: [
        { service: "s3", actions: ["CreateBucket"], resourceScope: TAGGED_AS_SELF },
        { service: "dynamodb", actions: ["CreateTable"], resourceScope: "arn:aws:dynamodb:*:*:table/X*" },
      ],
    });
    expect(byId(mixed, true)["sweepable"].holds).toBe(false);

    // and the labels must still be declared even when every grant is tag-scoped
    expect(byId(ps({ requiredTags: [] }), true)["sweepable"].holds).toBe(false);
  });

  it("its absence explains what still protects you, without alarm (rule 6)", () => {
    const named = ps({ grants: [{ service: "s3", actions: ["CreateBucket"], resourceScope: "arn:aws:s3:::x*" }] });
    const g = byId(named, true)["sweepable"];
    // says what removal DOES do — it is not a warning that removal fails, because it usually
    // does not: the stacks are deleted whether or not their contents carry a label
    expect(g.absent).toMatch(/deletes the stacks it created/i);
    expect(g.absent).toMatch(/sweeps for anything labelled as its own/i);
    // never our jargon, never "go audit AWS yourself", never a scare
    expect(g.absent).not.toMatch(/attribution tag|declare/i);
    expect(g.absent).not.toMatch(/check(ing)? your account|check AWS/i);
    expect(g.absent).not.toMatch(/cannot be removed|left behind|unsafe|risk/i);
  });

  it("supervision reflects the LIVE connection, not the default", () => {
    expect(byId(ps(), true)["supervised"].holds).toBe(true);
    const g = byId(ps(), false)["supervised"];
    expect(g.holds).toBe(false);
    expect(g.absent).toMatch(/switched off/);
  });

  it("a guarantee that holds carries no absence text", () => {
    for (const g of brokerGuarantees(ps(), { supervised: true })) {
      if (g.holds) expect(g.absent, g.id).toBeUndefined();
    }
  });
});
