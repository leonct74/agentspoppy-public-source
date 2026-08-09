// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { RegionSwitcher } from "./RegionSwitcher";

afterEach(cleanup);

const noop = () => {};

describe("RegionSwitcher", () => {
  it("renders nothing until an account (region) is linked", () => {
    const { container } = render(<RegionSwitcher region={null} footprintRegions={[]} onSwitch={noop} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the current region as a chip and loads footprint on open", () => {
    const onOpen = vi.fn();
    render(<RegionSwitcher region="us-east-1" footprintRegions={[]} onOpen={onOpen} onSwitch={noop} />);
    fireEvent.click(screen.getByText("us-east-1"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/AWS region/)).toBeTruthy();
  });

  it("warns when switching to a region where the apps have no resources", () => {
    render(<RegionSwitcher region="us-east-1" footprintRegions={["eu-west-1"]} onSwitch={noop} />);
    fireEvent.click(screen.getByText("us-east-1"));
    // it tells you where the resources actually are…
    expect(screen.getByText(/Your apps. resources are in/i)).toBeTruthy();
    // …and selecting a region with none warns
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ap-south-1" } });
    expect(screen.getByRole("alert").textContent).toMatch(/no resources in/i);
  });

  it("switches only on the explicit button, with the chosen region", () => {
    const onSwitch = vi.fn();
    render(<RegionSwitcher region="us-east-1" footprintRegions={["eu-west-1"]} onSwitch={onSwitch} />);
    fireEvent.click(screen.getByText("us-east-1"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "eu-west-1" } });
    fireEvent.click(screen.getByRole("button", { name: /Switch to eu-west-1/ }));
    expect(onSwitch).toHaveBeenCalledWith("eu-west-1");
  });

  it("keeps the switch button disabled until you pick a different region", () => {
    render(<RegionSwitcher region="us-east-1" footprintRegions={[]} onSwitch={noop} />);
    fireEvent.click(screen.getByText("us-east-1"));
    // default selection equals the current region → nothing to do
    expect((screen.getByRole("button", { name: /Switch to us-east-1/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
