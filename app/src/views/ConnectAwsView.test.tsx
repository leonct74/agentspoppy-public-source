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

/** Accounts that aren't fully set up land on the WIZARD; these tests exercise the pro
 *  stepper. The advanced-setup escape lives inside the key screen's SSO helper now
 *  (founder, 2026-09-02 — no pro chrome in the onboarding), so reaching pro means
 *  walking to the key slide first. */
async function toPro() {
  // Wait out the identity probe — every slide lives behind it.
  await waitFor(() => expect(document.querySelector(".probing")).toBeNull());
  // Fresh machine: pass the cloud chooser first.
  const enter = screen.queryByRole("button", { name: /I already have an account/ });
  if (enter) fireEvent.click(enter);
  // One-click shape (credentials on the machine): region → one-click → opt into keys.
  const region = screen.queryByRole("button", { name: /Europe \(Ireland\)/ });
  if (region) {
    fireEvent.click(region);
    fireEvent.click(await screen.findByRole("button", { name: "Use a different key instead" }));
  }
  fireEvent.click(await screen.findByRole("button", { name: /next: its access key/i }));
  fireEvent.click(screen.getByRole("button", { name: "Open the advanced setup" }));
}

/** The wizard's unmistakable marker for a linked-but-unfinished account (it starts on
 *  the IAM slide there — no cloud chooser). */
const WIZARD_MARKER = /its own key-holder/;

describe("ConnectAwsView", () => {
  it("lands a not-yet-set-up user on the wizard, one click away from pro — and back again", async () => {
    vi.stubGlobal("fetch", routedFetch());
    render(<ConnectAwsView accounts={[account]} onBack={() => {}} onChanged={() => {}} />);

    // Wizard is the default for anyone whose setup isn't finished (founder, 2026-08-11).
    expect(await screen.findByText(WIZARD_MARKER)).toBeTruthy();
    expect(screen.queryByText("Paste the Broker Role ARN")).toBeNull();

    // Pro is a couple of honest clicks away (via the key screen's SSO helper)…
    await toPro();
    expect(screen.getByText("Paste the Broker Role ARN")).toBeTruthy();
    // …and anyone tangled in it can hand back to the wizard just as easily.
    fireEvent.click(screen.getByRole("button", { name: "Switch to the wizard" }));
    expect(await screen.findByText(WIZARD_MARKER)).toBeTruthy();
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

    // The wizard appears and STAYS: the completed-account handoff is suppressed for
    // an explicit switch.
    expect(await screen.findByText(WIZARD_MARKER)).toBeTruthy();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, i]) => (i as RequestInit)?.method === "DELETE")).toBe(true),
    );
    expect(screen.queryByText("Paste the Broker Role ARN")).toBeNull();
  });

  it("shows the operator identity and the full set of guided steps, with no-admin framing", async () => {
    vi.stubGlobal("fetch", routedFetch());
    render(<ConnectAwsView accounts={[account]} onBack={() => {}} onChanged={() => {}} />);
    await toPro();

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
    await toPro();

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

  /** A bootstrap that fails with `message` — the deploy error paths. */
  function failingBootstrapFetch(message: string) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/bootstrap") && init?.method === "POST") {
        return jsonResponse({ error: "aws_error", message }, 500);
      }
      if (url.endsWith("/aws/identity")) {
        return jsonResponse({ accountId: "123456789012", arn: "arn:aws:iam::123456789012:user/admin", userId: "U" });
      }
      return jsonResponse({}, 404);
    });
  }

  /** Render the re-apply step and press Deploy once the reuse panel is actually up. */
  async function clickRedeploy(message: string) {
    vi.stubGlobal("fetch", failingBootstrapFetch(message));
    const linked = { ...account, roleArn: "arn:aws:iam::123456789012:role/AgentsPoppyBroker" };
    render(<ConnectAwsView accounts={[linked]} onBack={() => {}} onChanged={() => {}} initialAction="redeploy" />);
    // Wait for the reuse panel: clicking earlier hits the disabled paste-form button.
    await screen.findByRole("button", { name: "Use different credentials for this step" });
    fireEvent.click(screen.getByRole("button", { name: "Deploy setup" }));
  }

  it("deploys automatically by reusing the already-connected credentials (no second paste)", async () => {
    const fetchMock = bootstrapFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<ConnectAwsView accounts={[account]} onBack={() => {}} onChanged={() => {}} />);
    await toPro();

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
    await toPro();

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
    // Reused the connected creds (no keys posted). The mocked identity is NOT the operator
    // (a hand-managed user), so the re-apply runs KEYS-FIRST: switch this machine onto the
    // restricted operator key, then apply the template — after template v4 a non-operator
    // key can no longer assume the role, so updating first would strand it
    // (docs/specs/operator-key-least-privilege.md, ordering §3).
    expect(JSON.parse(String((bootstrap[1] as RequestInit).body))).toEqual({ keysFirst: true });
  });

  it("lets an already-connected user reveal the key form to change AWS credentials", async () => {
    vi.stubGlobal("fetch", routedFetch());
    render(<ConnectAwsView accounts={[account]} onBack={() => {}} onChanged={() => {}} />);
    await toPro();

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
    await toPro();

    expect(await screen.findByText("Link this account")).toBeTruthy();
    expect(screen.getByDisplayValue("000000000000")).toBeTruthy();
  });

  it("guides a brand-new user with no AWS to create a free account, then offers the in-app form + CLI path", async () => {
    vi.stubGlobal("fetch", noAwsFetch());
    render(<ConnectAwsView accounts={[]} onBack={() => {}} onChanged={() => {}} />);
    await toPro();

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
    await toPro();

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

  // A re-apply that AWS rolled back on iam:CreatePolicy means exactly one thing: the policy
  // attached to this IAM user predates the permissions boundary. The panel that fixes it
  // already existed but was only reachable from a cleanup-denied signal, so a user who hit
  // this got a paragraph describing a fix they then had to go and find.
  it("routes a rolled-back re-apply straight to the update-policy fix", async () => {
    await clickRedeploy(
      "The setup update was rolled back by AWS, so nothing changed. AWS said: AgentsPoppyBoundary: " +
        "not authorized to perform: iam:CreatePolicy",
    );
    expect(await screen.findByText("Update your AWS policy.")).toBeTruthy();
  });

  // The OTHER denial — wrong credentials, not a stale policy — must NOT open that panel: its
  // message also contains the words "access policy", and replacing the policy would not help
  // someone whose actual problem is that they used the non-admin operator key.
  it("does not offer the policy fix for a plain wrong-credentials refusal", async () => {
    await clickRedeploy(
      "Your AgentsPoppy setup needs updating, but these credentials aren't allowed to change it. " +
        "Paste your admin keys, or a key carrying the AgentsPoppy access policy.",
    );
    await screen.findByText(/aren't allowed to change it/i);
    expect(screen.queryByText("Update your AWS policy.")).toBeNull();
  });

  // Field report: pressing "Update setup" landed on five ticked-off steps and a Verify
  // button, with the credential form hidden behind a text link — so the obvious action did
  // nothing and the real one was invisible.
  describe("arriving from the staleness banner", () => {
    const operator = { accountId: "123456789012", arn: "arn:aws:iam::123456789012:user/AgentsPoppyOperator", userId: "U" };
    const renderRedeploy = (identity: typeof operator) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          url.endsWith("/aws/identity") ? jsonResponse(identity) : jsonResponse({}, 404),
        ),
      );
      const linked = { ...account, roleArn: "arn:aws:iam::123456789012:role/AgentsPoppyBroker" };
      render(<ConnectAwsView accounts={[linked]} onBack={() => {}} onChanged={() => {}} initialAction="redeploy" />);
    };

    const linked = { ...account, roleArn: "arn:aws:iam::123456789012:role/AgentsPoppyBroker" };
    const operatorFetch = (onBootstrap: () => Response) =>
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/aws/identity")) return jsonResponse(operator);
        if (url.endsWith("/bootstrap") && init?.method === "POST") return onBootstrap();
        return jsonResponse({}, 404);
      });
    const typeSetupKeyAndDeploy = async () => {
      fireEvent.change(await screen.findByLabelText("Access Key ID"), { target: { value: "AKIASETUP" } });
      fireEvent.change(screen.getByLabelText("Secret Access Key"), { target: { value: "setup-secret" } });
      fireEvent.click(screen.getByRole("button", { name: "Deploy setup" }));
    };

    // Field report 2026-09-03 — the first re-apply after the 0.3.9 operator switch, i.e. EVERY
    // user's path: the key form showed (the stored key is the operator), the user typed their
    // setup key, and the app dropped it — the submit rule predated mustPasteForRedeploy — then
    // ran the update on the operator, whose refusal to even read the stack was all they saw.
    it("sends the TYPED setup key when the stored key is the operator (update-only, no key switch)", async () => {
      const fetchMock = operatorFetch(() =>
        jsonResponse({ brokerRoleArn: linked.roleArn, account: linked }),
      );
      vi.stubGlobal("fetch", fetchMock);
      render(
        <ConnectAwsView accounts={[linked]} onBack={() => {}} onChanged={() => {}} initialAction="redeploy" deployedSetupVersion={4} />,
      );
      await screen.findByText(/Update the protections in your AWS account/i);
      await typeSetupKeyAndDeploy();

      await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/bootstrap"))).toBe(true));
      const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/bootstrap"))!;
      const body = JSON.parse(String((call[1] as RequestInit).body));
      // The typed key travels, the stack is touched in place, and the operator key is NOT rotated.
      expect(body).toMatchObject({ accessKeyId: "AKIASETUP", secretAccessKey: "setup-secret", updateOnly: true });
      expect(body.keysFirst).toBeUndefined();
    });

    // A refusal naming the operator is meaningless to someone who just typed a different key;
    // it must read as what happened and what to do, not as a raw IAM denial.
    it("explains a refusal that names the operator key instead of showing the raw AWS denial", async () => {
      vi.stubGlobal(
        "fetch",
        operatorFetch(() =>
          jsonResponse(
            {
              error: "aws_error",
              message:
                "User: arn:aws:iam::123456789012:user/AgentsPoppyOperator is not authorized to perform: " +
                "cloudformation:DescribeStacks on resource: arn:aws:cloudformation:eu-west-1:123456789012:stack/AgentsPoppy/x",
            },
            500,
          ),
        ),
      );
      render(
        <ConnectAwsView accounts={[linked]} onBack={() => {}} onChanged={() => {}} initialAction="redeploy" deployedSetupVersion={4} />,
      );
      await screen.findByText(/Update the protections in your AWS account/i);
      await typeSetupKeyAndDeploy();
      expect(await screen.findByText(/which by design cannot change the setup/i)).toBeTruthy();
      expect(screen.queryByText(/not authorized to perform/i)).toBeNull();
    });

    // AWS's "security token is invalid" means the access key ID is unknown — deleted, usually on
    // purpose after setup. Field report 2026-09-03: the founder had deleted the setup user's keys
    // on advice and was left staring at a sentence about tokens. Say deleted key, say make one.
    it("explains AWS's 'security token invalid' as a deleted key, with the way forward", async () => {
      vi.stubGlobal(
        "fetch",
        operatorFetch(() =>
          jsonResponse({ error: "aws_error", message: "The security token included in the request is invalid." }, 500),
        ),
      );
      render(
        <ConnectAwsView accounts={[linked]} onBack={() => {}} onChanged={() => {}} initialAction="redeploy" deployedSetupVersion={4} />,
      );
      await screen.findByText(/Update the protections in your AWS account/i);
      await typeSetupKeyAndDeploy();
      expect(await screen.findByText(/AWS does not know this access key ID/i)).toBeTruthy();
      expect(screen.queryByText(/security token included in the request/i)).toBeNull();
    });

    // From template version 2 the boundary already exists in the account, so "replace your
    // policy first" is wrong for these users (nothing was added to the policy after that): the
    // banner must lead with the key entry and describe the update as AWS ENFORCING the ceiling.
    it("for an account that already has the boundary, leads with the key entry, not the policy swap", async () => {
      vi.stubGlobal("fetch", operatorFetch(() => jsonResponse({}, 404)));
      render(
        <ConnectAwsView accounts={[linked]} onBack={() => {}} onChanged={() => {}} initialAction="redeploy" deployedSetupVersion={4} />,
      );
      await screen.findByText(/Update the protections in your AWS account/i);
      expect(screen.getByText(/makes AWS\s+itself enforce a safeguard your account already has/i)).toBeTruthy();
      // The real procedure: the old setup key is usually (rightly) deleted by now, so make one
      // for the update, use it once, delete it again — never "enter the key you used last time".
      expect(screen.getByText(/Create a fresh access key for this update/i)).toBeTruthy();
      expect(screen.getByText(/delete that key in IAM again/i)).toBeTruthy();
      expect(screen.queryByText(/key you used last time/i)).toBeNull();
      expect(screen.queryByText(/replace that policy with the current\s+version/i)).toBeNull();
      // The policy swap survives as the fallback for the one case it applies to.
      expect(screen.getByText(/Only if AWS answers with a message naming/i)).toBeTruthy();
    });

    // The update is its OWN screen now, not the onboarding wizard wearing a banner: no step
    // list, no "Create the broker role" heading, no Verify button to press by mistake.
    it("is a dedicated update screen, not the onboarding wizard", async () => {
      renderRedeploy(operator);
      expect(await screen.findByRole("heading", { name: /Update your AgentsPoppy setup/i })).toBeTruthy();
      expect(screen.getByText(/Update the protections in your AWS account/i)).toBeTruthy();
      expect(screen.queryByText(/Create the broker role \+ operator/i)).toBeNull();
      expect(screen.queryByRole("button", { name: /Verify connection/i })).toBeNull();
      expect(screen.queryByText(/Connect your AWS/i)).toBeNull();
    });

    // Field lesson (2026-08-28): the least-privilege user's real task — replace the policy on
    // their setup IAM user — surfaced only in an error message AFTER a rollback. The banner
    // must state it up front: what to do, where the policy is, and why it changed.
    it("leads with the policy replacement: the what, the where, and the why", async () => {
      renderRedeploy(operator);
      await screen.findByText(/Update the protections in your AWS account/i);
      // what — replace the policy before deploying
      expect(screen.getByText(/replace that policy with the current\s+version/i)).toBeTruthy();
      // where — the copy button and the console path
      expect(screen.getByRole("button", { name: /copy the policy/i })).toBeTruthy();
      // (the console path now also appears in the key step, for a setup user with no key left)
      expect(screen.getAllByText(/IAM → Users → your setup user/i).length).toBeGreaterThan(0);
      // why — the new safeguard the permission exists for
      expect(screen.getAllByText(/AgentsPoppyBoundary/i).length).toBeGreaterThan(0);
      expect(screen.getByText(/caps any IAM role a connected app creates/i)).toBeTruthy();
    });

    // The credential AgentsPoppy keeps is the powerless operator, so the "use what you already
    // connected" button offers the ONE key that cannot work. Go straight to the form.
    it("shows the key fields directly when the held credential is the operator", async () => {
      renderRedeploy(operator);
      expect(await screen.findByLabelText(/Access Key ID/i)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Use different credentials for this step/i })).toBeNull();
    });

    it("explains why a key must be pasted at all", async () => {
      renderRedeploy(operator);
      expect(await screen.findByText(/cannot\s+modify the setup/i)).toBeTruthy();
    });

    // An admin identity CAN do the update, so the one-click path stays.
    it("keeps the one-click path when the connected identity is not the operator", async () => {
      renderRedeploy({ ...operator, arn: "arn:aws:iam::123456789012:user/admin" });
      expect(await screen.findByRole("button", { name: "Use different credentials for this step" })).toBeTruthy();
    });

    // Field report (2026-08-28): step 3 said "enter the key below" unconditionally, so a user
    // whose STORED key was perfectly capable went hunting for a secret they never needed to
    // re-type. When the app holds a usable key, the banner must say it is reused.
    it("tells a capable-key user there is nothing to re-enter, never to enter a key", async () => {
      renderRedeploy({ ...operator, arn: "arn:aws:iam::123456789012:user/my-setup-user" });
      await screen.findByText(/Update the protections in your AWS account/i);
      expect(screen.getAllByText(/nothing to re-enter/i).length).toBeGreaterThan(0);
      expect(screen.queryByText(/Enter the key below/i)).toBeNull();
    });

    it("ends in an update-complete state, not back in the onboarding layout", async () => {
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/bootstrap") && init?.method === "POST") {
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
      vi.stubGlobal("fetch", fetchMock);
      const onBack = vi.fn();
      const linked = { ...account, roleArn: "arn:aws:iam::123456789012:role/AgentsPoppyBroker" };
      render(<ConnectAwsView accounts={[linked]} onBack={onBack} onChanged={() => {}} initialAction="redeploy" />);

      // Wait for the reuse panel (identity resolved) — before that, the paste form's
      // disabled Deploy button is what findByRole would grab.
      await screen.findByRole("button", { name: "Use different credentials for this step" });
      fireEvent.click(screen.getByRole("button", { name: "Deploy setup" }));
      await screen.findByText(/current protections/i);
      // Success must NOT drop the user back into "Setup complete" + Verify.
      expect(screen.queryByRole("button", { name: /Verify connection/i })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      expect(onBack).toHaveBeenCalled();
    });

    it("still tells the operator-key user to enter a key (theirs cannot do the job)", async () => {
      renderRedeploy(operator);
      await screen.findByText(/Update the protections in your AWS account/i);
      expect(screen.getByText(/Enter the key below/i)).toBeTruthy();
      expect(screen.queryAllByText(/nothing to re-enter/i)).toHaveLength(0);
    });
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

    // Actionable guidance: the connected identity is NOT the operator, so the remedy is
    // switching this machine onto the operator key (Update setup) — a user-policy edit can
    // no longer grant AssumeRole (the access policy dropped it; after template v4 the trust
    // condition refuses non-operator principals outright).
    expect(await screen.findByText(/setup key, not the operator key/i)).toBeTruthy();
    expect(screen.getByText(/Update setup/)).toBeTruthy();
    // Still shows the raw AWS reason as a detail.
    expect(screen.getByText(/AWS said:/)).toBeTruthy();
  });
});
