// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, expect, it, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CustodyNotice } from "./CustodyNotice";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const info = (secretCustody: "keychain" | "file" | "none", profileKeyId: string | null = "TESTKEYIDEXAMPLE0000") =>
  () => Promise.resolve({ profileKeyId, secretCustody, vaultName: "macOS Keychain" });

describe("the one-time custody notice", () => {
  it("announces the migration once, and dismissal sticks", async () => {
    render(<CustodyNotice loadInfo={info("keychain")} />);
    await waitFor(() => expect(screen.getByText(/now lives in the macOS Keychain/i)).toBeTruthy());
    // reassuring register (rule 6): says what happened and that others are untouched
    expect(screen.getByText(/other AWS profiles and tools are untouched/i)).toBeTruthy();
    fireEvent.click(screen.getByText("Got it"));
    expect(screen.queryByText(/Keychain/)).toBeNull();
    cleanup();
    render(<CustodyNotice loadInfo={info("keychain")} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/Keychain/)).toBeNull(); // remembered
  });

  it("stays silent for file custody, no profile, and load failure — never a false announcement", async () => {
    render(<CustodyNotice loadInfo={info("file")} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/Keychain/)).toBeNull();
    cleanup();
    render(<CustodyNotice loadInfo={info("keychain", null)} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/Keychain/)).toBeNull();
    cleanup();
    render(<CustodyNotice loadInfo={() => Promise.reject(new Error("down"))} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/Keychain/)).toBeNull();
  });
});
