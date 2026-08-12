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
// macOS ships ONE universal artifact; the arch-specific tree is the older layout and
// still works (a plain `tauri build` writes there). Prefer universal.
const MAC_BUILDS = [
  { bundle: join(appDir, "src-tauri", "target", "universal-apple-darwin", "release", "bundle"), suffix: "universal" },
  { bundle: join(appDir, "src-tauri", "target", "release", "bundle"), suffix: "aarch64" },
];
const macBuild =
  MAC_BUILDS.find((b) => existsSync(join(b.bundle, "macos", "AgentsPoppy.app.tar.gz"))) ?? MAC_BUILDS[1];
const bundle = macBuild.bundle;
const notes = process.argv[2] ?? "";

const platforms = {};

// macOS: the updater consumes the .app.tar.gz + its .sig.
//
// The updater keys entries by ARCH, and it has no notion of a universal build — an Intel
// Mac asks for `darwin-x86_64` and simply finds nothing if only `darwin-aarch64` is listed.
// So a universal artifact must be published under BOTH keys, pointing at the same file.
// (Until 0.3.1 only `darwin-aarch64` was ever emitted, which is why no Intel Mac has ever
// been offered an update — there was no Intel build to offer.)
const macTar = join(bundle, "macos", "AgentsPoppy.app.tar.gz");
if (existsSync(macTar) && existsSync(`${macTar}.sig`)) {
  const entry = {
    url: `https://github.com/leonct74/agentspoppy-releases/releases/download/v${version}/AgentsPoppy_${version}_${macBuild.suffix}.app.tar.gz`,
    signature: readFileSync(`${macTar}.sig`, "utf8").trim(),
  };
  platforms["darwin-aarch64"] = entry;
  if (macBuild.suffix === "universal") platforms["darwin-x86_64"] = { ...entry };
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
