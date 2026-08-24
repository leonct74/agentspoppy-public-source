#!/usr/bin/env -S npx tsx
// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
//
// validate-manifest — check an extension's `extension.json` against the AgentsPoppy
// manifest contract BEFORE you install it, and get every problem at once.
//
// It reuses the SDK's real structural validator (`@agentspoppy/extension-sdk`), so it
// can never drift from what the host actually enforces.
//
//   npm run validate-manifest -- path/to/extension.json     (default: ./extension.json)
//   npx tsx scripts/validate-manifest.ts path/to/extension.json
//
// Exit code 0 = valid, 1 = invalid / unreadable — so it's CI-friendly.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateManifest, type ExtensionManifest, effectiveIsolation } from "@agentspoppy/extension-sdk";

function fail(...lines: string[]): never {
  for (const l of lines) console.error(l);
  process.exit(1);
}

const path = resolve(process.argv[2] ?? "extension.json");

let text: string;
try {
  text = readFileSync(path, "utf8");
} catch {
  fail(`✗ cannot read ${path}`, `  pass a path: npm run validate-manifest -- path/to/extension.json`);
}

let parsed: unknown;
try {
  parsed = JSON.parse(text);
} catch (e) {
  fail(`✗ ${path}`, `  not valid JSON: ${(e as Error).message}`);
}

const { ok, errors } = validateManifest(parsed);
if (!ok) {
  fail(
    `✗ ${path} — ${errors.length} problem${errors.length === 1 ? "" : "s"}:`,
    ...errors.map((e) => `  • ${e}`),
    ``,
    `The manifest contract is in AGENTS.md §4 and packages/extension-sdk/src/manifest.ts.`,
  );
}

const m = parsed as ExtensionManifest;

// The Feedback tab is mandatory in every poppy (AGENTS.md §9a). Enforced HERE, at the gate you
// pass before shipping — not in the SDK's structural validator, which the host also runs at
// install time and which must keep accepting poppies that were installed before this rule.
const feedbackProblems: string[] = [];
if (!m.capabilities?.includes("host:openExternal")) {
  feedbackProblems.push(
    `capabilities must include "host:openExternal" — the mandatory Feedback tab opens your issue tracker and the donation checkout in the system browser`,
  );
}
if (!m.bugsUrl) {
  feedbackProblems.push(`bugsUrl is required — the https URL of your PUBLIC issue tracker, e.g. https://github.com/you/your-poppy/issues`);
}
if (feedbackProblems.length > 0) {
  fail(
    `✗ ${path} — the mandatory Feedback tab isn't declared:`,
    ...feedbackProblems.map((e) => `  • ${e}`),
    ``,
    `Every poppy's LAST tab is "Feedback" (rate · request a feature · report a bug · donate),`,
    `rendered by <agentspoppy-feedback> from the SDK — you don't build it. See AGENTS.md §9a.`,
  );
}

// Confinement (RUNTIMES.md R7): a backend must declare isolation "strict" to be listable.
// A structural warning here, so the developer hears it on THEIR machine first — the listing
// review enforces it for real (the only sanctioned exception is a named one-release migration).
// An unconfined backend is a hard failure, not advice. Before 0.3.5 this printed a
// warning and exited 0, so the only thing standing between an unconfined poppy and a
// user was a human remembering to read the output — and an external audit in Aug 2026
// correctly reported the platform as "confinement is opt-in" on the strength of it.
if (m.backend && effectiveIsolation(m.backend) === "none") {
  console.error(
    `✗ ${m.id} — backend is NOT confined ("isolation": "none"): it runs with the user's full
  file access, including ~/.aws/credentials. This package cannot be listed (RUNTIMES.md R7),
  and the submissions API refuses it server-side. Declare "runtime": "node22" +
  "isolation": "strict", keep state in bootstrap.dataDir, and hand files out via a one-shot
  /local-download token (see examples/hello-poppy). The single sanctioned exception is a
  named, one-release data migration — see docs/CONFINEMENT-MIGRATION.md.`,
  );
  process.exit(1);
}

const grants = m.permissionSet.grants.length;
console.log(`✓ ${m.id} v${m.version} — valid`);
console.log(
  `  ${grants} grant${grants === 1 ? "" : "s"} · capabilities: ${m.capabilities.join(", ") || "none"} · ` +
    (m.backend ? `backend: ${m.backend.transport ?? "http"}${m.backend.isolation === "strict" ? " · confined" : ""}` : "frontend-only"),
);
console.log(
  `  Structural check only — install it and confirm the rating is amber/green in AgentsPoppy (AGENTS.md §3).`,
);
