// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { watchParent } from "./parent-watch";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("watchParent", () => {
  it("stays quiet while the parent is alive", () => {
    const onGone = vi.fn();
    watchParent({ parentPid: 42, currentPpid: () => 42, isAlive: () => true, onGone });
    vi.advanceTimersByTime(60_000);
    expect(onGone).not.toHaveBeenCalled();
  });

  it("fires once when the ppid changes (reparented to init = parent died)", () => {
    const onGone = vi.fn();
    let ppid = 42;
    watchParent({ parentPid: 42, currentPpid: () => ppid, isAlive: () => true, onGone });
    vi.advanceTimersByTime(4_000);
    expect(onGone).not.toHaveBeenCalled();
    ppid = 1; // orphaned
    vi.advanceTimersByTime(10_000);
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it("fires when the kill(pid, 0) probe says the parent is gone (no-reparent platforms)", () => {
    const onGone = vi.fn();
    let alive = true;
    watchParent({ parentPid: 42, currentPpid: () => 42, isAlive: () => alive, onGone });
    alive = false;
    vi.advanceTimersByTime(4_000);
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it("stop() cancels the watch", () => {
    const onGone = vi.fn();
    const stop = watchParent({ parentPid: 42, currentPpid: () => 1, isAlive: () => false, onGone });
    stop();
    vi.advanceTimersByTime(10_000);
    expect(onGone).not.toHaveBeenCalled();
  });
});
