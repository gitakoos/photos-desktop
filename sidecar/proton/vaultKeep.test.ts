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

/* eslint-disable @typescript-eslint/no-explicit-any */

// A sign-in again must never delete what the vault on this PC holds for the same account: not
// when the saved session was lost, and not when the vault could not be opened at all.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@protontech/drive-sdk/dist/protonDrivePhotosClient.js", () => ({ ProtonDrivePhotosClient: class {} }));

import { recordAccountKeys } from "./accountSwitch.ts";
import { ProtonSession } from "./session.ts";
import {
  HIDDEN_FILE,
  SET_ASIDE_PREFIX,
  StoreLockedError,
  initStore,
  isReady,
  readSealedOrSetAside,
  unseal,
  writeSealedAtomic,
} from "./store.ts";
import { createDeviceVault, createVault, lockVault, setVaultMetaKey, vaultMode } from "./vault.ts";

let dir: string;

beforeEach(() => {
  lockVault();
  dir = mkdtempSync(join(tmpdir(), "pfp-vault-keep-"));
  initStore(dir);
  setVaultMetaKey("22".repeat(32));
});

/** A vault of the account with key `k1`, holding a hidden list, locked as at a cold start. */
function vaultWithHiddenList(kind: "device" | "password", keyIds = ["k1"]): void {
  if (kind === "device") createDeviceVault();
  else createVault("the old app password");
  recordAccountKeys(keyIds);
  writeSealedAtomic(join(dir, HIDDEN_FILE), Buffer.from('{"v":1,"photos":{"p1":5}}'));
  lockVault();
}

/** A browser sign-in that finished and waits for its protection to be chosen. */
function awaitingProtection(keyIds: string[]): any {
  const session = new ProtonSession() as any;
  session.awaitingProtection = true;
  session.photos = {};
  session.userKeyPassphrases = Object.fromEntries(keyIds.map((k) => [k, "pass"]));
  session.persistSession = () => {};
  session.attachFaceScan = () => {};
  return session;
}

describe("a vault that opens with no saved session", () => {
  it("stays open for the account to sign in again, its hidden list intact", async () => {
    vaultWithHiddenList("device");
    const session = new ProtonSession() as any;

    expect(await session.unlockDevice()).toEqual({ status: "relogin" });

    expect(isReady()).toBe(true);
    expect(session.reloginKeys).toEqual(["k1"]);
    expect(readSealedOrSetAside(join(dir, HIDDEN_FILE))?.toString()).toContain("p1");
  });
});

describe("protecting a browser sign-in where a vault already is", () => {
  it("keeps the vault of the same account when it opens with what was chosen", () => {
    vaultWithHiddenList("device");
    const session = awaitingProtection(["k1", "k2"]);

    expect(session.protectSession(null).status).toBe("ok");

    expect(isReady()).toBe(true);
    expect(readSealedOrSetAside(join(dir, HIDDEN_FILE))?.toString()).toContain("p1");
  });

  it("keeps it when nothing says which account it was", () => {
    vaultWithHiddenList("password", []);
    const session = awaitingProtection(["k1"]);

    expect(session.protectSession("the old app password").status).toBe("ok");

    expect(vaultMode()).toBe("password");
    expect(readSealedOrSetAside(join(dir, HIDDEN_FILE))?.toString()).toContain("p1");
  });

  it("deletes it only for another account", () => {
    vaultWithHiddenList("device", ["k9"]);
    const session = awaitingProtection(["k1"]);

    expect(session.protectSession(null).status).toBe("ok");

    expect(existsSync(join(dir, HIDDEN_FILE))).toBe(false);
    expect(readdirSync(dir).filter((n) => n.startsWith(SET_ASIDE_PREFIX))).toEqual([]);
  });

  it("sets aside a vault that does not open, never deleting it", () => {
    vaultWithHiddenList("password");
    const session = awaitingProtection(["k1"]);

    // No password asked this time: the old vault cannot be opened, and a new one starts.
    expect(session.protectSession(null).status).toBe("ok");

    expect(vaultMode()).toBe("device");
    expect(existsSync(join(dir, HIDDEN_FILE))).toBe(false);
    const aside = readdirSync(dir).filter((n) => n.startsWith(SET_ASIDE_PREFIX));
    expect(aside).toHaveLength(1);
    expect(existsSync(join(dir, aside[0], "vault.json"))).toBe(true);
    expect(readFileSync(join(dir, aside[0], HIDDEN_FILE)).length).toBeGreaterThan(0);
    expect(() => unseal(readFileSync(join(dir, aside[0], HIDDEN_FILE)))).toThrow();
  });
});

describe("the hidden list while locked", () => {
  it("answers locked, never an empty list", () => {
    vaultWithHiddenList("device");
    const session = new ProtonSession() as any;
    expect(() => session.hiddenState()).toThrow(StoreLockedError);
    expect(() => session.mountHidden()).toThrow(StoreLockedError);
    expect(existsSync(join(dir, HIDDEN_FILE))).toBe(true);
  });
});
