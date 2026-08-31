/**
 * The tag-scoped compiler and multi-resource births.
 *
 * `ec2:RunInstances` is the case that motivated all of this: it is a birth whose name does not
 * say "Create", and it is authorised against every resource it touches. The old regex put it in
 * the `aws:ResourceTag` branch, whose condition can never match a resource being born — so every
 * launch was denied, silently, until someone pressed the button.
 *
 * The expected shape here is not a guess. It was run against real IAM in the sandbox with
 * `run-instances --dry-run`, with an unconditional positive control and three negative controls;
 * see docs/specs/tag-scoping-and-ratings.md for the result table.
 */
import { describe, it, expect } from "vitest";
import { statementForGrant } from "./policy";
import { TAGGED_AS_SELF } from "@agentspoppy/core";

const APP = "com.vmpoppy.desktop";
const tagScoped = (actions: string[]) => ({ service: "ec2", actions, resourceScope: TAGGED_AS_SELF });
const cond = (s: { Condition?: unknown }) => JSON.stringify(s.Condition ?? null);

describe("multi-resource births", () => {
  it("conditions only what is born tagged, and leaves referenced resources unconditioned", () => {
    const out = statementForGrant(tagScoped(["RunInstances"]), APP, 0);
    const born = out.find((s) => String(s.Sid).endsWith("BornTagged"));
    const ref = out.find((s) => String(s.Sid).endsWith("Referenced"));
    expect(born, "no born-tagged statement emitted").toBeTruthy();
    expect(ref, "no referenced statement emitted").toBeTruthy();

    // Exactly the two types both EC2 poppies pass in TagSpecifications. Conditioning a type
    // they do NOT tag denies the launch just as surely as conditioning none.
    expect(born!.Resource).toEqual(["arn:aws:ec2:*:*:instance/*", "arn:aws:ec2:*:*:volume/*"]);
    expect(cond(born!)).toContain("aws:RequestTag/agentspoppy:app");
    expect(cond(born!)).toContain(APP);

    // The AMI and subnet carry no request tags; conditioning them is what denied the call.
    expect(ref!.Condition).toBeUndefined();
    expect(ref!.Resource).toContain("arn:aws:ec2:*::image/*");
    expect(ref!.Resource).toContain("arn:aws:ec2:*:*:subnet/*");
  });

  it("never puts RunInstances behind aws:ResourceTag — the bug this replaces", () => {
    const out = statementForGrant(tagScoped(["RunInstances"]), APP, 0);
    for (const s of out) {
      if (JSON.stringify(s.Action).includes("RunInstances")) {
        expect(cond(s)).not.toContain("aws:ResourceTag");
      }
    }
  });

  it("still classifies Create* as a simple birth on the request-tag condition", () => {
    const out = statementForGrant(tagScoped(["CreateSecurityGroup"]), APP, 0);
    const birth = out.find((s) => JSON.stringify(s.Action).includes("CreateSecurityGroup"));
    expect(cond(birth!)).toContain("aws:RequestTag");
  });

  it("treats CreateSecurityGroup as a SPREAD birth — it has a vpc leg that carries no tags", () => {
    // The first draft of this change left it as a "simple" birth on Resource:"*", which denies:
    // AWS authorises CreateSecurityGroup against the group AND the VPC it is created in, and the
    // VPC carries no request tags. That killed the VM launch on its first call.
    const out = statementForGrant(tagScoped(["CreateSecurityGroup"]), APP, 0);
    const born = out.find((s) => String(s.Sid).endsWith("BornTagged"));
    const ref = out.find((s) => String(s.Sid).endsWith("Referenced"));
    expect(born!.Resource).toEqual(["arn:aws:ec2:*:*:security-group/*"]);
    expect(cond(born!)).toContain("aws:RequestTag");
    expect(ref!.Resource).toEqual(["arn:aws:ec2:*:*:vpc/*"]);
    expect(ref!.Condition).toBeUndefined();
  });

  it("never lets RunInstances reference a snapshot — that is a data-exfiltration path", () => {
    // With snapshot/* in the referenced leg, a poppy can restore the user's database snapshot
    // onto an instance it owns: every created resource is correctly tagged, so the launch looks
    // perfectly compliant while the data leaves over the network. Proven live — with the leg the
    // launch was AUTHORIZED, without it DENIED, and an ordinary launch still AUTHORIZED.
    const out = statementForGrant(tagScoped(["RunInstances"]), APP, 0);
    for (const s of out) {
      const res = JSON.stringify(s.Resource);
      expect(res, `snapshot must never appear in ${s.Sid}`).not.toContain("snapshot");
    }
  });

  it("carries no speculative birth entries — every entry needs a call site and a dry-run", () => {
    // An earlier draft listed AllocateAddress, RegisterImage, CopyImage and CopySnapshot with no
    // call site. AWS's service reference shows three are multi-leg (so they would have been
    // denied at runtime) and the copy actions would have let a poppy copy a snapshot it does not
    // own. Untested table entries are how both classes of bug get in.
    const out = statementForGrant(tagScoped(["CopySnapshot"]), APP, 0);
    // Not classified as a birth → it lands on the resource-tag condition, which fails CLOSED
    // (a visible denial) rather than granting anything.
    expect(cond(out[0]!)).toContain("aws:ResourceTag");
  });

  it("keeps reads, changes and deletes on the resource-tag condition", () => {
    const out = statementForGrant(tagScoped(["DescribeInstances", "TerminateInstances"]), APP, 0);
    expect(out).toHaveLength(1);
    expect(cond(out[0]!)).toContain("aws:ResourceTag");
  });

  it("emits a coherent policy when a grant mixes all three kinds", () => {
    const out = statementForGrant(
      tagScoped(["RunInstances", "CreateSecurityGroup", "TerminateInstances"]),
      APP,
      2,
    );
    // Every action appears exactly once across the emitted statements, and every Sid is unique.
    const actions = out.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    const runCount = actions.filter((a) => String(a).includes("RunInstances")).length;
    expect(runCount).toBe(2); // born-tagged + referenced halves of the same action
    expect(new Set(out.map((s) => s.Sid)).size).toBe(out.length);
    for (const s of out) expect(String(s.Sid).startsWith("Grant2")).toBe(true);
  });
});
