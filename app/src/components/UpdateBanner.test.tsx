// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { UpdateBanner } from "./UpdateBanner";
import type { AvailableUpdate } from "../lib/selfUpdate";

afterEach(cleanup);

function update(over: Partial<AvailableUpdate> = {}): AvailableUpdate {
  return {
    version: "0.9.9",
    body: "notes",
    install: vi.fn(async () => {}),
    relaunch: vi.fn(async () => {}),
    ...over,
  };
}

describe("UpdateBanner", () => {
  it("renders nothing when the app is up to date (or the check can't run)", async () => {
    const { container } = render(<UpdateBanner check={async () => null} />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("informs, and installs ONLY on explicit confirmation", async () => {
    const u = update();
    render(<UpdateBanner check={async () => u} />);
    await screen.findByText(/AgentsPoppy 0.9.9 is available/);
    expect(u.install).not.toHaveBeenCalled(); // never auto-installs

    fireEvent.click(screen.getByText("Update & restart"));
    await waitFor(() => expect(u.install).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(u.relaunch).toHaveBeenCalledTimes(1));
  });

  it("'Not now' dismisses without installing", async () => {
    const u = update();
    render(<UpdateBanner check={async () => u} />);
    await screen.findByText(/is available/);
    fireEvent.click(screen.getByText("Not now"));
    expect(screen.queryByText(/is available/)).toBeNull();
    expect(u.install).not.toHaveBeenCalled();
  });

  it("surfaces an install failure and offers retry", async () => {
    const u = update({ install: vi.fn(async () => { throw new Error("network dropped"); }) });
    render(<UpdateBanner check={async () => u} />);
    await screen.findByText(/is available/);
    fireEvent.click(screen.getByText("Update & restart"));
    await screen.findByText("Try again");
    expect(screen.getByText(/network dropped/)).toBeTruthy();
    expect(u.relaunch).not.toHaveBeenCalled();
  });
});
