#!/usr/bin/env node
// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
/**
 * Package a built extension into a directory-installable zip, in the exact layout the
 * broker extracts into <extensionsRoot>/<id>/ (same layout install-dev-extension.mjs
 * stages for local dev):
 *
 *   extension.json          ← the manifest, at the zip root
 *   frontend/index.html(+…) ← the built UI (Vite dist)
 *   backend/<binary>        ← the SEA sidecar (only if the manifest declares a backend)
 *
 * The archive is written with the deterministic STORE-method writer (no compression,
 * fixed mtimes) so a published package can be reproduced byte-for-byte from source —
 * the sha256 in the catalog is the whole trust story. Dependency-free; macOS/Linux.
 *
 * Usage:
 *   node scripts/pack-extension.mjs --src <extension-source-dir> \
 *        [--frontend <built-frontend-dir>] [--backend <built-binary>] \
 *        [--out <dir>] [--platform <key>]
 *
 * Example (MailPoppy):
 *   node scripts/pack-extension.mjs --src /path/to/mailpoppy/apps/desktop --out /tmp/mailpoppy-package
 *   # defaults: --frontend <src>/dist  --backend <src>/src-tauri/binaries/<manifest backend basename>
 *   #           --out <src>/release    --platform derived from the backend binary's rust triple
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { deterministicZip } from "./lib/deterministic-zip.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function die(msg) {
  console.error(`pack-extension: ${msg}`);
  process.exit(1);
}

// Rust target triple (binary name suffix) → catalog platformKey (`${process.platform}-${process.arch}`).
const TRIPLE_TO_PLATFORM = {
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-pc-windows-msvc": "win32-x64",
  "x86_64-apple-darwin": "darwin-x64",
  "x86_64-unknown-linux-gnu": "linux-x64",
  "aarch64-unknown-linux-gnu": "linux-arm64",
};

const src = resolve(arg("src", process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : ""));
if (!src || !existsSync(src)) die(`--src must point at an extension source dir (got "${src}")`);

const manifestPath = join(src, "extension.json");
if (!existsSync(manifestPath)) die(`no extension.json in ${src} — build it first (npm run gen:manifest)`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!manifest.id || !manifest.frontend?.entry) die("extension.json is missing id or frontend.entry");
if (!manifest.version) die("extension.json is missing version — the catalog needs a semver to key releases on");

// A `runtime: "node22"` backend is a plain CJS bundle run on AgentsPoppy's own Node
// (docs/RUNTIMES.md) — platform-neutral, so the package key defaults to "any" and no
// win32 .exe games apply.
const runtime = manifest.backend?.runtime ?? "native";
const isNodeRuntime = runtime.startsWith("node");

// Source artifacts (same defaults as install-dev-extension.mjs). For a node-runtime
// poppy the default backend artifact is the entry itself under the source dir (the
// esbuild output); for native it's the SEA-era sidecar path.
const frontendSrc = resolve(arg("frontend", join(src, "dist")));
const backendBin = manifest.backend ? basename(manifest.backend.entry) : null;
const backendSrc = manifest.backend
  ? resolve(arg("backend", isNodeRuntime ? join(src, manifest.backend.entry) : join(src, "src-tauri", "binaries", backendBin)))
  : null;

if (!existsSync(frontendSrc)) die(`built frontend not found at ${frontendSrc} — run the app build first (e.g. vite build)`);
if (backendSrc && !existsSync(backendSrc)) die(`built backend not found at ${backendSrc} — run the backend build first`);

// Which computer this package is for. node-runtime poppies are platform-neutral ("any");
// native ones derive it from the backend binary's rust triple unless overridden — and a
// frontend-only poppy has nothing to derive from, so it must say.
let platform = arg("platform", null);
if (!platform && isNodeRuntime) platform = "any";
if (!platform) {
  const triple = backendBin ? Object.keys(TRIPLE_TO_PLATFORM).find((t) => backendBin.endsWith(t)) : null;
  if (!triple) {
    die(
      backendBin
        ? `can't tell which computer this package is for — the backend binary "${backendBin}" doesn't end in a known rust triple (${Object.keys(TRIPLE_TO_PLATFORM).join(", ")}); pass --platform, e.g. --platform darwin-arm64`
        : `can't tell which computer this package is for — this poppy has no backend binary to derive it from; pass --platform, e.g. --platform darwin-arm64`
    );
  }
  platform = TRIPLE_TO_PLATFORM[triple];
}

const out = resolve(arg("out", join(src, "release")));

// Windows packages carry a NATIVE backend as <entry>.exe — the manifest keeps the
// platform-neutral entry ("backend/foo") and the host appends .exe on win32. A
// node-runtime bundle is the same .cjs file everywhere; no suffix ever applies.
const isWinPackage = !isNodeRuntime && platform.startsWith("win32");
const stagedBackendName = backendBin && isWinPackage && !backendBin.endsWith(".exe") ? `${backendBin}.exe` : backendBin;
const stagedBackendEntry = manifest.backend
  ? isWinPackage && !manifest.backend.entry.endsWith(".exe")
    ? `${manifest.backend.entry}.exe`
    : manifest.backend.entry
  : null;

// Stage the exact extracted layout in a temp dir, then validate it as the broker will
// see it — a package that passes here extracts to a working extension. Cleanup rides the
// exit event because die()'s process.exit(1) would skip a finally block.
const staged = mkdtempSync(join(tmpdir(), "pack-extension-"));
process.on("exit", () => rmSync(staged, { recursive: true, force: true }));
{
  copyFileSync(manifestPath, join(staged, "extension.json"));
  cpSync(frontendSrc, join(staged, dirname(manifest.frontend.entry)), { recursive: true });
  if (backendSrc) {
    const backendDest = join(staged, dirname(manifest.backend.entry), stagedBackendName);
    mkdirSync(dirname(backendDest), { recursive: true });
    copyFileSync(backendSrc, backendDest);
  }

  if (!existsSync(join(staged, manifest.frontend.entry)))
    die(`the built frontend has no ${manifest.frontend.entry} — the app couldn't load; check the frontend build output at ${frontendSrc}`);
  if (manifest.backend && !existsSync(join(staged, stagedBackendEntry)))
    die(`the staged package has no ${stagedBackendEntry} — the poppy couldn't start; check the sidecar build`);

  // R1 — no bundled third-party runtimes (docs/RUNTIMES.md): the platform provides
  // runtimes; a package that ships one is refused HERE, before it can ever be listed.
  if (manifest.backend) {
    const bytes = readFileSync(join(staged, stagedBackendEntry));
    if (bytes.includes("NODE_SEA_FUSE_"))
      die(
        `${stagedBackendEntry} embeds a Node.js runtime (Node SEA detected). Poppies must not ship runtimes — ` +
          `declare "runtime": "node22" in extension.json and ship your esbuild CJS bundle instead; ` +
          `AgentsPoppy provides the runtime (docs/RUNTIMES.md).`
      );
    const be = bytes.length >= 4 ? bytes.readUInt32BE(0) : 0;
    const le = bytes.length >= 4 ? bytes.readUInt32LE(0) : 0;
    const MACHO = new Set([0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcafebabf]);
    const isNativeBinary =
      (bytes[0] === 0x4d && bytes[1] === 0x5a) || be === 0x7f454c46 || MACHO.has(be) || MACHO.has(le);
    if (isNodeRuntime && isNativeBinary)
      die(`backend.runtime is "${runtime}" but ${stagedBackendEntry} is a native executable — a node-runtime entry must be a plain CJS bundle.`);
    const NATIVE_CAP = 25 * 1024 * 1024;
    if (!isNodeRuntime && bytes.length > NATIVE_CAP)
      die(
        `the native backend is ${(bytes.length / 1048576).toFixed(1)} MB — over the 25 MB cap for self-contained ` +
          `native backends. If it embeds a language runtime, declare "runtime": "node22" and ship the JS bundle instead (docs/RUNTIMES.md).`
      );
  }
  // Icon is optional (the directory falls back to a placeholder), so a missing one only warns.
  if (manifest.icon && !existsSync(join(staged, manifest.icon)))
    console.warn(`pack-extension: warning — manifest declares icon "${manifest.icon}" but the built frontend doesn't contain it; packaging without an icon`);

  // Collect every staged file as a zip entry, paths relative with forward slashes
  // (extension.json, backend/**, frontend/**). The writer sorts internally.
  const entries = [];
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else entries.push({ name: relative(staged, p).replaceAll("\\", "/"), data: readFileSync(p) });
    }
  };
  walk(staged);

  // Fixed mtime: honour SOURCE_DATE_EPOCH so a rebuild from source can reproduce the
  // published bytes; default 0 clamps to the writer's 1980-01-01 floor.
  const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? 0);
  const zip = deterministicZip(entries, epoch);

  mkdirSync(out, { recursive: true });
  const zipName = `${manifest.id}-${manifest.version}-${platform}.zip`;
  const zipPath = join(out, zipName);
  writeFileSync(zipPath, zip);
  const sha256 = createHash("sha256").update(zip).digest("hex");
  writeFileSync(`${zipPath}.sha256`, `${sha256}  ${zipName}\n`); // shasum -a 256 -c compatible

  console.log(`packaged ${manifest.id} ${manifest.version} for ${platform}`);
  console.log(`  ${zipPath} (${entries.length} files, ${(zip.length / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`  sha256: ${sha256}`);
  console.log(`\nDirectory catalog entry (fill in the two <FILL> fields):`);
  console.log(
    JSON.stringify(
      {
        id: manifest.id,
        name: manifest.name ?? manifest.id,
        version: manifest.version,
        repo: "<FILL: the poppy's public repository URL>",
        packages: { [platform]: { url: "<FILL: where the zip is published>", sha256 } },
        // node-runtime packages need a host that can run them (docs/RUNTIMES.md §4.5)
        ...(isNodeRuntime ? { minHost: "0.3.0" } : {}),
      },
      null,
      2
    )
  );
}
