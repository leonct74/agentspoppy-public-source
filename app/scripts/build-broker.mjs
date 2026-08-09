#!/usr/bin/env node
// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
/**
 * Build the AgentsPoppy broker into a single self-contained executable so the
 * packaged Tauri app can ship it as an `externalBin` and end users never need
 * Node installed.
 *
 * Pipeline: esbuild (bundle @agentspoppy/broker + core → one CJS) → Node 22 SEA
 * (Single Executable Application) → codesign (macOS ad-hoc). Output is named with
 * the Rust target triple Tauri expects, e.g.
 *   app/src-tauri/binaries/agentspoppy-broker-aarch64-apple-darwin
 *
 * Run from the app workspace:  node scripts/build-broker.mjs
 */
import * as esbuild from "esbuild";
import { inject } from "postject";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", ".."); // app/scripts → repo root
const entry = join(repoRoot, "packages", "broker", "src", "serve.ts");
const buildDir = join(here, "..", "build");
const binariesDir = resolve(here, "..", "src-tauri", "binaries");

// Node's stable SEA fuse sentinel (see nodejs.org/api/single-executable-applications).
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

/** Map the current host to the Rust target triple Tauri appends to externalBin. */
function targetTriple() {
  if (process.env.TAURI_TARGET_TRIPLE) return process.env.TAURI_TARGET_TRIPLE;
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  if (process.platform === "linux") return `${arch}-unknown-linux-gnu`;
  throw new Error(`unsupported platform ${process.platform}`);
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

/**
 * Strip an Authenticode signature from a PE file, in place. Node's official node.exe is
 * Microsoft-signed; injecting the SEA blob into it with postject leaves a CORRUPTED
 * certificate table, and the Microsoft Store's signing service then rejects the whole
 * package with 0x800700C1 (ERROR_BAD_EXE_FORMAT) at pre-processing — exactly how the
 * first AgentsPoppy Store submission failed. Removing the certificate table BEFORE
 * injection leaves a cleanly unsigned PE any signer can sign. (Node's SEA docs call for
 * `signtool remove /s`; this is the same operation in pure Node, so it also works when
 * cross-building from macOS/Linux.) Returns true if a signature was removed.
 */
export function stripAuthenticode(file) {
  const buf = readFileSync(file);
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return false; // no MZ header
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 26 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) return false; // no "PE\0\0"
  const optMagic = buf.readUInt16LE(pe + 24);
  const dataDirs = pe + 24 + (optMagic === 0x20b ? 112 : 96); // PE32+ vs PE32 optional header
  const secEntry = dataDirs + 4 * 8; // IMAGE_DIRECTORY_ENTRY_SECURITY (file offset, not RVA)
  const certOff = buf.readUInt32LE(secEntry);
  const certSize = buf.readUInt32LE(secEntry + 4);
  if (!certOff || !certSize) return false; // already unsigned
  buf.writeUInt32LE(0, secEntry);
  buf.writeUInt32LE(0, secEntry + 4);
  // The certificate table lives at the end of the file — drop it when it does.
  const out = certOff + certSize >= buf.length ? buf.subarray(0, certOff) : buf;
  writeFileSync(file, out);
  return true;
}

async function main() {
  const triple = targetTriple();
  const isWin = process.platform === "win32";
  const binName = `agentspoppy-broker-${triple}${isWin ? ".exe" : ""}`;
  const bundlePath = join(buildDir, "broker.cjs");
  const blobPath = join(buildDir, "broker.blob");
  const seaConfigPath = join(buildDir, "sea-config.json");
  const outBin = join(binariesDir, binName);

  mkdirSync(buildDir, { recursive: true });
  mkdirSync(binariesDir, { recursive: true });

  // 1. Bundle the broker (+ @agentspoppy/core) into one CJS file. The app version is
  //    baked in (tauri.conf.json is the single source of truth) so the broker can
  //    enforce catalog `minHost` gates — a dev run without it leaves the gate off.
  const appVersion = JSON.parse(readFileSync(join(here, "..", "src-tauri", "tauri.conf.json"), "utf8")).version;
  console.log(`[1/5] esbuild bundle (v${appVersion}) →`, bundlePath);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: bundlePath,
    logLevel: "warning",
    define: { "process.env.AGENTSPOPPY_BUILD_VERSION": JSON.stringify(appVersion) },
  });

  // 2. Generate the SEA preparation blob from the bundle.
  console.log("[2/5] SEA blob →", blobPath);
  writeFileSync(
    seaConfigPath,
    JSON.stringify(
      { main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true, useCodeCache: false },
      null,
      2,
    ),
  );
  run(process.execPath, ["--experimental-sea-config", seaConfigPath]);

  // 3. Start from the current Node binary. On macOS the system Node is often a
  //    *universal* (fat) binary; the SEA sentinel then appears once per slice.
  //    Thin it to the target arch first.
  console.log("[3/5] stage node binary →", outBin);
  const macArch = triple.startsWith("aarch64") ? "arm64" : "x86_64";
  const isFat =
    process.platform === "darwin" &&
    execFileSync("lipo", ["-archs", process.execPath]).toString().trim().split(/\s+/).length > 1;
  if (isFat) {
    run("lipo", [process.execPath, "-thin", macArch, "-output", outBin]);
  } else {
    copyFileSync(process.execPath, outBin);
  }
  chmodSync(outBin, 0o755);

  // 4. Strip the existing signature before injecting the blob — on EVERY platform.
  //    macOS: codesign (a stale Mach-O signature breaks launch). Windows: the Authenticode
  //    cert table (injecting past it corrupts it, and the Microsoft Store's signer then
  //    fails the whole MSIX with 0x800700C1 — the first Store submission's failure).
  if (process.platform === "darwin") {
    console.log("[4/5] codesign --remove-signature");
    run("codesign", ["--remove-signature", outBin]);
  } else if (isWin) {
    console.log("[4/5] strip Authenticode signature");
    console.log(stripAuthenticode(outBin) ? "  signature removed (clean unsigned PE)" : "  (was not signed)");
  } else {
    console.log("[4/5] (no signature to strip on this platform)");
  }

  // 5. Inject the SEA blob and re-sign (ad-hoc) so macOS will run it.
  console.log("[5/5] postject inject + re-sign");
  await inject(outBin, "NODE_SEA_BLOB", readFileSync(blobPath), {
    sentinelFuse: SEA_FUSE,
    machoSegmentName: process.platform === "darwin" ? "NODE_SEA" : undefined,
  });
  if (process.platform === "darwin") {
    run("codesign", ["--sign", "-", outBin]);
  }

  console.log(`\n✅ broker binary ready: ${outBin}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
