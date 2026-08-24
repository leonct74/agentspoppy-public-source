// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: MIT
//
// Hello Poppy — the minimal AgentsPoppy extension BACKEND, in the shape every new poppy
// should copy: a plain CJS file run on the HOST'S shared node22 runtime (you ship no
// runtime of your own — docs/RUNTIMES.md R1), CONFINED from the user's files
// (extension.json declares `"isolation": "strict"`).
//
// Confinement means Node's permission model limits this process to: reading its own
// install folder, and writing ONLY `bootstrap.dataDir` (a private folder the host makes
// for you) and the OS temp dir. The user's home — ~/.aws/credentials, their documents,
// their browser profile — returns ERR_ACCESS_DENIED, and child processes are denied
// outright. Two practical rules follow:
//   1. Keep your state in `boot.dataDir`, never `~/.<yourname>/`.
//   2. To give the user a file, DON'T write their Downloads folder (denied — and a save
//      your process performs silently is exactly what confinement ends): stage the bytes
//      under a one-shot token on a `GET /local-download/:token` route and open
//      `/ext-dl/<your-id>/local-download/<token>` via host.openExternal — the system
//      browser saves it. (Trap: under `--permission`, fs.existsSync on a DENIED path
//      THROWS instead of returning false — wrap probes in try/catch.)
//
// The host spawns this file with AGENTSPOPPY_BOOTSTRAP in the environment, a JSON blob:
//
//   { "connectionId": "...",
//     "credentialsUrl": "http://127.0.0.1:<p>/...",   // mint scoped creds here, on demand
//     "credentialsToken": "...",                       // Bearer token for that mint
//     "port": 49xxx,                                   // for an "http" backend: listen on this
//     "dataDir": "/Users/you/.agentspoppy/extension-data/<your-id>",  // your writable folder
//     "account": { "accountId": "123456789012", "region": "eu-west-1" } }
//
// For an "http" backend the host waits until we're accepting connections on `port`
// before it hands the frontend tab to us. The frontend never talks to us directly — it
// calls `host.invokeBackend({ method, path, body })` and the HOST proxies it here.
//
// We are a SEPARATE process, not host memory, and we NEVER receive the operator's own
// AWS keys — only short-lived, scoped credentials we mint from `credentialsUrl`.
//
// Zero dependencies on purpose: clone and run, no `npm install`.

const { createServer } = require("node:http");

const boot = JSON.parse(process.env.AGENTSPOPPY_BOOTSTRAP ?? "{}");
// `port` comes from the host; PORT is a convenience for running this file standalone.
const port = boot.port ?? (process.env.PORT ? Number(process.env.PORT) : 0);

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  // The frontend reaches these routes via host.invokeBackend({ method, path }).
  if (req.method === "GET" && req.url === "/info") {
    return json(res, 200, {
      ok: true,
      connectionId: boot.connectionId ?? null,
      account: boot.account ?? null,
      // Where the host lets a CONFINED backend keep its files — write yours here.
      dataDir: boot.dataDir ?? null,
      message: "Hello from the Hello Poppy backend — a confined process AgentsPoppy spawned for this connection.",
      // To actually call AWS: fetch `boot.credentialsUrl` (Authorization: Bearer
      // <credentialsToken>) for short-lived, tag-scoped credentials, then use them with
      // the AWS SDK. See AGENTS.md §5 and MailPoppy's backend for the full pattern.
      // (This scaffold stays dependency-free, so it doesn't bundle the AWS SDK.)
    });
  }
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { ok: false, error: `no route for ${req.method} ${req.url}` });
});

server.listen(port, "127.0.0.1", () => {
  const actual = server.address();
  console.log(`[hello-poppy] backend listening on 127.0.0.1:${typeof actual === "object" && actual ? actual.port : port}`);
});
