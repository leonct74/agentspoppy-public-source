// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { TAGGED_AS_SELF } from "@agentspoppy/core";
import type { ExtensionManifest } from "./manifest";
import { parseManifest, validateManifest, effectiveRuntime, effectiveIsolation, GRANT_REASON_MAX } from "./manifest";

/** A realistic, valid manifest (MailPoppy-shaped) reused across cases. */
function validManifest(): ExtensionManifest {
  return {
    id: "com.mailpoppy.desktop",
    name: "MailPoppy",
    version: "1.0.0",
    description: "Run your own mail backend on your own AWS.",
    permissionSet: {
      id: "mailpoppy-backend",
      name: "MailPoppy backend",
      description: "Deploy & manage the MailPoppy mail backend.",
      grants: [
        { service: "s3", actions: ["CreateBucket"], resourceScope: "arn:aws:s3:::mailpoppy*" },
        { service: "cognito-idp", actions: ["DeleteUserPool"], resourceScope: TAGGED_AS_SELF },
      ],
      requiredTags: ["agentspoppy:connection"],
      limits: null,
    },
    frontend: { entry: "ui/index.html" },
    backend: { entry: "bin/mailpoppy-backend", transport: "http" },
    capabilities: ["aws:credentials", "connection:read", "backend:invoke", "host:openExternal"],
  };
}

describe("validateManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(validateManifest(validManifest())).toEqual({ ok: true, errors: [] });
  });

  it("accepts a frontend-only extension (no backend)", () => {
    const { backend: _backend, ...rest } = validManifest();
    expect(validateManifest(rest).ok).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest("nope").errors).toContain("manifest must be an object");
  });

  it("flags a bad id, name, and version", () => {
    const r = validateManifest({ ...validManifest(), id: "mailpoppy", name: "  ", version: "v1" });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("id must be"))).toBe(true);
    expect(r.errors).toContain("name is required");
    expect(r.errors.some((e) => e.includes("version must be semver"))).toBe(true);
  });

  it("requires a non-empty, well-formed permission set", () => {
    const empty = validateManifest({ ...validManifest(), permissionSet: { id: "x", name: "x", description: "", grants: [], requiredTags: [], limits: null } });
    expect(empty.errors).toContain("permissionSet.grants must be a non-empty array");

    const badGrant = validateManifest({
      ...validManifest(),
      permissionSet: { id: "x", name: "x", description: "", grants: [{ service: "", actions: [], resourceScope: "" } as never], requiredTags: [], limits: null },
    });
    expect(badGrant.ok).toBe(false);
    expect(badGrant.errors.some((e) => e.includes("grants[0].service"))).toBe(true);
    expect(badGrant.errors.some((e) => e.includes("grants[0].actions"))).toBe(true);
    expect(badGrant.errors.some((e) => e.includes("grants[0].resourceScope"))).toBe(true);
  });

  it("requires frontend.entry", () => {
    const r = validateManifest({ ...validManifest(), frontend: { entry: "" } });
    expect(r.errors.some((e) => e.includes("frontend.entry"))).toBe(true);
  });

  it("validates an optional backend's entry + transport", () => {
    const noEntry = validateManifest({ ...validManifest(), backend: { entry: "" } as never });
    expect(noEntry.errors.some((e) => e.includes("backend.entry"))).toBe(true);
    const badTransport = validateManifest({ ...validManifest(), backend: { entry: "bin/x", transport: "grpc" } as never });
    expect(badTransport.errors.some((e) => e.includes("backend.transport"))).toBe(true);
  });

  it("validates backend.runtime (docs/RUNTIMES.md — declare, don't ship)", () => {
    const node = validateManifest({ ...validManifest(), backend: { entry: "backend/index.cjs", runtime: "node22" } });
    expect(node.ok).toBe(true);
    // Since 0.3.5 a native backend must ALSO opt out of confinement explicitly: isolation
    // defaults to "strict", which native cannot satisfy. Saying nothing is no longer a way
    // to end up unconfined — see the "confinement defaults" block below.
    const silentNative = validateManifest({ ...validManifest(), backend: { entry: "bin/x", runtime: "native" } });
    expect(silentNative.ok).toBe(false);
    const declaredNative = validateManifest({
      ...validManifest(),
      backend: { entry: "bin/x", runtime: "native", isolation: "none" },
    });
    expect(declaredNative.ok).toBe(true);
    const bad = validateManifest({ ...validManifest(), backend: { entry: "bin/x", runtime: "python312" } as never });
    expect(bad.errors.some((e) => e.includes("backend.runtime"))).toBe(true);
  });

  it("rejects unknown capabilities", () => {
    const r = validateManifest({ ...validManifest(), capabilities: ["aws:credentials", "filesystem:write"] as never });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("unknown capabilities: filesystem:write"))).toBe(true);
  });

  it("accepts an optional teardown hook with a backend", () => {
    const r = validateManifest({ ...validManifest(), teardown: { endpoint: "/teardown" } });
    expect(r.ok).toBe(true);
  });

  it("rejects a teardown endpoint that is not a backend path", () => {
    const r = validateManifest({ ...validManifest(), teardown: { endpoint: "teardown" } as never });
    expect(r.errors.some((e) => /teardown\.endpoint must be a backend path/.test(e))).toBe(true);
  });

  it("rejects a teardown hook without a backend (the hook is a backend route)", () => {
    const { backend: _b, ...noBackend } = validManifest();
    const r = validateManifest({ ...noBackend, teardown: { endpoint: "/teardown" } });
    expect(r.errors.some((e) => /teardown requires a backend/.test(e))).toBe(true);
  });
});

describe("parseManifest", () => {
  it("returns the typed manifest for valid JSON", () => {
    const m = parseManifest(JSON.stringify(validManifest()));
    expect(m.id).toBe("com.mailpoppy.desktop");
    expect(m.capabilities).toContain("backend:invoke");
  });

  it("throws on malformed JSON", () => {
    expect(() => parseManifest("{ not json")).toThrow(/not valid JSON/);
  });

  it("throws listing every validation problem", () => {
    const bad = JSON.stringify({ ...validManifest(), id: "x", version: "nope" });
    expect(() => parseManifest(bad)).toThrow(/invalid extension\.json/);
  });
});

// 0.3.5 flipped the defaults. Before it, a poppy that simply never mentioned confinement
// ran with the user's full file access — the unsafe answer by OMISSION, which is exactly
// what an external audit reported in Aug 2026. Omission must now be the safe answer.
describe("confinement defaults (0.3.5)", () => {
  it("omitting both fields yields the CONFINED combination", () => {
    expect(effectiveRuntime({})).toBe("node22");
    expect(effectiveIsolation({})).toBe("strict");
  });

  it("an explicit value always wins over the default", () => {
    expect(effectiveRuntime({ runtime: "native" })).toBe("native");
    expect(effectiveIsolation({ isolation: "none" })).toBe("none");
    expect(effectiveIsolation({ isolation: "strict" })).toBe("strict");
  });

  it("a manifest that says nothing about the backend beyond its entry is VALID and confined", () => {
    const backend = { entry: "backend/index.cjs" };
    expect(validateManifest({ ...validManifest(), backend }).ok).toBe(true);
    expect(effectiveIsolation(backend)).toBe("strict");
    expect(effectiveRuntime(backend)).toBe("node22");
  });

  // The one way to be unconfined is now to write it down — and writing it down is exactly
  // what the listing gate refuses. It can no longer be reached by saying nothing.
  it("a native backend must opt out of confinement EXPLICITLY, or it fails validation", () => {
    const silent = validateManifest({ ...validManifest(), backend: { entry: "backend/bin", runtime: "native" } });
    expect(silent.ok).toBe(false);
    expect(silent.errors.join(" ")).toMatch(/must declare "isolation": "none" explicitly/);

    const declared = validateManifest({
      ...validManifest(),
      backend: { entry: "backend/bin", runtime: "native", isolation: "none" },
    });
    expect(declared.ok).toBe(true);
  });
});

describe("a grant's optional `reason` (docs/specs/permission-presentation.md)", () => {
  // AGENTS.md has asked developers for this since the Cognito child-create recipe; two poppies
  // wrote one and the field did not exist, so the host silently dropped it. Now it is modelled,
  // and because it is developer text on a security screen it is checked when present.
  const withReason = (reason: unknown) => ({
    id: "com.example.app", name: "ExamplePoppy", version: "0.1.0", description: "d",
    permissionSet: {
      id: "x", name: "x", description: "d", requiredTags: [], limits: null,
      grants: [{ service: "s3", actions: ["ListBucket"], resourceScope: "*", reason }],
    },
    frontend: { entry: "frontend/index.html" },
    capabilities: [],
  });

  it("accepts a real one, and survives the round trip", () => {
    const why = "Pool ids are generated, so creates cannot be name-scoped narrower.";
    const r = validateManifest(withReason(why));
    expect(r.ok).toBe(true);
    expect(parseManifest(JSON.stringify(withReason(why))).permissionSet.grants[0].reason).toBe(why);
  });

  it("is optional — omitting it is not an error", () => {
    const m = withReason(undefined);
    delete (m.permissionSet.grants[0] as { reason?: unknown }).reason;
    expect(validateManifest(m).ok).toBe(true);
  });

  it("rejects an empty or non-string reason rather than showing a blank line", () => {
    expect(validateManifest(withReason("   ")).ok).toBe(false);
    expect(validateManifest(withReason(42)).ok).toBe(false);
  });

  it("caps the length — this text lands on the approval screen", () => {
    expect(validateManifest(withReason("x".repeat(GRANT_REASON_MAX))).ok).toBe(true);
    expect(validateManifest(withReason("x".repeat(GRANT_REASON_MAX + 1))).ok).toBe(false);
  });

  it("refuses markup, so a manifest cannot dress a claim up as interface", () => {
    const r = validateManifest(withReason("safe <b>trust me</b>"));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("plain text"))).toBe(true);
  });
});

describe("network egress declaration (spec: network-egress.md phase 1)", () => {
  it("accepts a valid declaration on the permission set", () => {
    const m = validManifest();
    m.permissionSet.network = { egress: "aws-only" };
    expect(validateManifest(m)).toEqual({ ok: true, errors: [] });
    m.permissionSet.network = { egress: ["api.stripe.com"] };
    expect(validateManifest(m)).toEqual({ ok: true, errors: [] });
  });

  it("absence stays valid — undeclared is weighed on the screen, not rejected here", () => {
    expect(validateManifest(validManifest()).ok).toBe(true);
  });

  it("rejects a typo'd value rather than letting it ship as 'declared'", () => {
    const m = validManifest();
    (m.permissionSet as { network?: unknown }).network = { egress: "no-internet" };
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain('"none", "aws-only", "user-directed", or an array of hostnames');
  });

  it("rejects URLs and wildcards in the domain list", () => {
    const m = validManifest();
    m.permissionSet.network = { egress: ["https://api.stripe.com"] };
    expect(validateManifest(m).ok).toBe(false);
    m.permissionSet.network = { egress: ["*.stripe.com"] };
    expect(validateManifest(m).ok).toBe(false);
  });
});

describe("compliance declaration (spec: compliance-dossier.md)", () => {
  const withCompliance = (compliance: unknown): unknown => ({ ...validManifest(), compliance });

  it("is optional — a manifest without it stays valid (declare-then-require rollout)", () => {
    expect(validateManifest(validManifest()).ok).toBe(true);
  });

  it("accepts the full three-field shape, subprocessors included", () => {
    const r = validateManifest(
      withCompliance({
        dataHandled: "Mail content and metadata, stored only in your own AWS account.",
        subprocessors: [
          { name: "mailpoppy.com", operator: "Olly Digital", purpose: "mobile-access configuration", dataShared: "domain name and entitlement status — never mail content" },
        ],
        securityContact: "security@example.com",
      }),
    );
    expect(r).toEqual({ ok: true, errors: [] });
  });

  it('accepts an EMPTY subprocessors list — the "no user data leaves your cloud" declaration', () => {
    const r = validateManifest(withCompliance({ dataHandled: "Nothing beyond your own cloud.", subprocessors: [], securityContact: "https://example.com/security" }));
    expect(r.ok).toBe(true);
  });

  it("a malformed declaration is an ERROR, never rendered — a typo may not buy a garbage dossier", () => {
    expect(validateManifest(withCompliance("yes")).ok).toBe(false);
    expect(validateManifest(withCompliance({ dataHandled: "", subprocessors: [], securityContact: "security@example.com" })).ok).toBe(false);
    // subprocessors must be STATED, not omitted — [] is a deliberate claim.
    const noSubs = validateManifest(withCompliance({ dataHandled: "x", securityContact: "security@example.com" }));
    expect(noSubs.ok).toBe(false);
    expect(noSubs.errors.join(" ")).toContain("subprocessors must be an array");
  });

  it("rejects a subprocessor entry missing its data description, naming the index", () => {
    const r = validateManifest(
      withCompliance({ dataHandled: "x", subprocessors: [{ name: "api.example.com", purpose: "sync" }], securityContact: "security@example.com" }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("subprocessors[0].dataShared");
  });

  it("securityContact must be an email or https URL — http and prose are refused", () => {
    for (const bad of ["http://example.com/security", "ask in the forum", ""]) {
      expect(validateManifest(withCompliance({ dataHandled: "x", subprocessors: [], securityContact: bad })).ok).toBe(false);
    }
  });
});
