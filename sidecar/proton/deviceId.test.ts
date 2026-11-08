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
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { readBackupFlags } from "./backupFlags.ts";
import { adoptDeviceId, installDeviceId, machineDeviceId, nameUuid } from "./deviceId.ts";
import { FACES_DIR, PEOPLE_FILE, initStore, setDataKey, wipeCache, writeSealedAtomic } from "./store.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pfp-device-"));
  initStore(dir);
  setDataKey(randomBytes(32));
});

const FACE_ID = "0a0b0c0d-0e0f-4a1b-8c2d-3e4f5a6b7c8d";

describe("the install's id", () => {
  it("is made once and kept", () => {
    const id = installDeviceId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(installDeviceId()).toBe(id);
  });

  it("is the id the face copy was saved under, when there is one", () => {
    mkdirSync(join(dir, FACES_DIR), { recursive: true });
    writeSealedAtomic(join(dir, FACES_DIR, PEOPLE_FILE), Buffer.from(JSON.stringify({ deviceId: FACE_ID })));
    expect(installDeviceId()).toBe(FACE_ID);
  });

  it("takes the face copy's id only while it has none", () => {
    adoptDeviceId(FACE_ID);
    expect(installDeviceId()).toBe(FACE_ID);
    adoptDeviceId("1a1b1c1d-1e1f-4a1b-8c2d-3e4f5a6b7c8d");
    expect(installDeviceId()).toBe(FACE_ID);
  });

  it("is a new one after a sign-out wiped the store, on a PC without an id of its own", () => {
    delete process.env.PFP_MACHINE_ID;
    const before = installDeviceId();
    wipeCache();
    expect(installDeviceId()).not.toBe(before);
  });

  it("is made from the PC's own id, the same after a sign-out, and read back once as fresh", () => {
    process.env.PFP_MACHINE_ID = "5F2A9C3E-1B7D-4E60-9A8B-0C1D2E3F4A5B";
    try {
      const id = installDeviceId();
      expect(id).toBe(machineDeviceId("5f2a9c3e-1b7d-4e60-9a8b-0c1d2e3f4a5b"));
      expect(readBackupFlags().ownTaken).toBe(false);
      wipeCache();
      expect(installDeviceId()).toBe(id);
    } finally {
      delete process.env.PFP_MACHINE_ID;
    }
  });

  it("counts an install from before the flags were kept as one whose files are its own", () => {
    adoptDeviceId(FACE_ID);
    expect(installDeviceId()).toBe(FACE_ID);
    expect(readBackupFlags().ownTaken).toBe(true);
  });

  it("makes a name-based id the way Java's nameUUIDFromBytes does", () => {
    // UUID.nameUUIDFromBytes("hello".toByteArray()), as the JVM gives it.
    expect(nameUuid("hello")).toBe("5d41402a-bc4b-3a76-b971-9d911017c592");
    expect(machineDeviceId("not a guid")).toBeNull();
  });
});
