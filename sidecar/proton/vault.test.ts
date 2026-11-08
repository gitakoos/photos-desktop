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

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataKeyCopy, initStore, isReady, storeDir } from "./store";
import {
  convertToDeviceVault,
  createDeviceVault,
  createVault,
  unlockDeviceVault,
  unlockVault,
  vaultExists,
  vaultMode,
  lockVault,
  setVaultMetaKey,
  checkLocalLock,
  checkVaultPassword,
  clearLocalLock,
  localLockKind,
  setLocalLock,
} from "./vault";

// Point the store (and therefore vault.json) at a throwaway temp directory, and
// stand in for the key the Rust host supplies from behind DPAPI.
beforeAll(() => {
  initStore(mkdtempSync(join(tmpdir(), "pfp-vault-")));
  setVaultMetaKey("11".repeat(32));
});

const metaFile = () => join(storeDir(), "vault.json");

describe("vault (scrypt password gate)", () => {
  const pw = "correct horse battery staple";

  it("unlocks with the right password after a lock", () => {
    createVault(pw);
    expect(vaultExists()).toBe(true);
    expect(isReady()).toBe(true);
    lockVault();
    expect(isReady()).toBe(false);
    expect(unlockVault(pw)).toBe(true);
    expect(isReady()).toBe(true);
  });

  it("rejects a wrong password and sets no key", () => {
    lockVault();
    expect(unlockVault("not the password")).toBe(false);
    expect(isReady()).toBe(false);
  });
});

describe("vault metadata at rest", () => {
  const pw = "correct horse battery staple";

  // The salt is what makes a password guess testable offline, so the whole point
  // of sealing is that neither it nor the verifier survives as readable text.
  it("leaves no readable salt or verifier on disk", () => {
    createVault(pw);
    const raw = readFileSync(metaFile());
    expect(() => JSON.parse(raw.toString("utf8"))).toThrow();
    expect(raw.toString("utf8")).not.toContain("salt");
    expect(raw.toString("utf8")).not.toContain("verifier");
  });

  // Reproduces byte for byte what a build before the seal wrote, so an upgrade is
  // tested against the real thing rather than against a guess at it.
  it("opens a vault written before the seal, then seals it in place", () => {
    const salt = randomBytes(16);
    const key = scryptSync(pw, salt, 32, { N: 1 << 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
    const verifier = createHash("sha256").update(key).update("photos-for-proton/vault").digest();
    writeFileSync(
      metaFile(),
      JSON.stringify({ v: 1, salt: salt.toString("base64"), verifier: verifier.toString("base64") }),
    );

    lockVault();
    expect(unlockVault(pw)).toBe(true);
    expect(isReady()).toBe(true);

    // Sealed on the way through, so the readable copy does not outlive the upgrade.
    const after = readFileSync(metaFile());
    expect(() => JSON.parse(after.toString("utf8"))).toThrow();
    lockVault();
    expect(unlockVault(pw)).toBe(true);
  });

  it("treats metadata sealed under another key as no vault at all", () => {
    createVault(pw);
    setVaultMetaKey("33".repeat(32));
    lockVault();
    expect(unlockVault(pw)).toBe(false);
    expect(isReady()).toBe(false);
  });
});

describe("a vault that needs no password", () => {
  it("opens by this Windows account alone, and with no password", () => {
    createDeviceVault();
    expect(vaultMode()).toBe("device");
    lockVault();
    expect(unlockVault("")).toBe(false);
    expect(unlockVault("anything")).toBe(false);
    expect(isReady()).toBe(false);
    expect(unlockDeviceVault()).toBe(true);
    expect(isReady()).toBe(true);
  });

  it("keeps its key sealed on disk", () => {
    createDeviceVault();
    const raw = readFileSync(metaFile());
    expect(() => JSON.parse(raw.toString("utf8"))).toThrow();
    expect(raw.toString("utf8")).not.toContain("device");
  });

  it("does not open under another Windows account's key", () => {
    createDeviceVault();
    lockVault();
    setVaultMetaKey("22".repeat(32));
    try {
      expect(unlockDeviceVault()).toBe(false);
      expect(vaultMode()).toBeNull();
    } finally {
      setVaultMetaKey("11".repeat(32));
    }
  });

  it("is never opened as a password vault, nor a password vault as one", () => {
    createVault("a password of mine");
    expect(vaultMode()).toBe("password");
    lockVault();
    expect(unlockDeviceVault()).toBe(false);
    expect(unlockVault("a password of mine")).toBe(true);
  });
});

describe("a password vault turned into one this account opens", () => {
  it("keeps its key, so everything sealed under it stays readable", () => {
    createVault("the old proton password");
    const before = dataKeyCopy();
    expect(convertToDeviceVault()).toBe(true);
    expect(vaultMode()).toBe("device");
    lockVault();
    expect(unlockVault("the old proton password")).toBe(false);
    expect(unlockDeviceVault()).toBe(true);
    expect(dataKeyCopy()?.equals(before!)).toBe(true);
  });

  it("does nothing to a vault that already needs no password, or with none open", () => {
    createDeviceVault();
    expect(convertToDeviceVault()).toBe(false);
    createVault("a password");
    lockVault();
    expect(convertToDeviceVault()).toBe(false);
    expect(vaultMode()).toBe("password");
  });
});

describe("local lock (Hidden and the app lock without Windows Hello)", () => {
  it("asks for the vault's password while the app has one, and takes no password of its own then", () => {
    createVault("vault password 1");
    expect(localLockKind()).toBe("vault");
    expect(checkVaultPassword("vault password 1")).toBe(true);
    expect(checkLocalLock("vault password 1")).toBe(true);
    expect(checkLocalLock("wrong one!")).toBe(false);
    expect(setLocalLock("another password")).toBe(false);
  });

  it("checks the vault password without opening or closing anything", () => {
    createVault("vault password 2");
    lockVault();
    expect(checkVaultPassword("vault password 2")).toBe(true);
    expect(isReady()).toBe(false);
  });

  it("has a password of its own beside a vault that needs none: set once, changed and taken away only with it", () => {
    createDeviceVault();
    expect(localLockKind()).toBe("none");
    expect(checkLocalLock("")).toBe(false);
    expect(setLocalLock("short")).toBe(false);
    expect(setLocalLock("hidden pass 1")).toBe(true);
    expect(localLockKind()).toBe("own");
    expect(checkLocalLock("hidden pass 1")).toBe(true);
    expect(checkLocalLock("hidden pass 2")).toBe(false);
    expect(setLocalLock("hidden pass 2")).toBe(false);
    expect(setLocalLock("hidden pass 2", "wrong pass")).toBe(false);
    expect(setLocalLock("hidden pass 2", "hidden pass 1")).toBe(true);
    expect(checkLocalLock("hidden pass 2")).toBe(true);
    expect(clearLocalLock("hidden pass 1")).toBe(false);
    expect(clearLocalLock("hidden pass 2")).toBe(true);
    expect(localLockKind()).toBe("none");
  });

  it("keeps the password unreadable on disk", () => {
    createDeviceVault();
    setLocalLock("plain to see?");
    const raw = readFileSync(join(storeDir(), "local-lock.json"));
    expect(raw.toString("utf8")).not.toContain("salt");
    expect(raw.toString("utf8")).not.toContain("plain to see?");
    clearLocalLock("plain to see?");
  });
});
