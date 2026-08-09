// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
// Regression guard for the trust-critical archive writer (mirrors the MailPoppy original).
// Run from the repo root: node --test scripts/lib/deterministic-zip.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { deterministicZip, crc32, dosDateTime } from "./deterministic-zip.mjs";

const EPOCH = 1783360657; // a fixed reference epoch
const a = { name: "access-api.js", data: Buffer.from("alpha handler") };
const b = { name: "inbound-processor.js", data: Buffer.from("bravo handler") };

test("crc32 matches known vectors", () => {
  assert.equal(crc32(Buffer.from("")), 0x00000000);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926); // canonical CRC-32 check value
});

test("same input + epoch is byte-identical across calls", () => {
  const z1 = deterministicZip([a, b], EPOCH);
  const z2 = deterministicZip([a, b], EPOCH);
  assert.ok(z1.equals(z2), "two builds of the same input must be byte-identical");
});

test("entry order does not affect output (sorted internally)", () => {
  const forward = deterministicZip([a, b], EPOCH);
  const reversed = deterministicZip([b, a], EPOCH);
  assert.ok(forward.equals(reversed), "input order must not change the archive");
});

test("archive changes when content or mtime changes", () => {
  const base = deterministicZip([a, b], EPOCH);
  const otherData = deterministicZip([{ ...a, data: Buffer.from("ALPHA handler") }, b], EPOCH);
  const otherEpoch = deterministicZip([a, b], EPOCH + 4);
  assert.ok(!base.equals(otherData), "different content must produce a different archive");
  assert.ok(!base.equals(otherEpoch), "different mtime must produce a different archive");
});

test("output is a well-formed ZIP with STORED (verbatim) data", () => {
  const z = deterministicZip([a, b], EPOCH);
  assert.equal(z.readUInt32LE(0), 0x04034b50, "starts with a local file header");
  assert.equal(z.readUInt32LE(z.length - 22), 0x06054b50, "ends with the EOCD record");
  // STORED means the payload is embedded uncompressed — both handlers appear verbatim.
  assert.ok(z.includes(a.data), "alpha payload embedded verbatim");
  assert.ok(z.includes(b.data), "bravo payload embedded verbatim");
  // No deflate: every local header declares method 0 (stored).
  assert.equal(z.readUInt16LE(8), 0, "first entry uses the STORE method");
});

test("dosDateTime is UTC-stable and clamps pre-1980 epochs", () => {
  assert.deepEqual(dosDateTime(0), { time: 0, date: (1 << 5) | 1 }); // 1970 → clamp to 1980-01-01
  // Deterministic for a real epoch, and independent of the host timezone.
  const prev = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  const la = dosDateTime(EPOCH);
  process.env.TZ = "Asia/Tokyo";
  const tokyo = dosDateTime(EPOCH);
  process.env.TZ = prev;
  assert.deepEqual(la, tokyo, "DOS date/time must not depend on the host timezone");
});
