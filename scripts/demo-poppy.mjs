// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * A tiny stand-in "poppy" you can run against a live AgentsPoppy broker to
 * exercise the whole connection lifecycle by hand — without wiring a real app.
 *
 *   npm run demo:poppy
 *
 * It mirrors what `@agentspoppy/client`'s `connect()` does, over plain HTTP:
 *   1. discover a linked AWS account
 *   2. request a connection (declaring exactly what it needs)
 *   3. wait for YOU to approve "DemoPoppy" in the AgentsPoppy window
 *   4. mint a set of short-lived scoped credentials (proof the wiring works)
 *
 * Then open DemoPoppy in AgentsPoppy to see its (simulated) footprint and try
 * Pause / Revoke / "Tear down everything it built".
 *
 * Env: AGENTSPOPPY_PORT (default 8799), AGENTSPOPPY_BASE_URL to override fully.
 * In demo mode the broker simulates credentials + footprint — no AWS is touched.
 */

const BASE =
  process.env.AGENTSPOPPY_BASE_URL ?? `http://127.0.0.1:${process.env.AGENTSPOPPY_PORT ?? "8799"}`;

const APP = { id: "com.agentspoppy.demopoppy", name: "DemoPoppy" };

const PERMISSION_SET = {
  id: "demopoppy.default",
  name: "DemoPoppy — a harmless demo app",
  description: "Deploys a small stack so you can watch monitoring + teardown.",
  grants: [
    {
      service: "cloudformation",
      actions: ["CreateStack", "UpdateStack", "DeleteStack", "DescribeStacks"],
      resourceScope: "stack/agentspoppy-demopoppy-*",
    },
    { service: "s3", actions: ["CreateBucket", "PutObject", "ListBucket"], resourceScope: "tagged-as-self" },
  ],
  requiredTags: ["agentspoppy:account", "agentspoppy:app", "agentspoppy:connection"],
  limits: null,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch {
    throw new Error(
      `Can't reach the AgentsPoppy broker at ${BASE}.\n` +
        `Start the app (npm run -w @agentspoppy/app tauri:dev) or the broker (npm run broker:seed), then retry.`,
    );
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const msg = body?.message ?? res.statusText;
    throw new Error(`broker ${res.status}: ${msg}`);
  }
  return body;
}

function mask(v) {
  return typeof v === "string" && v.length > 8 ? `${v.slice(0, 6)}…${v.slice(-2)}` : v;
}

async function main() {
  console.log(`DemoPoppy → AgentsPoppy broker at ${BASE}\n`);

  // 1. Find an account to connect under.
  const accounts = await api("/accounts");
  if (!accounts.length) {
    console.error(
      "No AWS account is linked in AgentsPoppy yet.\n" +
        "  • Link one via the app's Connect-AWS flow, or\n" +
        "  • boot the app with a seeded demo: AGENTSPOPPY_SEED=1 (or run `npm run broker:seed`).",
    );
    process.exit(1);
  }
  const account = accounts[0];
  console.log(`Using account ${account.alias ?? account.accountId} (${account.accountId}).`);

  // 2. Reuse an existing DemoPoppy connection if there is one, else request a new one.
  const existing = (await api("/connections")).find(
    (c) => c.accountId === account.id && c.app.id === APP.id && c.status !== "revoked",
  );
  let connection =
    existing ??
    (await api("/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: account.id, app: APP, permissionSet: PERMISSION_SET }),
    }));

  if (existing) {
    console.log(`Reusing existing connection ${connection.id} (status: ${connection.status}).`);
  } else {
    console.log(`Requested connection ${connection.id} — status: pending.`);
  }

  // 3. Wait for the user to approve it in the AgentsPoppy window.
  if (connection.status !== "active") {
    console.log("\n👉 Open AgentsPoppy and click Approve on “DemoPoppy”. Waiting…");
    while (connection.status === "pending") {
      await sleep(1500);
      connection = await api(`/connections/${encodeURIComponent(connection.id)}`);
      process.stdout.write(".");
    }
    process.stdout.write("\n");
    if (connection.status !== "active") {
      console.error(`\nConnection ended as “${connection.status}” — not approved. Nothing minted.`);
      process.exit(1);
    }
  }
  console.log("✅ Approved.\n");

  // 4. Mint scoped credentials (in demo mode these are simulated — no AWS).
  const creds = await api(`/connections/${encodeURIComponent(connection.id)}/credentials`, { method: "POST" });
  console.log("Minted short-lived scoped credentials:");
  console.log(`  accessKeyId:  ${mask(creds.accessKeyId)}`);
  console.log(`  sessionToken: ${mask(creds.sessionToken)}`);
  console.log(`  expires:      ${creds.expiration}`);

  console.log(
    `\nDone. In AgentsPoppy, open “DemoPoppy” to see what it built, then try\n` +
      `Pause / Revoke / “Tear down everything it built”.`,
  );
}

main().catch((err) => {
  console.error(`\n${err.message ?? err}`);
  process.exit(1);
});
