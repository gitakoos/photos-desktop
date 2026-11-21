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

import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  keepSeenRevisions,
  markFreshInstall,
  newerThanSeen,
  readBackupFlags,
  settingsReadBackDone,
  writeBackupFlags,
} from "./backupFlags.ts";
import { BACKUP_FLAGS_FILE, initStore, setDataKey, storeDir, writeSealedAtomic } from "./store.ts";

beforeEach(() => {
  initStore(mkdtempSync(join(tmpdir(), "pfp-flags-")));
  setDataKey(randomBytes(32));
});

describe("the settings read-back flag", () => {
  it("counts as taken with no flags file, and in a file from before it existed", () => {
    expect(readBackupFlags().settingsOwnTaken).toBe(true);
    writeSealedAtomic(join(storeDir(), BACKUP_FLAGS_FILE), Buffer.from(JSON.stringify({ knownWipe: 0, ownTaken: false }), "utf8"));
    expect(readBackupFlags()).toMatchObject({ ownTaken: false, settingsOwnTaken: true });
  });

  it("is opened with the other one by a fresh install, and closed on its own", () => {
    expect(readBackupFlags().albumOrderOwnTaken).toBe(true);
    markFreshInstall();
    expect(readBackupFlags()).toMatchObject({ ownTaken: false, settingsOwnTaken: false, albumOrderOwnTaken: false });
    writeBackupFlags({ ownTaken: true });
    expect(readBackupFlags()).toMatchObject({ ownTaken: true, settingsOwnTaken: false });
  });

  it("is closed only by a round that asked, put the settings together and read every copy", () => {
    expect(settingsReadBackDone(true, true, 0)).toBe(true);
    // Not seeded yet, or the backup off: the settings were not taken in.
    expect(settingsReadBackDone(true, false, 0)).toBe(false);
    expect(settingsReadBackDone(true, true, 1)).toBe(false);
    expect(settingsReadBackDone(false, true, 0)).toBe(false);
  });
});

describe("the revisions of the other devices' copies last read", () => {
  it("tell a copy saved since, or never read, from one taken in", () => {
    expect(readBackupFlags().seen).toEqual({});
    expect(newerThanSeen([{ uid: "a", revision: "r1:1" }])).toBe(1);
    expect(keepSeenRevisions([["a", "r1:1"], ["b", "r1:2"]])).toBe(true);
    expect(newerThanSeen([{ uid: "a", revision: "r1:1" }, { uid: "b", revision: "r1:2" }])).toBe(0);
    expect(newerThanSeen([{ uid: "a", revision: "r2:5" }, { uid: "b", revision: "r1:2" }])).toBe(1);
    // The same again writes nothing; a copy no longer listed is forgotten.
    expect(keepSeenRevisions([["a", "r1:1"]])).toBe(false);
    expect(keepSeenRevisions([], new Set(["a"]))).toBe(true);
    expect(readBackupFlags().seen).toEqual({ a: "r1:1" });
    // Kept with the other flags, which leave them alone.
    writeBackupFlags({ ownTaken: false });
    expect(readBackupFlags().seen).toEqual({ a: "r1:1" });
  });
});
