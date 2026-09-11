// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * jsdom gaps that the app's components legitimately rely on in a real WKWebview.
 *
 * jsdom implements no layout, so it carries no `Element.prototype.scrollIntoView` at all —
 * the property is absent, not a no-op stub — and any component that scrolls something into
 * view throws under test. When that call sits inside a `requestAnimationFrame` callback the
 * throw escapes the test's own stack, so vitest reports it as an UNHANDLED error rather than
 * a failing assertion: the run exits non-zero while every assertion in it passes, which is a
 * uniquely unhelpful signal to land on.
 *
 * Kept here, not in any one test file, so it covers every component that scrolls and no test
 * file carries setup unrelated to what it asserts. Guarded so that a future jsdom which does
 * implement scrolling wins over this stub instead of being silently overwritten by it.
 */
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {
    /* no layout in jsdom — there is nothing to scroll */
  };
}
