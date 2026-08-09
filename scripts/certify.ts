#!/usr/bin/env -S npx tsx
// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
//
// certify — prove your poppy leaves no trace.
//
// Runs the REAL leaves-no-trace lifecycle against a connection you've already deployed
// and used in AgentsPoppy: it snapshots your tagged footprint, runs your teardown hook
// (if any), tears the connection down for real (deleting stacks, emptying buckets,
// deactivating SES), then sweeps by the `agentspoppy:app` tag — and PASSES only if
// nothing remains. On success it writes a (self-signed) leaves-no-trace certificate.
//
//   npm run certify -- --extension path/to/your/poppy --yes
//   npm run certify -- --extension . --connection <connectionId> --yes --out my.cert.json
//
// This is the SAME harness the platform re-runs and signs at directory submission
// (MARKETPLACE M7) — passing it locally is how you know you'll pass there.
//
// ⚠️  It performs a real teardown against the AWS account your operator credentials point
//     at. Run it against the account where you deployed the poppy (ideally a throwaway dev
//     account). It will NOT proceed without --yes. Exit code 0 = certified, 1 = failed.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseManifest, type ExtensionManifest } from "@agentspoppy/extension-sdk";
import {
  Store,
  BrokerService,
  ExtensionRegistry,
  StsCredentialVendor,
  CloudFormationProvider,
  CloudTrailActivityProvider,
  sdkAwsBootstrap,
  ec2AwareExistenceVerifier,
  runCertification,
  issueCertificate,
  listen,
} from "@agentspoppy/broker";
import type { Connection } from "@agentspoppy/core";

function fail(...lines: string[]): never {
  for (const l of lines) console.error(l);
  process.exit(1);
}

/** Minimal `--flag value` / `--flag` parser — no deps, matches the other scripts' spirit. */
function parseArgs(argv: string[]): { flags: Record<string, string>; bools: Set<string> } {
  const flags: Record<string, string> = {};
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) bools.add(key);
    else {
      flags[key] = next;
      i++;
    }
  }
  return { flags, bools };
}

/** The connection to certify: an explicit id, else the app's newest non-revoked one (active first). */
function resolveConnection(connections: Connection[], appId: string, explicitId?: string): Connection {
  if (explicitId) {
    const c = connections.find((x) => x.id === explicitId);
    if (!c) fail(`✗ no connection with id ${explicitId}`);
    if (c.app.id !== appId) {
      fail(`✗ connection ${explicitId} belongs to ${c.app.id}, not ${appId} (the manifest under test)`);
    }
    return c;
  }
  const mine = connections
    .filter((c) => c.app.id === appId && c.status !== "revoked")
    .sort((a, b) => Number(a.status === "active") - Number(b.status === "active") || a.createdAt.localeCompare(b.createdAt));
  const chosen = mine[mine.length - 1];
  if (!chosen) {
    fail(
      `✗ no active connection found for ${appId}.`,
      `  Install the poppy in AgentsPoppy, approve it, deploy, and USE it first — then certify.`,
    );
  }
  return chosen;
}

async function main(): Promise<void> {
  const { flags, bools } = parseArgs(process.argv.slice(2));
  const extDir = resolve(flags.extension ?? ".");
  const manifestPath = join(extDir, "extension.json");

  let manifest: ExtensionManifest;
  try {
    manifest = parseManifest(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    fail(`✗ ${manifestPath}`, `  ${(e as Error).message}`, ``, `  Pass --extension <dir> (default: current directory).`);
  }

  // The real AWS layer, using the operator's local credential chain — same as `npm run broker`.
  const service = new BrokerService({
    store: new Store(),
    credentials: new StsCredentialVendor(),
    cloud: new CloudFormationProvider(),
    aws: sdkAwsBootstrap(),
    activity: new CloudTrailActivityProvider(),
  });

  // Headless broker on an ephemeral port, so a declared teardown hook's backend can mint
  // its own scoped credentials against us (exactly as it would under AgentsPoppy proper).
  const { server, port } = await listen(service, 0);
  const registry = new ExtensionRegistry(service, { brokerBaseUrl: `http://127.0.0.1:${port}` });
  registry.install({ manifest, root: extDir });

  try {
    const identity = await service.getAwsIdentity().catch(() => null);
    if (!identity) {
      fail(
        `✗ no working AWS credentials.`,
        `  certify uses your operator credential chain (the AGENTSPOPPY profile / aws configure).`,
        `  Connect AWS in AgentsPoppy first, then run certify against that account.`,
      );
    }
    const conn = resolveConnection(await service.listConnections(), manifest.id, flags.connection);

    console.log(`AgentsPoppy certify — leaves-no-trace`);
    console.log(`  poppy:      ${manifest.id} v${manifest.version}`);
    console.log(`  connection: ${conn.id} (${conn.status})`);
    console.log(`  AWS account: ${identity.accountId}  (operator: ${identity.arn})`);
    console.log(`  teardown hook: ${manifest.teardown?.endpoint ?? "none declared"}`);
    console.log();

    if (!bools.has("yes")) {
      fail(
        `⚠️  This will REALLY tear down ${manifest.id} in account ${identity.accountId}:`,
        `    delete its CloudFormation stack(s), empty its S3 buckets, deactivate its SES rule set,`,
        `    and run its teardown hook. This is destructive and cannot be undone.`,
        ``,
        `  Re-run with --yes once you've confirmed this is the right (ideally throwaway) account.`,
      );
    }

    console.log(`Tearing down and verifying… (this can take 1–2 minutes)`);
    // Existence-verify each post-teardown tag hit so a tombstoned EC2 instance (still listed by
    // the Tagging API for ~1h after termination) isn't mistaken for a leftover and false-failed.
    const report = await runCertification(
      { service, registry, verifier: ec2AwareExistenceVerifier() },
      { connectionId: conn.id, manifest },
    );

    console.log();
    console.log(`  footprint before: ${report.footprintBefore.length} resource(s)`);
    console.log(`  stacks deleted:   ${report.deletedStacks.length ? report.deletedStacks.join(", ") : "none"}`);
    console.log(`  teardown hook:    ${report.teardownHookRun ? "ran" : "not run"}`);
    console.log(`  residual sweep:   ${report.residualsAfter.length} resource(s) still tagged`);
    for (const w of report.warnings) console.log(`  ⚠️  ${w}`);
    console.log();

    if (!report.passed) {
      for (const p of report.problems) console.error(`✗ ${p}`);
      for (const r of report.residualsAfter) console.error(`    • ${r.resourceType}  ${r.arn}  (${r.region})`);
      fail(``, `✗ NOT certified — ${report.residualsAfter.length} resource(s) remained. Fix per AGENTS.md §4, then re-run.`);
    }

    const cert = issueCertificate(report, { issuer: "self" });
    const outPath = resolve(flags.out ?? join(extDir, "leaves-no-trace.cert.json"));
    writeFileSync(outPath, JSON.stringify(cert, null, 2) + "\n");
    console.log(`✓ CERTIFIED — your poppy left no trace.`);
    console.log(`  manifestHash: ${cert.subject.manifestHash}`);
    console.log(`  self-signed certificate written to ${outPath}`);
    console.log();
    console.log(`  This is a local self-run (issuer: "self", unsigned). The curated directory issues the`);
    console.log(`  platform-signed certificate by re-running this same harness at submission (MARKETPLACE M7).`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
