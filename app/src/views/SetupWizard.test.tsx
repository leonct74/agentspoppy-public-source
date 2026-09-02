// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { ConnectedAccount } from "@agentspoppy/core";
import type { CallerIdentity } from "../api/broker";
import { SetupWizard, friendlyError } from "./SetupWizard";

const account: ConnectedAccount = {
  id: "a1",
  accountId: "123456789012",
  regions: ["eu-west-1"],
  createdAt: "t",
};

const identity: CallerIdentity = {
  accountId: "123456789012",
  arn: "arn:aws:iam::123456789012:user/setup",
  userId: "U",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A broker where bootstrap + verify both succeed; verify can be made to fail N times first. */
function happyFetch({ verifyFailures = 0 }: { verifyFailures?: number } = {}) {
  let verifyCalls = 0;
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/bootstrap") && init?.method === "POST") {
      return jsonResponse({
        brokerRoleArn: "arn:aws:iam::123456789012:role/AgentsPoppyBroker",
        account: { ...account, roleArn: "arn:aws:iam::123456789012:role/AgentsPoppyBroker" },
      });
    }
    if (url.endsWith("/verify") && init?.method === "POST") {
      verifyCalls += 1;
      if (verifyCalls <= verifyFailures) {
        return jsonResponse({ ok: false, reason: "InvalidClientTokenId: key not active yet" });
      }
      return jsonResponse({ ok: true, assumedArn: "arn:aws:sts::123456789012:assumed-role/AgentsPoppyBroker/x" });
    }
    return jsonResponse({}, 404);
  });
  return { fn, verifyCount: () => verifyCalls };
}

function renderWizard(over: Partial<Parameters<typeof SetupWizard>[0]> = {}) {
  const props = {
    accounts: [] as ConnectedAccount[],
    identity: null,
    checking: false,
    onChanged: vi.fn(),
    onBack: vi.fn(),
    onDone: vi.fn(),
    onProSwitch: vi.fn(),
    verifyDelayMs: 0,
    ...over,
  };
  render(<SetupWizard {...props} />);
  return props;
}

/** Slide 1 → onward: the cloud chooser's "I already have an account". */
function enterAws() {
  fireEvent.click(screen.getByRole("button", { name: /I already have an account/ }));
}

/** IAM slide → key slide. */
function toKeyStep() {
  fireEvent.click(screen.getByRole("button", { name: /next: its access key/i }));
}

function fillKeys() {
  fireEvent.change(screen.getByPlaceholderText("AKIA…"), { target: { value: "AKIAWIZARD" } });
  fireEvent.change(screen.getByPlaceholderText(/•+/), { target: { value: "wizard-secret" } });
}

/** Key slide → region slide (paste path: region is LAST, its confirm is the finish). */
function toRegionStep() {
  fireEvent.click(screen.getByRole("button", { name: /choose where it lives/i }));
}

function pickRegion(place = /Europe \(Ireland\)/) {
  fireEvent.click(screen.getByRole("button", { name: place }));
}

/** The region slide's finish — deploys with everything collected. */
function finishSetup() {
  fireEvent.click(screen.getByRole("button", { name: /^Set up in / }));
}

/** The whole paste path in one call: cloud → policy → key → region → run. */
function walkPastePath() {
  enterAws();
  toKeyStep();
  fillKeys();
  toRegionStep();
  pickRegion();
  finishSetup();
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SetupWizard steps (founder redesign 2026-09-02: cloud → user → key → region)", () => {
  it("opens on the cloud chooser: AWS live, the other two greyed with coming soon", () => {
    vi.stubGlobal("fetch", happyFetch().fn);
    renderWizard();

    expect(screen.getByText("Step 1 of 4")).toBeTruthy();
    expect(screen.getByText("Choose your cloud")).toBeTruthy();
    expect(screen.getAllByText("Coming soon").length).toBe(2);
    // No console work and no region yet.
    expect(screen.queryByPlaceholderText("AKIA…")).toBeNull();
    expect(screen.queryByText("🇮🇪")).toBeNull();
  });

  it("the big AWS mark and the sign-up link both open AWS sign-up externally", () => {
    vi.stubGlobal("fetch", happyFetch().fn);
    const opened: string[] = [];
    vi.stubGlobal("open", (url?: string | URL) => {
      opened.push(String(url));
      return null;
    });
    renderWizard();

    fireEvent.click(screen.getByRole("button", { name: "Create an AWS account" }));
    fireEvent.click(screen.getByRole("button", { name: /Sign up for AWS/ }));
    expect(opened.length).toBe(2);
    expect(opened[0]).toContain("signup");
    // Neither leaves the chooser.
    expect(screen.getByText("Step 1 of 4")).toBeTruthy();
  });

  it("step 2 is the IAM user — one action per card, with stuck? helpers behind disclosures", () => {
    vi.stubGlobal("fetch", happyFetch().fn);
    renderWizard();
    enterAws();

    expect(screen.getByText("Step 2 of 4")).toBeTruthy();
    expect(screen.getByText(/its own key-holder/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copy the policy/ })).toBeTruthy();
    expect(screen.getAllByText(/Stuck\?/).length).toBe(2);
  });

  it("step 3 walks the access key to AWS's Done button and won't advance without both values", () => {
    vi.stubGlobal("fetch", happyFetch().fn);
    renderWizard();
    enterAws();
    toKeyStep();

    expect(screen.getByText("Step 3 of 4")).toBeTruthy();
    expect(screen.getAllByText(/Done/).length).toBeGreaterThan(0);
    expect(screen.getByText(/only once/)).toBeTruthy();

    const next = screen.getByRole("button", { name: /choose where it lives/i });
    expect((next as HTMLButtonElement).disabled).toBe(true);
    fillKeys();
    expect((next as HTMLButtonElement).disabled).toBe(false);
  });

  it("step 4 is the region — flags, the closest one suggested, and the finish is its confirm", () => {
    vi.stubGlobal("fetch", happyFetch().fn);
    renderWizard();
    enterAws();
    toKeyStep();
    fillKeys();
    toRegionStep();

    expect(screen.getByText("Step 4 of 4")).toBeTruthy();
    expect(screen.getByText("🇮🇪")).toBeTruthy();
    expect(screen.getByText("Europe (Frankfurt)")).toBeTruthy();
    expect(screen.getByText("Closest to you")).toBeTruthy();
    // No region picked yet — the finish stays disabled and says why.
    const finish = screen.getByRole("button", { name: /Pick a region to finish/ });
    expect((finish as HTMLButtonElement).disabled).toBe(true);
    pickRegion();
    expect(screen.getByRole("button", { name: /Set up in Europe \(Ireland\)/ })).toBeTruthy();
  });

  it("the top-left Back walks WITHIN the flow — region → key → user → cloud, inputs remembered", () => {
    vi.stubGlobal("fetch", happyFetch().fn);
    renderWizard();
    enterAws();
    toKeyStep();
    fillKeys();
    toRegionStep();

    fireEvent.click(screen.getByRole("button", { name: "← Back" }));
    expect(screen.getByText("Step 3 of 4")).toBeTruthy();
    expect(screen.getByDisplayValue("AKIAWIZARD")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "← Back" }));
    expect(screen.getByText("Step 2 of 4")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "← Back" }));
    expect(screen.getByText("Step 1 of 4")).toBeTruthy();
  });

  it("a first-run user can NEVER fall out of the onboarding — no Back and no exit on the first screen", () => {
    vi.stubGlobal("fetch", happyFetch().fn);
    const props = renderWizard();
    expect(screen.queryByRole("button", { name: "← Back" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Exit setup/ })).toBeNull();
    expect(props.onBack).not.toHaveBeenCalled();
  });

  it("with a connected account behind it, the first screen offers an honest exit instead", () => {
    vi.stubGlobal("fetch", happyFetch().fn);
    const props = renderWizard({ accounts: [account], completedHandsOffToPro: false });
    fireEvent.click(screen.getByRole("button", { name: "← Exit setup" }));
    expect(props.onBack).toHaveBeenCalled();
  });
});

describe("SetupWizard setup run", () => {
  it("the region confirm runs the whole setup — bootstrap with keys + the chosen region, verify, celebration", async () => {
    const { fn } = happyFetch();
    vi.stubGlobal("fetch", fn);
    const props = renderWizard();

    walkPastePath();

    expect(await screen.findByRole("img", { name: "Success" })).toBeTruthy();
    expect(screen.getByText(/Your cloud is ready/)).toBeTruthy();

    // The account-less one-shot got the keys and the REGION THE USER PICKED —
    // there is no default to fall through to.
    const bootstrap = fn.mock.calls.find(([u]) => String(u).endsWith("/aws/bootstrap"))!;
    expect(JSON.parse(String((bootstrap[1] as RequestInit).body))).toMatchObject({
      accessKeyId: "AKIAWIZARD",
      secretAccessKey: "wizard-secret",
      region: "eu-west-1",
    });
    expect(fn.mock.calls.some(([u]) => String(u).endsWith("/verify"))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Explore the poppies/ }));
    expect(props.onDone).toHaveBeenCalled();
  });

  it("keeps retrying verification while AWS activates the fresh operator key", async () => {
    const { fn, verifyCount } = happyFetch({ verifyFailures: 2 });
    vi.stubGlobal("fetch", fn);
    renderWizard();

    walkPastePath();

    expect(await screen.findByRole("img", { name: "Success" })).toBeTruthy();
    expect(verifyCount()).toBe(3);
  });

  it("a failed setup lands back on the region step with a plain-words error, keys intact one step back", async () => {
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/aws/bootstrap") && init?.method === "POST") {
        return jsonResponse(
          { error: "aws", message: "User is not authorized to perform: iam:CreateRole" },
          500,
        );
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fn);
    renderWizard();

    walkPastePath();

    expect(await screen.findByText(/isn't allowed to run the setup/)).toBeTruthy();
    expect(screen.getByText(/AWS said: .*iam:CreateRole/)).toBeTruthy();
    // Landed back where it fired (region), the retry is one click…
    expect(screen.getByText("Step 4 of 4")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Set up in Europe \(Ireland\)/ })).toBeTruthy();
    // …and the pasted keys survived, one step back, for a re-check.
    fireEvent.click(screen.getByRole("button", { name: "← Back" }));
    expect(screen.getByDisplayValue("AKIAWIZARD")).toBeTruthy();
  });

  it("with working credentials on the machine: cloud → region (picking advances) → one-click, no keys posted", async () => {
    const { fn } = happyFetch();
    vi.stubGlobal("fetch", fn);
    renderWizard({ identity });

    enterAws();
    expect(screen.getByText("Step 2 of 3")).toBeTruthy(); // region, on the shorter one-click trail
    pickRegion();
    expect(screen.getByText(/no keys to paste/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set up my AWS now" }));

    await screen.findByRole("img", { name: "Success" });
    const bootstrap = fn.mock.calls.find(([u]) => String(u).endsWith("/aws/bootstrap"))!;
    const body = JSON.parse(String((bootstrap[1] as RequestInit).body));
    expect(body.accessKeyId).toBeUndefined(); // reused the connected creds
    expect(body.region).toBe("eu-west-1"); // the region choice still applies
  });

  it("the one-click screen can hand over to the pasted-key steps", () => {
    vi.stubGlobal("fetch", happyFetch().fn);
    renderWizard({ identity });

    enterAws();
    pickRegion();
    fireEvent.click(screen.getByRole("button", { name: "Use a different key instead" }));
    expect(screen.getByText(/its own key-holder/)).toBeTruthy();
  });

  it("resumes a half-done pro setup against the linked account: no chooser, no region step, its region wins", async () => {
    const { fn } = happyFetch();
    vi.stubGlobal("fetch", fn);
    renderWizard({ accounts: [account] });

    // The account already fixed its region — the wizard starts at the console work.
    expect(screen.getByText("Step 1 of 2")).toBeTruthy();
    expect(screen.queryByText("Choose your cloud")).toBeNull();
    expect(screen.queryByText("🇮🇪")).toBeNull();

    toKeyStep();
    fillKeys();
    fireEvent.click(screen.getByRole("button", { name: "Connect and set up" }));

    await screen.findByRole("img", { name: "Success" });
    const bootstrap = fn.mock.calls.find(([u]) => String(u).includes("/accounts/a1/bootstrap"))!;
    expect(bootstrap).toBeTruthy();
    expect(JSON.parse(String((bootstrap[1] as RequestInit).body)).region).toBeUndefined();
  });

  it("the advanced-setup escape lives inside the key screen's SSO helper, not as onboarding chrome", () => {
    vi.stubGlobal("fetch", happyFetch().fn);
    const props = renderWizard();
    // Nowhere on the chooser…
    expect(screen.queryByText(/advanced setup/)).toBeNull();
    enterAws();
    toKeyStep();
    // …but exactly where its audience hits the wall: no access keys under company SSO.
    expect(screen.getByText(/company SSO, temporary credentials/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open the advanced setup" }));
    expect(props.onProSwitch).toHaveBeenCalled();
  });

  it("a verify timeout is told as what it is — never as a bad pasted key", async () => {
    // The raw reason contains InvalidClientTokenId (the fresh OPERATOR key propagating).
    // friendlyError() would say "re-copy your Access Key ID" — the wrong key and the
    // wrong fix, so the timeout must bypass that mapping.
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/aws/bootstrap") && init?.method === "POST") {
        return jsonResponse({
          brokerRoleArn: "arn:aws:iam::123456789012:role/AgentsPoppyBroker",
          account: { ...account, roleArn: "arn:aws:iam::123456789012:role/AgentsPoppyBroker" },
        });
      }
      if (url.endsWith("/verify") && init?.method === "POST") {
        return jsonResponse({ ok: false, reason: "InvalidClientTokenId: still propagating" });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fn);
    renderWizard({ verifyTimeoutMs: 1 });

    walkPastePath();

    expect(await screen.findByText(/hasn't confirmed the connection yet/)).toBeTruthy();
    expect(screen.queryByText(/Re-copy it from the console/)).toBeNull();
    // The raw reason stays visible as detail.
    expect(screen.getByText(/AWS said: .*InvalidClientTokenId/)).toBeTruthy();
  });

  it("hands a COMPLETED account over to pro instead of offering to re-run setup", () => {
    // The accounts-list race: routed to the wizard before the list loaded. Re-running
    // setup there rotates the operator key — under IAM's two-key limit that can evict
    // the key another computer still uses.
    vi.stubGlobal("fetch", happyFetch().fn);
    const done = { ...account, roleArn: "arn:aws:iam::123456789012:role/AgentsPoppyBroker" };
    const props = renderWizard({ accounts: [done] });
    expect(props.onProSwitch).toHaveBeenCalled();
  });

  it("does NOT hand off when the wizard was chosen explicitly (stale prop after unlink)", () => {
    vi.stubGlobal("fetch", happyFetch().fn);
    const done = { ...account, roleArn: "arn:aws:iam::123456789012:role/AgentsPoppyBroker" };
    const props = renderWizard({ accounts: [done], completedHandsOffToPro: false });
    expect(props.onProSwitch).not.toHaveBeenCalled();
  });

  it("the one-click success does not claim a key was pasted", async () => {
    const { fn } = happyFetch();
    vi.stubGlobal("fetch", fn);
    renderWizard({ identity });

    enterAws();
    pickRegion();
    fireEvent.click(screen.getByRole("button", { name: "Set up my AWS now" }));

    await screen.findByRole("img", { name: "Success" });
    expect(screen.queryByText(/key you pasted/)).toBeNull();
  });
});

describe("friendlyError", () => {
  it("translates the classic AWS failures into words, and keeps a safe fallback", () => {
    expect(friendlyError("InvalidClientTokenId: The security token included is invalid")).toMatch(
      /didn't recognize that Access Key ID/,
    );
    expect(friendlyError("SignatureDoesNotMatch: check your key")).toMatch(/Secret Access Key doesn't match/);
    expect(friendlyError("User x is not authorized to perform: iam:CreateRole")).toMatch(
      /policy is missing or incomplete/,
    );
    expect(friendlyError("ExpiredToken: token expired")).toMatch(/expired/);
    expect(friendlyError("something nobody predicted")).toMatch(/safe to just try again/);
  });
});
