// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AccountHealth } from "./AccountHealth";

afterEach(cleanup);

const noop = () => {};

describe("AccountHealth", () => {
  it("healthy: shows Connected + the account id + the region, and offers no fix", () => {
    render(<AccountHealth health="healthy" accountId="123456789012" region="eu-west-1" onSwitchRegion={noop} onFix={noop} />);
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText(/123456789012/)).toBeTruthy();
    expect(screen.getByText("eu-west-1")).toBeTruthy(); // region chip
    expect(screen.queryByRole("button", { name: /Reconnect|Fix access|Connect AWS/ })).toBeNull();
  });

  it("unreachable: offers Reconnect and routes to the change-credentials flow", () => {
    const onFix = vi.fn();
    render(<AccountHealth health="unreachable" region="eu-west-1" onSwitchRegion={noop} onFix={onFix} />);
    expect(screen.getByText("Can't reach AWS")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(onFix).toHaveBeenCalledWith("change-creds");
  });

  it("unauthorized: flags a policy gap and offers Fix access (→ update-policy)", () => {
    const onFix = vi.fn();
    render(<AccountHealth health="unauthorized" region="eu-west-1" onSwitchRegion={noop} onFix={onFix} />);
    expect(screen.getByText("Access needs a fix")).toBeTruthy();
    expect(screen.getByText(/policy needs updating/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fix access" }));
    expect(onFix).toHaveBeenCalledWith("update-policy");
  });

  it("disconnected: offers Connect AWS (connect) and hides the region chip", () => {
    const onFix = vi.fn();
    render(<AccountHealth health="disconnected" region={null} onSwitchRegion={noop} onFix={onFix} />);
    expect(screen.getByText("Not connected")).toBeTruthy();
    expect(screen.queryByText("eu-west-1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connect AWS" }));
    expect(onFix).toHaveBeenCalledWith("connect");
  });
});
