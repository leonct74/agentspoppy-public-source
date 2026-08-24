# Hello Poppy — a minimal AgentsPoppy extension

The clone-and-go starting point for building an [AgentsPoppy](../../AGENTS.md) extension (a
"poppy"). It is a **complete, working extension with zero toolchain** — no `npm install`, no build
step. Copy this folder, rename it, and start editing.

Read [`AGENTS.md`](../../AGENTS.md) first — it's the full guide and the rules you must follow.

## What's here

```
hello-poppy/
├── extension.json        # the manifest: identity, declared AWS access, capabilities
├── frontend/
│   ├── index.html        # the UI the host renders in a sandboxed iframe (no build)
│   ├── app.js            # talks to the host over the capability-gated bridge
│   └── icon.svg
└── backend/
    └── server.cjs        # a zero-dependency CJS file the host runs on ITS node22 (confined)
```

What it demonstrates, end to end:

- A **valid manifest** with a minimal, least-privilege `permissionSet` (read-only `sts:GetCallerIdentity`).
- The **frontend** reading its own connection (`getConnection`) and rendering its declared access +
  status — using only the `connection:read` capability.
- The **backend** being spawned by the host, reading its injected `AGENTSPOPPY_BOOTSTRAP`, and
  answering a request the frontend makes via `invokeBackend` (`backend:invoke`).
- The `host:openExternal` and `host:notify` capabilities, each behind a button.

The frontend inlines a ~20-line bridge client to stay build-free. A real (bundled) extension should
import `createHostBridgeClient` from `@agentspoppy/extension-sdk` instead — same wire protocol, typed.

## Run it

From the AgentsPoppy repo root:

```bash
# 1. Install into your AgentsPoppy home (~/.agentspoppy/extensions/com.example.hello-poppy/).
#    This scaffold's source IS its built output, so point --frontend/--backend at the sources:
node scripts/install-dev-extension.mjs \
  --src      examples/hello-poppy \
  --frontend examples/hello-poppy/frontend \
  --backend  examples/hello-poppy/backend/server.cjs

# 2. Relaunch AgentsPoppy — the broker discovers extensions from disk at startup.
npm run -w @agentspoppy/app tauri:dev
```

Then in AgentsPoppy: open the **Hello Poppy** tab, **approve** its connection (it'll rate green —
read-only), and try the three buttons. Its permission view should show **"No risks to other
resources identified."**

You can also run the backend on its own to see the bootstrap contract:

```bash
AGENTSPOPPY_BOOTSTRAP='{"connectionId":"demo","credentialsUrl":"http://127.0.0.1:0/creds","credentialsToken":"demo-token","port":8123,"account":{"accountId":"123456789012","region":"eu-west-1"}}' \
  node examples/hello-poppy/backend/server.cjs
# → curl -s http://127.0.0.1:8123/info
```

A real spawned backend always receives a `credentialsToken` in its bootstrap and must echo it as
`Authorization: Bearer <credentialsToken>` when minting (see step 3).

## Make it yours

1. **Rename:** change `id` (reverse-DNS) and `name` in `extension.json`; rename the folder.
2. **Declare your real access:** replace the `sts:GetCallerIdentity` grant with the specific actions
   your extension needs — **scoped to its own resources** (`tagged-as-self` or a name/ARN pattern you
   own; never `*` on a mutate-existing action). See [`AGENTS.md` §3–4](../../AGENTS.md#3-the-security-rules-non-negotiable).
3. **Actually call AWS:** add the `aws:credentials` capability, have the frontend call
   `ensureAccess()` first, then in the backend fetch `bootstrap.credentialsUrl` for short-lived,
   scoped credentials and use them with the AWS SDK. MailPoppy is the full worked example.
4. **Bundle a richer frontend** (React/Vite/etc.) if you outgrow a static page — build it to static
   assets and point `frontend.entry` at the built `index.html`, and import the typed bridge from
   `@agentspoppy/extension-sdk`.

## License

**MIT** — poppies are permissively licensed to encourage the ecosystem. Copy this example, build
your own poppy, ship it however you like. (Only the AgentsPoppy host itself is source-available
under a non-compete license; the poppies that run on it are yours.) The **AgentsPoppy** and
**Poppy** names/logos remain trademarks — see [`TRADEMARK.md`](../../TRADEMARK.md).
