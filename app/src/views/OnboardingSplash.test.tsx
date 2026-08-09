// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { OnboardingSplash } from "./OnboardingSplash";

afterEach(cleanup);

describe("OnboardingSplash", () => {
  it("shows the narrative + no-admin promise across both carousel slides and wires Connect", () => {
    const onConnect = vi.fn();
    const onClose = vi.fn();
    render(<OnboardingSplash onConnect={onConnect} onClose={onClose} />);

    expect(screen.getByText("AgentsPoppy")).toBeTruthy();
    expect(screen.getByText(/Never asks for or uses admin access/i)).toBeTruthy();
    // Slide 1: the three promises.
    expect(screen.getByText("Runs on your machine")).toBeTruthy();
    expect(screen.getByText("Least privilege")).toBeTruthy();
    expect(screen.getByText("Revocable anytime")).toBeTruthy();
    // Slide 2: how it works.
    expect(screen.getByText("How it works")).toBeTruthy();
    // Two slides → two dots.
    expect(screen.getAllByRole("tab")).toHaveLength(2);

    fireEvent.click(screen.getByText("Connect your AWS"));
    expect(onConnect).toHaveBeenCalled();
  });

  it("can be dismissed via the close button", () => {
    const onClose = vi.fn();
    render(<OnboardingSplash onConnect={() => {}} onClose={onClose} />);

    fireEvent.click(screen.getByLabelText("Close intro"));
    expect(onClose).toHaveBeenCalled();
  });
});
