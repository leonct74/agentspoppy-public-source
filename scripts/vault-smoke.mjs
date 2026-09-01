#!/usr/bin/env node
// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0
//
// The REAL vault round trip, with a throwaway item — run in each platform's CI build
// (docs/specs/operator-key-custody.md). Unit tests pin the logic with injected vaults;
// this is the one check that the actual OS mechanism answers: store → verified read →
// remove → confirmed gone. Exits non-zero on any failure, so the build goes red.
//
// Linux runners need an unlocked keyring COLLECTION, not just an unlocked daemon — a
// fresh headless machine has none, and creating one prompts via a GUI that isn't there.
// Seed a plaintext lockless default keyring in ~/.local/share/keyrings, then run under
// dbus-run-session with `gnome-keyring-daemon --start --components=secrets` (see
// .github/workflows/linux-build.yml for the exact recipe).
import { vaultAvailable, vaultName, vaultRead, vaultRemove, vaultStore } from "../packages/broker/src/aws/vault.ts";

const KEY = "TESTVAULTSMOKE000000";
const SECRET = "ciSmokeSecret123/+=" + Math.floor(Date.now() / 1000);

console.log(`vault-smoke: ${vaultName()} — available=${vaultAvailable()}`);
if (!vaultAvailable()) {
  console.error("vault-smoke: FAIL — vault unavailable on this runner");
  process.exit(1);
}
if (!vaultStore(KEY, SECRET)) {
  console.error("vault-smoke: FAIL — store (with verified readback) failed");
  process.exit(1);
}
const back = vaultRead(KEY);
if (back !== SECRET) {
  vaultRemove(KEY);
  console.error("vault-smoke: FAIL — readback mismatch");
  process.exit(1);
}
if (!vaultRemove(KEY)) {
  console.error("vault-smoke: FAIL — remove failed");
  process.exit(1);
}
if (vaultRead(KEY) !== null) {
  console.error("vault-smoke: FAIL — item still present after remove");
  process.exit(1);
}
console.log("vault-smoke: PASS — store, verified read, remove, confirmed gone");
