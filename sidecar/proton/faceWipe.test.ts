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

import { readBackupFlags, writeBackupFlags } from "./backupFlags.ts";
import { installDeviceId } from "./deviceId.ts";
import type { FaceCopy, FaceCopyToWrite } from "./driveData.ts";
import { FaceScanner } from "./faceScan.ts";
import { initStore, setDataKey } from "./store.ts";

const OTHER = "00000000-0000-4000-8000-000000000002";

const copy = (facesWipedAt: number, createdAt = 100): FaceCopy => ({
  deviceId: OTHER,
  deviceLabel: "Pixel",
  createdAt,
  faceModelVersion: 7,
  faceModelSha256: "",
  clusterParamsVersion: 1,
  embeddingDim: 512,
  facesWipedAt,
  faces: [],
  notPerson: [],
  covers: new Map(),
  coverSetAt: new Map(),
  manual: [],
  removals: [],
  namedAt: new Map([["Ann", 50]]),
  nameChanges: [],
  scanned: [],
});

let scanner: FaceScanner;
let saved: FaceCopyToWrite[];

beforeEach(() => {
  initStore(mkdtempSync(join(tmpdir(), "pfp-wipe-")));
  setDataKey(randomBytes(32));
  scanner = new FaceScanner();
  saved = [];
  scanner.setDriveWriter(async (c) => {
    saved.push(c);
    return true;
  });
  // On, and shared through the backup; with no library to read, nothing scans.
  scanner.setEnabled(true, false, false, true, false);
  scanner.store.load();
  scanner.store.people.people.push({ id: "p9", name: "Bob", isOther: false });
  scanner.store.markPeople();
});

const held = () => scanner.store.people;

describe("a delete of the face data everywhere", () => {
  it("turns away a copy written before the newest delete known here, noting it as taken in", () => {
    writeBackupFlags({ knownWipe: 10 });
    scanner.setPhoneCopies([copy(5)]);
    expect(held().namedAt).toEqual({});
    expect(held().applied[OTHER]).toBe(100);
    expect(held().people.map((p) => p.name)).toEqual(["Bob"]);
  });

  it("takes in a copy carrying the delete known here as any other", () => {
    writeBackupFlags({ knownWipe: 10 });
    scanner.setPhoneCopies([copy(10)]);
    expect(held().namedAt).toEqual({ ann: 50 });
    expect(held().people.map((p) => p.name)).toEqual(["Bob"]);
  });

  it("deletes the face data here for a newer one, turns face recognition off, and carries it on", async () => {
    writeBackupFlags({ knownWipe: 10 });
    scanner.setPhoneCopies([copy(20), { ...copy(10), deviceId: "00000000-0000-4000-8000-000000000003" }]);
    expect(held().people).toEqual([]);
    expect(readBackupFlags().knownWipe).toBe(20);
    expect(scanner.getStatus()).toMatchObject({ state: "off", offByWipe: 20 });
    // Off, nothing is taken in yet; the copy that saw the delete is, once it is on again.
    expect(held().namedAt).toEqual({});
    expect(scanner.facesDirty()).toBe(true);
    await scanner.saveFaces();
    expect(saved.map((c) => [c.facesWipedAt, c.faces.length])).toEqual([[20, 0]]);
    expect(scanner.facesDirty()).toBe(false);
    expect(scanner.wipeSaved()).toBe(true);
    // An "on" sent before the window heard of the delete leaves it off.
    expect(scanner.setEnabled(true, false, false, true, false).state).toBe("off");
    scanner.wipeSeen();
    scanner.setEnabled(true, false, false, true, false);
    scanner.setPhoneCopies([copy(20, 200)]);
    expect(held().namedAt).toEqual({ ann: 50 });
  });

  it("has no switch to turn off when face recognition is off already", () => {
    scanner.setEnabled(false, false, false, true, false);
    scanner.setPhoneCopies([copy(20)]);
    expect(held().people).toEqual([]);
    expect(scanner.getStatus().offByWipe).toBeNull();
    expect(readBackupFlags().knownWipe).toBe(20);
  });

  it("leaves the switch on in a new install that holds no face data yet", () => {
    scanner.store.people.people.length = 0;
    scanner.store.markPeople();
    scanner.setPhoneCopies([copy(20)]);
    expect(scanner.getStatus().offByWipe).toBeNull();
    expect((scanner as unknown as { enabled: boolean }).enabled).toBe(true);
    expect(readBackupFlags().knownWipe).toBe(20);
    expect(held().namedAt).toEqual({ ann: 50 });
  });

  it("leaves the switch as it is on the round after a fresh install", () => {
    scanner.setPhoneCopies([copy(20)], true);
    expect(held().people).toEqual([]);
    expect(scanner.getStatus().offByWipe).toBeNull();
    expect(held().namedAt).toEqual({ ann: 50 });
    expect(readBackupFlags().knownWipe).toBe(20);
  });

  it("made here, turns face recognition off and keeps the delete for the next copy and the trash", async () => {
    await scanner.clearEverywhere();
    expect(held().people).toEqual([]);
    expect(scanner.getStatus().state).toBe("off");
    const flags = readBackupFlags();
    expect(flags.knownWipe).toBeGreaterThan(0);
    expect(flags.trashPending).toBe(true);
    expect(scanner.facesDirty()).toBe(true);
    await scanner.saveFaces();
    expect(saved[0].facesWipedAt).toBe(flags.knownWipe);
  });

  it("only here, deletes the face data and reads this install's own copy back", async () => {
    await scanner.clearHere();
    expect(held().people).toEqual([]);
    expect(readBackupFlags()).toMatchObject({ ownTaken: false, knownWipe: 0 });
    held().deviceId = installDeviceId();
    const own = { ...copy(0), deviceId: installDeviceId() };
    scanner.setPhoneCopies([own]);
    expect(held().namedAt).toEqual({});
    scanner.setPhoneCopies([own], true);
    expect(held().namedAt).toEqual({ ann: 50 });
  });
});
