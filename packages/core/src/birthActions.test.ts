// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The rating must not promise more than the compiled policy delivers (invariant I6).
 *
 * A tag-scoped grant containing a multi-resource birth compiles to an extra statement with NO
 * tag condition — the birth has to be able to name the AMI and subnet it references, or AWS
 * denies the launch. The consent line used to say such a grant "cannot touch any resource with
 * a different tag", which was not true of that leg.
 */
import { describe, it, expect } from "vitest";
import { assessGrant, TAGGED_AS_SELF } from "./index";
import { grantHasReferencedLeg, compilerTreatsAsBirth, SPREAD_BIRTHS } from "./birthActions";

const tagScoped = (actions: string[]) => ({ service: "ec2", actions, resourceScope: TAGGED_AS_SELF });

describe("what the rating says about a referenced leg", () => {
  it("admits it can use resources it did not create, when the grant has one", () => {
    const { reason } = assessGrant(tagScoped(["RunInstances", "TerminateInstances"]));
    expect(reason).toMatch(/did not create/i);
    // …and still says what it CANNOT do to them.
    expect(reason).toMatch(/cannot change or delete/i);
  });

  it("says no such thing when the grant has no referenced leg", () => {
    const { reason } = assessGrant(tagScoped(["DescribeInstances", "TerminateInstances"]));
    expect(reason).not.toMatch(/did not create/i);
  });

  it("never claims a tag-scoped grant cannot TOUCH other resources — only that it cannot change them", () => {
    // The old wording ("cannot touch any resource with a different tag") was the I6 overstatement.
    for (const actions of [["RunInstances"], ["DescribeInstances"], ["CreateSecurityGroup"]]) {
      expect(assessGrant(tagScoped(actions)).reason).not.toMatch(/cannot touch/i);
    }
  });

  it("detects the referenced leg from unqualified and qualified action names alike", () => {
    expect(grantHasReferencedLeg({ service: "ec2", actions: ["RunInstances"] })).toBe(true);
    expect(grantHasReferencedLeg({ service: "ec2", actions: ["ec2:RunInstances"] })).toBe(true);
    expect(grantHasReferencedLeg({ service: "ec2", actions: ["DescribeInstances"] })).toBe(false);
  });

  it("agrees with the compiler about what a birth is — one table, both readers", () => {
    for (const key of Object.keys(SPREAD_BIRTHS)) {
      expect(compilerTreatsAsBirth(key), `${key} is in SPREAD_BIRTHS but not classified a birth`).toBe(true);
    }
  });
});
