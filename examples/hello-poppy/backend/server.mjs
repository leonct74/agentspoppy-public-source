#!/usr/bin/env node
// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: MIT
//
// Hello Poppy — the minimal AgentsPoppy extension BACKEND.
//
// The host spawns this file as a child process (it must be executable — the install
// step `chmod +x`es it) and injects AGENTSPOPPY_BOOTSTRAP into the environment, a JSON
// blob:
//
//   { "connectionId": "...",
//     "credentialsUrl": "http://127.0.0.1:<p>/...",   // mint scoped creds here, on demand
//     "port": 49xxx,                                   // for an "http" backend: listen on this
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

import { createServer } from "node:http";

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
      message: "Hello from the Hello Poppy backend — a process AgentsPoppy spawned for this connection.",
      // To actually call AWS: fetch `boot.credentialsUrl` for short-lived, tag-scoped
      // credentials, then use them with the AWS SDK. See AGENTS.md §5 and MailPoppy's
      // backend for the full pattern. (This scaffold stays dependency-free, so it
      // doesn't bundle the AWS SDK.)
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
