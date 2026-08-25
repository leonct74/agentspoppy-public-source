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

  // Someone the Store moved across several versions should read all of them.
  it("shows every version the user skipped", async () => {
    mount({ version: "0.3.5", seen: "0.3.3" });
    await screen.findByRole("dialog");
    expect(screen.getByText("Confined by default.")).toBeTruthy();
    expect(screen.getByText("Windows update fix.")).toBeTruthy();
    expect(screen.queryByText("Setup wizard.")).toBeNull();
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

  // A feed that is missing, empty or has no entry for this version must degrade to a
  // sentence — never an error, and never a blank box.
  it("says so plainly when there are no notes for this version", async () => {
    mount({ version: "9.9.9", seen: "0.3.3", notes: NOTES });
    const button = await screen.findByRole("button", { name: /AgentsPoppy 9\.9\.9/ });
    fireEvent.click(button);
    expect(await screen.findByText(/no notes for this version/i)).toBeTruthy();
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
