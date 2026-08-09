#!/usr/bin/env node
// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
/**
 * Emit the updater feed (latest.json) for a release. The app's updater plugin
 * fetches this from the PUBLIC releases repo's latest release and compares
 * `version` with the running app; the per-platform `signature` is the updater
 * key's minisign signature (produced by `tauri build` when
 * TAURI_SIGNING_PRIVATE_KEY_PATH is set — see RELEASE.md).
 *
 * Usage (from app/):  node scripts/make-latest-json.mjs ["release notes"]
 * Writes: src-tauri/target/release/bundle/latest.json
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(readFileSync(join(appDir, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;
const bundle = join(appDir, "src-tauri", "target", "release", "bundle");
const notes = process.argv[2] ?? "";

const platforms = {};

// macOS (Apple Silicon): the updater consumes the .app.tar.gz + its .sig.
const macTar = join(bundle, "macos", "AgentsPoppy.app.tar.gz");
if (existsSync(macTar) && existsSync(`${macTar}.sig`)) {
  platforms["darwin-aarch64"] = {
    url: `https://github.com/leonct74/agentspoppy-releases/releases/download/v${version}/AgentsPoppy_${version}_aarch64.app.tar.gz`,
    signature: readFileSync(`${macTar}.sig`, "utf8").trim(),
  };
}

// Linux (AppImage channel): the updater downloads and swaps the AppImage in place.
// The CI artifact is placed under bundle/appimage/ by the release flow (RELEASE.md).
const appImage = join(bundle, "appimage", `AgentsPoppy_${version}_amd64.AppImage`);
if (existsSync(appImage) && existsSync(`${appImage}.sig`)) {
  platforms["linux-x86_64"] = {
    url: `https://github.com/leonct74/agentspoppy-releases/releases/download/v${version}/AgentsPoppy_${version}_amd64.AppImage`,
    signature: readFileSync(`${appImage}.sig`, "utf8").trim(),
  };
}

// Windows (NSIS channel) — OPT-IN via --windows. Deliberately excluded by default:
// the Microsoft Store MSIX build contains the same updater plugin, and a feed entry
// for windows-x86_64 would make Store-installed copies download the NSIS installer
// over themselves (two install mechanisms colliding). Include it only once the app
// can detect an MSIX context and suppress the check there.
const winSetup = join(bundle, "nsis", `AgentsPoppy_${version}_x64-setup.exe`);
if (process.argv.includes("--windows") && existsSync(winSetup) && existsSync(`${winSetup}.sig`)) {
  platforms["windows-x86_64"] = {
    url: `https://github.com/leonct74/agentspoppy-releases/releases/download/v${version}/AgentsPoppy_${version}_x64-setup.exe`,
    signature: readFileSync(`${winSetup}.sig`, "utf8").trim(),
  };
}

if (Object.keys(platforms).length === 0) {
  console.error("make-latest-json: no signed updater artifacts found — build with TAURI_SIGNING_PRIVATE_KEY_PATH set");
  process.exit(1);
}

const feed = { version, notes, pub_date: new Date().toISOString(), platforms };
const out = join(bundle, "latest.json");
writeFileSync(out, JSON.stringify(feed, null, 2) + "\n");
console.log(`wrote ${out} (${Object.keys(platforms).join(", ")})`);
