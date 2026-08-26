// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { TAGGED_AS_SELF, type Connection, type ConnectionStatus, type InfraGraph, type Inventory, type PermissionSet } from "@agentspoppy/core";
import { ConnectionDetailView } from "./ConnectionDetailView";

afterEach(cleanup);

const emptyInventory: Inventory = { connectionId: "c1", stacks: [], ledger: [] };

function connWith(ps: PermissionSet, status: ConnectionStatus = "active", supervised = false): Connection {
  return {
    id: "c1", accountId: "a1", app: { id: "x", name: "TestPoppy" }, status, supervised,
    permissionSet: ps, createdAt: "t", updatedAt: "t",
  };
}

const noop = () => {};
function renderDetail(
  ps: PermissionSet,
  opts: {
    status?: ConnectionStatus;
    supervised?: boolean;
    onApprove?: () => void;
    onDeny?: () => void;
    onToggleSupervise?: (s: boolean) => void;
  } = {},
) {
  render(
    <ConnectionDetailView
      connection={connWith(ps, opts.status, opts.supervised)} inventory={emptyInventory} audit={[]}
      onBack={noop} onPause={noop} onResume={noop} onRevoke={noop} onTeardown={noop}
      onApprove={opts.onApprove} onDeny={opts.onDeny} onToggleSupervise={opts.onToggleSupervise}
    />,
  );
}

const simpleSet: PermissionSet = {
  id: "p", name: "P", description: "",
  grants: [{ service: "s3", actions: ["PutObject"], resourceScope: TAGGED_AS_SELF }],
  requiredTags: ["agentspoppy:account", "agentspoppy:app", "agentspoppy:connection"],
  limits: null,
};

describe("ConnectionDetailView — report a poppy", () => {
  it("opens the report dialog and applies the chosen self-protection (pause + block)", () => {
    const onPause = vi.fn();
    const onBlock = vi.fn();
    render(
      <ConnectionDetailView
        connection={connWith(simpleSet, "active")} inventory={emptyInventory} audit={[]}
        onBack={noop} onPause={onPause} onResume={noop} onRevoke={noop} onTeardown={noop} onBlock={onBlock}
      />,
    );

    // A Report control sits beside the poppy name.
    fireEvent.click(screen.getByRole("button", { name: /^Report$/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Report TestPoppy/)).toBeTruthy();

    // Tick both self-protection options, then send.
    fireEvent.click(within(dialog).getByLabelText(/Pause this poppy/i));
    fireEvent.click(within(dialog).getByLabelText(/Block from loading/i));
    fireEvent.click(within(dialog).getByRole("button", { name: "Send report" }));

    expect(onPause).toHaveBeenCalledTimes(1);
    expect(onBlock).toHaveBeenCalledTimes(1);
    // Dialog closes after sending.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("hides the Block option when onBlock isn't provided", () => {
    renderDetail(simpleSet, { status: "active" });
    fireEvent.click(screen.getByRole("button", { name: /^Report$/ }));
    expect(screen.queryByLabelText(/Block from loading/i)).toBeNull();
  });
});

describe("ConnectionDetailView — revoke ordering guard", () => {
  const withStacks: Inventory = {
    connectionId: "c1",
    stacks: [{ stackName: "S", region: "eu-west-1", stackExists: true, resources: [] }],
    ledger: [],
  };

  it("warns and steers to teardown-first when revoking a poppy that still has a footprint", () => {
    const onRevoke = vi.fn();
    render(
      <ConnectionDetailView
        connection={connWith(simpleSet, "active")} inventory={withStacks} audit={[]}
        onBack={noop} onPause={noop} onResume={noop} onRevoke={onRevoke} onTeardown={noop}
      />,
    );
    fireEvent.click(screen.getByText("Revoke access"));
    // Doesn't revoke immediately — it asks first.
    expect(onRevoke).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/tear it down before revoking/i)).toBeTruthy();

    // "Revoke access only" honours the deliberate choice.
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke access only" }));
    expect(onRevoke).toHaveBeenCalledTimes(1);
  });

  it("revokes directly (no warning) when there's no footprint to strand", () => {
    const onRevoke = vi.fn();
    render(
      <ConnectionDetailView
        connection={connWith(simpleSet, "active")} inventory={emptyInventory} audit={[]}
        onBack={noop} onPause={noop} onResume={noop} onRevoke={onRevoke} onTeardown={noop}
      />,
    );
    fireEvent.click(screen.getByText("Revoke access"));
    expect(onRevoke).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("ConnectionDetailView — policy risk", () => {
  it("shows a green all-clear when every grant is scoped to its own resources", () => {
    renderDetail({
      id: "p", name: "P", description: "",
      grants: [{ service: "s3", actions: ["PutObject"], resourceScope: TAGGED_AS_SELF }],
      requiredTags: ["agentspoppy:account", "agentspoppy:app", "agentspoppy:connection"],
      limits: null,
    });
    expect(screen.getByText("No risks to other resources identified")).toBeTruthy();
    expect(screen.getByText("S3")).toBeTruthy(); // capability box header
  });

  it("badges each gated risk with a Supervised pill when supervision is on", () => {
    renderDetail(
      {
        id: "p", name: "P", description: "",
        grants: [{ service: "iam", actions: ["CreateRole", "DeleteRole"], resourceScope: "*" }],
        requiredTags: ["agentspoppy:account", "agentspoppy:app", "agentspoppy:connection"],
        limits: null,
      },
      { supervised: true },
    );
    expect(screen.getByText("IAM — can change resources beyond its own")).toBeTruthy();
    // The per-service risk carries the reassurance pill...
    const pill = screen.getByText("Supervised");
    expect(pill.getAttribute("title")).toMatch(/approval/i);
  });

  it("does not badge risks with a Supervised pill when supervision is off", () => {
    renderDetail(
      {
        id: "p", name: "P", description: "",
        grants: [{ service: "iam", actions: ["CreateRole", "DeleteRole"], resourceScope: "*" }],
        requiredTags: ["agentspoppy:account", "agentspoppy:app", "agentspoppy:connection"],
        limits: null,
      },
      { supervised: false },
    );
    expect(screen.getByText("IAM — can change resources beyond its own")).toBeTruthy();
    expect(screen.queryByText("Supervised")).toBeNull();
  });

  it("flags an unscoped mutating grant as a high (red) risk", () => {
    renderDetail({
      id: "p", name: "P", description: "",
      grants: [{ service: "iam", actions: ["CreateRole", "DeleteRole"], resourceScope: "*" }],
      requiredTags: [],
      limits: null,
    });
    expect(screen.queryByText("No risks to other resources identified")).toBeNull();
    expect(screen.getByText("IAM — can change resources beyond its own")).toBeTruthy();
    // missing attribution tags surfaces its own finding
    expect(screen.getByText("Footprint can't be tracked or torn down")).toBeTruthy();
  });

  it("offers Approve/Deny while pending so you can decide after reviewing", () => {
    const onApprove = vi.fn();
    renderDetail(
      {
        id: "p", name: "P", description: "",
        grants: [{ service: "s3", actions: ["PutObject"], resourceScope: TAGGED_AS_SELF }],
        requiredTags: ["agentspoppy:account", "agentspoppy:app", "agentspoppy:connection"],
        limits: null,
      },
      { status: "pending", onApprove, onDeny: noop },
    );
    fireEvent.click(screen.getByText("Approve"));
    expect(onApprove).toHaveBeenCalled();
    // a pending poppy hasn't built anything → no teardown control
    expect(screen.queryByText("Tear down everything it built")).toBeNull();
  });
});

describe("ConnectionDetailView — supervision", () => {
  it("offers to turn supervision ON when it's off", () => {
    const onToggleSupervise = vi.fn();
    renderDetail(simpleSet, { supervised: false, onToggleSupervise });
    expect(screen.getByText("Unsupervised — acts within its scope")).toBeTruthy();
    fireEvent.click(screen.getByText("Turn on"));
    expect(onToggleSupervise).toHaveBeenCalledWith(true);
  });

  it("offers to turn supervision OFF when it's on", () => {
    const onToggleSupervise = vi.fn();
    renderDetail(simpleSet, { supervised: true, onToggleSupervise });
    expect(screen.getByText("Supervised — you approve its AWS access")).toBeTruthy();
    fireEvent.click(screen.getByText("Turn off"));
    expect(onToggleSupervise).toHaveBeenCalledWith(false);
  });

  it("hides supervision for a pending connection", () => {
    renderDetail(simpleSet, { status: "pending", onToggleSupervise: noop });
    expect(screen.queryByText(/Unsupervised|Supervised —/)).toBeNull();
  });
});

describe("ConnectionDetailView — result notice", () => {
  it("renders a result notice and dismisses it on click", () => {
    const onDismissNotice = vi.fn();
    render(
      <ConnectionDetailView
        connection={connWith(simpleSet)} inventory={emptyInventory} audit={[]}
        notice="Nothing for AgentsPoppy to tear down here." onDismissNotice={onDismissNotice}
        onBack={noop} onPause={noop} onResume={noop} onRevoke={noop} onTeardown={noop}
      />,
    );
    expect(screen.getByText("Nothing for AgentsPoppy to tear down here.")).toBeTruthy();
    fireEvent.click(screen.getByText("Dismiss"));
    expect(onDismissNotice).toHaveBeenCalledTimes(1);
  });

  it("shows no notice element when none is provided", () => {
    renderDetail(simpleSet);
    expect(screen.queryByText("Dismiss")).toBeNull();
  });

  it("renders a residual warning notice with the warn styling", () => {
    const { container } = render(
      <ConnectionDetailView
        connection={connWith(simpleSet)} inventory={emptyInventory} audit={[]}
        notice="2 resources tagged as built by this app are still present." noticeWarn
        onBack={noop} onPause={noop} onResume={noop} onRevoke={noop} onTeardown={noop}
      />,
    );
    expect(container.querySelector(".notice--warn")).toBeTruthy();
    expect(screen.getByText(/still present/)).toBeTruthy();
  });

  it("disables and relabels the teardown button while tearing down", () => {
    render(
      <ConnectionDetailView
        connection={connWith(simpleSet)} inventory={emptyInventory} audit={[]} tearingDown
        onBack={noop} onPause={noop} onResume={noop} onRevoke={noop} onTeardown={noop}
      />,
    );
    const btn = screen.getByText("Tearing down…") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.queryByText("Tear down everything it built")).toBeNull();
  });

  it("shows a live in-progress status while tearing down so it never looks frozen", () => {
    const { container } = render(
      <ConnectionDetailView
        connection={connWith(simpleSet)} inventory={emptyInventory} audit={[]} tearingDown
        onBack={noop} onPause={noop} onResume={noop} onRevoke={noop} onTeardown={noop}
      />,
    );
    expect(screen.getByText(/emptying buckets and waiting for AWS/i)).toBeTruthy();
    expect(container.querySelector(".teardown-status .poppy-spinner")).toBeTruthy();
  });
});

describe("ConnectionDetailView — teardown confirmation", () => {
  // connWith() names the poppy "TestPoppy" — that's the string the user must type to confirm.
  function openConfirm(onTeardown = vi.fn()) {
    render(
      <ConnectionDetailView
        connection={connWith(simpleSet)} inventory={emptyInventory} audit={[]}
        onBack={noop} onPause={noop} onResume={noop} onRevoke={noop} onTeardown={onTeardown}
      />,
    );
    fireEvent.click(screen.getByText("Tear down everything it built"));
    return onTeardown;
  }

  it("does NOT tear down on the first click — it asks for confirmation first", () => {
    const onTeardown = openConfirm();
    // a destructive action must never fire on a single stray click
    expect(onTeardown).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/cannot be undone/i)).toBeTruthy();
  });

  it("keeps the destroy button disabled until the poppy name is typed exactly", () => {
    openConfirm();
    const confirmBtn = screen.getByText("Tear it all down") as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    // a near-miss is not enough
    fireEvent.change(screen.getByPlaceholderText("TestPoppy"), { target: { value: "TestPopp" } });
    expect(confirmBtn.disabled).toBe(true);
    // the exact name (case-insensitive) arms it
    fireEvent.change(screen.getByPlaceholderText("TestPoppy"), { target: { value: "testpoppy" } });
    expect(confirmBtn.disabled).toBe(false);
  });

  it("does not tear down when the confirm button is clicked without typing the name", () => {
    const onTeardown = openConfirm();
    // disabled buttons don't fire onClick, but assert intent explicitly
    fireEvent.click(screen.getByText("Tear it all down"));
    expect(onTeardown).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("cancels the confirmation without tearing down", () => {
    const onTeardown = openConfirm();
    fireEvent.click(screen.getByText("Cancel"));
    expect(onTeardown).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("tears down only after typing the poppy name and confirming", () => {
    const onTeardown = openConfirm();
    fireEvent.change(screen.getByPlaceholderText("TestPoppy"), { target: { value: "TestPoppy" } });
    fireEvent.click(screen.getByText("Tear it all down"));
    expect(onTeardown).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("previews exactly what teardown will delete, summarised from the live footprint", () => {
    const infra: InfraGraph = {
      connectionId: "c1", appId: "x", generatedAt: "t", edges: [],
      nodes: [
        { id: "n1", service: "lambda", resourceType: "AWS::Lambda::Function", name: "fn-a", region: "eu-west-1", status: "present", inStack: true },
        { id: "n2", service: "lambda", resourceType: "AWS::Lambda::Function", name: "fn-b", region: "eu-west-1", status: "present", inStack: true },
        { id: "n3", service: "cognito-idp", resourceType: "AWS::Cognito::UserPool", name: "pool", region: "eu-west-1", status: "present", inStack: true },
      ],
    };
    render(
      <ConnectionDetailView
        connection={connWith(simpleSet)}
        inventory={{ connectionId: "c1", stacks: [{ stackName: "MyStack", region: "eu-west-1", stackExists: true, resources: [] }], ledger: [] }}
        audit={[]} infra={infra}
        onBack={noop} onPause={noop} onResume={noop} onRevoke={noop} onTeardown={noop}
      />,
    );
    fireEvent.click(screen.getByText("Tear down everything it built"));
    // scope to the dialog — the infra map also renders these service labels
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("What will be deleted")).toBeTruthy();
    expect(dialog.getByText(/resources across 2 services/i)).toBeTruthy();
    expect(dialog.getByText("Lambda")).toBeTruthy();
    expect(dialog.getByText("Cognito")).toBeTruthy();
    expect(dialog.getByText(/MyStack/)).toBeTruthy();
  });

  it("re-arms (clears the typed name) if you cancel and reopen", () => {
    const onTeardown = openConfirm();
    fireEvent.change(screen.getByPlaceholderText("TestPoppy"), { target: { value: "TestPoppy" } });
    fireEvent.click(screen.getByText("Cancel"));
    fireEvent.click(screen.getByText("Tear down everything it built"));
    // the field is blank again, so the destroy button is disabled until re-typed
    expect((screen.getByPlaceholderText("TestPoppy") as HTMLInputElement).value).toBe("");
    expect((screen.getByText("Tear it all down") as HTMLButtonElement).disabled).toBe(true);
    expect(onTeardown).not.toHaveBeenCalled();
  });
});

describe("ConnectionDetailView — teardown of a revoked/blocked poppy (always possible, re-enable recommended)", () => {
  const withStacks: Inventory = {
    connectionId: "c1",
    stacks: [{ stackName: "S", region: "eu-west-1", stackExists: true, resources: [] }],
    ledger: [],
  };

  it("never blocks teardown of a revoked poppy — and recommends re-enabling first for completeness", () => {
    const onTeardown = vi.fn();
    const onReEnable = vi.fn();
    render(
      <ConnectionDetailView
        connection={connWith(simpleSet, "revoked")} inventory={withStacks} audit={[]}
        onBack={noop} onPause={noop} onResume={noop} onRevoke={noop} onTeardown={onTeardown} onReEnable={onReEnable}
      />,
    );
    fireEvent.click(screen.getByText("Tear down everything it built"));
    const dialog = within(screen.getByRole("dialog"));

    // The host backstop is explained, and re-enable-first is recommended — not required.
    expect(dialog.getByText(/directly removes everything still tagged/i)).toBeTruthy();
    expect(dialog.getByText(/most complete/i)).toBeTruthy();

    // The type-to-confirm destroy path is ALWAYS available: users can always clean up.
    fireEvent.change(screen.getByPlaceholderText("TestPoppy"), { target: { value: "TestPoppy" } });
    fireEvent.click(screen.getByText("Tear it all down"));
    expect(onTeardown).toHaveBeenCalledTimes(1);
  });

  it("the recommended 'Re-enable first' button jumps to the poppy without tearing down", () => {
    const onTeardown = vi.fn();
    const onReEnable = vi.fn();
    render(
      <ConnectionDetailView
        connection={connWith(simpleSet, "revoked")} inventory={withStacks} audit={[]}
        onBack={noop} onPause={noop} onResume={noop} onRevoke={noop} onTeardown={onTeardown} onReEnable={onReEnable}
      />,
    );
    fireEvent.click(screen.getByText("Tear down everything it built"));
    fireEvent.click(screen.getByRole("button", { name: /Re-enable first/i }));
    expect(onReEnable).toHaveBeenCalledTimes(1);
    expect(onTeardown).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows no recommendation for a revoked poppy with no footprint", () => {
    render(
      <ConnectionDetailView
        connection={connWith(simpleSet, "revoked")} inventory={emptyInventory} audit={[]}
        onBack={noop} onPause={noop} onResume={noop} onRevoke={noop} onTeardown={noop} onReEnable={noop}
      />,
    );
    fireEvent.click(screen.getByText("Tear down everything it built"));
    // Nothing to strand → the plain type-to-confirm path, no re-enable steering.
    expect(screen.getByPlaceholderText("TestPoppy")).toBeTruthy();
    expect(screen.queryByText(/Re-enable first/)).toBeNull();
  });

  it("a BLOCKED poppy gets honest blocked copy, no dead-end re-enable suggestion", () => {
    const onTeardown = vi.fn();
    render(
      <ConnectionDetailView
        connection={connWith(simpleSet, "revoked")} inventory={withStacks} audit={[]}
        onBack={noop} onPause={noop} onResume={noop} onRevoke={noop} onTeardown={onTeardown}
        onReEnable={noop} poppyBlocked
      />,
    );
    fireEvent.click(screen.getByText("Tear down everything it built"));
    const dialog = within(screen.getByRole("dialog"));

    // A blocked poppy would dead-end on re-enable, so it's never suggested.
    expect(screen.queryByText(/Re-enable first/)).toBeNull();
    expect(dialog.getByText(/is blocked, so its own cleanup can’t run/i)).toBeTruthy();
    // Teardown still works: the host removes what's tagged.
    fireEvent.change(screen.getByPlaceholderText("TestPoppy"), { target: { value: "TestPoppy" } });
    fireEvent.click(screen.getByText("Tear it all down"));
    expect(onTeardown).toHaveBeenCalledTimes(1);
  });
});

describe("ConnectionDetailView — leftovers the teardown couldn't remove", () => {
  const leftover = {
    arn: "arn:aws:s3:::orphan-bucket",
    resourceType: "s3",
    region: "eu-west-1",
    consoleUrl: "https://s3.console.aws.amazon.com/s3/buckets/orphan-bucket?region=eu-west-1",
  };

  it("lists each leftover with a console link — never a silent orphan", () => {
    render(
      <ConnectionDetailView
        connection={connWith(simpleSet, "revoked")} inventory={emptyInventory} audit={[]}
        onBack={noop} onPause={noop} onResume={noop} onRevoke={noop} onTeardown={noop}
        leftovers={[leftover]}
      />,
    );
    expect(screen.getByText(/1 resource could not be removed/i)).toBeTruthy();
    expect(screen.getByText("arn:aws:s3:::orphan-bucket")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Open in console/ })).toBeTruthy();
  });

  it("offers the update-policy fix when cleanup was denied by the access policy", () => {
    const onUpdatePolicy = vi.fn();
    render(
      <ConnectionDetailView
        connection={connWith(simpleSet, "revoked")} inventory={emptyInventory} audit={[]}
        onBack={noop} onPause={noop} onResume={noop} onRevoke={noop} onTeardown={noop}
        leftovers={[leftover]} cleanupAuthProblem onUpdatePolicy={onUpdatePolicy}
      />,
    );
    expect(screen.getByText(/access policy predates automatic cleanup/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update access policy" }));
    expect(onUpdatePolicy).toHaveBeenCalledTimes(1);
  });

  it("renders no leftovers panel when there's nothing left", () => {
    render(
      <ConnectionDetailView
        connection={connWith(simpleSet)} inventory={emptyInventory} audit={[]}
        onBack={noop} onPause={noop} onResume={noop} onRevoke={noop} onTeardown={noop}
        leftovers={[]}
      />,
    );
    expect(screen.queryByText(/could not be removed/i)).toBeNull();
  });

  it("still shows the update-policy fix when cleanup was denied but the lagging sweep listed nothing", () => {
    const onUpdatePolicy = vi.fn();
    render(
      <ConnectionDetailView
        connection={connWith(simpleSet, "revoked")} inventory={emptyInventory} audit={[]}
        onBack={noop} onPause={noop} onResume={noop} onRevoke={noop} onTeardown={noop}
        leftovers={[]} cleanupAuthProblem onUpdatePolicy={onUpdatePolicy}
      />,
    );
    // The fix must never be invisible just because the tag index under-reported.
    expect(screen.getByText(/access policy predates automatic cleanup/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update access policy" }));
    expect(onUpdatePolicy).toHaveBeenCalledTimes(1);
  });
});

describe("ConnectionDetailView — activity order", () => {
  it("lists the most recent activity first", () => {
    render(
      <ConnectionDetailView
        connection={connWith(simpleSet)} inventory={emptyInventory}
        audit={[
          { ts: "2026-06-01T10:00:00Z", type: "connected" },
          { ts: "2026-06-03T10:00:00Z", type: "torn-down" },
          { ts: "2026-06-02T10:00:00Z", type: "approved" },
        ]}
        onBack={noop} onPause={noop} onResume={noop} onRevoke={noop} onTeardown={noop}
      />,
    );
    const items = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    const order = ["torn-down", "approved", "connected"].map((t) => items.findIndex((x) => x.includes(t)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("ConnectionDetailView — account unreadable", () => {
  it("shows a reconnect banner with a working Reconnect button instead of an empty map when AWS can't be read", () => {
    const onReconnect = vi.fn();
    render(
      <ConnectionDetailView
        connection={connWith(simpleSet)} inventory={emptyInventory} audit={[]}
        infraError="AgentsPoppy can't read this AWS account — its operator credentials are invalid or expired."
        onReconnect={onReconnect}
        onBack={noop} onPause={noop} onResume={noop} onRevoke={noop} onTeardown={noop}
      />,
    );
    expect(screen.getByText("AgentsPoppy can’t read this AWS account")).toBeTruthy();
    expect(screen.getByText(/operator credentials are invalid or expired/i)).toBeTruthy();
    // not the misleading empty-state
    expect(screen.queryByText("Nothing yet.")).toBeNull();
    // the banner offers a real path out (the old copy pointed at a nonexistent "Account → connect AWS")
    const reconnect = screen.getByRole("button", { name: /Reconnect AWS/i });
    fireEvent.click(reconnect);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});

describe("ConnectionDetailView — live indicator", () => {
  it("shows a Live cue when the view auto-refreshes", () => {
    render(
      <ConnectionDetailView
        connection={connWith(simpleSet)} inventory={emptyInventory} audit={[]} live
        onBack={noop} onPause={noop} onResume={noop} onRevoke={noop} onTeardown={noop}
      />,
    );
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("omits the Live cue when not auto-refreshing", () => {
    renderDetail(simpleSet);
    expect(screen.queryByText("Live")).toBeNull();
  });
});

// A launch-class grant (ec2:RunInstances) is rated HIGH because the compiler cannot tag
// such a resource at birth, so teardown will never find it. The card sitting next to that
// badge must not simultaneously reassure the user with the additive wording — a red badge
// beside "Create only / New resources it creates (not existing ones)" is the rating and
// the UI contradicting each other on the same card. See docs/specs/scope-policy-and-rating.md.
describe("ConnectionDetailView — a launch grant is not described as a harmless create", () => {
  const launchSet: PermissionSet = {
    id: "p", name: "P", description: "",
    grants: [{ service: "ec2", actions: ["RunInstances", "CreateSecurityGroup"], resourceScope: "*" }],
    requiredTags: ["agentspoppy:account", "agentspoppy:app", "agentspoppy:connection"],
    limits: null,
  };

  it("labels it as starting things up, not as 'Create only'", () => {
    renderDetail(launchSet);
    expect(screen.getByText("Start up new")).toBeTruthy();
    expect(screen.queryByText("Create only")).toBeNull();
  });

  it("does not tell the user it is limited to resources it creates", () => {
    renderDetail(launchSet);
    expect(screen.queryByText(/New resources it creates \(not existing ones\)/)).toBeNull();
    expect(screen.getByText(/untagged, so not tracked/)).toBeTruthy();
  });

  it("still uses the plain additive wording for a genuine create-only grant", () => {
    renderDetail({
      ...launchSet,
      grants: [{ service: "cognito-idp", actions: ["CreateUserPool"], resourceScope: "*" }],
    });
    expect(screen.getByText("Create only")).toBeTruthy();
    expect(screen.getByText(/New resources it creates \(not existing ones\)/)).toBeTruthy();
  });
});

// From the adversarial review of the fault C/E fix: a grant can be confined to its own
// NAMES and still rate high, because creating an IAM role is creating a new holder of
// power in the account whatever it is called. Before this, such a grant fell through to
// the green "Its own" badge — AgentsPoppy's most reassuring badge, on precisely the
// grant the rating had just been fixed to take seriously — and was filtered out of the
// risk list because that list only looked at unscoped grants.
describe("ConnectionDetailView — a scoped grant can still be serious", () => {
  const iamSet: PermissionSet = {
    id: "p", name: "P", description: "",
    grants: [{ service: "iam", actions: ["CreateRole", "PassRole"], resourceScope: "arn:aws:iam::*:role/App-*" }],
    requiredTags: ["agentspoppy:account", "agentspoppy:app", "agentspoppy:connection"],
    limits: null,
  };

  it("does not show the green badge on a control-plane grant", () => {
    renderDetail(iamSet);
    expect(screen.getByText("Its own — permissions")).toBeTruthy();
  });

  it("lists it under the risks, not only as a badge", () => {
    renderDetail(iamSet);
    expect(screen.getByText(/IAM — controls who can do what in your account/)).toBeTruthy();
  });

  // The contradiction: a red Unscoped badge with "Resources matching <pattern>" printed
  // underneath it, where that pattern in fact matches every hosted zone in the account.
  it("never describes an unscoped grant with a phrase that reads as a constraint", () => {
    renderDetail({
      ...iamSet,
      grants: [{ service: "route53", actions: ["ChangeResourceRecordSets"], resourceScope: "arn:aws:route53:::hostedzone/*" }],
    });
    expect(screen.queryByText(/^Resources matching/)).toBeNull();
    expect(screen.getByText(/matches all of them/)).toBeTruthy();
  });
});

