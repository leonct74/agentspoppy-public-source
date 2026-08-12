// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import type { ConnectedAccount } from "@agentspoppy/core";
import { ConnectAwsView } from "./ConnectAwsView";

const account: ConnectedAccount = {
  id: "a1",
  accountId: "123456789012",
  alias: "Personal",
  regions: ["eu-west-1"],
  createdAt: "t",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function routedFetch() {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/aws/identity")) {
      return jsonResponse({ accountId: "000000000000", arn: "arn:aws:iam::000000000000:user/op", userId: "U" });
    }
    if (url.endsWith("/role-template")) {
      return jsonResponse({
        operator: { accountId: "000000000000", arn: "a", userId: "U" },
        templateJson: '{"AWSTemplateFormatVersion":"2010-09-09"}',
      });
    }
    return jsonResponse({}, 404);
  });
}

/** Simulates a machine with no AWS configured (the brand-new-user case). */
function noAwsFetch() {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/aws/identity")) {
      return jsonResponse({ error: "internal", message: "No AWS credentials found" }, 500);
    }
    return jsonResponse({}, 404);
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Accounts that aren't fully set up land on the WIZARD; these tests exercise the pro stepper. */
function toPro() {
  fireEvent.click(screen.getByRole("button", { name: "Use the pro setup" }));
}

describe("ConnectAwsView", () => {
  it("lands a not-yet-set-up user on the wizard, one click away from pro — and back again", async () => {
    vi.stubGlobal("fetch", routedFetch());
    render(<ConnectAwsView accounts={[account]} onBack={() => {}} onChanged={() => {}} />);

    // Wizard is the default for anyone whose setup isn't finished (founder, 2026-08-11).
    expect(screen.getByRole("button", { name: "Use the pro setup" })).toBeTruthy();
    expect(screen.queryByText("Paste the Broker Role ARN")).toBeNull();

    // Pro is one click away…
    toPro();
    expect(screen.getByText("Paste the Broker Role ARN")).toBeTruthy();
    // …and anyone tangled in it can hand back to the wizard just as easily.
    fireEvent.click(screen.getByRole("button", { name: "Switch to the wizard" }));
    expect(screen.getByRole("button", { name: "Use the pro setup" })).toBeTruthy();
  });

  it("lands an already-set-up account straight on the pro view (management, not onboarding)", async () => {
    vi.stubGlobal("fetch", routedFetch());
    const linked = { ...account, roleArn: "arn:aws:iam::123456789012:role/AgentsPoppyBroker" };
    render(<ConnectAwsView accounts={[linked]} onBack={() => {}} onChanged={() => {}} />);

    expect(screen.getByText("Paste the Broker Role ARN")).toBeTruthy();
  });

  it("'use a different account' (unlink) opens the WIZARD — and the stale accounts prop can't bounce it back", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return jsonResponse({ ok: true });
      if (url.endsWith("/aws/identity")) {
        return jsonResponse({ accountId: "123456789012", arn: "arn:aws:iam::123456789012:user/op", userId: "U" });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const linked = { ...account, roleArn: "arn:aws:iam::123456789012:role/AgentsPoppyBroker" };
    // onChanged does NOT update the accounts prop here — exactly the stale window the
    // real app has between unlinking and the refreshed list arriving.
    render(<ConnectAwsView accounts={[linked]} onBack={() => {}} onChanged={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: /Unlink \/ use a different account/ }));

    // The wizard appears (its pro-switch link is unique to it) and STAYS: the
    // completed-account handoff is suppressed for an explicit switch.
    expect(await screen.findByRole("button", { name: "Use the pro setup" })).toBeTruthy();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit)?.method === "DELETE")).toBe(true),
    );
    expect(screen.queryByText("Paste the Broker Role ARN")).toBeNull();
  });

  it("shows the operator identity and the full set of guided steps, with no-admin framing", async () => {
    vi.stubGlobal("fetch", routedFetch());
    render(<ConnectAwsView accounts={[account]} onBack={() => {}} onChanged={() => {}} />);
    toPro();

    expect(screen.getByText("Connect your AWS")).toBeTruthy();
    expect(screen.getByText(/never asks for or uses admin access/i)).toBeTruthy();
    // The operator ARN now shows in both step 1 and the step-3 reuse panel.
    expect((await screen.findAllByText(/arn:aws:iam::000000000000:user\/op/)).length).toBeGreaterThan(0);
    expect(screen.getByText("Get your AWS ready")).toBeTruthy();
    expect(screen.getByText("Link your AWS account")).toBeTruthy();
    expect(screen.getByText("Create the broker role + operator")).toBeTruthy();
    expect(screen.getByText("Paste the Broker Role ARN")).toBeTruthy();
    expect(screen.getByText("Verify the connection")).toBeTruthy();
    expect(screen.queryByText("Link this account")).toBeNull();
  });

  it("generates and shows the CloudFormation setup template (manual path)", async () => {
    vi.stubGlobal("fetch", routedFetch());
    render(<ConnectAwsView accounts={[account]} onBack={() => {}} onChanged={() => {}} />);
    toPro();

    // The template lives behind the expert "Manual" path; automated is the default.
    fireEvent.click(screen.getByRole("tab", { name: "Manual (expert)" }));
    fireEvent.click(screen.getByText("Generate setup template"));
    expect(await screen.findByDisplayValue(/AWSTemplateFormatVersion/)).toBeTruthy();
  });

  function bootstrapFetch() {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/bootstrap") && init?.method === "POST") {
        return jsonResponse({
          brokerRoleArn: "arn:aws:iam::123456789012:role/AgentsPoppyBroker",
          account: { ...account, roleArn: "arn:aws:iam::123456789012:role/AgentsPoppyBroker" },
        });
      }
      if (url.endsWith("/aws/identity")) {
        return jsonResponse({ accountId: "123456789012", arn: "arn:aws:iam::123456789012:user/admin", userId: "U" });
      }
      return jsonResponse({}, 404);
    });
  }

  it("deploys automatically by reusing the already-connected credentials (no second paste)", async () => {
    const fetchMock = bootstrapFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<ConnectAwsView accounts={[account]} onBack={() => {}} onChanged={() => {}} />);
    toPro();

    // AWS is already connected → automated reuse is the default; no key form, just deploy.
    // Wait for the reuse panel (its "different credentials" link is unique to it) so we
    // don't click the disabled paste-form button that shows during the initial probe.
    await screen.findByRole("button", { name: "Use different credentials for this step" });
    fireEvent.click(screen.getByRole("button", { name: "Deploy setup" }));

    expect(
      await screen.findByDisplayValue("arn:aws:iam::123456789012:role/AgentsPoppyBroker"),
    ).toBeTruthy();
    const bootstrap = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/bootstrap"));
    expect(bootstrap).toBeTruthy();
    // Reused the connected creds → no keys posted.
    expect(JSON.parse(String((bootstrap![1] as RequestInit).body))).toEqual({});
  });

  it("can deploy with different (pasted) credentials when asked", async () => {
    const fetchMock = bootstrapFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<ConnectAwsView accounts={[account]} onBack={() => {}} onChanged={() => {}} />);
    toPro();

    fireEvent.click(await screen.findByRole("button", { name: "Use different credentials for this step" }));
    fireEvent.change(screen.getByLabelText("Access Key ID"), { target: { value: "AKIAADMIN" } });
    fireEvent.change(screen.getByLabelText("Secret Access Key"), { target: { value: "admin-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Deploy setup" }));

    expect(
      await screen.findByDisplayValue("arn:aws:iam::123456789012:role/AgentsPoppyBroker"),
    ).toBeTruthy();
    const bootstrap = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/bootstrap"));
    expect(JSON.parse(String((bootstrap![1] as RequestInit).body))).toMatchObject({
      accessKeyId: "AKIAADMIN",
      secretAccessKey: "admin-secret",
    });
  });

  it("re-apply on an already-set-up account shows an enabled Deploy setup (reuse by default)", async () => {
    const fetchMock = bootstrapFetch();
    vi.stubGlobal("fetch", fetchMock);
    const linked = { ...account, roleArn: "arn:aws:iam::123456789012:role/AgentsPoppyBroker" };
    render(<ConnectAwsView accounts={[linked]} onBack={() => {}} onChanged={() => {}} />);

    // Already set up → the complete state, plus a re-apply affordance (e.g. to land a new guardrail).
    expect(await screen.findByText(/Setup complete/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Re-apply setup (update the broker role)" }));

    // Reuse is the default → an enabled Deploy setup with no key entry needed (the
    // "different credentials" link is unique to the reuse panel, so wait for it first).
    await screen.findByRole("button", { name: "Use different credentials for this step" });
    fireEvent.click(screen.getByRole("button", { name: "Deploy setup" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/bootstrap"))).toBe(true));
    const bootstrap = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/bootstrap"))!;
    expect(JSON.parse(String((bootstrap[1] as RequestInit).body))).toEqual({}); // reused the connected creds
  });

  it("lets an already-connected user reveal the key form to change AWS credentials", async () => {
    vi.stubGlobal("fetch", routedFetch());
    render(<ConnectAwsView accounts={[account]} onBack={() => {}} onChanged={() => {}} />);
    toPro();

    // Connected → step 1 shows the identity, no key form until asked.
    await screen.findByText(/Reached AWS as/);
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Use a different AWS user/ }));
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("offers to link an account on first run, prefilled from the operator identity", async () => {
    vi.stubGlobal("fetch", routedFetch());
    render(<ConnectAwsView accounts={[]} onBack={() => {}} onChanged={() => {}} />);
    toPro();

    expect(await screen.findByText("Link this account")).toBeTruthy();
    expect(screen.getByDisplayValue("000000000000")).toBeTruthy();
  });

  it("guides a brand-new user with no AWS to create a free account, then offers the in-app form + CLI path", async () => {
    vi.stubGlobal("fetch", noAwsFetch());
    render(<ConnectAwsView accounts={[]} onBack={() => {}} onChanged={() => {}} />);
    toPro();

    expect(await screen.findByText("Create a free AWS account")).toBeTruthy();
    expect(screen.getByText("No AWS credentials found on this machine.")).toBeTruthy();

    fireEvent.click(screen.getByText("I already have AWS"));
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy(); // the in-app paste form
    expect(screen.getByText(/Prefer the AWS CLI/)).toBeTruthy(); // the CLI alternative
    expect(screen.getByText("I've set it up — check again")).toBeTruthy();
  });

  it("saves pasted keys via the in-app form and shows the resolved identity", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/aws/credentials") && init?.method === "POST") {
        return jsonResponse({ accountId: "999999999999", arn: "arn:aws:iam::999999999999:user/op", userId: "U2" });
      }
      if (url.endsWith("/aws/identity")) {
        return jsonResponse({ error: "internal", message: "No AWS credentials found" }, 500);
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ConnectAwsView accounts={[]} onBack={() => {}} onChanged={() => {}} />);
    toPro();

    fireEvent.click(await screen.findByText("I already have AWS"));
    // Scope to the step-1 paste panel — step 3's automated form shares these placeholders.
    const panel = (screen.getByRole("button", { name: "Connect" }).closest(".panel") ?? document.body) as HTMLElement;
    fireEvent.change(within(panel).getByPlaceholderText("AKIA…"), { target: { value: "AKIATEST" } });
    fireEvent.change(within(panel).getByPlaceholderText(/•+/), { target: { value: "shh-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    // Resolved identity now appears in step 1 and the step-3 reuse panel.
    expect((await screen.findAllByText(/arn:aws:iam::999999999999:user\/op/)).length).toBeGreaterThan(0);
  });

  it("frames an expired-credential reconnect as a resume, not a fresh setup", async () => {
    // Account already linked + role set up, but the operator credentials have lapsed
    // (/aws/identity fails) — the reconnect case the global banner deep-links into.
    vi.stubGlobal("fetch", noAwsFetch());
    const linked = { ...account, roleArn: "arn:aws:iam::123456789012:role/AgentsPoppyBroker" };
    render(
      <ConnectAwsView accounts={[linked]} onBack={() => {}} onChanged={() => {}} initialAction="change-creds" />,
    );

    // A "you don't need to start over" banner makes clear this is a resume, not a rebuild…
    expect(await screen.findByText(/you don't need to start over/i)).toBeTruthy();
    // …Step 1 lands directly on the "I already have AWS" re-entry form (no tab hunting), because
    // the account is already linked — and does NOT push the brand-new-user "create an account" path.
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(screen.queryByText("Create a free AWS account")).toBeNull();
  });

  it("update-policy: shows the current policy link + replace instructions and a working Re-check", async () => {
    const denial =
      "User: arn:aws:iam::123456789012:user/acmepoppy-3 is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::123456789012:role/AgentsPoppyBroker";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/verify") && init?.method === "POST") return jsonResponse({ ok: false, reason: denial });
      if (url.endsWith("/aws/identity")) {
        return jsonResponse({ accountId: "123456789012", arn: "arn:aws:iam::123456789012:user/acmepoppy-3", userId: "U" });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const linked = { ...account, accountId: "123456789012", roleArn: "arn:aws:iam::123456789012:role/AgentsPoppyBroker" };
    render(
      <ConnectAwsView accounts={[linked]} onBack={() => {}} onChanged={() => {}} initialAction="update-policy" />,
    );

    // The panel names the fix and offers the policy. The COPY BUTTON is the primary path —
    // it reads from the app bundle, so it can't 404 the way the old private-repo link did
    // (2026-08-11 onboarding breakage). The GitHub link is a convenience and must point at
    // the PUBLIC mirror.
    expect(await screen.findByText("Update your AWS policy.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Copy the policy/i }).length).toBeGreaterThan(0);
    const link = screen.getByRole("link", { name: /open it on GitHub/i });
    expect(link.getAttribute("href")).toContain("agentspoppy-access-policy.json");
    expect(link.getAttribute("href")).toContain("agentspoppy-public-source");

    // Re-check runs a live verify.
    fireEvent.click(screen.getByRole("button", { name: "Re-check" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/verify"))).toBe(true));
  });

  it("turns an AssumeRole permission denial into an actionable fix, not a raw STS error", async () => {
    const denial =
      "User: arn:aws:iam::123456789012:user/acmepoppy-3 is not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::123456789012:role/AgentsPoppyBroker";
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/verify") && init?.method === "POST") return jsonResponse({ ok: false, reason: denial });
      if (url.endsWith("/aws/identity")) {
        return jsonResponse({ accountId: "123456789012", arn: "arn:aws:iam::123456789012:user/acmepoppy-3", userId: "U" });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const linked = {
      ...account,
      accountId: "123456789012",
      roleArn: "arn:aws:iam::123456789012:role/AgentsPoppyBroker",
    };
    render(<ConnectAwsView accounts={[linked]} onBack={() => {}} onChanged={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Verify connection" }));

    // Actionable guidance (replace the policy), not just the raw STS message.
    expect(await screen.findByText(/policy is missing a permission/i)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Copy the policy/i }).length).toBeGreaterThan(0);
    const link = screen.getByRole("link", { name: /open it on GitHub/i });
    expect(link.getAttribute("href")).toContain("agentspoppy-public-source");
    // Still shows the raw AWS reason as a detail.
    expect(screen.getByText(/AWS said:/)).toBeTruthy();
  });
});
