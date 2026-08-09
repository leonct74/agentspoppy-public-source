// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { defineFeedbackTab, type FeedbackBridge, DONATION_MIN_USD, FEATURE_REQUEST_MAX } from "./feedback-tab";

const API = "https://api.test";
const POPPY = "com.demo.poppy";

/**
 * The tab talks to the feedback API itself and asks the host for ONE thing: openExternal. So the
 * test stubs `fetch` (the API) and a one-method bridge (the host) — which is the whole point of
 * the design: no host release is needed to ship this.
 */
function stubWorld(opts: { failDonate?: boolean; failRating?: boolean } = {}) {
  const calls: Array<[string, unknown[]]> = [];
  let rating = { average: 4.5, count: 2, yours: null as number | null };

  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = String(url).replace(`${API}/api/feedback/`, "").split("?")[0];
    const ok = (json: unknown) => ({ ok: true, status: 200, json: async () => json }) as unknown as Response;

    if (path === "rating" && !init?.body) {
      if (opts.failRating) throw new Error("offline");
      return ok(rating);
    }
    if (path === "rating") {
      calls.push(["rate", [body.stars, body.poppyId, body.buyerId]]);
      rating = { average: 4.7, count: 3, yours: body.stars };
      return ok(rating);
    }
    if (path === "feature-request") {
      calls.push(["sendFeatureRequest", [body.text]]);
      return ok({ ok: true });
    }
    if (path === "donate") {
      if (opts.failDonate) {
        return { ok: false, status: 409, json: async () => ({ error: "donations_unavailable" }) } as unknown as Response;
      }
      calls.push(["donate", [body.amountUsd, body.message]]);
      return ok({ url: "https://checkout.stripe.test/session" });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const bridge: FeedbackBridge = {
    openExternal: async (url: string) => {
      calls.push(["openExternal", [url]]);
    },
  };
  return { bridge, calls };
}

const BUGS = "https://github.com/leonct74/demo/issues";

// A custom element can only be defined ONCE per document, so the definition captures whichever
// bridge it was given first. Production is one poppy = one bridge, so that's correct there; here
// we define a delegating bridge once and point it at each test's stub.
let active: FeedbackBridge;
const delegating = new Proxy({} as FeedbackBridge, {
  get:
    (_t, method: string) =>
    (...args: unknown[]) =>
      (active as unknown as Record<string, (...a: unknown[]) => unknown>)[method](...args),
});

/** Mount the element and let its async rating load settle. */
async function mount(bridge: FeedbackBridge, attrs = `bugs="${BUGS}" name="DemoPoppy"`) {
  active = bridge;
  defineFeedbackTab(delegating);
  document.body.innerHTML = `<agentspoppy-feedback poppy="${POPPY}" api="${API}" ${attrs}></agentspoppy-feedback>`;
  const el = document.querySelector("agentspoppy-feedback")!;
  await Promise.resolve();
  await Promise.resolve();
  return el.shadowRoot!;
}

const $ = (root: ShadowRoot, sel: string) => root.querySelector(sel) as HTMLElement | null;

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the standard Feedback tab", () => {
  it("shows all four things a user can do", async () => {
    const { bridge } = stubWorld();
    const root = await mount(bridge);
    const headings = Array.from(root.querySelectorAll("h3")).map((h) => h.textContent);
    expect(headings).toEqual(["Rate DemoPoppy", "Ask for a feature", "Report a bug", "Support the developer"]);
  });

  it("rates through the host and reflects the new tally", async () => {
    const { bridge, calls } = stubWorld();
    const root = await mount(bridge);
    ($(root, '[data-star="4"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(calls.some((c) => c[0] === "rate" && (c[1] as unknown[])[0] === 4)).toBe(true));
    // The rating is recorded against THIS poppy, by a stable per-install id it minted itself.
    const rateCall = calls.find((c) => c[0] === "rate")![1] as unknown[];
    expect(rateCall[1]).toBe(POPPY);
    expect(String(rateCall[2])).not.toHaveLength(0);
    await vi.waitFor(() => expect($(root, ".tally")!.textContent).toContain("you gave 4"));
  });

  it("sends a feature request and clears the box, refusing an empty one", async () => {
    const { bridge, calls } = stubWorld();
    const root = await mount(bridge);
    const box = $(root, "#request") as HTMLTextAreaElement;
    const send = $(root, "#send-request") as HTMLButtonElement;

    expect(send.disabled).toBe(true); // nothing typed yet
    box.value = "  please add dark mode  ";
    box.dispatchEvent(new Event("input"));
    expect(send.disabled).toBe(false);
    expect($(root, "#request-count")!.textContent).toBe(`20/${FEATURE_REQUEST_MAX}`);

    send.click();
    await vi.waitFor(() => expect(calls).toContainEqual(["sendFeatureRequest", ["please add dark mode"]]));
    await vi.waitFor(() => expect(box.value).toBe(""));
  });

  it("keeps what the user typed when they rate — rating must not wipe the boxes", async () => {
    const { bridge } = stubWorld();
    const root = await mount(bridge);
    const box = $(root, "#request") as HTMLTextAreaElement;
    const msg = $(root, "#donate-message") as HTMLInputElement;
    box.value = "half-written thought";
    msg.value = "sam@example.com";

    ($(root, '[data-star="5"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect($(root, ".tally")!.textContent).toContain("you gave 5"));

    // Same nodes, same content: a full re-render would have thrown both away.
    expect(($(root, "#request") as HTMLTextAreaElement).value).toBe("half-written thought");
    expect(($(root, "#donate-message") as HTMLInputElement).value).toBe("sam@example.com");
  });

  it("opens the public issue tracker for a bug — it never posts the bug itself", async () => {
    const { bridge, calls } = stubWorld();
    const root = await mount(bridge);
    ($(root, "#report-bug") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(calls).toContainEqual(["openExternal", [BUGS]]));
  });

  it("explains itself instead of dead-ending when there is no issue tracker", async () => {
    const { bridge } = stubWorld();
    const root = await mount(bridge, 'name="DemoPoppy"');
    expect($(root, "#report-bug")).toBeNull();
    expect(root.textContent).toContain("hasn't published a public issue tracker");
  });

  it("donates the chosen amount with the optional message", async () => {
    const { bridge, calls } = stubWorld();
    const root = await mount(bridge);
    ($(root, '[data-amount="25"]') as HTMLButtonElement).click();
    const msg = $(root, "#donate-message") as HTMLInputElement;
    msg.value = "thanks! sam@example.com";
    msg.dispatchEvent(new Event("input"));
    ($(root, "#donate") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(calls).toContainEqual(["donate", [25, "thanks! sam@example.com"]]));
    // The one host call: the frame can't open an OS window itself.
    await vi.waitFor(() => expect(calls).toContainEqual(["openExternal", ["https://checkout.stripe.test/session"]]));
  });

  it("cannot donate less than the minimum — the button goes dead, and nothing reaches the host", async () => {
    const { bridge, calls } = stubWorld();
    const root = await mount(bridge);
    const amount = $(root, "#amount") as HTMLInputElement;
    const donate = $(root, "#donate") as HTMLButtonElement;

    amount.value = "2";
    amount.dispatchEvent(new Event("input"));
    expect(donate.disabled).toBe(true);
    donate.click();
    await Promise.resolve();
    expect(calls.some((c) => c[0] === "donate")).toBe(false);

    // Back above the floor and it works again.
    amount.value = String(DONATION_MIN_USD);
    amount.dispatchEvent(new Event("input"));
    expect(donate.disabled).toBe(false);
    donate.click();
    await vi.waitFor(() => expect(calls).toContainEqual(["donate", [DONATION_MIN_USD, undefined]]));
  });

  it("tells the user when the developer can't receive donations", async () => {
    const { bridge } = stubWorld({ failDonate: true });
    const root = await mount(bridge);
    ($(root, "#donate") as HTMLButtonElement).click();
    await vi.waitFor(() => expect($(root, "#donate-msg")!.textContent).toContain("hasn't set up payments"));
  });

  it("survives a host that cannot read the rating", async () => {
    const { bridge } = stubWorld({ failRating: true });
    const root = await mount(bridge);
    expect($(root, ".tally")!.textContent).toContain("No ratings yet");
  });
});
