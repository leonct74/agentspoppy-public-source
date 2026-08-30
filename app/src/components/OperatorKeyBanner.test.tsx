// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { OperatorKeyBanner } from "./OperatorKeyBanner";
import type { CallerIdentity, SetupVersionStatus } from "../api/broker";

afterEach(cleanup);

const OPERATOR: CallerIdentity = {
  accountId: "123456789012",
  arn: "arn:aws:iam::123456789012:user/AgentsPoppyOperator",
  userId: "U",
};
const SETUP_KEY: CallerIdentity = {
  accountId: "123456789012",
  arn: "arn:aws:iam::123456789012:user/admin-setup",
  userId: "U",
};
const status = (over: Partial<SetupVersionStatus> = {}): SetupVersionStatus => ({
  state: "current",
  deployed: 4,
  expected: 4,
  ...over,
});

function mount(props: {
  identity?: CallerIdentity | null;
  st?: SetupVersionStatus;
  accountId?: string | null;
  onSwitched?: () => void;
  switchKey?: (a: string, e: boolean) => Promise<{ setupNotUpdated?: boolean }>;
}) {
  return render(
    <OperatorKeyBanner
      accountId={props.accountId ?? "acct-1"}
      onSwitched={props.onSwitched}
      loadIdentity={async () => props.identity ?? SETUP_KEY}
      loadStatus={async () => props.st ?? status()}
      switchKey={props.switchKey ?? (async () => ({}))}
    />,
  );
}

describe("OperatorKeyBanner (step 0)", () => {
  it("stays silent when the machine is already on the operator key", async () => {
    const { container } = mount({ identity: OPERATOR });
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("stays silent with no linked account", async () => {
    const { container } = mount({ accountId: null });
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it.each(["absent", "pending"] as const)("stays silent while setup is %s", async (state) => {
    const { container } = mount({ st: status({ state }) });
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("warns when standing on a powerful setup key and offers the one-click switch", async () => {
    mount({});
    expect(await screen.findByText(/powerful setup key/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Switch to the operator key/i })).toBeTruthy();
  });

  it("runs the keys-first switch and reports success", async () => {
    const onSwitched = vi.fn();
    const switchKey = vi.fn(async () => ({}));
    mount({ onSwitched, switchKey });
    fireEvent.click(await screen.findByRole("button", { name: /Switch to the operator key/i }));
    await waitFor(() => expect(switchKey).toHaveBeenCalledWith("acct-1", false));
    expect(onSwitched).toHaveBeenCalled();
    expect(await screen.findByText(/now uses the restricted operator key/i)).toBeTruthy();
  });

  it("surfaces the eviction gate and retries with consent", async () => {
    const switchKey = vi
      .fn()
      .mockRejectedValueOnce(new Error("eviction_required: the operator user is at the two-access-key limit (AKIAOLD)"))
      .mockResolvedValueOnce({});
    mount({ switchKey });
    fireEvent.click(await screen.findByRole("button", { name: /Switch to the operator key/i }));
    // The named key appears, then confirming retries with allowEviction=true.
    expect(await screen.findByText(/two-access-key limit/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Delete that key and continue/i }));
    await waitFor(() => expect(switchKey).toHaveBeenLastCalledWith("acct-1", true));
  });

  it("uses the SOFT variant (no false alarm) when setup can't be verified", async () => {
    // A non-operator key that also can't read the stack: offer setup, don't claim a fix path
    // that can't run. `unknown` is the only non-silent unverified state.
    mount({ st: status({ state: "unknown", deployed: null, reason: "couldn't read the stack" }) });
    expect(await screen.findByText(/can't verify your setup/i)).toBeTruthy();
    // No powerful-key one-click switch in this state — the safe route is full setup.
    expect(screen.queryByRole("button", { name: /Switch to the operator key/i })).toBeNull();
  });
});
