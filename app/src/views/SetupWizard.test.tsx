// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
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

/** Step 1 → 2: pick a region card (selection advances by itself — no Next button). */
function pickRegion(place = /Europe \(Ireland\)/) {
  fireEvent.click(screen.getByRole("button", { name: place }));
}

/** Step 2 → 3. */
function toKeyStep() {
  fireEvent.click(screen.getByRole("button", { name: /Next: create its access key/ }));
}

function fillKeys() {
  fireEvent.change(screen.getByPlaceholderText("AKIA…"), { target: { value: "AKIAWIZARD" } });
  fireEvent.change(screen.getByPlaceholderText(/•+/), { target: { value: "wizard-secret" } });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SetupWizard steps", () => {
  it("step 1 is the region — flags + place names, no default, and picking it advances by itself", () => {
    vi.stubGlobal("fetch", happyFetch().fn);
    renderWizard();

    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    // Flags and human place names, not bare region codes.
    expect(screen.getByText("🇮🇪")).toBeTruthy();
    expect(screen.getByText("Europe (Frankfurt)")).toBeTruthy();
    // No key fields yet — the console work comes later.
    expect(screen.queryByPlaceholderText("AKIA…")).toBeNull();

    pickRegion();
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    expect(screen.getByText(/Create the user AgentsPoppy will set up with/)).toBeTruthy();
  });

  it("step 2 carries the policy button and the friendlier user-name wording", () => {
    vi.stubGlobal("fetch", happyFetch().fn);
    renderWizard();
    pickRegion();

    expect(screen.getByText(/or a name you'll remember/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Copy the policy/ })).toBeTruthy();
  });

  it("step 3 walks the access key to AWS's Done button and won't fire without both values", () => {
    vi.stubGlobal("fetch", happyFetch().fn);
    renderWizard();
    pickRegion();
    toKeyStep();

    expect(screen.getByText("Step 3 of 3")).toBeTruthy();
    // The Done reminder — and the reason it matters (the secret is shown only once).
    expect(screen.getAllByText(/Done/).length).toBeGreaterThan(0);
    expect(screen.getByText(/the secret is shown only once/)).toBeTruthy();

    const go = screen.getByRole("button", { name: "Connect and set up" });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    fillKeys();
    expect((go as HTMLButtonElement).disabled).toBe(false);
  });

  it("every step has a way back — key → policy → region", () => {
    vi.stubGlobal("fetch", happyFetch().fn);
    renderWizard();
    pickRegion();
    toKeyStep();

    fireEvent.click(screen.getByRole("button", { name: "← Previous step" }));
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "← Previous step" }));
    expect(screen.getByText("Step 1 of 3")).toBeTruthy();
    // The chosen region is remembered when walking back.
    expect(screen.getByRole("button", { name: /Europe \(Ireland\)/ }).className).toContain("selected");
  });
});

describe("SetupWizard setup run", () => {
  it("one button runs the whole setup — bootstrap with keys + the chosen region, verify, success", async () => {
    const { fn } = happyFetch();
    vi.stubGlobal("fetch", fn);
    const props = renderWizard();

    pickRegion(); // Ireland
    toKeyStep();
    fillKeys();
    fireEvent.click(screen.getByRole("button", { name: "Connect and set up" }));

    expect(await screen.findByRole("img", { name: "Success" })).toBeTruthy();
    expect(screen.getByText("Your AWS is connected")).toBeTruthy();

    // The account-less one-shot got the keys and the REGION THE USER PICKED —
    // there is no default to fall through to.
    const bootstrap = fn.mock.calls.find(([u]) => String(u).endsWith("/aws/bootstrap"))!;
    expect(JSON.parse(String((bootstrap[1] as RequestInit).body))).toMatchObject({
      accessKeyId: "AKIAWIZARD",
      secretAccessKey: "wizard-secret",
      region: "eu-west-1",
    });
    expect(fn.mock.calls.some(([u]) => String(u).endsWith("/verify"))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(props.onDone).toHaveBeenCalled();
  });

  it("keeps retrying verification while AWS activates the fresh operator key", async () => {
    const { fn, verifyCount } = happyFetch({ verifyFailures: 2 });
    vi.stubGlobal("fetch", fn);
    renderWizard();

    pickRegion();
    toKeyStep();
    fillKeys();
    fireEvent.click(screen.getByRole("button", { name: "Connect and set up" }));

    expect(await screen.findByRole("img", { name: "Success" })).toBeTruthy();
    expect(verifyCount()).toBe(3);
  });

  it("a failed setup lands back on the key step with a plain-words error and the keys intact", async () => {
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

    pickRegion();
    toKeyStep();
    fillKeys();
    fireEvent.click(screen.getByRole("button", { name: "Connect and set up" }));

    expect(await screen.findByText(/isn't allowed to run the setup/)).toBeTruthy();
    expect(screen.getByText(/AWS said: .*iam:CreateRole/)).toBeTruthy();
    // Still on step 3, keys preserved — a retry is one click, not a re-paste.
    expect(screen.getByText("Step 3 of 3")).toBeTruthy();
    expect(screen.getByDisplayValue("AKIAWIZARD")).toBeTruthy();
  });

  it("with working credentials on the machine, region choice leads to one-click setup — no keys posted", async () => {
    const { fn } = happyFetch();
    vi.stubGlobal("fetch", fn);
    renderWizard({ identity });

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

    pickRegion();
    fireEvent.click(screen.getByRole("button", { name: "Use a different key instead" }));
    expect(screen.getByText("Step 2 of 3")).toBeTruthy();
  });

  it("resumes a half-done pro setup against the linked account: no region step, its region wins", async () => {
    const { fn } = happyFetch();
    vi.stubGlobal("fetch", fn);
    renderWizard({ accounts: [account] });

    // The account already fixed its region — the wizard starts at the console work.
    expect(screen.getByText("Step 1 of 2")).toBeTruthy();
    expect(screen.queryByText("🇮🇪")).toBeNull();

    toKeyStep();
    fillKeys();
    fireEvent.click(screen.getByRole("button", { name: "Connect and set up" }));

    await screen.findByRole("img", { name: "Success" });
    const bootstrap = fn.mock.calls.find(([u]) => String(u).includes("/accounts/a1/bootstrap"))!;
    expect(bootstrap).toBeTruthy();
    expect(JSON.parse(String((bootstrap[1] as RequestInit).body)).region).toBeUndefined();
  });

  it("hands over to the pro setup on request", () => {
    vi.stubGlobal("fetch", happyFetch().fn);
    const props = renderWizard();
    fireEvent.click(screen.getByRole("button", { name: "Use the pro setup" }));
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

    pickRegion();
    toKeyStep();
    fillKeys();
    fireEvent.click(screen.getByRole("button", { name: "Connect and set up" }));

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
