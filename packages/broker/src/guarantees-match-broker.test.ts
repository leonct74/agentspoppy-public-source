// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The numbers Panel 1 quotes to the user are mirrored in browser-safe core
 * (guarantees.ts) rather than imported from the broker. This test is the tether:
 * if the broker's real constants ever move, the mirror fails here before a stale
 * number reaches an approval screen. Same guard shape as
 * rating-matches-compiler.test.ts, and for the same reason — a number quoted to
 * the user is a claim, and a stale claim is a false one.
 *
 * It reads the SOURCE, not an export: sts.ts is a §4 mechanism file, and adding
 * an export there just to feed a test is a worse trade than a strict regex here.
 * Each regex is anchored to the exact declaration; if the line is renamed or
 * removed the match count drops to zero and the test fails on that, so it can
 * never pass vacuously against a file that no longer says what it claims.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APPROVAL_WINDOW_MINUTES, SESSION_MAX_SECONDS } from "@agentspoppy/core";

const src = (rel: string) => readFileSync(join(__dirname, rel), "utf8");

describe("guarantees.ts mirrors the broker's real numbers", () => {
  it("session lifetime: core's SESSION_MAX_SECONDS is the broker's DEFAULT_DURATION_SECONDS", () => {
    const m = src("aws/sts.ts").match(/^const DEFAULT_DURATION_SECONDS = (\d+);$/m);
    expect(m, "sts.ts no longer declares DEFAULT_DURATION_SECONDS — update this test AND guarantees.ts").toBeTruthy();
    expect(Number(m![1])).toBe(SESSION_MAX_SECONDS);
  });

  it("approval window: core's APPROVAL_WINDOW_MINUTES is the broker's APPROVAL_TTL_MS", () => {
    const m = src("service.ts").match(/^const APPROVAL_TTL_MS = (\d+) \* 60 \* 1000;$/m);
    expect(m, "service.ts no longer declares APPROVAL_TTL_MS in minutes — update this test AND guarantees.ts").toBeTruthy();
    expect(Number(m![1])).toBe(APPROVAL_WINDOW_MINUTES);
  });

  it("the role-chain cap agrees too — a poppy chaining sessions gains nothing", () => {
    const m = src("aws/sts.ts").match(/^const ROLE_CHAIN_MAX_DURATION = (\d+);$/m);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeLessThanOrEqual(SESSION_MAX_SECONDS);
  });
});
