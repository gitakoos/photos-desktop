/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * Source:  https://github.com/gitakoos/photos-desktop
 * Website: https://www.photosforproton.eu
 *
 * This file is part of Photos for Proton.
 *
 * Photos for Proton is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

// Password-derived vault key.
//
// The local data key is derived from the user's Proton password with scrypt, so
// the encrypted cache and the stored session cannot be opened without it. This
// replaces the Windows DPAPI seal: it is stronger (knowledge-gated, not merely
// scoped to the OS account) and cross-platform (no Windows-only API), matching
// how Proton itself derives keys from the mailbox password.
//
// Design: dataKey = scrypt(password, salt). A password change (rare) yields a
// different key; the old cache/session become unreadable and are recreated on
// the next sign-in. The meta file stores only the salt and a hash of the key as
// a verifier, which reveals nothing about the key itself.
//
// A sign-in through the browser never shows this app the Proton password. The user
// then picks either a password of their own for the vault, which works exactly as
// above, or none: the key is then random and kept in the meta file, sealed under the
// host's DPAPI key, so the Windows account is what guards it, as it does for
// Proton's own desktop apps.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { clearDataKey, setDataKey, storeDir, wipeCache } from "./store";

// ~64 MiB of work per derivation: strong for an interactive unlock, still snappy.
const SCRYPT: import("node:crypto").ScryptOptions = {
  N: 1 << 16,
  r: 8,
  p: 1,
  maxmem: 128 * 1024 * 1024,
};
const KEY_LEN = 32;
const SALT_LEN = 16;
const META_FILE = "vault.json";

type PasswordMeta = { v: 1; salt: string; verifier: string };
type DeviceMeta = { v: 1; mode: "device"; key: string };
type VaultMeta = PasswordMeta | DeviceMeta;

/** How the vault is opened: with a password, or by this Windows account alone. */
export type VaultMode = "password" | "device";

const META_NONCE_LEN = 12;

/**
 * Seals the meta file. Supplied by the Rust host at startup, which keeps it under
 * DPAPI, so it never sits next to what it protects.
 *
 * Why the meta file needs sealing at all: the salt is what turns a password guess
 * into a key, so anyone holding it can attack the password offline, at whatever
 * rate their hardware allows and with no server to stop them. That password is the
 * Proton account password, not a local one, so the cache is the least of what a
 * success costs. Without the salt there is nothing to guess against.
 */
let metaKey: Buffer | null = null;

export function setVaultMetaKey(hex: string): void {
  const raw = Buffer.from(hex, "hex");
  if (raw.length !== 32) throw new Error("vault meta key must be 32 bytes");
  metaKey = raw;
}

function metaPath(): string {
  return join(storeDir(), META_FILE);
}

export function vaultExists(): boolean {
  return existsSync(metaPath());
}

function sealMeta(meta: VaultMeta): Buffer {
  if (!metaKey) throw new Error("vault meta key not set");
  const nonce = randomBytes(META_NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", metaKey, nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(meta), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

/**
 * Reads the meta file, accepting the plaintext JSON that builds before this seal
 * wrote. Returning null covers both a torn file and one sealed under a key this
 * Windows account cannot unseal: the caller then treats the vault as absent and
 * starts a clean one, which is the same recovery an unreadable cache already gets.
 */
function readMeta(): { meta: VaultMeta; sealed: boolean } | null {
  let blob: Buffer;
  try {
    blob = readFileSync(metaPath());
  } catch {
    return null;
  }
  try {
    const meta = JSON.parse(blob.toString("utf8")) as PasswordMeta;
    if (meta?.salt && meta?.verifier) return { meta, sealed: false };
  } catch {
    // Not the legacy form, so it is sealed. Fall through.
  }
  if (!metaKey || blob.length <= META_NONCE_LEN + 16) return null;
  try {
    const nonce = blob.subarray(0, META_NONCE_LEN);
    const tag = blob.subarray(blob.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", metaKey, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([
      decipher.update(blob.subarray(META_NONCE_LEN, blob.length - 16)),
      decipher.final(),
    ]);
    return { meta: JSON.parse(plain.toString("utf8")) as VaultMeta, sealed: true };
  } catch {
    return null;
  }
}

function derive(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LEN, SCRYPT);
}

// A preimage-resistant tag over the key: lets us check a password without ever
// storing the key or anything that could reconstruct it.
function verifierFor(key: Buffer): Buffer {
  return createHash("sha256").update(key).update("photos-for-proton/vault").digest();
}

/** Start a fresh vault for this password (first sign-in, or after a password change). */
export function createVault(password: string): void {
  const salt = randomBytes(SALT_LEN);
  const key = derive(password, salt);
  const meta: VaultMeta = {
    v: 1,
    salt: salt.toString("base64"),
    verifier: verifierFor(key).toString("base64"),
  };
  writeFileSync(metaPath(), sealMeta(meta));
  setDataKey(key);
}

/**
 * Start a fresh vault that needs no password: a random key, kept in the meta file,
 * which only this Windows account can unseal.
 */
export function createDeviceVault(): void {
  const key = randomBytes(KEY_LEN);
  const meta: DeviceMeta = { v: 1, mode: "device", key: key.toString("base64") };
  writeFileSync(metaPath(), sealMeta(meta));
  setDataKey(key);
}

/** Which kind of vault this is, or null when there is none that opens here. */
export function vaultMode(): VaultMode | null {
  const stored = readMeta();
  if (!stored) return null;
  return "mode" in stored.meta && stored.meta.mode === "device" ? "device" : "password";
}

/** Open a vault that needs no password. False when this one does, or there is none. */
export function unlockDeviceVault(): boolean {
  const stored = readMeta();
  if (!stored || !("mode" in stored.meta) || stored.meta.mode !== "device") return false;
  const key = Buffer.from(stored.meta.key, "base64");
  if (key.length !== KEY_LEN) return false;
  setDataKey(key);
  return true;
}

/** Unlock an existing vault. Returns false (without touching the key) on a wrong password. */
export function unlockVault(password: string): boolean {
  const stored = readMeta();
  if (!stored || !("salt" in stored.meta)) return false;
  const key = derive(password, Buffer.from(stored.meta.salt, "base64"));
  const got = verifierFor(key);
  const want = Buffer.from(stored.meta.verifier, "base64");
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    key.fill(0);
    return false;
  }
  // The password just proved this meta belongs to this vault, so a file left
  // readable by an older build can be sealed now. Here rather than at startup, so
  // the rewrite happens once instead of on every launch, and a failure to write
  // does not cost the user an unlock that otherwise succeeded.
  if (!stored.sealed) {
    try {
      writeFileSync(metaPath(), sealMeta(stored.meta));
    } catch {
      /* still readable, but the session continues */
    }
  }
  setDataKey(key);
  return true;
}

/**
 * Sign-in path (the Proton password was just validated by SRP). Unlock the
 * existing vault if the password still matches; otherwise the password changed,
 * so drop the now-unreadable cache and start a clean vault.
 */
export function openOrResetVault(password: string): void {
  if (unlockVault(password)) return;
  wipeCache();
  createVault(password);
}

/** Forget the in-memory key (sign-out, or tray lock when "always ask" is on). */
export function lockVault(): void {
  clearDataKey();
}
