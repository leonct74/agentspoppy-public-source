// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { InfraGraph, InfraNode } from "@agentspoppy/core";
import { InfraMap } from "./InfraMap";

afterEach(cleanup);

const node = (over: Partial<InfraNode> & Pick<InfraNode, "id" | "service">): InfraNode => ({
  resourceType: "AWS::X::Y", name: over.id, region: "eu-west-1", status: "present", inStack: true, ...over,
});
const graph = (nodes: InfraNode[], edges: { from: string; to: string }[] = []): InfraGraph => ({
  connectionId: "c", appId: "a", nodes, edges, generatedAt: "t",
});

describe("InfraMap", () => {
  it("draws a node per service with a friendly label", () => {
    render(<InfraMap graph={graph([node({ id: "x", service: "cognito-idp" }), node({ id: "y", service: "dynamodb" })])} />);
    expect(screen.getByText("Cognito")).toBeTruthy();
    expect(screen.getByText("DynamoDB")).toBeTruthy();
  });

  it("shows the empty state when nothing is deployed", () => {
    render(<InfraMap graph={graph([])} />);
    expect(screen.getByText(/Nothing deployed yet/)).toBeTruthy();
  });

  it("expands a node on click to reveal its resources and a console link", () => {
    render(<InfraMap graph={graph([node({ id: "b1", service: "s3", name: "my-bucket", consoleUrl: "https://console/s3" })])} />);
    expect(screen.queryByText("my-bucket")).toBeNull(); // collapsed: no detail yet
    fireEvent.click(screen.getByRole("button", { name: /S3/ }));
    expect(screen.getByText("my-bucket")).toBeTruthy();
    expect(screen.getByText(/Open in console/).getAttribute("href")).toBe("https://console/s3");
  });

  it("collapses the panel when the same node is clicked again", () => {
    render(<InfraMap graph={graph([node({ id: "b1", service: "s3", name: "my-bucket" })])} />);
    const sphere = screen.getByRole("button", { name: /S3/ });
    fireEvent.click(sphere);
    expect(screen.getByText("my-bucket")).toBeTruthy();
    fireEvent.click(sphere);
    expect(screen.queryByText("my-bucket")).toBeNull();
  });

  it("marks a removed service so a drained teardown reads at a glance", () => {
    render(<InfraMap graph={graph([node({ id: "x", service: "s3", status: "removed", inStack: false })])} />);
    expect(screen.getAllByText("removed").length).toBeGreaterThan(0);
  });

  it("reveals the verifying explainer only when its help button is pressed", () => {
    render(<InfraMap graph={graph([node({ id: "x", service: "cognito-idp", status: "unverified", inStack: false })])} />);
    expect(screen.queryByText(/independently confirm this resource/i)).toBeNull(); // hidden by default
    fireEvent.click(screen.getByRole("button", { name: /what does .*verifying.* mean/i }));
    expect(screen.getByText(/independently confirm this resource/i)).toBeTruthy();
  });
});
