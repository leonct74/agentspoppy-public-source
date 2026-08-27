// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * A tripwire for a bug this repo has now actually made: **the bootstrap template grew an
 * IAM resource that the scoped setup policy could not create.**
 *
 * Most users deploy setup with admin credentials, so the miss is invisible to whoever
 * writes the template. The users it breaks are precisely the careful ones — those who
 * followed the advice to attach the least-privilege access policy instead of using admin.
 * They get a raw AccessDenied on a step they cannot fix themselves.
 *
 * So: every IAM resource the template declares must have a matching create grant, pinned
 * to that resource's own ARN, in infra/policies/agentspoppy-access-policy.json.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { roleCloudFormationTemplate } from "./role-template";

const POLICY_PATH = new URL("../../../../infra/policies/agentspoppy-access-policy.json", import.meta.url);
const BUNDLED_PATH = new URL("../../../../app/src/assets/access-policy.json", import.meta.url);
const README_PATH = new URL("../../../../infra/policies/README.md", import.meta.url);

interface Stmt {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
}

const policy = (): { Statement: Stmt[] } => JSON.parse(readFileSync(POLICY_PATH, "utf8"));
const asArray = (v: string | string[]): string[] => (Array.isArray(v) ? v : [v]);

/** How each IAM resource type maps to an ARN path and the action that creates it. */
const IAM_TYPES: Record<string, { arnPath: string; nameProp: string; create: string }> = {
  "AWS::IAM::Role": { arnPath: "role", nameProp: "RoleName", create: "iam:CreateRole" },
  "AWS::IAM::User": { arnPath: "user", nameProp: "UserName", create: "iam:CreateUser" },
  "AWS::IAM::ManagedPolicy": { arnPath: "policy", nameProp: "ManagedPolicyName", create: "iam:CreatePolicy" },
  "AWS::IAM::Group": { arnPath: "group", nameProp: "GroupName", create: "iam:CreateGroup" },
  "AWS::IAM::InstanceProfile": {
    arnPath: "instance-profile",
    nameProp: "InstanceProfileName",
    create: "iam:CreateInstanceProfile",
  },
};

describe("the scoped access policy covers the bootstrap template", () => {
  const tpl = roleCloudFormationTemplate({ operatorAccountId: "123456789012" }) as {
    Resources: Record<string, { Type: string; Properties: Record<string, string> }>;
  };
  const iamResources = Object.entries(tpl.Resources).filter(([, r]) => r.Type.startsWith("AWS::IAM::"));

  it("recognises every IAM resource type the template uses", () => {
    // A type this test doesn't know about would be silently skipped below — which is
    // exactly the silence that let the boundary policy ship uncovered.
    for (const [logicalId, r] of iamResources) {
      expect(IAM_TYPES[r.Type], `${logicalId} is a ${r.Type}, unknown to this tripwire`).toBeDefined();
    }
    expect(iamResources.length).toBeGreaterThan(0);
  });

  it.each(
    iamResources.map(([logicalId, r]) => {
      const spec = IAM_TYPES[r.Type]!;
      return { logicalId, name: r.Properties[spec.nameProp]!, arnPath: spec.arnPath, create: spec.create };
    }),
  )("grants $create for $name (used by $logicalId)", ({ name, arnPath, create }) => {
    const arn = `arn:aws:iam::*:${arnPath}/${name}`;
    const covering = policy().Statement.filter(
      (s) => s.Effect === "Allow" && asArray(s.Resource).includes(arn) && asArray(s.Action).includes(create),
    );
    expect(covering.length, `no Allow of ${create} on ${arn} in the access policy`).toBeGreaterThan(0);
  });

  // The app ships its own copy for the "copy this policy" panel. release-check enforces
  // this too, but that runs at release time — a drifted copy is worth failing on now.
  it("keeps the app's bundled copy identical to the source of truth", () => {
    expect(readFileSync(BUNDLED_PATH, "utf8")).toBe(readFileSync(POLICY_PATH, "utf8"));
  });

  // The README is what an admin diffs against before pasting a policy into their own IAM,
  // and it ships on the public mirror. It claimed the bootstrap needed no iam:CreatePolicy
  // for a whole release after the template started requiring one — an admin who trusted it
  // would hand-trim the grant back out and land in the silent-rollback failure.
  it("documents every resource the policy is scoped to", () => {
    const readme = readFileSync(README_PATH, "utf8");
    const scopes = new Set(
      policy()
        .Statement.flatMap((st) => asArray(st.Resource))
        .filter((r) => r !== "*")
        .map((r) => r.split("/").pop()!),
    );
    for (const name of scopes) {
      expect(readme.includes(name), `${name} is granted but never mentioned in infra/policies/README.md`).toBe(true);
    }
  });
});
