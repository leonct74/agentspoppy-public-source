// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * Regenerate src/generated/awsForcedActions.ts from AWS's own published service
 * reference.
 *
 * A "forced" action is one AWS lists with NO resource types, which means the ONLY
 * Resource that can authorise it is "*". Scoping such an action to an ARN does not
 * narrow it — it denies it outright. Verified live (see docs/specs/tag-scoping-and-ratings.md
 * Rule C): ec2:DescribeInstances scoped to arn:…:instance/* simulates implicitDeny,
 * while the same action at "*" is allowed, with a working positive control alongside.
 *
 * This table is GENERATED, never edited by hand. Curating it by memory is exactly the
 * mistake the NAMED_BIRTHS review caught in birthActions.ts, and it fails the same way:
 * silently, in the flattering direction.
 *
 *   node packages/core/scripts/gen-forced-actions.mjs           # rewrite the table
 *   node packages/core/scripts/gen-forced-actions.mjs --check   # exit 1 if stale
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INDEX_URL = "https://servicereference.us-east-1.amazonaws.com/";
const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "generated",
  "awsForcedActions.ts",
);
const CONCURRENCY = 12;

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function build() {
  const index = await getJson(INDEX_URL);
  const table = {};
  const versions = new Set();
  let failed = 0;
  const queue = [...index];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const entry = queue.shift();
        try {
          const doc = await getJson(entry.url);
          if (doc.Version) versions.add(doc.Version);
          const forced = (doc.Actions ?? [])
            .filter((a) => !(a.Resources ?? []).length)
            .map((a) => a.Name.toLowerCase())
            .sort();
          if (forced.length) table[entry.service] = forced.join(",");
        } catch {
          failed++;
        }
      }
    }),
  );
  // A partial fetch would silently DELETE services from the table, turning "AWS cannot
  // narrow this" into silence for whole services. Refuse rather than ship a hole.
  if (failed) throw new Error(`${failed} service documents failed to fetch — refusing to write a partial table`);
  return { table, services: index.length, versions: [...versions].sort() };
}

function render({ table, services, versions }) {
  const names = Object.keys(table).sort();
  const rows = names.map((s) => `  ${JSON.stringify(s)}: ${JSON.stringify(table[s])},`).join("\n");
  const count = names.reduce((a, s) => a + table[s].split(",").length, 0);
  return `// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * GENERATED FILE — DO NOT EDIT.
 *   node packages/core/scripts/gen-forced-actions.mjs
 *
 * Actions AWS provides no way to narrow: it publishes no resource types for them, so
 * the only Resource that can authorise them is "*". Scoping one to an ARN denies it.
 *
 * Source:  ${INDEX_URL}
 * Schema:  ${versions.join(", ")}
 * Covers:  ${services} services, ${names.length} of which have at least one such action
 * Actions: ${count}
 *
 * Values are comma-joined, lower-cased, sorted action names. See awsNarrowing.ts.
 */
export const AWS_FORCED_ACTIONS: Readonly<Record<string, string>> = {
${rows}
};
`;
}

const built = await build();
const next = render(built);
const check = process.argv.includes("--check");
const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
if (check) {
  if (current === next) {
    console.log("awsForcedActions.ts is up to date with AWS's service reference.");
  } else {
    console.error("awsForcedActions.ts is STALE — rerun without --check.");
    process.exit(1);
  }
} else {
  fs.writeFileSync(OUT, next);
  console.log(`wrote ${OUT}`);
}
