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

// Every sealed store read while the app is locked answers "locked", keeps its file, and reads it
// whole after the unlock; nothing read while locked is kept as if it were what the file holds.

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { readBackupFlags, writeBackupFlags } from "./backupFlags.ts";
import { compressedUploadOf, forgetCompressedUploads, rememberCompressedUpload } from "./compressedUploads.ts";
import { DuplicateFinder } from "./duplicates.ts";
import { LabelStore, setLabels } from "./labelStore.ts";
import { isPinned, resetOfflineState } from "./offline.ts";
import {
  BACKUP_FLAGS_FILE,
  COMPRESSED_UPLOADS_FILE,
  DUPLICATES_FILE,
  LABELS_DIR,
  OFFLINE_LIST_FILE,
  StoreLockedError,
  clearDataKey,
  initStore,
  setDataKey,
  storeDir,
  writeSealedAtomic,
} from "./store.ts";

let key: Buffer;

beforeEach(() => {
  initStore(mkdtempSync(join(tmpdir(), "pfp-locked-")));
  key = randomBytes(32);
  setDataKey(Buffer.from(key));
});

const unlock = () => setDataKey(Buffer.from(key));
const bytes = (path: string) => readFileSync(path);

describe("sealed stores across a lock", () => {
  it("labels", () => {
    const store = new LabelStore();
    store.change((s) => setLabels(s, "p1", ["beach"], 5), (c) => c);
    const path = join(storeDir(), LABELS_DIR, "labels.enc");
    const sealed = bytes(path);
    store.unload();
    clearDataKey();
    expect(() => store.get()).toThrow(StoreLockedError);
    expect(() => store.change((s) => setLabels(s, "p2", ["x"], 6), (c) => c)).toThrow(StoreLockedError);
    expect(bytes(path).equals(sealed)).toBe(true);
    unlock();
    expect(store.get().photos.p1?.l).toEqual(["beach"]);
  });

  it("the duplicate finder's groups left alone", () => {
    const first = new DuplicateFinder(async () => null);
    first.ignore(["a", "b"]);
    const path = join(storeDir(), DUPLICATES_FILE);
    const sealed = bytes(path);
    const second = new DuplicateFinder(async () => null);
    clearDataKey();
    expect(() => second.ignore(["c", "d"])).toThrow(StoreLockedError);
    expect(bytes(path).equals(sealed)).toBe(true);
    unlock();
    second.ignore(["c", "d"]);
    const third = new DuplicateFinder(async () => null);
    third.ignore(["a", "b"]);
    expect(JSON.parse(JSON.stringify((third as any).ignored)).length).toBe(2);
  });

  it("the lighter copies uploaded from here", () => {
    forgetCompressedUploads();
    rememberCompressedUpload("sha-1", "vol~u1");
    const path = join(storeDir(), COMPRESSED_UPLOADS_FILE);
    const sealed = bytes(path);
    forgetCompressedUploads();
    clearDataKey();
    expect(() => compressedUploadOf("sha-1")).toThrow(StoreLockedError);
    rememberCompressedUpload("sha-2", "vol~u2");
    expect(bytes(path).equals(sealed)).toBe(true);
    unlock();
    expect(compressedUploadOf("sha-1")).toBe("vol~u1");
  });

  it("the shared backup's own flags", () => {
    writeBackupFlags({ knownWipe: 42 });
    const path = join(storeDir(), BACKUP_FLAGS_FILE);
    const sealed = bytes(path);
    clearDataKey();
    expect(() => readBackupFlags()).toThrow(StoreLockedError);
    expect(bytes(path).equals(sealed)).toBe(true);
    unlock();
    expect(readBackupFlags().knownWipe).toBe(42);
  });

  it("the photos kept offline", () => {
    const path = join(storeDir(), OFFLINE_LIST_FILE);
    writeSealedAtomic(path, Buffer.from(JSON.stringify({ uids: ["vol~k1"] })));
    resetOfflineState();
    clearDataKey();
    expect(isPinned("vol~k1")).toBe(false);
    expect(existsSync(path)).toBe(true);
    unlock();
    expect(isPinned("vol~k1")).toBe(true);
  });
});
