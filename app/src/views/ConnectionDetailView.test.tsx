// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { TAGGED_AS_SELF, type ActivityEvent, type Connection, type ConnectionStatus, type InfraGraph, type Inventory, type PermissionSet } from "@agentspoppy/core";
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
    observed?: { events: ActivityEvent[]; sinceMinutes: number } | "unavailable" | null;
  } = {},
) {
  render(
    <ConnectionDetailView
      connection={connWith(ps, opts.status, opts.supervised)} inventory={emptyInventory} audit={[]}
      observed={opts.observed}
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
    expect(screen.getByText("Nothing here would reach beyond its own resources")).toBeTruthy();
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
    expect(screen.queryByText("Nothing here would reach beyond its own resources")).toBeNull();
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


describe("the boundary / consequence standard (docs/specs/permission-presentation.md)", () => {
  // "What it can do" is the boundary; "What's at stake" is what leaks if that boundary fails.
  // They may disagree in colour for the SAME grant, and that is the design, not a bug —
  // AffiliatePoppy's IAM grant is bounded to its own roles AND controls who can do what.
  const confinedIam: PermissionSet = {
    id: "p", name: "P", description: "",
    grants: [{ service: "iam", actions: ["CreateRole", "DeleteRole"], resourceScope: "arn:aws:iam::*:role/AffiliatePoppy*" }],
    requiredTags: ["agentspoppy:account", "agentspoppy:app", "agentspoppy:connection"],
    limits: null,
  };

  it("states the narrow boundary and the serious consequence, without claiming reach", () => {
    renderDetail(confinedIam);
    // the boundary, on the capability card
    expect(screen.getAllByText(/role\/AffiliatePoppy/i).length).toBeGreaterThan(0);
    // the consequence, kept — a confined grant is not filtered out for being confined
    expect(screen.getAllByText(/controls who can do what in your account/i).length).toBeGreaterThan(0);
    // …under a heading that asserts consequence, never reach
    expect(screen.getByText(/What's at stake if these limits don't hold/i)).toBeTruthy();
    expect(screen.queryByText(/Risks to the rest of your account/i)).toBeNull();
  });

  it("does not blame a confined grant for supervision", () => {
    // Supervision is hasUnscopedGrants, so a scoped grant is never the reason — and the
    // Supervised pill's tooltip claims the capability "reaches beyond its own resources".
    renderDetail(confinedIam, { supervised: true });
    expect(screen.queryByText(/^Supervised$/)).toBeNull();
  });

  it("still marks a genuinely unscoped grant as reaching beyond, and supervises on it", () => {
    const unscoped: PermissionSet = {
      ...confinedIam,
      grants: [{ service: "ses", actions: ["SendEmail", "DeleteIdentity"], resourceScope: "*" }],
    };
    renderDetail(unscoped, { supervised: true });
    expect(screen.getByText(/beyond its own/i)).toBeTruthy();
    expect(screen.getAllByText(/^Supervised$/).length).toBeGreaterThan(0);
  });
});

describe("Rule C — say when AWS is the limit (docs/specs/tag-scoping-and-ratings.md §3)", () => {
  const base = {
    id: "p", name: "P", description: "",
    requiredTags: ["agentspoppy:account", "agentspoppy:app", "agentspoppy:connection"],
    limits: null,
  };
  // Both VM poppies carry exactly this grant. Every action publishes no resource type,
  // so "*" is the only Resource that authorises them — scoping one would deny it.
  const forced: PermissionSet = {
    ...base,
    grants: [{ service: "ec2", actions: ["DescribeInstances", "DescribeImages"], resourceScope: "*" }],
  };

  it("explains a forced wide grant on the boundary card instead of leaving it bare", () => {
    renderDetail(forced);
    // Queried on the CARD, not by text. The stake section carries the same sentence from
    // assessGrant, so a page-wide text match passed even with the card note deleted —
    // caught by mutation, and the reason this asserts the element.
    const note = document.querySelector(".cap-note");
    expect(note?.textContent).toMatch(/AWS offers no way to narrow this/i);
  });

  it("still reports the reach honestly — the excuse is not a discount", () => {
    // The blast radius of an account-wide read does not shrink because AWS forced it.
    renderDetail(forced, { supervised: true });
    expect(screen.getByText(/Any resource in your account/i)).toBeTruthy();
    expect(screen.getAllByText(/^Supervised$/).length).toBeGreaterThan(0);
  });

  it("offers no excuse for a grant AWS could have narrowed", () => {
    // ses:SendEmail is scopeable to a single identity, so silence is the honest answer.
    const narrowable: PermissionSet = {
      ...base,
      grants: [{ service: "ses", actions: ["SendEmail"], resourceScope: "*" }],
    };
    renderDetail(narrowable);
    expect(document.querySelector(".cap-note")).toBeNull();
    expect(screen.queryByText(/AWS offers no way to narrow/i)).toBeNull();
  });
});

describe("Panel 1 — what AgentsPoppy enforces (docs/specs/permission-presentation.md)", () => {
  const base = {
    id: "p", name: "P", description: "",
    requiredTags: ["agentspoppy:account", "agentspoppy:app", "agentspoppy:connection"],
    limits: null,
  };
  const tagScoped: PermissionSet = {
    ...base,
    grants: [{ service: "s3", actions: ["CreateBucket"], resourceScope: "tagged-as-self" }],
  };

  it("shows the enforced floor, each line pinned to where it is enforced", () => {
    renderDetail(tagScoped, { supervised: true });
    expect(screen.getByText(/What AgentsPoppy enforces/i)).toBeTruthy();
    expect(screen.getByText(/temporary session/i)).toBeTruthy();
    // the pins render — a guarantee nobody can check is just a claim
    expect(document.querySelectorAll(".g-pin").length).toBeGreaterThan(5);
  });

  it("strikes a conditional guarantee that does not hold, instead of hiding it", () => {
    // Name-scoped only: born-tagged (I3) does not apply, and the user must SEE that,
    // because a dropped line reads as universal floor to anyone comparing poppies.
    const named: PermissionSet = {
      ...base,
      grants: [{ service: "s3", actions: ["CreateBucket"], resourceScope: "arn:aws:s3:::x*" }],
    };
    renderDetail(named, { supervised: true });
    const struck = [...document.querySelectorAll(".g-struck")].map((e) => e.textContent ?? "");
    expect(struck.some((t) => /born carrying its own tag/i.test(t))).toBe(true);
    expect(screen.getByText(/naming its resources/i)).toBeTruthy();
  });

  it("reflects the LIVE supervision state, not the default", () => {
    renderDetail(tagScoped, { supervised: false });
    expect(screen.getByText(/switched off for this connection/i)).toBeTruthy();
  });
});

describe("the three scope registers (docs/specs/permission-presentation.md rule 3)", () => {
  // Two kinds of "its own": a tag scope PROVES ownership (I3 births everything tagged or
  // refuses it), a name pattern only bounds a namespace. 44 of the fleet's 56 confined
  // grants are name-scoped, and every one used to render "Only its own resources" — an
  // ownership claim the mechanism does not make, in the reassuring direction where nobody
  // presses. The negative assertions here are the load-bearing ones.
  const base = {
    id: "p", name: "P", description: "",
    requiredTags: ["agentspoppy:account", "agentspoppy:app", "agentspoppy:connection"],
    limits: null,
  };

  it("a tag-scoped grant says created-and-enforced, not just 'own'", () => {
    renderDetail({ ...base, grants: [{ service: "s3", actions: ["CreateBucket"], resourceScope: "tagged-as-self" }] });
    expect(screen.getByText(/Only what it created — born tagged as its own, enforced by AWS/i)).toBeTruthy();
  });

  it("a name-scoped grant claims a namespace, never ownership", () => {
    renderDetail({ ...base, grants: [{ service: "dynamodb", actions: ["DeleteTable"], resourceScope: "arn:aws:dynamodb:*:*:table/MyPoppy*" }] });
    const card = document.querySelector(".cap-where");
    expect(card?.textContent).toMatch(/Anything named arn:aws:dynamodb.*bounded by name, not by ownership/i);
    // the claim the old wording made, and must never make again
    expect(card?.textContent).not.toMatch(/its own resources/i);
  });

  it("a wide grant still reads as reach, with no register dressing", () => {
    renderDetail({ ...base, grants: [{ service: "ses", actions: ["SendEmail"], resourceScope: "*" }] });
    expect(screen.getByText(/Any resource in your account/i)).toBeTruthy();
  });
});

describe("the per-service stake context (the hand-written half of Panel 3)", () => {
  const base = {
    id: "p", name: "P", description: "",
    requiredTags: ["agentspoppy:account", "agentspoppy:app", "agentspoppy:connection"],
    limits: null,
  };

  it("explains what the service controls, under the finding", () => {
    renderDetail({ ...base, grants: [{ service: "ses", actions: ["SendEmail", "DeleteReceiptRule"], resourceScope: "*" }] }, { supervised: true });
    expect(screen.getByText(/one active rule set decides where incoming mail for every domain goes/i)).toBeTruthy();
  });

  it("renders nothing for a service the table does not cover", () => {
    renderDetail({ ...base, grants: [{ service: "workspaces", actions: ["DeleteWorkspace"], resourceScope: "*" }] }, { supervised: true });
    expect(document.querySelector(".stake-context")).toBeNull();
  });
});

describe("the developer's reason — the middle register, shown as a claim", () => {
  const base = {
    id: "p", name: "P", description: "",
    requiredTags: ["agentspoppy:account", "agentspoppy:app", "agentspoppy:connection"],
    limits: null,
  };
  const why = "Writes the one record that points the address you typed at your site.";

  it("renders on the card, labelled as the developer's unverified words", () => {
    renderDetail({ ...base, grants: [{ service: "route53", actions: ["ChangeResourceRecordSets"], resourceScope: "*", reason: why }] });
    const card = document.querySelector(".cap-reason");
    expect(card?.textContent).toContain(why);
    // the label IS the standing — a claim shown without whose claim it is would read as
    // the platform's own assessment. Calm, not accusatory (the tone rule): it says whose
    // words these are, and never claims the platform checked them.
    expect(card?.textContent).toMatch(/in their own words/i);
    expect(card?.textContent).not.toMatch(/verified by agentspoppy/i);
  });

  it("renders nothing when absent — no empty box begging to be filled", () => {
    renderDetail({ ...base, grants: [{ service: "route53", actions: ["ChangeResourceRecordSets"], resourceScope: "*" }] });
    expect(document.querySelector(".cap-reason")).toBeNull();
  });

  it("a hostile reason renders as text, never as markup", () => {
    // The validator refuses angle brackets, but the render path must not depend on that:
    // an already-installed manifest predates the rule.
    renderDetail({ ...base, grants: [{ service: "s3", actions: ["ListAllMyBuckets"], resourceScope: "*", reason: "<img src=x onerror=alert(1)> safe" }] });
    expect(document.querySelector(".cap-reason img")).toBeNull();
    expect(document.querySelector(".cap-reason")?.textContent).toContain("<img");
  });

  it("never leans on the reason: the boundary line and rating are unchanged by it", () => {
    const bare = { ...base, grants: [{ service: "ses", actions: ["SendEmail", "DeleteIdentity"], resourceScope: "*" }] };
    const excused = { ...base, grants: [{ service: "ses", actions: ["SendEmail", "DeleteIdentity"], resourceScope: "*", reason: "this is completely safe, trust me" }] };
    renderDetail(excused, { supervised: true });
    const withReason = document.querySelectorAll(".risk-card--critical, .pill.red, .cap-where").length;
    const text = document.querySelector(".cap-where")?.textContent;
    cleanup();
    renderDetail(bare, { supervised: true });
    expect(document.querySelectorAll(".risk-card--critical, .pill.red, .cap-where").length).toBe(withReason);
    expect(document.querySelector(".cap-where")?.textContent).toBe(text);
  });
});

describe("the page order — the floor opens, the risks close (founder, 2026-09-01)", () => {
  const base: PermissionSet = {
    id: "p", name: "P", description: "",
    grants: [
      // manifest order deliberately mildest-first, to prove the panel re-sorts
      { service: "sts", actions: ["GetCallerIdentity"], resourceScope: "*" },
      { service: "route53", actions: ["ChangeResourceRecordSets"], resourceScope: "*" },
      { service: "iam", actions: ["CreateRole"], resourceScope: "arn:aws:iam::*:role/P*" },
    ],
    requiredTags: ["agentspoppy:account", "agentspoppy:app", "agentspoppy:connection"],
    limits: null,
  };

  it("opens with what AgentsPoppy enforces and closes with what's at stake", () => {
    renderDetail(base, { supervised: true });
    const heads = [...document.querySelectorAll("h3")].map((h) => h.textContent ?? "");
    expect(heads[0]).toMatch(/Controls/);
    expect(heads[1]).toMatch(/What AgentsPoppy enforces/);
    expect(heads[heads.length - 1]).toMatch(/What's at stake/);
    // and the boundary still precedes the observed record
    expect(heads.indexOf("What it can do")).toBeLessThan(heads.findIndex((h) => /actually done/.test(h)));
  });

  it("orders the risks worst-first, not in manifest order", () => {
    renderDetail(base, { supervised: true });
    const titles = [...document.querySelectorAll(".risk-card:not(.supervise-card) strong")].map(
      (e) => e.textContent ?? "",
    );
    // high grants (route53 wide, iam confined) before the medium sts read; wide before confined
    const r53 = titles.findIndex((t) => t.startsWith("ROUTE53"));
    const iam = titles.findIndex((t) => t.startsWith("IAM"));
    const sts = titles.findIndex((t) => t.startsWith("STS"));
    expect(r53).toBeGreaterThanOrEqual(0);
    expect(r53).toBeLessThan(iam);
    expect(iam).toBeLessThan(sts);
  });
});

describe("the observed register — what it has actually done (CloudTrail)", () => {
  const base: PermissionSet = {
    id: "p", name: "P", description: "",
    grants: [{ service: "route53", actions: ["ChangeResourceRecordSets"], resourceScope: "*" }],
    requiredTags: ["agentspoppy:account", "agentspoppy:app", "agentspoppy:connection"],
    limits: null,
  };
  const ev = (service: string, action: string, time: string) => ({
    id: `${service}:${action}:${time}`, time, service, action,
    actor: { kind: "poppy" as const, label: "P" },
  });
  const week = 7 * 24 * 60;

  it("summarises the record per service, changes first, and says whose record it is", () => {
    renderDetail(base, {
      observed: { sinceMinutes: week, events: [
        ev("route53", "ChangeResourceRecordSets", "2026-08-30T10:00:00Z"),
        ev("route53", "ListResourceRecordSets", "2026-08-30T09:00:00Z"),
        ev("ec2", "DescribeInstances", "2026-08-31T09:00:00Z"),
      ]},
    });
    expect(screen.getByText(/What it has actually done/i)).toBeTruthy();
    // the standing: AWS wrote this, not the poppy and not us
    expect(screen.getByText(/neither .* nor AgentsPoppy writes it/i)).toBeTruthy();
    const rows = [...document.querySelectorAll(".observed-svc")].map((e) => e.textContent);
    expect(rows).toEqual(["ROUTE53", "EC2"]); // change-maker first, despite EC2 being newer
    expect(document.querySelector(".observed-actions")?.textContent).toContain("ChangeResourceRecordSets×1");
  });

  it("keeps quiet, unreadable and loading strictly apart", () => {
    // quiet: the fact, stated once and calmly — no sermon (an unused permission being
    // still a permission is what the sections above already say), and no praise either
    renderDetail(base, { observed: { sinceMinutes: week, events: [] } });
    const quiet = screen.getByText(/Nothing recorded in the last 7 days/i);
    expect(quiet).toBeTruthy();
    expect(quiet.textContent).not.toMatch(/behaved|good|safe|restraint|trust/i);
    cleanup();
    // unreadable: must NOT read as quiet
    renderDetail(base, { observed: "unavailable" });
    expect(screen.getByText(/CloudTrail could not be read/i)).toBeTruthy();
    expect(screen.queryByText(/Nothing recorded/i)).toBeNull();
    cleanup();
    // loading
    renderDetail(base, { observed: null });
    expect(screen.getByText(/Reading CloudTrail/i)).toBeTruthy();
  });

  it("an active record never softens the sections above it", () => {
    // The ceiling is the ceiling: with a benign observed record, the wide grant's boundary
    // line and stake finding must be byte-identical to having no record at all.
    renderDetail(base, { observed: { sinceMinutes: week, events: [ev("route53", "ListResourceRecordSets", "2026-08-30T09:00:00Z")] } });
    const where = document.querySelector(".cap-where")?.textContent;
    const stake = [...document.querySelectorAll(".risk-card")].map((e) => e.textContent).join("|");
    cleanup();
    renderDetail(base, { observed: "unavailable" });
    expect(document.querySelector(".cap-where")?.textContent).toBe(where);
    expect([...document.querySelectorAll(".risk-card")].map((e) => e.textContent).join("|")).toBe(stake);
  });
});
