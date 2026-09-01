// Copyright 2026 Marco Tomasello (AgentsPoppy)
// SPDX-License-Identifier: LicenseRef-PolyForm-Perimeter-1.0.0

/**
 * The OS secret vault, per platform (docs/specs/operator-key-custody.md):
 * macOS Keychain · Windows Credential Manager · Linux Secret Service.
 *
 * One dispatcher so custody code (credentials.ts) is platform-blind. Every
 * implementation verifies its own readback inside store() — the migration's
 * verify-before-strip rule is only as strong as that — and every one is
 * best-effort and non-throwing: a vault failure means "file custody stays",
 * never a broken broker.
 */
import { platform } from "node:os";
import { keychainAvailable, keychainRead, keychainRemove, keychainStore } from "./keychain";
import { wincredAvailable, wincredRead, wincredRemove, wincredStore } from "./wincred";
import { libsecretAvailable, libsecretRead, libsecretRemove, libsecretStore } from "./libsecret";

export interface VaultImpl {
  /** The user-facing name — "macOS Keychain", "Windows Credential Manager", "system keyring". */
  name: string;
  available(): boolean;
  /** Store + verified readback. False on any failure or mismatch. */
  store(keyId: string, secret: string): boolean;
  read(keyId: string): string | null;
  remove(keyId: string): boolean;
}

const DARWIN: VaultImpl = {
  name: "macOS Keychain",
  available: keychainAvailable,
  store: keychainStore,
  read: keychainRead,
  remove: keychainRemove,
};
const WINDOWS: VaultImpl = {
  name: "Windows Credential Manager",
  available: wincredAvailable,
  store: wincredStore,
  read: wincredRead,
  remove: wincredRemove,
};
const LINUX: VaultImpl = {
  name: "system keyring",
  available: libsecretAvailable,
  store: libsecretStore,
  read: libsecretRead,
  remove: libsecretRemove,
};

function platformVault(): VaultImpl | null {
  switch (platform()) {
    case "darwin":
      return DARWIN;
    case "win32":
      return WINDOWS;
    case "linux":
      return LINUX;
    default:
      return null;
  }
}

let override: VaultImpl | null = null;
/** Test seam — custody tests run on every platform against an injected vault. */
export function setVaultForTests(impl: VaultImpl | null): void {
  override = impl;
}

const active = (): VaultImpl | null => override ?? platformVault();

export function vaultName(): string {
  return active()?.name ?? "OS keyring";
}
export function vaultAvailable(): boolean {
  return active()?.available() ?? false;
}
export function vaultStore(keyId: string, secret: string): boolean {
  const v = active();
  return v ? v.available() && v.store(keyId, secret) : false;
}
export function vaultRead(keyId: string): string | null {
  const v = active();
  return v && v.available() ? v.read(keyId) : null;
}
export function vaultRemove(keyId: string): boolean {
  const v = active();
  return v ? v.available() && v.remove(keyId) : false;
}
