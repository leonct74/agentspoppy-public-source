// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SetupUpdateBanner } from "./SetupUpdateBanner";
import type { SetupVersionStatus } from "../api/broker";
import { broker } from "../api/broker";

// The DEFAULT load path — the only one the app actually uses, and the one every other test
// here bypasses by injecting a stable `load`. That gap hid a real fetch loop.
vi.mock("../api/broker", async (orig) => ({
  ...(await orig<typeof import("../api/broker")>()),
  broker: { setupStatus: vi.fn(async () => ({ state: "outdated", deployed: 1, expected: 2 })) },
}));

afterEach(cleanup);

const status = (over: Partial<SetupVersionStatus>): SetupVersionStatus => ({
  state: "current",
  deployed: 2,
  expected: 2,
  ...over,
});

const show = (s: SetupVersionStatus, onUpdate = vi.fn()) =>
  render(<SetupUpdateBanner onUpdate={onUpdate} load={async () => s} />);

describe("SetupUpdateBanner", () => {
  it("says nothing when the deployed setup is current", async () => {
    const { container } = show(status({ state: "current" }));
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  // The two silent states, each for its own reason: there is no setup to be stale
  // (the user has a louder path for that), or one is being deployed right now.
  it.each(["absent", "pending"] as const)("stays silent while the setup is %s", async (state) => {
    const { container } = show(status({ state }));
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("tells a stale user what is actually at stake, and what it will cost them", async () => {
    show(status({ state: "outdated", deployed: 1, expected: 2 }));
    await screen.findByText(/setup needs updating/i);
    // The point, in the user's terms: protections added since then are NOT in place.
    expect(screen.getByText(/isn't actually in place/i)).toBeTruthy();
    expect(screen.getByText(/setup version 1/i)).toBeTruthy();
    // Never spring the credential requirement on them after they've started — and name BOTH
    // paths: admin keys, or the access-policy user with the policy brought up to date. Saying
    // only "admin keys" sent a least-privilege user hunting for credentials they don't have.
    expect(screen.getByText(/setup credentials once/i)).toBeTruthy();
    expect(screen.getByText(/access\s+policy/i)).toBeTruthy();
  });

  // Crying wolf is how a security banner gets trained out of a user. A check that
  // FAILED must not be reported as a verdict that the setup is old.
  it("says 'couldn't check' — not 'out of date' — when the read failed", async () => {
    show(status({ state: "unknown", deployed: null, reason: "these AWS credentials are expired or invalid" }));
    await screen.findByText(/couldn't check your setup/i);
    expect(screen.getByText(/expired or invalid/)).toBeTruthy();
    expect(screen.queryByText(/needs updating/i)).toBeNull();
  });

  it("acts only on an explicit click, and can be put off for the session", async () => {
    const onUpdate = vi.fn();
    const { container } = show(status({ state: "outdated", deployed: 1 }), onUpdate);
    await screen.findByText(/setup needs updating/i);
    expect(onUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /update setup/i }));
    expect(onUpdate).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("hides itself rather than breaking the screen when the broker is unreachable", async () => {
    const { container } = render(
      <SetupUpdateBanner onUpdate={vi.fn()} load={async () => { throw new Error("broker down"); }} />,
    );
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  // A banner that keeps nagging after the user has done what it asked is worse than no
  // banner: it teaches them the warning means nothing.
  it("re-checks when setup may have changed, and clears once it's current", async () => {
    let state: SetupVersionStatus["state"] = "outdated";
    const load = async () => status({ state, deployed: state === "outdated" ? 1 : 2 });
    const { rerender, container } = render(
      <SetupUpdateBanner onUpdate={vi.fn()} refreshKey={0} load={load} />,
    );
    await screen.findByText(/setup needs updating/i);

    state = "current"; // the user re-applied
    rerender(<SetupUpdateBanner onUpdate={vi.fn()} refreshKey={1} load={load} />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  // "Not now" answers the verdict it was shown for. A LATER, different verdict is new
  // information, and hiding that would silently swallow a real staleness warning.
  it("does not let an old 'not now' suppress a fresh check", async () => {
    const load = async () => status({ state: "outdated", deployed: 1 });
    const { rerender } = render(<SetupUpdateBanner onUpdate={vi.fn()} refreshKey={0} load={load} />);
    await screen.findByText(/setup needs updating/i);
    fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    await waitFor(() => expect(screen.queryByText(/setup needs updating/i)).toBeNull());

    rerender(<SetupUpdateBanner onUpdate={vi.fn()} refreshKey={1} load={load} />);
    await screen.findByText(/setup needs updating/i);
  });

  // Regression: `load` defaulted to an inline closure, so it was a new function identity on
  // every render AND an effect dependency — fetch → setState → re-render → fetch, measured at
  // ~11,500 CloudFormation-backed calls in 300ms. Fast enough to throttle the account into
  // the "couldn't check" state this component exists to prevent.
  it("checks ONCE with the default loader, not on every render", async () => {
    const calls = broker.setupStatus as unknown as ReturnType<typeof vi.fn>;
    calls.mockClear();
    render(<SetupUpdateBanner onUpdate={vi.fn()} />);
    await screen.findByText(/setup needs updating/i);
    await new Promise((r) => setTimeout(r, 60));
    expect(calls.mock.calls.length).toBe(1);
  });

  // The same loop also made "Not now" impossible to use once refreshKey was non-zero: the
  // effect re-ran constantly and un-dismissed the banner between the click and the repaint.
  it("keeps a dismissal until the NEXT re-check, not merely until the next render", async () => {
    const load = async () => status({ state: "outdated", deployed: 1 });
    const { rerender, container } = render(
      <SetupUpdateBanner onUpdate={vi.fn()} refreshKey={3} load={load} />,
    );
    await screen.findByText(/setup needs updating/i);
    fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    await waitFor(() => expect(container.firstChild).toBeNull());

    // A plain re-render at the SAME refreshKey must not resurrect it.
    rerender(<SetupUpdateBanner onUpdate={vi.fn()} refreshKey={3} load={load} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(container.firstChild).toBeNull();
  });
});
