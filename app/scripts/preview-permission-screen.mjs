// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
//
// Render the REAL permission screen — the shipped ConnectionDetailView component, the
// app's real stylesheet, a poppy's real manifest — to a standalone HTML page.
//
// Why this exists (founder, 2026-09-01): a hand-made mock was shown as the design and the
// shipped screen differed from it. From now on the preview IS the component: what this
// script emits is what users get, because it is produced by the same code.
//
//   npx tsx app/scripts/preview-permission-screen.mjs <path-to-extension.json> [out.html]
//
// The observed register is fed SAMPLE events (CloudTrail needs a live account) and the
// page banner says so — everything else is the real data path.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(process.argv[2] ?? "extension.json");
const outPath = resolve(process.argv[3] ?? "/tmp/permission-screen-preview.html");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const { ConnectionDetailView } = await import(join(here, "../src/views/ConnectionDetailView.tsx"));

const connection = {
  id: "preview",
  accountId: "acct-preview",
  app: { id: manifest.id, name: manifest.name },
  permissionSet: manifest.permissionSet,
  status: "active",
  supervised: true,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
};

// Sample observed events — labelled as such in the banner below.
const observed = {
  sinceMinutes: 7 * 24 * 60,
  events: [
    { id: "s1", time: "2026-08-30T10:00:00Z", service: "route53", action: "ChangeResourceRecordSets", actor: { kind: "poppy", label: manifest.name } },
    { id: "s2", time: "2026-08-30T10:00:05Z", service: "route53", action: "ListResourceRecordSets", actor: { kind: "poppy", label: manifest.name } },
    { id: "s3", time: "2026-08-29T09:00:00Z", service: "cloudformation", action: "DescribeStacks", actor: { kind: "poppy", label: manifest.name } },
  ],
};

const noop = () => {};
const el = React.createElement(ConnectionDetailView, {
  connection,
  inventory: { stacks: [], ledger: [] },
  audit: [],
  observed,
  onBack: noop, onPause: noop, onResume: noop, onRevoke: noop, onTeardown: noop,
});

const body = renderToStaticMarkup(el);
const theme = readFileSync(join(here, "../src/theme.css"), "utf8");

writeFileSync(outPath, `<title>${manifest.name} — permission screen preview</title>
<style>${theme}</style>
<style>
  body { margin: 0; padding: 24px clamp(16px, 5vw, 60px) 80px; max-width: 980px; margin-inline: auto; }
  .preview-banner { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.05em;
    color: var(--warn); border: 1px dashed var(--warn); border-radius: 4px; padding: 8px 12px; margin-bottom: 18px; }
</style>
<div class="preview-banner">PREVIEW — the shipped ConnectionDetailView component rendering ${manifest.name} ${manifest.version}'s real manifest. The "used in the last 7 days" lines are sample data (CloudTrail needs a live account); everything else is the real code path.</div>
${body}
`);
console.log(`wrote ${outPath}`);
