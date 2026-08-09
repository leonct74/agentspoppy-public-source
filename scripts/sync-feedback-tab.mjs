#!/usr/bin/env node
// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
//
// sync-feedback-tab — copy the CANONICAL Feedback tab element into a poppy.
//
// Every poppy must ship the Feedback tab (AGENTS.md §9a), but poppies don't depend on
// @agentspoppy/extension-sdk (it isn't published to npm — they mirror the wire contract instead).
// So they vendor this one deliberately import-free file, and this script is how it gets there.
//
//   node scripts/sync-feedback-tab.mjs --dest ../your-poppy/frontend/src/vendor
//   node scripts/sync-feedback-tab.mjs --dest <dir> --check     (CI: fail if the copy has drifted)
//
// The copy carries a header with the source hash; --check re-derives it, so a poppy that edits
// its vendored copy — or one that goes stale after this file changes — fails loudly instead of
// quietly shipping a different Feedback tab to users.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, "..", "packages", "extension-sdk", "src", "feedback-tab.ts");
const FILENAME = "agentspoppy-feedback-tab.ts";

const args = process.argv.slice(2);
const destArg = args[args.indexOf("--dest") + 1];
const check = args.includes("--check");
if (!destArg || destArg.startsWith("--")) {
  console.error("usage: sync-feedback-tab.mjs --dest <dir> [--check]");
  process.exit(2);
}

const source = readFileSync(SOURCE, "utf8");
const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);

const header = `// GENERATED — DO NOT EDIT. Vendored from AgentsPoppy's extension SDK:
//   packages/extension-sdk/src/feedback-tab.ts   (sha256:${hash})
// Refresh it with:  npm run sync-feedback
// Edit the copy and \`--check\` fails: every poppy must ship the SAME Feedback tab, or the
// consistency users rely on — and the rating the catalogue shows — stops meaning anything.

`;

const destDir = resolve(destArg);
const destFile = join(destDir, FILENAME);
const expected = header + source;

if (check) {
  if (!existsSync(destFile)) {
    console.error(`✗ ${destFile} is missing — run: npm run sync-feedback`);
    process.exit(1);
  }
  if (readFileSync(destFile, "utf8") !== expected) {
    console.error(`✗ ${destFile} has drifted from the SDK's Feedback tab (expected sha256:${hash}).`);
    console.error(`  Run: npm run sync-feedback`);
    process.exit(1);
  }
  console.log(`✓ ${FILENAME} matches the SDK (sha256:${hash})`);
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });
writeFileSync(destFile, expected);
console.log(`✓ wrote ${destFile} (sha256:${hash})`);
