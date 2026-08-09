// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * A minimal STORE-only ZIP reader for directory packages — dependency-free on
 * purpose (the broker stays auditable end-to-end; a zip library would be its
 * biggest import). Packages are plain ZIPs with no compression (STORE), chosen
 * for byte-reproducibility: the same tree always packs to the same bytes, so a
 * package can be re-derived from its open repo and checked against its
 * published sha256.
 *
 * Deliberately narrow: no zip64, no encryption, no multi-disk. Every entry's
 * path is containment-checked against the destination and its CRC32 verified
 * BEFORE the file is written, so a truncated or tampered archive can never
 * half-install.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const LOCAL_SIG = 0x04034b50; // PK\x03\x04
const CENTRAL_SIG = 0x02014b50; // PK\x01\x02
const EOCD_SIG = 0x06054b50; // PK\x05\x06

const NOT_A_PACKAGE =
  "This file isn't a poppy package this app can read — the download may be incomplete or the wrong file. Nothing was installed.";

// Standard CRC32 (the polynomial every zip tool uses), table-driven.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The EOCD sits at the very end, behind an up-to-64KB archive comment — scan back for it. */
function findEocd(view: DataView): number {
  const floor = Math.max(0, view.byteLength - 22 - 65535);
  for (let i = view.byteLength - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  throw new Error(`${NOT_A_PACKAGE} — no ZIP end-of-central-directory record found`);
}

/**
 * Refuse any entry name that could land outside `destRoot`: absolute paths,
 * backslashes (Windows separators we won't normalise), ".." segments, and — as
 * the backstop, the same containment idiom the registry's asset serving uses —
 * a resolve + prefix check. Returns the resolved absolute target path.
 */
function safeTarget(name: string, destRoot: string): string {
  const unsafe =
    name === "" ||
    name.startsWith("/") ||
    /^[a-zA-Z]:/.test(name) ||
    name.includes("\\") ||
    name.split("/").some((part) => part === "..");
  const target = resolve(destRoot, name);
  if (unsafe || (target !== destRoot && !target.startsWith(destRoot + sep))) {
    throw new Error(
      `This package tried to put files outside its own folder — refusing to extract it. Nothing was installed. — unsafe entry path "${name}"`,
    );
  }
  return target;
}

/**
 * Extract a STORE-only ZIP into `destDir`, returning the extracted relative
 * paths. Throws (plain-language first) on compression, zip64, unsafe paths,
 * truncation, or a CRC32 mismatch — the caller is expected to discard
 * `destDir` on any failure.
 */
export async function extractZip(bytes: Uint8Array, destDir: string): Promise<string[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);

  const totalEntries = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error(
      "This package uses a ZIP feature the directory doesn't support (zip64) — poppy packages are small, plain ZIP files. Nothing was installed.",
    );
  }
  if (cdOffset + cdSize > eocd) throw new Error(`${NOT_A_PACKAGE} — central directory extends past the archive`);

  const destRoot = resolve(destDir);
  const decoder = new TextDecoder();
  const extracted: string[] = [];
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > eocd || view.getUint32(p, true) !== CENTRAL_SIG) {
      throw new Error(`${NOT_A_PACKAGE} — malformed central directory entry`);
    }
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compSize = view.getUint32(p + 20, true);
    const uncompSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(
        "This package uses a ZIP feature the directory doesn't support (zip64) — poppy packages are small, plain ZIP files. Nothing was installed.",
      );
    }
    if (method !== 0) {
      throw new Error(
        `This package can't be read — directory packages are stored uncompressed, but "${name}" is compressed. It wasn't built by the directory's packer. Nothing was installed. — compression method ${method}`,
      );
    }
    if (compSize !== uncompSize) throw new Error(`${NOT_A_PACKAGE} — stored entry "${name}" has mismatched sizes`);

    const target = safeTarget(name, destRoot);
    if (name.endsWith("/")) {
      await mkdir(target, { recursive: true });
      extracted.push(name);
      continue;
    }

    // Data lives behind the LOCAL header, whose name/extra lengths can legally
    // differ from the central ones — re-read them there.
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== LOCAL_SIG) {
      throw new Error(`${NOT_A_PACKAGE} — missing local header for "${name}"`);
    }
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > bytes.length) throw new Error(`${NOT_A_PACKAGE} — "${name}" is truncated`);
    const data = bytes.subarray(dataStart, dataStart + compSize);

    if (crc32(data) !== crc) {
      throw new Error(
        `Part of this package is damaged — a file inside failed its integrity check, so the download was likely interrupted or altered. Nothing was installed. — CRC32 mismatch for "${name}"`,
      );
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data, { mode: 0o644 });
    extracted.push(name);
  }
  return extracted;
}
