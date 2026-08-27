// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { Store } from "../store";
import { BrokerService, BrokerError } from "../service";
import { StubActivityProvider, StubCloudProvider, StubCredentialVendor } from "../providers";
import { StubAwsBootstrap } from "../aws";
import { ExtensionRegistry } from "./registry";
import { DirectoryService, httpFetchBytes, renameWithRetry, versionAtLeast } from "./directory";
import { buildZip } from "./zip.fixtures";

const POPPY_ID = "com.example.testpoppy";
const PLATFORM = "test-plat";
const CATALOG_URL = "test://catalog.json";
const PACKAGE_URL = "test://package.zip";

function service(): BrokerService {
  return new BrokerService({
    store: new Store(),
    credentials: new StubCredentialVendor(),
    cloud: new StubCloudProvider(),
    aws: new StubAwsBootstrap(),
    activity: new StubActivityProvider(),
  });
}

function manifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: POPPY_ID,
    name: "TestPoppy",
    version: "1.0.0",
    permissionSet: {
      id: "testpoppy-backend",
      name: "TestPoppy backend",
      description: "",
      grants: [{ service: "s3", actions: ["CreateBucket"], resourceScope: "tagged-as-self" }],
      requiredTags: ["agentspoppy:connection"],
      limits: null,
    },
    frontend: { entry: "frontend/index.html" },
    backend: { entry: "backend/bin" },
    capabilities: ["aws:credentials"],
    ...overrides,
  });
}

function packageZip(manifest: string = manifestJson()): Uint8Array {
  return buildZip([
    { name: "extension.json", data: manifest },
    { name: "frontend/index.html", data: "<html>poppy</html>" },
    { name: "backend/bin", data: "#!/bin/sh\necho poppy" },
  ]);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function catalogJson(pkg: Uint8Array, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    poppies: [
      {
        id: POPPY_ID,
        name: "TestPoppy",
        version: "1.0.0",
        repo: "https://example.test/testpoppy",
        featured: true,
        packages: { [PLATFORM]: { url: PACKAGE_URL, sha256: sha256(pkg) } },
        ...over,
      },
    ],
  });
}

describe("DirectoryService", () => {
  let home: string;
  let root: string;
  let s: BrokerService;
  let registry: ExtensionRegistry;

  beforeEach(async () => {
    home = join(tmpdir(), `agentspoppy-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.AGENTSPOPPY_HOME = home;
    process.env.AGENTSPOPPY_LEDGER = join(home, "ledger.json");
    root = join(home, "extensions");
    await fs.mkdir(root, { recursive: true });
    s = service();
    registry = new ExtensionRegistry(s);
  });
  afterEach(async () => {
    delete process.env.AGENTSPOPPY_HOME;
    delete process.env.AGENTSPOPPY_LEDGER;
    await fs.rm(home, { recursive: true, force: true });
  });

  function directory(
    files: Record<string, Uint8Array | string>,
    opts: { count?: { n: number }; hostVersion?: string } = {},
  ) {
    return new DirectoryService({
      extensionsRoot: root,
      registry,
      listBlocked: () => s.listBlockedExtensions(),
      catalogUrl: CATALOG_URL,
      platformKey: PLATFORM,
      hostVersion: opts.hostVersion,
      fetchBytes: async (url: string) => {
        if (opts.count) opts.count.n++;
        const hit = files[url];
        if (hit === undefined) throw new Error(`no fixture for ${url}`);
        return typeof hit === "string" ? new TextEncoder().encode(hit) : hit;
      },
    });
  }

  async function stagingDirs(): Promise<string[]> {
    return (await fs.readdir(root)).filter((n) => n.startsWith("."));
  }

  it("annotates the catalog with installed/blocked/platform state", async () => {
    const pkg = packageZip();
    const dir = directory({ [CATALOG_URL]: catalogJson(pkg), [PACKAGE_URL]: pkg });

    const before = await dir.getCatalog();
    expect(before.sourceUrl).toBe(CATALOG_URL);
    expect(before.poppies).toHaveLength(1);
    expect(before.poppies[0]).toMatchObject({
      id: POPPY_ID,
      installed: false,
      blocked: false,
      platform: { key: PLATFORM, available: true },
    });

    await dir.install(POPPY_ID);
    await s.blockExtension(POPPY_ID);
    const after = await dir.getCatalog();
    expect(after.poppies[0]).toMatchObject({ installed: true, blocked: true });
  });

  it("caches the catalog for browsing", async () => {
    const pkg = packageZip();
    const count = { n: 0 };
    const dir = directory({ [CATALOG_URL]: catalogJson(pkg) }, { count });
    await dir.getCatalog();
    await dir.getCatalog();
    expect(count.n).toBe(1);
  });

  it("installs: verified download → files on disk → backend executable → hot-registered, not started", async () => {
    const pkg = packageZip();
    const dir = directory({ [CATALOG_URL]: catalogJson(pkg), [PACKAGE_URL]: pkg });

    const out = await dir.install(POPPY_ID);
    expect(out).toEqual({ ok: true, extensionId: POPPY_ID });

    expect(await fs.readFile(join(root, POPPY_ID, "frontend/index.html"), "utf8")).toBe("<html>poppy</html>");
    // The install chmods the backend executable — but Windows has no execute bit, so
    // assert the POSIX guarantee only where it exists (the file itself must exist on all).
    expect(await fs.stat(join(root, POPPY_ID, "backend/bin"))).toBeTruthy();
    if (process.platform !== "win32") {
      const mode = (await fs.stat(join(root, POPPY_ID, "backend/bin"))).mode;
      expect(mode & 0o111).toBeTruthy(); // executable after install
    }
    expect(registry.has(POPPY_ID)).toBe(true);
    expect(await stagingDirs()).toEqual([]);
    // Installing must not start the poppy: no connection was created for it.
    expect(await s.listConnections()).toHaveLength(0);
  });

  it("installs a win32 package whose backend ships as <entry>.exe", async () => {
    // Manifests keep the platform-neutral entry ("backend/bin"); Windows packages
    // carry the binary as bin.exe (the host appends .exe at spawn).
    const pkg = buildZip([
      { name: "extension.json", data: manifestJson() },
      { name: "frontend/index.html", data: "<html>poppy</html>" },
      { name: "backend/bin.exe", data: "MZ-fake-pe" },
    ]);
    const dir = new DirectoryService({
      extensionsRoot: root,
      registry,
      listBlocked: () => s.listBlockedExtensions(),
      catalogUrl: CATALOG_URL,
      platformKey: "win32-x64",
      fetchBytes: async (url: string) => {
        const files: Record<string, Uint8Array | string> = {
          [CATALOG_URL]: catalogJson(pkg, { packages: { "win32-x64": { url: PACKAGE_URL, sha256: sha256(pkg) } } }),
          [PACKAGE_URL]: pkg,
        };
        const hit = files[url];
        if (hit === undefined) throw new Error(`no fixture for ${url}`);
        return typeof hit === "string" ? new TextEncoder().encode(hit) : hit;
      },
    });
    const out = await dir.install(POPPY_ID);
    expect(out).toEqual({ ok: true, extensionId: POPPY_ID });
    expect(await fs.stat(join(root, POPPY_ID, "backend/bin.exe"))).toBeTruthy();
    expect(registry.has(POPPY_ID)).toBe(true);
  });

  it("still refuses a non-Windows package whose backend is only <entry>.exe", async () => {
    const pkg = buildZip([
      { name: "extension.json", data: manifestJson() },
      { name: "frontend/index.html", data: "<html>poppy</html>" },
      { name: "backend/bin.exe", data: "MZ-fake-pe" },
    ]);
    const dir = directory({ [CATALOG_URL]: catalogJson(pkg), [PACKAGE_URL]: pkg });
    await expect(dir.install(POPPY_ID)).rejects.toThrow(/missing its backend/);
    expect(registry.has(POPPY_ID)).toBe(false);
  });

  it("refuses a hash mismatch and leaves nothing behind", async () => {
    const pkg = packageZip();
    const dir = directory({
      [CATALOG_URL]: catalogJson(pkg, { packages: { [PLATFORM]: { url: PACKAGE_URL, sha256: "0".repeat(64) } } }),
      [PACKAGE_URL]: pkg,
    });
    await expect(dir.install(POPPY_ID)).rejects.toThrow(/corrupted or tampered/);
    expect(registry.has(POPPY_ID)).toBe(false);
    await expect(fs.stat(join(root, POPPY_ID))).rejects.toThrow();
    expect(await stagingDirs()).toEqual([]);
  });

  it("refuses a package whose manifest doesn't match its listing (id squatting)", async () => {
    const imposter = packageZip(manifestJson({ id: "com.example.imposter" }));
    const dir = directory({ [CATALOG_URL]: catalogJson(imposter), [PACKAGE_URL]: imposter });
    await expect(dir.install(POPPY_ID)).rejects.toThrow(/doesn't match its listing/);
    expect(await stagingDirs()).toEqual([]);
    expect(registry.has("com.example.imposter")).toBe(false);
  });

  it("refuses a package whose display name doesn't match its listing (impersonation defence)", async () => {
    // Same id + version, different name: after install the sidebar would show the
    // manifest's name, not the directory's — so a mismatch is refused outright.
    const disguised = packageZip(manifestJson({ name: "TotallyOtherPoppy" }));
    const dir = directory({ [CATALOG_URL]: catalogJson(disguised), [PACKAGE_URL]: disguised });
    await expect(dir.install(POPPY_ID)).rejects.toThrow(/doesn't match its listing/);
    expect(await stagingDirs()).toEqual([]);
    expect(registry.has(POPPY_ID)).toBe(false);
  });

  it("refuses an invalid manifest and cleans the staging dir", async () => {
    const bad = packageZip("{not json");
    const dir = directory({ [CATALOG_URL]: catalogJson(bad), [PACKAGE_URL]: bad });
    await expect(dir.install(POPPY_ID)).rejects.toThrow(/manifest is invalid/);
    expect(await stagingDirs()).toEqual([]);
  });

  it("409s when already installed", async () => {
    const pkg = packageZip();
    const dir = directory({ [CATALOG_URL]: catalogJson(pkg), [PACKAGE_URL]: pkg });
    await dir.install(POPPY_ID);
    const err = await dir.install(POPPY_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect((err as BrokerError).code).toBe("invalid_state");
    expect((err as BrokerError).message).toMatch(/already installed/);
  });

  it("409s when blocked", async () => {
    const pkg = packageZip();
    const dir = directory({ [CATALOG_URL]: catalogJson(pkg), [PACKAGE_URL]: pkg });
    await s.blockExtension(POPPY_ID);
    const err = await dir.install(POPPY_ID).catch((e: unknown) => e);
    expect((err as BrokerError).code).toBe("invalid_state");
    expect((err as BrokerError).message).toMatch(/blocked on this computer/);
  });

  it("400s when there is no package for this platform", async () => {
    const pkg = packageZip();
    const dir = directory({ [CATALOG_URL]: catalogJson(pkg, { packages: {} }), [PACKAGE_URL]: pkg });
    const err = await dir.install(POPPY_ID).catch((e: unknown) => e);
    expect((err as BrokerError).code).toBe("bad_request");
    expect((err as BrokerError).message).toMatch(/isn't available for this computer/);
  });

  it("refuses a catalog id that isn't a valid poppy id (path-injection defence)", async () => {
    // A compromised catalog must not be able to smuggle path segments into the
    // staging dir name — the id is validated before it ever touches a path.
    const evilId = "../evil";
    const pkg = packageZip();
    const dir = directory({
      [CATALOG_URL]: catalogJson(pkg, { id: evilId }),
      [PACKAGE_URL]: pkg,
    });
    const err = await dir.install(evilId).catch((e: unknown) => e);
    expect((err as BrokerError).code).toBe("bad_request");
    expect((err as BrokerError).message).toMatch(/isn't a valid poppy id/);
    expect(await stagingDirs()).toEqual([]);
  });

  it("404s an id the catalog doesn't list", async () => {
    const pkg = packageZip();
    const dir = directory({ [CATALOG_URL]: catalogJson(pkg), [PACKAGE_URL]: pkg });
    const err = await dir.install("com.example.unknown").catch((e: unknown) => e);
    expect((err as BrokerError).code).toBe("not_found");
  });

  it("drops malformed catalog entries but keeps the valid ones", async () => {
    const pkg = packageZip();
    const raw = JSON.stringify({
      schemaVersion: 1,
      poppies: [{ name: "NoId", version: "1.0.0" }, JSON.parse(catalogJson(pkg)).poppies[0]],
    });
    const dir = directory({ [CATALOG_URL]: raw });
    const view = await dir.getCatalog();
    expect(view.poppies).toHaveLength(1);
    expect(view.poppies[0]!.id).toBe(POPPY_ID);
  });

  it("uninstalls: files gone, registry forgotten, cloud/connection untouched", async () => {
    const pkg = packageZip();
    const dir = directory({ [CATALOG_URL]: catalogJson(pkg), [PACKAGE_URL]: pkg });
    await dir.install(POPPY_ID);
    expect(registry.has(POPPY_ID)).toBe(true);

    const out = await dir.uninstall(POPPY_ID);
    expect(out).toEqual({ ok: true, extensionId: POPPY_ID });
    expect(registry.has(POPPY_ID)).toBe(false);
    await expect(fs.stat(join(root, POPPY_ID))).rejects.toThrow(); // files removed
    // The catalog offers it again (installed flag flips back).
    expect((await dir.getCatalog()).poppies[0]!.installed).toBe(false);
    // And a reinstall works cleanly.
    await dir.install(POPPY_ID);
    expect(registry.has(POPPY_ID)).toBe(true);
  });

  it("404s an uninstall of something not installed", async () => {
    const pkg = packageZip();
    const dir = directory({ [CATALOG_URL]: catalogJson(pkg), [PACKAGE_URL]: pkg });
    const err = await dir.uninstall(POPPY_ID).catch((e: unknown) => e);
    expect((err as BrokerError).code).toBe("not_found");
  });

  // A directory pinned to version 1.1.0 with a matching package — the "catalog moved on" state.
  function directoryAtV2() {
    const v2 = packageZip(manifestJson({ version: "1.1.0" }));
    return directory({
      [CATALOG_URL]: catalogJson(v2, {
        version: "1.1.0",
        packages: { [PLATFORM]: { url: PACKAGE_URL, sha256: sha256(v2) } },
      }),
      [PACKAGE_URL]: v2,
    });
  }

  it("reports installedVersion + updateAvailable once the catalog lists a newer version", async () => {
    const v1 = packageZip();
    await directory({ [CATALOG_URL]: catalogJson(v1), [PACKAGE_URL]: v1 }).install(POPPY_ID);

    const view = await directoryAtV2().getCatalog();
    expect(view.poppies[0]).toMatchObject({
      installed: true,
      installedVersion: "1.0.0",
      version: "1.1.0",
      updateAvailable: true,
    });
  });

  it("updates: swaps to the catalog's newer version, old files gone, connection kept, nothing staged", async () => {
    const v1 = packageZip();
    await directory({ [CATALOG_URL]: catalogJson(v1), [PACKAGE_URL]: v1 }).install(POPPY_ID);
    expect(registry.get(POPPY_ID)!.manifest.version).toBe("1.0.0");

    const dir = directoryAtV2();
    const out = await dir.update(POPPY_ID);
    expect(out).toEqual({ ok: true, extensionId: POPPY_ID, version: "1.1.0" });

    // Registered at the new version, files in place, no connection created (update ≠ start),
    // and no staging/trash residue.
    expect(registry.get(POPPY_ID)!.manifest.version).toBe("1.1.0");
    expect(await fs.readFile(join(root, POPPY_ID, "frontend/index.html"), "utf8")).toBe("<html>poppy</html>");
    expect(await s.listConnections()).toHaveLength(0);
    expect(await stagingDirs()).toEqual([]);
    expect((await dir.getCatalog()).poppies[0]).toMatchObject({ installedVersion: "1.1.0", updateAvailable: false });
  });

  it("update: a no-op (already current) returns ok without touching disk", async () => {
    const v1 = packageZip();
    const dir = directory({ [CATALOG_URL]: catalogJson(v1), [PACKAGE_URL]: v1 });
    await dir.install(POPPY_ID);
    const out = await dir.update(POPPY_ID);
    expect(out).toEqual({ ok: true, extensionId: POPPY_ID, version: "1.0.0" });
    expect(registry.get(POPPY_ID)!.manifest.version).toBe("1.0.0");
  });

  it("update: 404s when the poppy isn't installed", async () => {
    const err = await directoryAtV2().update(POPPY_ID).catch((e: unknown) => e);
    expect((err as BrokerError).code).toBe("not_found");
    expect((err as BrokerError).message).toMatch(/nothing to update/);
  });

  it("update: a corrupt new package is rejected BEFORE the swap — old install stays intact", async () => {
    const v1 = packageZip();
    await directory({ [CATALOG_URL]: catalogJson(v1), [PACKAGE_URL]: v1 }).install(POPPY_ID);

    const v2 = packageZip(manifestJson({ version: "1.1.0" }));
    const dir = directory({
      [CATALOG_URL]: catalogJson(v2, {
        version: "1.1.0",
        packages: { [PLATFORM]: { url: PACKAGE_URL, sha256: "0".repeat(64) } }, // wrong hash
      }),
      [PACKAGE_URL]: v2,
    });
    await expect(dir.update(POPPY_ID)).rejects.toThrow(/corrupted or tampered/);

    // Still installed at the old version, its files intact, nothing left staged.
    expect(registry.get(POPPY_ID)!.manifest.version).toBe("1.0.0");
    expect(await fs.stat(join(root, POPPY_ID))).toBeTruthy();
    expect(await stagingDirs()).toEqual([]);
  });

  it("previewUpdate reads the repo WITHOUT downloading the package; applyUpdate downloads on consent", async () => {
    const v1 = packageZip();
    await directory({ [CATALOG_URL]: catalogJson(v1), [PACKAGE_URL]: v1 }).install(POPPY_ID);

    const v2 = packageZip(manifestJson({ version: "1.1.0" }));
    // The PACKAGE_URL must NOT be fetched during preview — only when the user chooses to install.
    let pkgFetches = 0;
    const dir = new DirectoryService({
      extensionsRoot: root,
      registry,
      listBlocked: () => s.listBlockedExtensions(),
      catalogUrl: CATALOG_URL,
      platformKey: PLATFORM,
      fetchBytes: async (url: string) => {
        if (url === CATALOG_URL) return new TextEncoder().encode(catalogJson(v2, { version: "1.1.0" }));
        if (url === PACKAGE_URL) {
          pkgFetches++;
          return v2;
        }
        throw new Error(`no fixture for ${url}`);
      },
    });

    const pv = await dir.previewUpdate(POPPY_ID);
    expect(pv).toMatchObject({ id: POPPY_ID, installedVersion: "1.0.0", version: "1.1.0" });
    expect(pv.installedGrants.length).toBeGreaterThan(0); // the CURRENT scope, for the agent to compare
    expect(pkgFetches).toBe(0); // ← nothing downloaded to the machine at review time
    expect(registry.get(POPPY_ID)!.manifest.version).toBe("1.0.0"); // not applied
    expect(await stagingDirs()).toEqual([]); // nothing staged

    const out = await dir.applyUpdate(POPPY_ID);
    expect(out).toMatchObject({ ok: true, extensionId: POPPY_ID, version: "1.1.0", scopeChanged: false });
    expect(pkgFetches).toBe(1); // downloaded only now, on consent
    expect(registry.get(POPPY_ID)!.manifest.version).toBe("1.1.0");
    expect(await stagingDirs()).toEqual([]); // consumed, nothing lingering
  });

  it("previewUpdate returns the CURRENTLY-installed scope for the agent to compare (no download)", async () => {
    const v1 = packageZip();
    await directory({ [CATALOG_URL]: catalogJson(v1), [PACKAGE_URL]: v1 }).install(POPPY_ID);
    const pv = await directoryAtV2().previewUpdate(POPPY_ID);
    // The installed manifest declares s3:CreateBucket tagged-as-self.
    expect(pv.installedGrants.some((g) => g.includes("s3") && g.includes("CreateBucket"))).toBe(true);
    expect(pv.installedCapabilities).toContain("aws:credentials");
  });

  it("applyUpdate reports the AWS scope change (computed from the downloaded manifest, at install)", async () => {
    const v1 = packageZip();
    await directory({ [CATALOG_URL]: catalogJson(v1), [PACKAGE_URL]: v1 }).install(POPPY_ID);

    const v2 = packageZip(
      manifestJson({
        version: "1.1.0",
        permissionSet: {
          id: "testpoppy-backend",
          name: "TestPoppy backend",
          description: "",
          grants: [
            { service: "s3", actions: ["CreateBucket"], resourceScope: "tagged-as-self" },
            { service: "ses", actions: ["SendEmail"], resourceScope: "*" }, // NEW
          ],
          requiredTags: ["agentspoppy:connection"],
          limits: null,
        },
      }),
    );
    const dir = directory({ [CATALOG_URL]: catalogJson(v2, { version: "1.1.0" }), [PACKAGE_URL]: v2 });

    const out = await dir.applyUpdate(POPPY_ID);
    expect(out.scopeChanged).toBe(true);
    expect(out.grantsAdded.some((g) => g.includes("ses") && g.includes("SendEmail"))).toBe(true);
    expect(out.grantsRemoved).toEqual([]);
  });

  // Step 2 of the permissions-boundary migration adds ONE action to an existing IAM grant in
  // five poppies. Diffing whole grants reported all fourteen actions as "new access", burying
  // the one that changed — a consent prompt that is mostly noise is one people learn to click
  // past, which is worse than not prompting. The delta must be the delta.
  it("applyUpdate reports an ACTION added to an existing grant as just that action", async () => {
    const v1 = packageZip();
    await directory({ [CATALOG_URL]: catalogJson(v1), [PACKAGE_URL]: v1 }).install(POPPY_ID);

    const v2 = packageZip(
      manifestJson({
        version: "1.1.0",
        permissionSet: {
          id: "testpoppy-backend",
          name: "TestPoppy backend",
          description: "",
          // Same service, same scope — one action added.
          grants: [{ service: "s3", actions: ["CreateBucket", "DeleteBucket"], resourceScope: "tagged-as-self" }],
          requiredTags: ["agentspoppy:connection"],
          limits: null,
        },
      }),
    );
    const out = await directory({
      [CATALOG_URL]: catalogJson(v2, { version: "1.1.0" }),
      [PACKAGE_URL]: v2,
    }).applyUpdate(POPPY_ID);

    expect(out.scopeChanged).toBe(true); // still asks the user — this governs WHAT they're told
    expect(out.grantsAdded).toHaveLength(1);
    expect(out.grantsAdded[0]).toContain("+ DeleteBucket");
    // The already-approved action must NOT be re-presented as new access.
    expect(out.grantsAdded[0]).not.toContain("CreateBucket");
    expect(out.grantsRemoved).toEqual([]);
  });

  it("applyUpdate reports an action REMOVED from a grant as a narrowing, not as a new grant", async () => {
    const v1 = packageZip(
      manifestJson({
        permissionSet: {
          id: "testpoppy-backend",
          name: "TestPoppy backend",
          description: "",
          grants: [{ service: "s3", actions: ["CreateBucket", "DeleteBucket"], resourceScope: "tagged-as-self" }],
          requiredTags: ["agentspoppy:connection"],
          limits: null,
        },
      }),
    );
    await directory({ [CATALOG_URL]: catalogJson(v1), [PACKAGE_URL]: v1 }).install(POPPY_ID);

    const v2 = packageZip(manifestJson({ version: "1.1.0" })); // back to CreateBucket only
    const out = await directory({
      [CATALOG_URL]: catalogJson(v2, { version: "1.1.0" }),
      [PACKAGE_URL]: v2,
    }).applyUpdate(POPPY_ID);

    expect(out.grantsAdded).toEqual([]);
    expect(out.grantsRemoved).toHaveLength(1);
    expect(out.grantsRemoved[0]).toContain("no longer DeleteBucket");
  });

  it("applyUpdate reports a HOST-POWER (capability) change too — not only AWS grants", async () => {
    const v1 = packageZip();
    await directory({ [CATALOG_URL]: catalogJson(v1), [PACKAGE_URL]: v1 }).install(POPPY_ID);

    const v2 = packageZip(manifestJson({ version: "1.1.0", capabilities: ["aws:credentials", "host:openExternal"] }));
    const dir = directory({ [CATALOG_URL]: catalogJson(v2, { version: "1.1.0" }), [PACKAGE_URL]: v2 });

    const out = await dir.applyUpdate(POPPY_ID);
    expect(out.scopeChanged).toBe(false); // AWS grants unchanged…
    expect(out.capabilitiesAdded).toContain("host:openExternal"); // …but a new host power is surfaced
  });

  it("previewUpdate 404s when the poppy isn't installed", async () => {
    const err = await directoryAtV2().previewUpdate(POPPY_ID).catch((e: unknown) => e);
    expect((err as BrokerError).code).toBe("not_found");
  });

  it("serialises concurrent updates for ONE poppy — exactly one swaps, no registry/disk divergence", async () => {
    const v1 = packageZip();
    await directory({ [CATALOG_URL]: catalogJson(v1), [PACKAGE_URL]: v1 }).install(POPPY_ID);
    const dir = directoryAtV2();

    // Two applyUpdate calls at once. The per-id lock serialises them: the first downloads + swaps
    // to 1.1.0; the second, now already-current, is a clean no-op — instead of both racing swapIn
    // and leaving the registry pinned to a version disk doesn't hold.
    const settled = await Promise.allSettled([dir.applyUpdate(POPPY_ID), dir.applyUpdate(POPPY_ID)]);
    expect(settled.every((r) => r.status === "fulfilled")).toBe(true);
    const swapped = settled.filter((r) => r.status === "fulfilled" && (r.value as { version: string }).version === "1.1.0");
    expect(swapped).toHaveLength(2); // both report 1.1.0 (one did the swap, one saw it already current)
    expect(registry.get(POPPY_ID)!.manifest.version).toBe("1.1.0");
    expect(await stagingDirs()).toEqual([]); // clean — no leaked staging/backup
  });

  it("never deletes files rooted OUTSIDE the extensions root (sideload safety)", async () => {
    const outside = join(home, "elsewhere", POPPY_ID);
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(join(outside, "extension.json"), manifestJson());
    registry.install({ manifest: JSON.parse(manifestJson()), root: outside });

    const dir = directory({});
    await dir.uninstall(POPPY_ID);
    expect(registry.has(POPPY_ID)).toBe(false); // forgotten…
    expect(await fs.stat(join(outside, "extension.json"))).toBeTruthy(); // …but never deleted
  });

  it("keeps only the first listing when ids or names collide (M15: one name per poppy)", async () => {
    const first = { id: POPPY_ID, name: "MailPoppy", version: "1.0.0", repo: "https://example.test/a" };
    const raw = JSON.stringify({
      schemaVersion: 1,
      poppies: [
        first,
        // A lookalike: different id, but the name normalizes to the same key.
        { id: "com.example.lookalike", name: "Mail-Poppy", version: "2.0.0", repo: "https://example.test/b" },
        // A straight id duplicate.
        { ...first, version: "9.9.9" },
      ],
    });
    const dir = directory({ [CATALOG_URL]: raw });
    const view = await dir.getCatalog();
    expect(view.poppies).toHaveLength(1);
    expect(view.poppies[0]).toMatchObject({ id: POPPY_ID, name: "MailPoppy", version: "1.0.0" });
  });

  it("passes a conforming PNG data-URI icon through and strips anything else", async () => {
    const PNG = `data:image/png;base64,${Buffer.from("fake png bytes").toString("base64")}`;
    const raw = JSON.stringify({
      schemaVersion: 1,
      poppies: [
        { id: POPPY_ID, name: "MailPoppy", version: "1.0.0", repo: "https://example.test/a", icon: PNG },
        // Icons render straight into an <img src>, so a URL (hello, tracking pixel)
        // or an oversized blob loses the ICON — never the listing.
        { id: "com.example.url", name: "Url-Poppy", version: "1.0.0", repo: "https://example.test/b", icon: "https://evil.test/pixel.png" },
        { id: "com.example.huge", name: "Huge-Poppy", version: "1.0.0", repo: "https://example.test/c", icon: `data:image/png;base64,${"A".repeat(120_000)}` },
      ],
    });
    const view = await directory({ [CATALOG_URL]: raw }).getCatalog();
    expect(view.poppies).toHaveLength(3);
    expect(view.poppies.find((p) => p.id === POPPY_ID)?.icon).toBe(PNG);
    expect(view.poppies.find((p) => p.id === "com.example.url")?.icon).toBeUndefined();
    expect(view.poppies.find((p) => p.id === "com.example.huge")?.icon).toBeUndefined();
  });

  it("drops names that try to work around the naming convention (M15 shape)", async () => {
    const entry = (id: string, name: string) => ({ id, name, version: "1.0.0", repo: "https://example.test/r" });
    const raw = JSON.stringify({
      schemaVersion: 1,
      poppies: [
        entry("com.example.a", "mail-poppy"), // lowercase suffix
        entry("com.example.b", "Mail---Poppy"), // consecutive separators
        entry("com.example.c", "Mail@Poppy"), // special character
        entry("com.example.d", "Poppy"), // no brand before the suffix
        entry("com.example.e", "Backup Poppy"), // conforming — kept
      ],
    });
    const dir = directory({ [CATALOG_URL]: raw });
    const view = await dir.getCatalog();
    expect(view.poppies.map((p) => p.name)).toEqual(["Backup Poppy"]);
  });

  it("reports an unreachable catalog in plain language", async () => {
    const dir = directory({});
    await expect(dir.getCatalog()).rejects.toThrow(/check your internet connection/);
  });

  it('installs a platform-neutral "any" package (node-runtime poppies ship one zip for every OS)', async () => {
    const pkg = packageZip();
    const dir = directory({
      [CATALOG_URL]: catalogJson(pkg, { packages: { any: { url: PACKAGE_URL, sha256: sha256(pkg) } } }),
      [PACKAGE_URL]: pkg,
    });
    const view = await dir.getCatalog();
    expect(view.poppies[0].platform.available).toBe(true); // "any" satisfies every platformKey
    await expect(dir.install(POPPY_ID)).resolves.toEqual({ ok: true, extensionId: POPPY_ID });
  });

  it("minHost: refuses to install on a too-old host, with an 'update AgentsPoppy' error", async () => {
    const pkg = packageZip();
    const dir = directory(
      { [CATALOG_URL]: catalogJson(pkg, { minHost: "9.9.9" }), [PACKAGE_URL]: pkg },
      { hostVersion: "0.2.9" },
    );
    const view = await dir.getCatalog();
    expect(view.poppies[0].hostTooOld).toBe(true);
    await expect(dir.install(POPPY_ID)).rejects.toThrow(/update AgentsPoppy first/);
    expect(registry.has(POPPY_ID)).toBe(false);
  });

  it("minHost: suppresses updateAvailable and blocks applyUpdate (no failing Update button)", async () => {
    // Install 1.0.0 normally, then the catalog moves to 2.0.0 gated on a newer host.
    const pkg1 = packageZip();
    const dir1 = directory({ [CATALOG_URL]: catalogJson(pkg1), [PACKAGE_URL]: pkg1 }, { hostVersion: "0.2.9" });
    await dir1.install(POPPY_ID);

    const pkg2 = packageZip(manifestJson({ version: "2.0.0" }));
    const dir2 = directory(
      { [CATALOG_URL]: catalogJson(pkg2, { version: "2.0.0", minHost: "9.9.9" }), [PACKAGE_URL]: pkg2 },
      { hostVersion: "0.2.9" },
    );
    const view = await dir2.getCatalog();
    expect(view.poppies[0]).toMatchObject({ installedVersion: "1.0.0", updateAvailable: false, hostTooOld: true });
    await expect(dir2.applyUpdate(POPPY_ID)).rejects.toThrow(/update AgentsPoppy first/);
    // The old install is untouched.
    expect(registry.get(POPPY_ID)?.manifest.version).toBe("1.0.0");
  });

  it("minHost: a satisfied gate and an unknown host version (dev) both stay open", async () => {
    const pkg = packageZip();
    const satisfied = directory(
      { [CATALOG_URL]: catalogJson(pkg, { minHost: "0.2.9" }), [PACKAGE_URL]: pkg },
      { hostVersion: "0.2.9" },
    );
    await expect(satisfied.install(POPPY_ID)).resolves.toEqual({ ok: true, extensionId: POPPY_ID });

    // Reset, then the dev-run case: no hostVersion → the gate is off even for an absurd minHost.
    await registry.remove(POPPY_ID);
    await fs.rm(join(root, POPPY_ID), { recursive: true, force: true });
    const dev = directory({ [CATALOG_URL]: catalogJson(pkg, { minHost: "9.9.9" }), [PACKAGE_URL]: pkg });
    await expect(dev.install(POPPY_ID)).resolves.toEqual({ ok: true, extensionId: POPPY_ID });
  });

  // The install-time confinement gate. It exists so the refusal does not depend on
  // either zip reader catching a shadowed second manifest: whatever ends up on disk
  // is what gets checked, and a catalog listing only ever serves confined poppies.
  describe("unconfined packages", () => {
    it("refuses a catalog install whose extracted manifest opts out of confinement", async () => {
      const pkg = packageZip(manifestJson({ backend: { entry: "backend/bin", runtime: "node22", isolation: "none" } }));
      const dir = directory({ [CATALOG_URL]: catalogJson(pkg), [PACKAGE_URL]: pkg });
      await expect(dir.install(POPPY_ID)).rejects.toThrow(/without confinement/);
    });

    it("installs it when the LISTING grants the sanctioned migration exemption", async () => {
      const pkg = packageZip(manifestJson({ backend: { entry: "backend/bin", runtime: "node22", isolation: "none" } }));
      const dir = directory({
        [CATALOG_URL]: catalogJson(pkg, { allowUnconfined: true }),
        [PACKAGE_URL]: pkg,
      });
      await expect(dir.install(POPPY_ID)).resolves.toMatchObject({ extensionId: POPPY_ID });
    });

    it("does not accept a truthy non-boolean as the exemption", async () => {
      const pkg = packageZip(manifestJson({ backend: { entry: "backend/bin", runtime: "node22", isolation: "none" } }));
      const dir = directory({
        [CATALOG_URL]: catalogJson(pkg, { allowUnconfined: "yes" }),
        [PACKAGE_URL]: pkg,
      });
      await expect(dir.install(POPPY_ID)).rejects.toThrow(/without confinement/);
    });

    it("leaves a confined package alone", async () => {
      const pkg = packageZip(manifestJson({ backend: { entry: "backend/bin", runtime: "node22", isolation: "strict" } }));
      const dir = directory({ [CATALOG_URL]: catalogJson(pkg), [PACKAGE_URL]: pkg });
      await expect(dir.install(POPPY_ID)).resolves.toMatchObject({ extensionId: POPPY_ID });
    });
});

describe("versionAtLeast", () => {
  it("compares X.Y.Z numerically and fails open on junk", () => {
    expect(versionAtLeast("0.3.0", "0.2.9")).toBe(true);
    expect(versionAtLeast("0.2.9", "0.3.0")).toBe(false);
    expect(versionAtLeast("0.3.0", "0.3.0")).toBe(true);
    expect(versionAtLeast("0.10.0", "0.9.9")).toBe(true); // numeric, not lexicographic
    expect(versionAtLeast("1.0.0", "0.99.99")).toBe(true);
    expect(versionAtLeast("banana", "0.1.0")).toBe(true); // fail open — a typo must not brick installs
    expect(versionAtLeast("0.1.0", "soon")).toBe(true);
  });
});

describe("httpFetchBytes (resilient downloader)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const enc = new TextEncoder();
  /** A web stream that yields `parts` one per read, then closes or errors (a mid-body
   *  reset). Pull-based on purpose: `controller.error()` DISCARDS queued chunks, so an
   *  enqueue-then-error fixture would deliver nothing and never exercise resume. */
  function streamOf(parts: Uint8Array[], failAfter = false): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (i < parts.length) {
          c.enqueue(parts[i++]);
          return;
        }
        if (failAfter) c.error(new Error("connection reset"));
        else c.close();
      },
    });
  }
  const rangeOf = (init?: RequestInit) => (init?.headers as Record<string, string> | undefined)?.range;

  it("resumes with a Range header after a mid-body failure (the 110MB VPN-Poppy case)", async () => {
    const bytes = enc.encode("0123456789");
    const ranges: Array<string | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const range = rangeOf(init);
        ranges.push(range);
        if (!range) return new Response(streamOf([bytes.slice(0, 4)], true), { status: 200 });
        // Serve from the offset actually requested — the output proves resume correctness.
        const from = Number(/^bytes=(\d+)-$/.exec(range)![1]);
        return new Response(streamOf([bytes.slice(from)]), { status: 206 });
      }),
    );
    const out = await httpFetchBytes("https://example.test/pkg.zip", { retryDelayMs: 0 });
    expect(new TextDecoder().decode(out)).toBe("0123456789");
    expect(ranges).toEqual([undefined, "bytes=4-"]);
  });

  it("starts over cleanly when the server ignores the Range request", async () => {
    const bytes = enc.encode("abcdefgh");
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        if (call === 1) return new Response(streamOf([bytes.slice(0, 3)], true), { status: 200 });
        return new Response(streamOf([bytes]), { status: 200 }); // full body, Range ignored
      }),
    );
    const out = await httpFetchBytes("https://example.test/pkg.zip", { retryDelayMs: 0 });
    expect(new TextDecoder().decode(out)).toBe("abcdefgh");
  });

  it("gives up in plain language after exhausting attempts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(streamOf([], true), { status: 200 })),
    );
    await expect(
      httpFetchBytes("https://example.test/pkg.zip", { attempts: 2, retryDelayMs: 0 }),
    ).rejects.toThrow(/check your internet connection.*2 attempts/s);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses a body over maxBytes immediately — no retry can fix too-big", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(streamOf([enc.encode("0123456789")]), { status: 200 })),
    );
    await expect(
      httpFetchBytes("https://example.test/pkg.zip", { maxBytes: 5, retryDelayMs: 0 }),
    ).rejects.toThrow(/far larger than any poppy should be/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries transient 5xx but fails fast on a definitive 404", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        if (call === 1) return new Response(null, { status: 503 });
        return new Response(streamOf([enc.encode("ok")]), { status: 200 });
      }),
    );
    const out = await httpFetchBytes("https://example.test/pkg.zip", { retryDelayMs: 0 });
    expect(new TextDecoder().decode(out)).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(2);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    await expect(httpFetchBytes("https://example.test/gone.zip", { retryDelayMs: 0 })).rejects.toThrow(
      /the server said 404/,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// The Windows sharing-violation shield on the update swap (field bug 2026-08-22: a
// poppy update failed EBUSY because the just-stopped backend still held its install
// dir). The retry must absorb TRANSIENT EBUSY/EPERM, give up on persistent ones, and
// never mask a genuinely different error.
describe("renameWithRetry", () => {
  const errWith = (code: string) => {
    const e = new Error(code) as NodeJS.ErrnoException;
    e.code = code;
    return e;
  };

  it("retries EBUSY/EPERM and succeeds once the lock clears", async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls < 4) throw errWith(calls % 2 ? "EBUSY" : "EPERM");
    };
    await renameWithRetry("a", "b", flaky, 0);
    expect(calls).toBe(4);
  });

  it("gives up after bounded attempts and rethrows the real error", async () => {
    let calls = 0;
    const stuck = async () => {
      calls++;
      throw errWith("EBUSY");
    };
    await expect(renameWithRetry("a", "b", stuck, 0)).rejects.toThrow("EBUSY");
    expect(calls).toBe(20); // MAX_RENAME_ATTEMPTS — bounded, but generous enough for an AV scan
  });

  it("does not retry unrelated errors", async () => {
    let calls = 0;
    const gone = async () => {
      calls++;
      throw errWith("ENOENT");
    };
    await expect(renameWithRetry("a", "b", gone, 0)).rejects.toThrow("ENOENT");
    expect(calls).toBe(1);
  });
  });
});
