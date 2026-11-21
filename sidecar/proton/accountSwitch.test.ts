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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accountMatch, recordAccountKeys, recordedAccountKeys } from "./accountSwitch.ts";
import { clearDataKey, initStore, setDataKey, StoreLockedError, wipeCache } from "./store.ts";

describe("accountMatch", () => {
  it("knows the account again by a user key it unlocked before", () => {
    expect(accountMatch(["k1", "k2"], ["k2"])).toBe("same");
    expect(accountMatch(["k1"], ["k1", "k3"])).toBe("same");
  });

  it("takes keys that share nothing for another account", () => {
    expect(accountMatch(["k1", "k2"], ["k3"])).toBe("different");
  });

  // An empty side used to count as another account, which deleted the vault of the same account
  // signing in again after its saved session was lost.
  it("takes an empty side for unknown, never for another account", () => {
    expect(accountMatch([], ["k1"])).toBe("unknown");
    expect(accountMatch(["k1"], [])).toBe("unknown");
  });
});

describe("the account record", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pfp-account-"));
    initStore(dir);
    setDataKey(randomBytes(32));
  });
  afterEach(() => {
    clearDataKey();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the key ids for a sign-in after the session file was lost", () => {
    expect(recordedAccountKeys()).toEqual([]);
    recordAccountKeys(["k2", "k1"]);
    expect(recordedAccountKeys()).toEqual(["k1", "k2"]);
    expect(accountMatch(recordedAccountKeys(), ["k1"])).toBe("same");
  });

  it("goes at sign-out with the rest of the account", () => {
    recordAccountKeys(["k1"]);
    wipeCache();
    expect(recordedAccountKeys()).toEqual([]);
  });

  it("is not read while the store is locked", () => {
    recordAccountKeys(["k1"]);
    clearDataKey();
    expect(() => recordedAccountKeys()).toThrow(StoreLockedError);
  });
});
