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

describe("UpdateBanner on Windows", () => {
  // The Store does not let an app install its own update, so the mac/Linux button would be
  // a promise this channel cannot keep. But "the Store does it for you" is only true by
  // default: auto-update is a setting the user can switch off, and even on, it can lag by
  // days. So the copy hedges and the button opens the listing.
  it("does not offer to install the update itself", async () => {
    render(<UpdateBanner check={async () => update()} onWindows />);
    await screen.findByText(/is available/);
    expect(screen.queryByText("Update & restart")).toBeNull();
  });

  it("offers the Store instead, without claiming the update is automatic", async () => {
    render(<UpdateBanner check={async () => update()} onWindows />);
    await screen.findByText(/is available/);
    expect(screen.getByText("Open Microsoft Store")).toBeTruthy();
    expect(screen.getByText(/usually installs Store updates on its own/)).toBeTruthy();
  });

  it("still offers to install on macOS and Linux", async () => {
    render(<UpdateBanner check={async () => update()} onWindows={false} />);
    await screen.findByText(/is available/);
    expect(screen.getByText("Update & restart")).toBeTruthy();
    expect(screen.queryByText("Open Microsoft Store")).toBeNull();
  });
});

describe("UpdateBanner release notes", () => {
  // The feed has always carried notes and the banner always dropped them, so people were
  // asked to accept an update without being told what was in it.
  it("shows the first line of the notes it already downloads", async () => {
    render(<UpdateBanner check={async () => update({ body: "**Confinement is the default now.**\n\nMore detail." })} onWindows={false} />);
    expect(await screen.findByText(/Confinement is the default now/)).toBeTruthy();
  });

  it("renders nothing extra when the release has no notes", async () => {
    const { container } = render(<UpdateBanner check={async () => update({ body: "" })} onWindows={false} />);
    await screen.findByText(/is available/);
    expect(container.querySelector(".update-banner__notes")).toBeNull();
  });
});

describe("UpdateBanner re-checks", () => {
  // Checking only at startup is why a running app never noticed 0.3.6: the app had been
  // open since before it was published, so the one check had already happened.
  it("checks again when the window regains focus", async () => {
    const check = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(update());
    render(<UpdateBanner check={check} onWindows={false} />);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/is available/)).toBeNull();

    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByText(/is available/)).toBeTruthy();
  });

  it("stops checking once unmounted", async () => {
    const check = vi.fn().mockResolvedValue(null);
    const { unmount } = render(<UpdateBanner check={check} onWindows={false} />);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    unmount();
    window.dispatchEvent(new Event("focus"));
    expect(check).toHaveBeenCalledTimes(1);
  });
});
