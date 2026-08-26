// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { WhatsNew } from "./WhatsNew";
import type { ReleaseNote } from "../lib/whatsNew";

afterEach(cleanup);

const NOTES: ReleaseNote[] = [
  { version: "0.3.5", date: "2026-08-24", summary: "Confined by default.", changes: ["Poppies are confined."] },
  { version: "0.3.4", date: "2026-08-22", summary: "Windows update fix.", changes: ["Updates no longer fail."] },
  { version: "0.3.3", date: "2026-08-12", summary: "Setup wizard.", changes: ["Guided AWS setup."] },
  { version: "0.3.2", date: "2026-08-11", summary: "Policy link fix.", changes: ["The link works."] },
];

function mount(opts: { version?: string | null; seen?: string | null; notes?: ReleaseNote[] } = {}) {
  const writeSeen = vi.fn();
  render(
    <WhatsNew
      readVersion={async () => opts.version ?? "0.3.5"}
      loadNotes={async () => opts.notes ?? NOTES}
      readSeen={() => (opts.seen === undefined ? "0.3.3" : opts.seen)}
      writeSeen={writeSeen}
    />,
  );
  return { writeSeen };
}

describe("WhatsNew", () => {
  it("opens by itself when the version changed since last launch", async () => {
    mount({ version: "0.3.5", seen: "0.3.3" });
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Confined by default.")).toBeTruthy();
  });

  // Someone the Store moved across several versions should read all of them — and the
  // ones they skipped are marked, so "what am I accepting?" is still answerable at a
  // glance within the full list.
  it("marks the versions the user skipped as new", async () => {
    mount({ version: "0.3.5", seen: "0.3.3" });
    await screen.findByRole("dialog");
    expect(screen.getAllByText("New").length).toBe(2); // 0.3.5 and 0.3.4, not 0.3.3
  });

  // The history is the point: showing only what changed answers one question and then
  // vanishes, leaving no way to look back at what a version did.
  it("lists every release, not just the unseen ones", async () => {
    mount({ version: "0.3.5", seen: "0.3.3" });
    await screen.findByRole("dialog");
    expect(screen.getByText("Confined by default.")).toBeTruthy();
    expect(screen.getByText("Windows update fix.")).toBeTruthy();
    expect(screen.getByText("Setup wizard.")).toBeTruthy();
  });

  it("still shows the whole history when nothing is new", async () => {
    mount({ version: "0.3.5", seen: "0.3.5" });
    fireEvent.click(await screen.findByRole("button", { name: /AgentsPoppy 0\.3\.5/ }));
    await screen.findByRole("dialog");
    expect(screen.getByText("Setup wizard.")).toBeTruthy();
    expect(screen.getByText("Policy link fix.")).toBeTruthy();
    expect(screen.queryByText("New")).toBeNull();
  });

  it("marks which release you are running", async () => {
    mount({ version: "0.3.4", seen: "0.3.4" });
    fireEvent.click(await screen.findByRole("button", { name: /AgentsPoppy 0\.3\.4/ }));
    expect(await screen.findByText("You have this")).toBeTruthy();
  });

  it("stays shut when the version has not changed", async () => {
    mount({ version: "0.3.5", seen: "0.3.5" });
    await waitFor(() => expect(screen.getByRole("button", { name: /AgentsPoppy 0\.3\.5/ })).toBeTruthy());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // A fresh install has changed nothing for this user.
  it("stays shut on a first run", async () => {
    mount({ version: "0.3.5", seen: null });
    await waitFor(() => expect(screen.getByRole("button", { name: /AgentsPoppy 0\.3\.5/ })).toBeTruthy());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("can be reopened from the version in the statusline", async () => {
    mount({ version: "0.3.5", seen: "0.3.5" });
    const button = await screen.findByRole("button", { name: /AgentsPoppy 0\.3\.5/ });
    fireEvent.click(button);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("records the version so it does not announce twice", async () => {
    const { writeSeen } = mount({ version: "0.3.5", seen: "0.3.3" });
    await screen.findByRole("dialog");
    expect(writeSeen).toHaveBeenCalledWith("0.3.5");
  });

  // A version the feed has never heard of still gets the history — it is useful on its
  // own — but nothing is claimed about the version being run.
  it("shows the history for a version with no entry of its own", async () => {
    mount({ version: "9.9.9", seen: "0.3.3", notes: NOTES });
    fireEvent.click(await screen.findByRole("button", { name: /AgentsPoppy 9\.9\.9/ }));
    await screen.findByRole("dialog");
    expect(screen.getByText("Confined by default.")).toBeTruthy();
    expect(screen.queryByText("You have this")).toBeNull();
  });

  it("survives an empty feed", async () => {
    mount({ version: "0.3.5", seen: "0.3.3", notes: [] });
    const button = await screen.findByRole("button", { name: /AgentsPoppy 0\.3\.5/ });
    fireEvent.click(button);
    expect(await screen.findByText(/no notes for this version/i)).toBeTruthy();
  });

  // Outside Tauri the version is unknowable, so the whole surface stays out of the way.
  it("renders nothing when the version cannot be read", async () => {
    const { container } = render(
      <WhatsNew
        readVersion={async () => null}
        loadNotes={async () => NOTES}
        readSeen={() => "0.3.3"}
        writeSeen={vi.fn()}
      />,
    );
    await waitFor(() => expect(container.textContent).toBe(""));
  });

  it("closes", async () => {
    mount({ version: "0.3.5", seen: "0.3.3" });
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByLabelText("Close"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
