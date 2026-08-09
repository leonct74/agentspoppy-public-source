// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import type { InfraGraph, InfraNode, InfraNodeStatus } from "@agentspoppy/core";
import { toServiceGraph, layoutServiceGraph, summarizeFootprint, serviceLabel } from "./infraLayout";

const node = (
  id: string,
  service: string,
  status: InfraNodeStatus = "present",
  consoleUrl?: string,
  inStack = true,
): InfraNode => ({
  id, service, resourceType: "AWS::X::Y", name: id, region: "eu-west-1", status, inStack, consoleUrl,
});
const graph = (nodes: InfraNode[], edges: { from: string; to: string }[] = []): InfraGraph => ({
  connectionId: "c", appId: "a", nodes, edges, generatedAt: "t",
});

describe("toServiceGraph", () => {
  it("collapses resources to one node per service with counts + worst-case status", () => {
    const sg = toServiceGraph(graph([node("a", "s3", "removed"), node("b", "s3", "present"), node("c", "lambda")]));
    expect(sg.nodes).toHaveLength(2);
    const s3 = sg.nodes.find((n) => n.service === "s3")!;
    expect(s3.count).toBe(2);
    expect(s3.status).toBe("present"); // present beats removed
    expect(s3.resources.map((r) => r.id)).toEqual(["a", "b"]); // individual resources carried for expand
  });

  it("collapses edges to service→service, dropping self-loops and dupes", () => {
    const sg = toServiceGraph(
      graph([node("a", "s3"), node("b", "s3"), node("c", "lambda")], [{ from: "a", to: "c" }, { from: "b", to: "c" }, { from: "a", to: "b" }]),
    );
    expect(sg.edges).toEqual([{ from: "s3", to: "lambda" }]);
  });

  it("carries a console url from the first resource that has one", () => {
    const sg = toServiceGraph(graph([node("a", "s3", "present"), node("b", "s3", "present", "https://console/s3")]));
    expect(sg.nodes[0]?.consoleUrl).toBe("https://console/s3");
  });
});

describe("layoutServiceGraph", () => {
  it("places sources left of their dependents (by dependency depth)", () => {
    const sg = toServiceGraph(graph([node("a", "ses"), node("b", "s3"), node("c", "lambda")], [{ from: "a", to: "b" }, { from: "b", to: "c" }]));
    const { nodes: pos } = layoutServiceGraph(sg);
    const col = (s: string) => pos.find((n) => n.service === s)!.col;
    expect(col("ses")).toBeLessThan(col("s3"));
    expect(col("s3")).toBeLessThan(col("lambda"));
  });

  it("places a single node in the first cell and returns no nodes for an empty graph", () => {
    const one = layoutServiceGraph(toServiceGraph(graph([node("a", "s3")])));
    expect(one.nodes[0]).toMatchObject({ col: 0, row: 0 });
    expect(one.cols).toBe(1);
    expect(layoutServiceGraph({ nodes: [], edges: [] }).nodes).toEqual([]);
  });

  it("grids unconnected services into a square-ish block instead of one tall column", () => {
    const services = ["s3", "lambda", "dynamodb", "cognito", "ses", "iam", "sns", "logs", "route53"];
    const out = layoutServiceGraph(toServiceGraph(graph(services.map((s, i) => node(String(i), s))))); // no edges
    expect(out.cols).toBeGreaterThan(1);
    expect(out.rows).toBeGreaterThan(1);
    const cells = new Set(out.nodes.map((n) => `${n.col},${n.row}`));
    expect(cells.size).toBe(out.nodes.length); // every node has its own cell — no overlap
  });

  it("does not loop on a cycle", () => {
    const sg = toServiceGraph(graph([node("a", "s3"), node("b", "lambda")], [{ from: "a", to: "b" }, { from: "b", to: "a" }]));
    expect(layoutServiceGraph(sg).nodes).toHaveLength(2);
  });
});

describe("summarizeFootprint", () => {
  it("counts resources per service, most first, and totals them", () => {
    const s = summarizeFootprint(
      graph([node("a", "lambda"), node("b", "lambda"), node("c", "lambda"), node("d", "dynamodb"), node("e", "s3")]),
    );
    expect(s.total).toBe(5);
    expect(s.services[0]).toMatchObject({ service: "lambda", count: 3, label: "Lambda" });
    expect(s.services.map((x) => x.count)).toEqual([3, 1, 1]); // desc by count
  });

  it("excludes confirmed-removed nodes (already gone) but keeps still-verifying ones", () => {
    const s = summarizeFootprint(
      graph([node("a", "s3", "present"), node("b", "s3", "removed"), node("c", "cognito-idp", "unverified")]),
    );
    expect(s.total).toBe(2); // present + unverified; removed dropped
    expect(s.services.find((x) => x.service === "s3")?.count).toBe(1);
    expect(s.services.find((x) => x.service === "cognito-idp")?.label).toBe("Cognito");
  });

  it("counts how many targeted resources live outside the stack", () => {
    const s = summarizeFootprint(
      graph([node("a", "s3", "present", undefined, true), node("b", "route53", "present", undefined, false)]),
    );
    expect(s.total).toBe(2);
    expect(s.outOfStack).toBe(1);
  });

  it("is empty for an empty graph", () => {
    expect(summarizeFootprint(graph([]))).toEqual({ total: 0, services: [], outOfStack: 0 });
  });
});

describe("serviceLabel", () => {
  it("maps known services to friendly names and title-cases the rest", () => {
    expect(serviceLabel("cloudformation")).toBe("CloudFormation");
    expect(serviceLabel("cognito-idp")).toBe("Cognito");
    expect(serviceLabel("glacier")).toBe("Glacier");
  });
});
