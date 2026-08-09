#!/usr/bin/env node
// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
/**
 * Lay out a built extension into AgentsPoppy's extensions dir for LOCAL testing, in the
 * layout the broker's installExtensionsFromDisk + frontend server expect:
 *
 *   <home>/extensions/<id>/extension.json          ← the manifest
 *   <home>/extensions/<id>/frontend/index.html(+…) ← the built UI (Vite dist)
 *   <home>/extensions/<id>/backend/<binary>        ← the SEA sidecar (exec)
 *
 * It reads the manifest to learn the id + the frontend/backend entry paths, then copies
 * the built artifacts into place. Dependency-free; macOS/Linux.
 *
 * Usage:
 *   node scripts/install-dev-extension.mjs --src <extension-source-dir> \
 *        [--frontend <built-frontend-dir>] [--backend <built-binary>] [--home <agentspoppy-home>]
 *
 * Example (MailPoppy):
 *   node scripts/install-dev-extension.mjs --src /path/to/mailpoppy/apps/desktop
 *   # defaults: --frontend <src>/dist  --backend <src>/src-tauri/binaries/<manifest backend basename>
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, chmodSync, copyFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function die(msg) {
  console.error(`install-dev-extension: ${msg}`);
  process.exit(1);
}

const src = resolve(arg("src", process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : ""));
if (!src || !existsSync(src)) die(`--src must point at an extension source dir (got "${src}")`);

const manifestPath = join(src, "extension.json");
if (!existsSync(manifestPath)) die(`no extension.json in ${src} — build it first (npm run gen:manifest)`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!manifest.id || !manifest.frontend?.entry) die("extension.json is missing id or frontend.entry");

const home = resolve(arg("home", process.env.AGENTSPOPPY_HOME ?? join(homedir(), ".agentspoppy")));
const dest = join(home, "extensions", manifest.id);

// Source artifacts (with sensible MailPoppy/Vite/Tauri defaults).
const frontendSrc = resolve(arg("frontend", join(src, "dist")));
const frontendDestDir = join(dest, dirname(manifest.frontend.entry)); // <dest>/frontend
const backendBin = manifest.backend ? basename(manifest.backend.entry) : null;
const backendSrc = manifest.backend ? resolve(arg("backend", join(src, "src-tauri", "binaries", backendBin))) : null;

if (!existsSync(frontendSrc)) die(`built frontend not found at ${frontendSrc} — run the app build first (e.g. vite build)`);
if (backendSrc && !existsSync(backendSrc)) die(`built backend not found at ${backendSrc} — run the sidecar build first`);

// Fresh layout.
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
copyFileSync(manifestPath, join(dest, "extension.json"));
cpSync(frontendSrc, frontendDestDir, { recursive: true });
if (backendSrc) {
  const backendDest = join(dest, dirname(manifest.backend.entry), backendBin);
  mkdirSync(dirname(backendDest), { recursive: true });
  copyFileSync(backendSrc, backendDest);
  chmodSync(backendDest, 0o755);
}

console.log(`installed ${manifest.id} → ${dest}`);
console.log(`  frontend: ${frontendDestDir}`);
if (backendSrc) console.log(`  backend:  ${join(dest, dirname(manifest.backend.entry), backendBin)}`);
console.log(`\nRestart the AgentsPoppy broker so it picks up the new extension.`);
