// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The broker entrypoint: construct the service and start the local HTTP server.
 *
 *   npm run broker            # serve on 127.0.0.1:8799 with the REAL AWS layer
 *   npm run broker:seed       # serve + seed demo poppies (DEMO providers, no AWS)
 *
 * Default: the real AWS-backed providers (STS scoped credentials + live
 * CloudFormation inventory/teardown), using the operator's local credential
 * chain. Pass `--seed` or set AGENTSPOPPY_DEMO=1 to swap in the stub/demo
 * providers — a fake-but-realistic footprint for UI work, never touching AWS.
 */
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { record } from "@agentspoppy/core/ledger";
import type { ActivityEvent, Connection, InfraGraph, ResidualResource, StackInventory } from "@agentspoppy/core";
import { BrokerService } from "./service";
import { Store } from "./store";
import { StubCredentialVendor } from "./providers";
import type { ActivityProvider, ActivityQuery, CloudProvider, CredentialVendor } from "./providers";
import { StsCredentialVendor, CloudFormationProvider, CloudTrailActivityProvider, StubAwsBootstrap, sdkAwsBootstrap, consoleUrlForArn } from "./aws";
import type { AwsBootstrap, DeletionReport } from "./aws";
import { listen } from "./http";
import { generateToken, HOST_TOKEN_STDOUT_PREFIX } from "./auth";
import { watchParent } from "./parent-watch";
import { DirectoryService, ExtensionRegistry, killAllBackends, poppyBackendEntry, reapOrphanSidecars } from "./extensions";
import { parseManifest } from "@agentspoppy/extension-sdk";

const PORT = Number(process.env.AGENTSPOPPY_PORT ?? 8799);

/**
 * Where installed extensions live. Honors AGENTSPOPPY_EXTENSIONS_DIR, then
 * AGENTSPOPPY_HOME — the same home resolution the store uses (store.ts), so the
 * scan, the dev-install script and the directory's install engine can never
 * disagree about the root.
 */
export function extensionsRoot(): string {
  if (process.env.AGENTSPOPPY_EXTENSIONS_DIR) return process.env.AGENTSPOPPY_EXTENSIONS_DIR;
  const home = process.env.AGENTSPOPPY_HOME ?? join(homedir(), ".agentspoppy");
  return join(home, "extensions");
}

/**
 * Install any extensions found on disk (each a directory under the extensions root
 * containing an `extension.json`). A no-op when the directory doesn't exist yet, so
 * it never changes behaviour for installs that haven't enabled any extension.
 * Dot-directories are skipped: the directory install engine stages downloads there,
 * and a half-extracted package must never be scanned as an extension.
 */
async function installExtensionsFromDisk(registry: ExtensionRegistry): Promise<void> {
  const { readdir, readFile } = await import("node:fs/promises");
  const dir = extensionsRoot();

  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return; // no extensions directory → nothing installed
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const root = join(dir, e.name);
    try {
      const manifest = parseManifest(await readFile(join(root, "extension.json"), { encoding: "utf8" }));
      registry.install({ manifest, root });
      console.log(`installed extension: ${manifest.id} (${manifest.name})`);
    } catch (err) {
      console.warn(`skipped extension in ${root}: ${(err as Error).message}`);
    }
  }
}

/** Demo: pretend each poppy deployed a small stack; teardown actually clears it. */
class DemoCloudProvider implements CloudProvider {
  private toreDown = new Set<string>();

  async listStacks(connection: Connection): Promise<StackInventory[]> {
    if (this.toreDown.has(connection.id)) return [];
    const slug = connection.app.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return [
      {
        stackName: `agentspoppy-${slug}-prod`,
        region: "eu-west-1",
        stackExists: true,
        resources: [
          { logicalId: "MailBucket", physicalId: `agentspoppy-${slug}-mail-7f3a`, type: "AWS::S3::Bucket", status: "CREATE_COMPLETE" },
          { logicalId: "InboundFn", physicalId: `agentspoppy-${slug}-inbound`, type: "AWS::Lambda::Function", status: "CREATE_COMPLETE" },
          { logicalId: "MailTable", physicalId: `agentspoppy-${slug}-MailTable`, type: "AWS::DynamoDB::Table", status: "CREATE_COMPLETE" },
          { logicalId: "UserPool", physicalId: "eu-west-1_AbC123", type: "AWS::Cognito::UserPool", status: "CREATE_COMPLETE" },
        ],
      },
    ];
  }

  async deleteStack(connection: Connection): Promise<void> {
    this.toreDown.add(connection.id);
  }
  async findResiduals(): Promise<ResidualResource[]> {
    return []; // the demo teardown is always clean
  }
  async deleteResiduals(): Promise<DeletionReport> {
    return { removed: [], failed: [], unsupported: [] }; // nothing to host-clean in the demo
  }
  async buildInfraGraph(connection: Connection): Promise<InfraGraph> {
    const torn = this.toreDown.has(connection.id);
    const status: InfraGraph["nodes"][number]["status"] = torn ? "removed" : "present";
    const region = "eu-west-1";
    const node = (id: string, service: string, resourceType: string, name: string, arn: string) => ({
      id, service, resourceType, name, region, status, inStack: true, arn, consoleUrl: consoleUrlForArn(arn, region),
    });
    const lambda = (id: string, fn: string) => node(id, "lambda", "AWS::Lambda::Function", fn, `arn:aws:lambda:${region}:123456789012:function:${fn}`);
    const table = (id: string, name: string) => node(id, "dynamodb", "AWS::DynamoDB::Table", name, `arn:aws:dynamodb:${region}:123456789012:table/${name}`);
    return {
      connectionId: connection.id,
      appId: connection.app.id,
      nodes: [
        node("Receiver", "ses", "AWS::SES::ReceiptRuleSet", "mailpoppy-inbound", `arn:aws:ses:${region}:123456789012:receipt-rule-set/mailpoppy-inbound`),
        node("MailBucket", "s3", "AWS::S3::Bucket", "agentspoppy-mailpoppy-mail-7f3a", "arn:aws:s3:::agentspoppy-mailpoppy-mail-7f3a"),
        lambda("InboundFn", "agentspoppy-mailpoppy-inbound"),
        lambda("AccessApiFn", "agentspoppy-mailpoppy-access-api"),
        lambda("JanitorFn", "agentspoppy-mailpoppy-janitor"),
        table("IndexTable", "agentspoppy-mailpoppy-IndexTable"),
        table("SettingsTable", "agentspoppy-mailpoppy-SettingsTable"),
        node("UserPool", "cognito", "AWS::Cognito::UserPool", "eu-west-1_AbC123", `arn:aws:cognito-idp:${region}:123456789012:userpool/eu-west-1_AbC123`),
      ],
      edges: [
        { from: "Receiver", to: "MailBucket" },
        { from: "MailBucket", to: "InboundFn" },
        { from: "InboundFn", to: "IndexTable" },
        { from: "InboundFn", to: "UserPool" },
        { from: "AccessApiFn", to: "IndexTable" },
        { from: "AccessApiFn", to: "UserPool" },
        { from: "JanitorFn", to: "MailBucket" },
        { from: "JanitorFn", to: "SettingsTable" },
      ],
      generatedAt: new Date().toISOString(),
    };
  }
}

/** Demo: a believable activity feed — mostly through AgentsPoppy, plus a couple
 * of "external" events so the "activity around AgentsPoppy" panel has something
 * to show. Never touches AWS. */
class DemoActivityProvider implements ActivityProvider {
  async recentActivity(q: ActivityQuery): Promise<ActivityEvent[]> {
    const region = q.regions[0] ?? "eu-west-1";
    const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
    const ext = (label: string, arn: string) => ({ kind: "external" as const, label, arn });
    const bot = ext("IAM user deploy-bot", "arn:aws:iam::123456789012:user/deploy-bot");
    const ci = ext("Role terraform-ci", "arn:aws:sts::123456789012:assumed-role/terraform-ci/build");
    const root = ext("Account root", "arn:aws:iam::123456789012:root");
    const admin = ext("IAM user console-admin", "arn:aws:iam::123456789012:user/console-admin");
    // A realistic, longer feed: plenty of activity from *other* projects in the
    // same account (external), so the "very long list" cases — scroll + dedicated
    // view — are exercised. Never touches AWS.
    return [
      // External — the headline: things that touched the cloud outside AgentsPoppy.
      { id: "evt-ext-1", time: ago(8), service: "s3", action: "CreateBucket", region, actor: bot },
      { id: "evt-ext-2", time: ago(19), service: "iam", action: "CreateAccessKey", region: "us-east-1", actor: bot },
      { id: "evt-ext-3", time: ago(26), service: "s3", action: "PutBucketPolicy", region, actor: bot },
      { id: "evt-ext-4", time: ago(34), service: "ec2", action: "RunInstances", region, actor: ci },
      { id: "evt-ext-5", time: ago(41), service: "ec2", action: "CreateSecurityGroup", region, actor: ci },
      { id: "evt-ext-6", time: ago(63), service: "rds", action: "CreateDBInstance", region, actor: ci },
      { id: "evt-ext-7", time: ago(72), service: "lambda", action: "CreateFunction", region, actor: admin },
      { id: "evt-ext-8", time: ago(95), service: "dynamodb", action: "CreateTable", region, actor: admin },
      { id: "evt-ext-9", time: ago(140), service: "iam", action: "CreateUser", region: "us-east-1", actor: root },
      // Through a poppy (enriched to the app name by the service when it matches).
      { id: "evt-poppy-1", time: ago(15), service: "cloudformation", action: "CreateStack", region,
        actor: { kind: "poppy", label: "MailPoppy" } },
      { id: "evt-poppy-2", time: ago(22), service: "cognito-idp", action: "AdminCreateUser", region,
        actor: { kind: "poppy", label: "MailPoppy" } },
      { id: "evt-poppy-3", time: ago(58), service: "ses", action: "CreateReceiptRule", region,
        actor: { kind: "poppy", label: "MailPoppy" } },
      // AgentsPoppy itself (the operator deploying/cleaning up on the user's behalf).
      // The real feed is mutations-only (ReadOnly=false), so demo events are too.
      { id: "evt-op-1", time: ago(5), service: "cloudformation", action: "DeleteStack", region,
        actor: { kind: "agentspoppy", label: "AgentsPoppy" } },
      { id: "evt-op-2", time: ago(35), service: "iam", action: "CreatePolicy", region: "us-east-1",
        actor: { kind: "agentspoppy", label: "AgentsPoppy" } },
    ];
  }
}

async function seed(service: BrokerService): Promise<void> {
  if ((await service.listConnections()).length > 0) return; // already seeded

  const account = await service.linkAccount({
    accountId: "123456789012",
    alias: "Personal AWS",
    regions: ["eu-west-1"],
  });

  const mailpoppy = await service.requestConnection({
    accountId: account.id,
    app: { id: "com.mailpoppy.desktop", name: "MailPoppy" },
    permissionSet: {
      id: "mailpoppy.default",
      name: "MailPoppy — host email in your AWS",
      description: "Deploy and run a mail backend in your account.",
      grants: [
        { service: "cloudformation", actions: ["CreateStack", "UpdateStack", "DeleteStack", "DescribeStacks"], resourceScope: "stack/agentspoppy-mailpoppy-*" },
        { service: "s3", actions: ["CreateBucket", "PutObject", "DeleteObject", "ListBucket"], resourceScope: "tagged-as-self" },
        { service: "ses", actions: ["SendEmail", "GetAccount"], resourceScope: "tagged-as-self" },
      ],
      requiredTags: ["agentspoppy:account", "agentspoppy:app", "agentspoppy:connection"],
      limits: null,
    },
  });
  await service.approve(mailpoppy.id);
  await record([
    { connectionId: mailpoppy.id, action: "created", service: "Route 53", resourceType: "MX record", name: "mail.example.com", region: "eu-west-1" },
    { connectionId: mailpoppy.id, action: "created", service: "SES", resourceType: "Domain identity", name: "example.com", region: "eu-west-1" },
  ]);

  // A second poppy left pending, to show the approve/deny flow — tightly scoped.
  await service.requestConnection({
    accountId: account.id,
    app: { id: "com.example.backuppoppy", name: "BackupPoppy" },
    permissionSet: {
      id: "backup.default",
      name: "BackupPoppy — snapshots to your S3",
      description: "Store backups in your account.",
      grants: [{ service: "s3", actions: ["CreateBucket", "PutObject", "ListBucket"], resourceScope: "tagged-as-self" }],
      requiredTags: ["agentspoppy:account", "agentspoppy:app", "agentspoppy:connection"],
      limits: null,
    },
  });

  // A deliberately over-broad poppy (pending) so the policy-risk warning is visible:
  // unscoped, mutating grants + no attribution tags → AgentsPoppy flags "Broad access".
  await service.requestConnection({
    accountId: account.id,
    app: { id: "com.example.widepoppy", name: "WidePoppy" },
    permissionSet: {
      id: "wide.default",
      name: "WidePoppy — account-wide access (example of what to watch for)",
      description: "Asks for access well beyond its own resources.",
      grants: [
        { service: "s3", actions: ["GetObject", "PutObject", "DeleteObject", "ListBucket"], resourceScope: "*" },
        { service: "dynamodb", actions: ["GetItem", "PutItem", "DeleteItem"], resourceScope: "*" },
      ],
      requiredTags: [],
      limits: null,
    },
  });

  console.log(
    "seeded demo: MailPoppy (active, footprint) + BackupPoppy (pending, scoped) + WidePoppy (pending, broad)",
  );
}

function buildProviders(demo: boolean): {
  credentials: CredentialVendor;
  cloud: CloudProvider;
  aws: AwsBootstrap;
  activity: ActivityProvider;
} {
  if (demo) {
    // AGENTSPOPPY_SIMULATE=no-aws → reproduce the brand-new-user path: the first
    // identity probe fails (as if no AWS is set up), then succeeds on re-check.
    const aws =
      process.env.AGENTSPOPPY_SIMULATE === "no-aws" ? new StubAwsBootstrap(undefined, 1) : new StubAwsBootstrap();
    return {
      credentials: new StubCredentialVendor(),
      cloud: new DemoCloudProvider(),
      aws,
      activity: new DemoActivityProvider(),
    };
  }
  return {
    credentials: new StsCredentialVendor(),
    cloud: new CloudFormationProvider(),
    aws: sdkAwsBootstrap(),
    activity: new CloudTrailActivityProvider(),
  };
}

async function main(): Promise<void> {
  // The Tauri host passes its own PID; if it ever dies without running its exit
  // hook (crash, force-quit), follow it — an orphaned broker squats the port and
  // 401s every future launch. Standalone/dev runs don't set this and are unaffected.
  const parentPid = Number(process.env.AGENTSPOPPY_PARENT_PID);
  if (Number.isInteger(parentPid) && parentPid > 0) watchParent({ parentPid });

  // Take our children with us on EVERY exit path (parent-watch, SIGTERM from the
  // host's port reclaim, Ctrl-C in dev): a backend that outlives the broker keeps
  // running on live scoped credentials as an orphan nothing in the UI can stop.
  // `exit` handlers must be synchronous — killAllBackends is.
  process.on("exit", killAllBackends);
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));

  // Seeding demo poppies requires the demo providers (simulated footprint +
  // teardown), so AGENTSPOPPY_SEED implies demo mode — never touch real AWS.
  const wantSeed = process.argv.includes("--seed") || process.env.AGENTSPOPPY_SEED === "1";
  const demo =
    wantSeed ||
    process.env.AGENTSPOPPY_DEMO === "1" ||
    process.env.AGENTSPOPPY_SIMULATE === "no-aws";
  const { credentials, cloud, aws, activity } = buildProviders(demo);
  const service = new BrokerService({ store: new Store(), credentials, cloud, aws, activity });

  if (wantSeed) await seed(service);

  // The extension registry runs only the REAL backend host (no demo spawning), and
  // mints creds against this broker's own address.
  // Sweep orphaned poppy backends from previous sessions BEFORE this broker spawns
  // anything: at this instant, any process running from under the extensions root is
  // by definition an orphan (a prior broker that died uncatchably — e.g. SIGKILL —
  // never reaped its children). Self-heals machines that accumulated idle sidecars.
  await reapOrphanSidecars(extensionsRoot());

  const registry = new ExtensionRegistry(service, { brokerBaseUrl: `http://127.0.0.1:${PORT}` });
  await installExtensionsFromDisk(registry);

  // The curated directory: catalog browsing + verified package installs (hot, no
  // restart). The catalog URL is the ONLY remote source — overridable for dogfood
  // via AGENTSPOPPY_DIRECTORY_URL.
  const directory = new DirectoryService({
    extensionsRoot: extensionsRoot(),
    registry,
    listBlocked: () => service.listBlockedExtensions(),
    // Baked in by build-broker.mjs (esbuild define, from tauri.conf.json). Dev runs
    // have no version → the catalog minHost gate is off (docs/RUNTIMES.md §4.5).
    hostVersion: process.env.AGENTSPOPPY_BUILD_VERSION,
  });

  // Caller auth: mint a fresh HOST token for this run. The Tauri host captures it
  // off our stdout (a channel a spawned poppy backend can't read) and presents it on
  // the management plane. The pure-browser dev harness has no host to hold a token,
  // so it opts out with AGENTSPOPPY_DEV_OPEN=1 (never set in the packaged app).
  const devOpen = /^(1|true|yes|on)$/i.test(process.env.AGENTSPOPPY_DEV_OPEN ?? "");
  const hostToken = generateToken();
  // Emit FIRST, on its own line, so the host reads it before anything else. Printing
  // it is safe: only our parent process sees this pipe; backends we later spawn cannot.
  console.log(`${HOST_TOKEN_STDOUT_PREFIX}${hostToken}`);

  const { port } = await listen(service, PORT, registry, { hostToken, devOpen }, directory);
  const mode = demo
    ? "DEMO — credentials & teardown are simulated, no AWS calls"
    : "AWS — STS scoped credentials + live CloudFormation, via your local credential chain";
  console.log(
    `AgentsPoppy broker on http://127.0.0.1:${port}  (${mode}${devOpen ? "; DEV-OPEN auth" : ""})`,
  );
}

// Child-interpreter mode (docs/RUNTIMES.md §4.2): `--poppy-backend <entry>` means this
// process is NOT the broker — it is the shared Node runtime for one poppy backend. The
// packaged broker is a Node SEA, so the host re-execs its own binary with this flag to
// run a `"runtime": "node22"` poppy's CJS bundle — the poppy ships no runtime of its own.
const poppyEntry = poppyBackendEntry(process.argv);
if (poppyEntry) {
  // createRequire, not import(): a SEA main can only load external files through it.
  // Any throw (missing file, bundle syntax error) crashes this child with a real
  // stack on stderr — the host's readiness probe then reports the exit cleanly.
  createRequire(poppyEntry)(poppyEntry);
} else {
  serveBroker();
}

function serveBroker(): void {
  main().catch((err: NodeJS.ErrnoException) => {
    if (err?.code === "EADDRINUSE") {
      console.error(
        `Port ${PORT} is already in use — the AgentsPoppy broker may already be running.\n` +
          `Stop the other instance, or use a different port:  AGENTSPOPPY_PORT=8800 npm run broker:seed`,
      );
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}
