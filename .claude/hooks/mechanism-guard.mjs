#!/usr/bin/env node
// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
//
// PreToolUse guard for the patented delegation mechanism (docs/SECURITY_MECHANISM.md).
//
// Any Edit/Write aimed at a mechanism enforcement point is BLOCKED unless the FOUNDER
// has freshly approved — by personally running:
//
//     touch .claude/mechanism-approval        (valid for 60 minutes)
//
// The approval is an action only a human at the terminal performs; an agent asking
// nicely (or a founder replying "ok" to an innocuous-sounding request) is not enough.
// This hook is deterministic: it fires whether or not the agent read any docs.

import { readFileSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";

const PROTECTED = [
  "packages/broker/src/aws/policy.ts",
  "packages/broker/src/aws/policy.test.ts", // the invariants' tripwires — weakening tests IS a mechanism change
  "packages/broker/src/aws/sts.ts",
  "packages/broker/src/aws/tagging.ts",
  "packages/broker/src/aws/deletion.ts",
  "packages/core/src/permissions.ts",
  // The rating's tripwires. Same reasoning as policy.test.ts above: an agent told to
  // "make the failing test pass" can satisfy that instruction by deleting the row that
  // failed, and the next change to permissions.ts is then approved against a tripwire
  // that no longer trips. These two pin I6 — that the consent screen describes what the
  // compiled policy actually permits — so weakening them IS a mechanism change.
  "packages/core/src/permissions-rating.test.ts",
  "packages/broker/src/aws/rating-matches-compiler.test.ts",
  "packages/broker/src/certify.ts",
  "scripts/certify.ts",
  "docs/SECURITY_MECHANISM.md", // the spec itself — rewriting the law is changing the mechanism
];

const APPROVAL_FILE = ".claude/mechanism-approval";
const APPROVAL_TTL_MS = 60 * 60 * 1000;

let input = "";
try {
  input = readFileSync(0, "utf8");
} catch {
  process.exit(0); // no stdin — never break unrelated tooling
}

let filePath = "";
try {
  const parsed = JSON.parse(input);
  filePath = parsed?.tool_input?.file_path ?? parsed?.tool_input?.notebook_path ?? "";
} catch {
  process.exit(0);
}
if (!filePath) process.exit(0);

const repoRoot = resolve(new URL(".", import.meta.url).pathname, "../..");
const rel = relative(repoRoot, resolve(filePath));
if (!PROTECTED.includes(rel)) process.exit(0);

// A fresh, founder-made approval file opens a 60-minute window.
try {
  const age = Date.now() - statSync(resolve(repoRoot, APPROVAL_FILE)).mtimeMs;
  if (age >= 0 && age < APPROVAL_TTL_MS) process.exit(0);
} catch {
  /* no approval file — fall through to block */
}

console.error(
  [
    `⛔ BLOCKED — ${rel} is an enforcement point of the patented security mechanism.`,
    ``,
    `AGENT: do NOT retry or work around this. Relay the following to the founder VERBATIM,`,
    `then explain in plain language WHAT you want to change and WHICH invariants of`,
    `docs/SECURITY_MECHANISM.md (I1–I6) it touches:`,
    ``,
    `  🚨 ATTENTION — THIS CHANGE MIGHT IMPACT THE SECURITY MECHANISM 🚨`,
    ``,
    `FOUNDER: if — after reading the explanation — you consciously approve, run this`,
    `yourself in a terminal at the repo root (agents must never run it for you):`,
    ``,
    `    touch ${APPROVAL_FILE}`,
    ``,
    `That opens a 60-minute editing window, then this guard re-arms. Any change made in`,
    `the window must walk the SECURITY_MECHANISM.md §5 checklist and update the spec in`,
    `the same commit.`,
  ].join("\n"),
);
process.exit(2);
