// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { KeySecurityPanel, keyAgeDays } from "./KeySecurityPanel";
import { ApiError } from "../api/broker";

afterEach(cleanup);

const daysAgo = (n: number): string => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

describe("keyAgeDays", () => {
  it("counts whole days since the mint time", () => {
    expect(keyAgeDays(daysAgo(0))).toBe(0);
    expect(keyAgeDays(daysAgo(95))).toBe(95);
  });
  it("returns null on an unparseable timestamp", () => {
    expect(keyAgeDays("not-a-date")).toBeNull();
  });
});

describe("KeySecurityPanel", () => {
  it("stays hidden when no key is stored on this machine", async () => {
    const { container } = render(
      <KeySecurityPanel loadInfo={async () => ({ profileKeyId: null, mintedAt: null })} revoke={vi.fn()} />,
    );
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("shows the key id and a rotation nudge past 90 days", async () => {
    render(
      <KeySecurityPanel
        loadInfo={async () => ({ profileKeyId: "AKIAOLD", mintedAt: daysAgo(120) })}
        revoke={vi.fn()}
      />,
    );
    expect(await screen.findByText(/AKIAOLD/)).toBeTruthy();
    expect(screen.getByText(/over 90 days old/i)).toBeTruthy();
  });

  it("no rotation nudge for a fresh key", async () => {
    render(
      <KeySecurityPanel loadInfo={async () => ({ profileKeyId: "AKIANEW", mintedAt: daysAgo(3) })} revoke={vi.fn()} />,
    );
    expect(await screen.findByText(/AKIANEW/)).toBeTruthy();
    expect(screen.queryByText(/over 90 days old/i)).toBeNull();
  });

  it("confirms before revoking and reports the honest outcome", async () => {
    const revoke = vi.fn(async () => ({ deletedKeyId: "AKIAOLD", alreadyGone: false }));
    const onRevoked = vi.fn();
    render(
      <KeySecurityPanel
        loadInfo={async () => ({ profileKeyId: "AKIAOLD", mintedAt: daysAgo(1) })}
        revoke={revoke}
        onRevoked={onRevoked}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Revoke this computer's key…/i }));
    // A confirm step, not an immediate destructive action.
    expect(screen.getByText(/compromised/i)).toBeTruthy();
    expect(revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Revoke the key now/i }));
    await waitFor(() => expect(revoke).toHaveBeenCalled());
    expect(onRevoked).toHaveBeenCalled();
    expect(await screen.findByText(/removed from this machine/i)).toBeTruthy();
  });

  it("routes a not_operator refusal to its guidance, not a raw error", async () => {
    const revoke = vi.fn(async () => {
      throw new ApiError(409, "not_operator", "This machine isn't on the operator key — switch it first.");
    });
    render(
      <KeySecurityPanel
        loadInfo={async () => ({ profileKeyId: "AKIAX", mintedAt: daysAgo(1) })}
        revoke={revoke}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Revoke this computer's key…/i }));
    fireEvent.click(screen.getByRole("button", { name: /Revoke the key now/i }));
    expect(await screen.findByText(/switch it first/i)).toBeTruthy();
  });
});
