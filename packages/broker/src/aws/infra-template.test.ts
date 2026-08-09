// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { parseTemplateEdges } from "./infra-template";

describe("parseTemplateEdges", () => {
  const template = {
    Resources: {
      Bucket: { Type: "AWS::S3::Bucket" },
      Fn: {
        Type: "AWS::Lambda::Function",
        Properties: {
          Environment: { Variables: { BUCKET: { Ref: "Bucket" }, TABLE: { "Fn::GetAtt": ["Table", "Arn"] } } },
          Role: { "Fn::GetAtt": "Role.Arn" },
        },
        DependsOn: ["Table"],
      },
      Table: { Type: "AWS::DynamoDB::Table" },
      Role: { Type: "AWS::IAM::Role" },
    },
  };

  it("derives edges from Ref, Fn::GetAtt (object + string), and DependsOn", () => {
    const edges = parseTemplateEdges(template);
    expect(edges).toContainEqual({ from: "Fn", to: "Bucket" });
    expect(edges).toContainEqual({ from: "Fn", to: "Table" });
    expect(edges).toContainEqual({ from: "Fn", to: "Role" });
  });

  it("dedupes (DependsOn + GetAtt to the same resource is one edge)", () => {
    const edges = parseTemplateEdges(template);
    expect(edges.filter((e) => e.from === "Fn" && e.to === "Table")).toHaveLength(1);
  });

  it("ignores refs to non-resources (parameters, pseudo-params)", () => {
    const edges = parseTemplateEdges({
      Resources: { Fn: { Type: "AWS::Lambda::Function", Properties: { R: { Ref: "AWS::Region" }, P: { Ref: "SomeParam" } } } },
    });
    expect(edges).toEqual([]);
  });

  it("accepts a JSON string body and tolerates junk", () => {
    expect(parseTemplateEdges(JSON.stringify(template)).length).toBeGreaterThan(0);
    expect(parseTemplateEdges("not json")).toEqual([]);
    expect(parseTemplateEdges(undefined)).toEqual([]);
    expect(parseTemplateEdges({})).toEqual([]);
  });
});
