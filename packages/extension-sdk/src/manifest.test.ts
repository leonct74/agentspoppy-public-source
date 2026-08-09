// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect } from "vitest";
import { TAGGED_AS_SELF } from "@agentspoppy/core";
import type { ExtensionManifest } from "./manifest";
import { parseManifest, validateManifest } from "./manifest";

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
    const native = validateManifest({ ...validManifest(), backend: { entry: "bin/x", runtime: "native" } });
    expect(native.ok).toBe(true);
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
