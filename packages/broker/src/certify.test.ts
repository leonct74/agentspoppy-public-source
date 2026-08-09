// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { Store } from "./store";
import { BrokerService } from "./service";
import {
  StubActivityProvider,
  StubCredentialVendor,
  type CloudProvider,
} from "./providers";
import { StubAwsBootstrap } from "./aws";
import { manifestHash, subjectFor, runCertification, issueCertificate } from "./certify";
import type { ExtensionRegistry } from "./extensions";
import { ATTRIBUTION_TAG_KEYS, TAGGED_AS_SELF } from "@agentspoppy/core";
import type { Connection, InfraGraph, ResidualResource, StackInventory } from "@agentspoppy/core";
import type { DeletionReport } from "./aws/deletion";
import type { ExtensionManifest } from "@agentspoppy/extension-sdk";

const APP_ID = "com.mailpoppy.desktop";

function manifest(over: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    id: APP_ID,
    name: "MailPoppy",
    version: "1.2.3",
    permissionSet: {
      id: "mailpoppy.default",
      name: "MailPoppy",
      description: "",
      grants: [{ service: "s3", actions: ["CreateBucket"], resourceScope: TAGGED_AS_SELF }],
      requiredTags: [...ATTRIBUTION_TAG_KEYS],
      limits: null,
    },
    frontend: { entry: "ui/index.html" },
    backend: { entry: "bin/backend", transport: "http" },
    capabilities: ["aws:credentials"],
    ...over,
  };
}

const stack = (name: string): StackInventory => ({
  stackName: name,
  region: "eu-west-1",
  stackExists: true,
  resources: [],
});
const residual = (arn: string, resourceType: string): ResidualResource => ({ arn, resourceType, region: "eu-west-1" });

/** A configurable CloudProvider: residuals differ before vs after the (one) teardown. */
class FakeCloud implements CloudProvider {
  toreDown = false;
  constructor(
    private readonly opts: { stacks?: StackInventory[]; before?: ResidualResource[]; after?: ResidualResource[] } = {},
  ) {}
  async listStacks(): Promise<StackInventory[]> {
    return this.toreDown ? [] : (this.opts.stacks ?? []);
  }
  async deleteStack(): Promise<void> {
    this.toreDown = true;
  }
  async findResiduals(): Promise<ResidualResource[]> {
    return this.toreDown ? (this.opts.after ?? []) : (this.opts.before ?? []);
  }
  async buildInfraGraph(connection: Connection): Promise<InfraGraph> {
    return { connectionId: connection.id, appId: connection.app.id, nodes: [], edges: [], generatedAt: "t" };
  }
  /** Certification calls teardown with hostCleanup:false, so this must never run. Throwing
   *  alone is NOT a guard (service.teardown wraps the engine in a swallow-all catch), so we
   *  RECORD the invocation — tests assert it stayed false, which fails loudly if anyone ever
   *  drops the hostCleanup:false flag from runCertification. */
  hostCleanupInvoked = false;
  async deleteResiduals(): Promise<DeletionReport> {
    this.hostCleanupInvoked = true;
    throw new Error("host cleanup must not run during certification");
  }
}

function service(cloud: CloudProvider): BrokerService {
  return new BrokerService({
    store: new Store(),
    credentials: new StubCredentialVendor(),
    cloud,
    aws: new StubAwsBootstrap(),
    activity: new StubActivityProvider(),
  });
}

/** Link an account + an approved connection for the app, returning the service + connection id. */
async function deployed(cloud: CloudProvider): Promise<{ s: BrokerService; connId: string }> {
  const s = service(cloud);
  const account = await s.linkAccount({ accountId: "123456789012", regions: ["eu-west-1"] });
  const conn = await s.requestConnection({ accountId: account.id, app: { id: APP_ID, name: "MailPoppy" }, permissionSet: manifest().permissionSet });
  await s.approve(conn.id);
  return { s, connId: conn.id };
}

describe("manifestHash / subjectFor", () => {
  it("is stable across key ordering and pins content", () => {
    const a = manifest();
    const reordered = { capabilities: a.capabilities, version: a.version, name: a.name, id: a.id, frontend: a.frontend, backend: a.backend, permissionSet: a.permissionSet } as ExtensionManifest;
    expect(manifestHash(a)).toBe(manifestHash(reordered));
    // A scope change moves the hash → a stale certificate can't carry over.
    const widened = manifest({ permissionSet: { ...a.permissionSet, grants: [{ service: "s3", actions: ["CreateBucket"], resourceScope: "*" }] } });
    expect(manifestHash(widened)).not.toBe(manifestHash(a));
  });

  it("subjectFor carries id/version/hash", () => {
    expect(subjectFor(manifest())).toEqual({ appId: APP_ID, version: "1.2.3", manifestHash: manifestHash(manifest()) });
  });
});

describe("runCertification", () => {
  let home: string;
  beforeEach(() => {
    home = join(tmpdir(), `agentspoppy-cert-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.AGENTSPOPPY_HOME = home;
    process.env.AGENTSPOPPY_LEDGER = join(home, "ledger.json");
  });
  afterEach(async () => {
    delete process.env.AGENTSPOPPY_HOME;
    delete process.env.AGENTSPOPPY_LEDGER;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("PASSES when teardown removes the footprint and the sweep is clean", async () => {
    const cloud = new FakeCloud({ stacks: [stack("MailpoppyMailStack")], before: [residual("arn:aws:s3:::mp-mail", "s3")], after: [] });
    const { s, connId } = await deployed(cloud);
    const report = await runCertification({ service: s, now: () => "2026-06-27T00:00:00.000Z" }, { connectionId: connId, manifest: manifest() });

    expect(report.passed).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.deletedStacks).toEqual(["MailpoppyMailStack"]);
    expect(report.footprintBefore).toHaveLength(1);
    expect(report.residualsAfter).toEqual([]);
    expect(report.accountId).toBe("123456789012");
    expect(report.regions).toEqual(["eu-west-1"]);
    expect(report.subject.manifestHash).toBe(manifestHash(manifest()));
    expect(report.ranAt).toBe("2026-06-27T00:00:00.000Z");
  });

  it("FAILS and reports the leftovers when the sweep is not clean", async () => {
    const cloud = new FakeCloud({
      stacks: [stack("MailpoppyMailStack")],
      before: [residual("arn:aws:s3:::mp-mail", "s3")],
      after: [residual("arn:aws:route53:::hostedzone/Z1", "route53:hostedzone"), residual("arn:aws:ses:eu-west-1:1:identity/x", "ses:identity")],
    });
    const { s, connId } = await deployed(cloud);
    const report = await runCertification({ service: s }, { connectionId: connId, manifest: manifest() });

    expect(report.passed).toBe(false);
    expect(report.residualsAfter).toHaveLength(2);
    expect(report.problems.join("\n")).toMatch(/2 resource\(s\) still tagged/);
    expect(report.problems.join("\n")).toMatch(/route53:hostedzone/);
    // THE hostCleanup:false guard: residuals were non-empty, so if runCertification ever
    // stopped passing the flag, the engine WOULD have been invoked here (and the failure
    // silently papered over). Recording-not-throwing is what makes this assert meaningful.
    expect(cloud.hostCleanupInvoked).toBe(false);
  });

  it("with a verifier, a STALE tag hit (confirmed gone) does NOT fail the run", async () => {
    const cloud = new FakeCloud({ stacks: [stack("S")], before: [residual("arn:aws:s3:::b", "s3")], after: [residual("arn:aws:cognito-idp:eu-west-1:1:userpool/x", "cognito-idp:userpool")] });
    const { s, connId } = await deployed(cloud);
    const report = await runCertification({ service: s, verifier: { verify: async () => "removed" as const } }, { connectionId: connId, manifest: manifest() });
    expect(report.passed).toBe(true);
    expect(report.residualsAfter).toEqual([]);
  });

  it("with a verifier, a CONFIRMED-present residual still fails", async () => {
    const cloud = new FakeCloud({ stacks: [stack("S")], after: [residual("arn:aws:route53:::hostedzone/Z1", "route53:hostedzone")] });
    const { s, connId } = await deployed(cloud);
    const report = await runCertification({ service: s, verifier: { verify: async () => "present" as const } }, { connectionId: connId, manifest: manifest() });
    expect(report.passed).toBe(false);
    expect(report.residualsAfter).toHaveLength(1);
    expect(cloud.hostCleanupInvoked).toBe(false); // cert must never lean on the host backstop
  });

  it("with a verifier, an UNVERIFIABLE residual warns but does not fail", async () => {
    const cloud = new FakeCloud({ stacks: [stack("S")], after: [residual("arn:aws:s3:::b", "s3")] });
    const { s, connId } = await deployed(cloud);
    const report = await runCertification({ service: s, verifier: { verify: async () => "unverified" as const } }, { connectionId: connId, manifest: manifest() });
    expect(report.passed).toBe(true);
    expect(report.warnings.join("\n")).toMatch(/couldn't be confirmed present/);
  });

  it("WARNS (but still passes) when nothing was found before teardown", async () => {
    const cloud = new FakeCloud({ stacks: [], before: [], after: [] });
    const { s, connId } = await deployed(cloud);
    const report = await runCertification({ service: s }, { connectionId: connId, manifest: manifest() });

    expect(report.passed).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.warnings.join("\n")).toMatch(/Nothing tagged with your app id was found before teardown/);
  });

  it("runs the declared teardown hook when a registry is supplied", async () => {
    const cloud = new FakeCloud({ stacks: [stack("S")], before: [residual("arn:aws:s3:::b", "s3")], after: [] });
    const { s, connId } = await deployed(cloud);
    const runTeardownHook = vi.fn(async () => {});
    const registry = { runTeardownHook } as unknown as ExtensionRegistry;

    const report = await runCertification({ service: s, registry }, { connectionId: connId, manifest: manifest({ teardown: { endpoint: "/teardown" } }) });
    expect(runTeardownHook).toHaveBeenCalledWith(connId);
    expect(report.teardownHookRun).toBe(true);
  });

  it("does not flag a hook for a manifest without one", async () => {
    const cloud = new FakeCloud({ stacks: [stack("S")], before: [], after: [] });
    const { s, connId } = await deployed(cloud);
    const runTeardownHook = vi.fn(async () => {});
    const report = await runCertification(
      { service: s, registry: { runTeardownHook } as unknown as ExtensionRegistry },
      { connectionId: connId, manifest: manifest() },
    );
    expect(runTeardownHook).not.toHaveBeenCalled();
    expect(report.teardownHookRun).toBe(false);
  });

  it("throws when the manifest id does not match the connection's app", async () => {
    const { s, connId } = await deployed(new FakeCloud());
    await expect(runCertification({ service: s }, { connectionId: connId, manifest: manifest({ id: "com.someone.else" }) })).rejects.toThrow(/does not match the connection's app/);
  });

  it("throws on an unknown connection", async () => {
    const s = service(new FakeCloud());
    await expect(runCertification({ service: s }, { connectionId: "nope", manifest: manifest() })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("issueCertificate", () => {
  const passing = () => ({
    subject: subjectFor(manifest()),
    accountId: "123456789012",
    regions: ["eu-west-1"],
    footprintBefore: [residual("arn:aws:s3:::b", "s3")],
    deletedStacks: ["S"],
    residualsAfter: [],
    teardownHookRun: false,
    passed: true,
    problems: [],
    warnings: [],
    ranAt: "2026-06-27T00:00:00.000Z",
  });

  it("issues an unsigned self certificate for a passed report", () => {
    const cert = issueCertificate(passing(), { now: () => "2026-06-27T01:00:00.000Z" });
    expect(cert.schema).toBe("agentspoppy.leaves-no-trace/1");
    expect(cert.issuer).toBe("self");
    expect(cert.signature).toBeUndefined();
    expect(cert.subject.appId).toBe(APP_ID);
    expect(cert.issuedAt).toBe("2026-06-27T01:00:00.000Z");
  });

  it("includes a signature when a signer is supplied (platform path)", () => {
    const cert = issueCertificate(passing(), { issuer: "agentspoppy", sign: (s) => `sig(${s.length})` });
    expect(cert.issuer).toBe("agentspoppy");
    expect(cert.signature).toMatch(/^sig\(\d+\)$/);
  });

  it("refuses to issue for a failed report", () => {
    const failed = { ...passing(), residualsAfter: [residual("arn:aws:s3:::leftover", "s3")], passed: false, problems: ["1 resource(s) still tagged"] };
    expect(() => issueCertificate(failed)).toThrow(/cannot issue/);
  });
});
