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

// Sign-out deletes the labels, the hidden list and the synced settings on this PC. While one of
// them holds a change that is not on Drive, nothing is deleted unless the user chose to lose it.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@protontech/drive-sdk/dist/protonDrivePhotosClient.js", () => ({ ProtonDrivePhotosClient: class {} }));

import { ProtonSession } from "./session.ts";
import { HIDDEN_FILE, initStore, isReady, writeSealedAtomic } from "./store.ts";
import { createDeviceVault, lockVault, setVaultMetaKey } from "./vault.ts";
import { readSignOutHold, SIGN_OUT_HOLD_FILE, writeSignOutHold } from "./signOutHold.ts";

let dir: string;

beforeEach(() => {
  lockVault();
  dir = mkdtempSync(join(tmpdir(), "pfp-signout-hold-"));
  initStore(dir);
  setVaultMetaKey("33".repeat(32));
  createDeviceVault();
  writeSealedAtomic(join(dir, HIDDEN_FILE), Buffer.from('{"v":1,"photos":{"p1":5}}'));
});

/** A signed-in session whose shared backup reports `unsaved` as not on Drive. */
function sessionWith(unsaved: string[]): any {
  const session = new ProtonSession() as any;
  session.backup = { unsaved: () => unsaved, stop: () => {}, getStatus: () => ({ on: true }) };
  return session;
}

describe("signing out", () => {
  it("deletes nothing while a change is not on Drive, and names what would be lost", () => {
    const session = sessionWith(["hidden", "labels"]);
    expect(session.signOut()).toEqual({ ok: false, unsaved: ["hidden", "labels"] });
    expect(isReady()).toBe(true);
    expect(existsSync(join(dir, HIDDEN_FILE))).toBe(true);
  });

  it("deletes it when the user chose to sign out anyway", () => {
    const session = sessionWith(["hidden"]);
    expect(session.signOut(true)).toEqual({ ok: true });
    expect(isReady()).toBe(false);
    expect(existsSync(join(dir, HIDDEN_FILE))).toBe(false);
  });

  it("deletes it once everything is on Drive", () => {
    const session = sessionWith([]);
    expect(session.signOut()).toEqual({ ok: true });
    expect(existsSync(join(dir, HIDDEN_FILE))).toBe(false);
  });

  it("has nothing to save before a sign-out while locked", async () => {
    lockVault();
    const session = sessionWith(["labels"]);
    expect(await session.signOutSave(1000, true)).toEqual({ done: true, unsaved: [] });
  });

  it("records at a lock what is not on Drive, and a sign-out from the lock screen asks first", () => {
    const session = sessionWith(["labels", "hidden"]);
    session.lock();
    expect(isReady()).toBe(false);
    expect(readSignOutHold()).toEqual(["labels", "hidden"]);
    expect(session.signOut()).toEqual({ ok: false, unsaved: ["labels", "hidden"] });
    // The sealed files stay for an unlock, which saves them.
    expect(existsSync(join(dir, HIDDEN_FILE))).toBe(true);
  });

  it("deletes everything, the record too, when the user signs out anyway from the lock screen", () => {
    lockVault();
    writeSignOutHold(["settings"]);
    const session = sessionWith([]);
    expect(session.signOut(true)).toEqual({ ok: true });
    expect(existsSync(join(dir, HIDDEN_FILE))).toBe(false);
    expect(existsSync(join(dir, SIGN_OUT_HOLD_FILE))).toBe(false);
  });

  it("signs out from the lock screen at once when everything had reached Drive", () => {
    const session = sessionWith([]);
    session.lock();
    expect(existsSync(join(dir, SIGN_OUT_HOLD_FILE))).toBe(false);
    expect(session.signOut()).toEqual({ ok: true });
    expect(existsSync(join(dir, HIDDEN_FILE))).toBe(false);
  });
});
