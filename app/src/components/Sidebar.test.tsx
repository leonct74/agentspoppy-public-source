// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Sidebar, type SidebarExtension } from "./Sidebar";

afterEach(cleanup);

const exts: SidebarExtension[] = [{ id: "com.mailpoppy.desktop", name: "MailPoppy", backend: "running" }];
const noop = () => {};

describe("Sidebar", () => {
  it("renders brand, the health panel, Dashboard, the extensions, and Activity", () => {
    render(
      <Sidebar
        active="dashboard"
        extensions={exts}
        health="healthy"
        onFixConnection={noop}
        onDashboard={noop}
        onDirectory={noop}
        onActivity={noop}
        onPurchases={noop}
        onExtension={noop}
      />,
    );
    expect(screen.getByText("AgentsPoppy")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy(); // from the account-health panel
    expect(screen.getByText("Dashboard")).toBeTruthy();
    expect(screen.getByText("Poppies")).toBeTruthy();
    expect(screen.getByText("MailPoppy")).toBeTruthy();
    expect(screen.getByText("Activity")).toBeTruthy();
  });

  it("shows an empty hint when no extensions are installed, and a not-connected panel", () => {
    render(
      <Sidebar
        active="dashboard"
        extensions={[]}
        health="disconnected"
        onFixConnection={noop}
        onDashboard={noop}
        onDirectory={noop}
        onActivity={noop}
        onPurchases={noop}
        onExtension={noop}
      />,
    );
    expect(screen.getByText("None installed yet")).toBeTruthy();
    expect(screen.getByText("Not connected")).toBeTruthy();
  });

  it.each([
    ["paused", "Paused"],
    ["revoked", "Revoked"],
    ["blocked", "Blocked"],
  ] as const)("makes a %s poppy unmistakable: a labelled pill + state styling + dot", (backend, label) => {
    render(
      <Sidebar
        active="dashboard"
        extensions={[{ id: "com.mailpoppy.desktop", name: "MailPoppy", backend }]}
        health="healthy"
        onFixConnection={noop}
        onDashboard={noop}
        onDirectory={noop}
        onActivity={noop}
        onPurchases={noop}
        onExtension={noop}
      />,
    );
    // The visible pill + the state styling both call it out — you can't stop one and forget.
    expect(screen.getByText(label)).toBeTruthy();
    const item = screen.getByText("MailPoppy").closest("button");
    expect(item?.className).toContain(`ext-item--${backend}`);
    expect(item?.querySelector(`.ext-dot.ext-${backend}`)).toBeTruthy();
  });

  it("routes clicks to the right handler", () => {
    const onDashboard = vi.fn();
    const onDirectory = vi.fn();
    const onActivity = vi.fn();
    const onExtension = vi.fn();
    render(
      <Sidebar
        active={{ ext: "com.mailpoppy.desktop" }}
        extensions={exts}
        health="healthy"
        onFixConnection={noop}
        onDashboard={onDashboard}
        onDirectory={onDirectory}
        onActivity={onActivity}
        onPurchases={noop}
        onExtension={onExtension}
      />,
    );
    fireEvent.click(screen.getByText("Dashboard"));
    fireEvent.click(screen.getByText("Poppies"));
    fireEvent.click(screen.getByText("Activity"));
    fireEvent.click(screen.getByText("MailPoppy"));
    expect(onDashboard).toHaveBeenCalled();
    expect(onDirectory).toHaveBeenCalled();
    expect(onActivity).toHaveBeenCalled();
    expect(onExtension).toHaveBeenCalledWith("com.mailpoppy.desktop");
  });

  it("shows a poppy's app icon in its avatar, letter as the fallback", () => {
    render(
      <Sidebar
        active="dashboard"
        extensions={[
          { id: "com.mailpoppy.desktop", name: "MailPoppy", backend: "running", iconUrl: "http://127.0.0.1:8799/ext-ui/com.mailpoppy.desktop/icon.png" },
          { id: "com.example.bare", name: "BarePoppy", backend: "running" },
        ]}
        health="healthy"
        onFixConnection={noop}
        onDashboard={noop}
        onDirectory={noop}
        onActivity={noop}
        onPurchases={noop}
        onExtension={noop}
      />,
    );
    const img = document.querySelector(".poppy-avatar img") as HTMLImageElement | null;
    expect(img?.getAttribute("src")).toBe("http://127.0.0.1:8799/ext-ui/com.mailpoppy.desktop/icon.png");
    // The icon-less poppy keeps its letter avatar.
    expect(screen.getByText("B")).toBeTruthy();
    expect(document.querySelectorAll(".poppy-avatar img")).toHaveLength(1);
  });

});
