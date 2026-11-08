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

// This install's id among the account's devices: one for every kind of copy it saves to Drive,
// so the phone sees the faces, the labels and the search index as coming from one computer. Made
// from Windows' own id for the PC, so a reinstall, or a sign-in after a sign-out, writes on in
// the files an earlier install saved instead of leaving a second set behind.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { markFreshInstall } from "./backupFlags.ts";
import {
  DEVICE_ID_FILE,
  FACES_DIR,
  PEOPLE_FILE,
  readSealedOrDiscard,
  storeDir,
  unseal,
  writeSealedAtomic,
} from "./store.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function read(): string | null {
  const raw = readSealedOrDiscard(join(storeDir(), DEVICE_ID_FILE))?.toString("utf8").trim() ?? "";
  return UUID.test(raw) ? raw : null;
}

/**
 * The id a face copy saved before this file existed was written under, read without changing
 * anything: a file that will not open is left for the face store to deal with.
 */
function faceCopyId(): string | null {
  try {
    const path = join(storeDir(), FACES_DIR, PEOPLE_FILE);
    if (!existsSync(path)) return null;
    const id = JSON.parse(unseal(readFileSync(path)).toString("utf8"))?.deviceId;
    return typeof id === "string" && UUID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** A name-based UUID of `text`, as Java's `UUID.nameUUIDFromBytes` makes one (version 3). */
export function nameUuid(text: string): string {
  const b = createHash("md5").update(text, "utf8").digest();
  b[6] = (b[6] & 0x0f) | 0x30;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The id this PC's installs take, from the MachineGuid the app hands over; null without one. */
export function machineDeviceId(guid = process.env.PFP_MACHINE_ID): string | null {
  const value = (guid ?? "").trim().toLowerCase();
  if (!UUID.test(value)) return null;
  return nameUuid(`photos-for-proton/drive-data/windows/${value}`);
}

/** The id, made the first time it is asked for. Read from the store each time, so a wiped store
 *  (a sign-out) makes it again; from the PC's own id that is the same one, else a new one. */
export function installDeviceId(): string {
  let id = read();
  if (!id) {
    const earlier = faceCopyId();
    id = earlier ?? machineDeviceId() ?? randomUUID().toLowerCase();
    writeSealedAtomic(join(storeDir(), DEVICE_ID_FILE), Buffer.from(id, "utf8"));
    // What Drive holds under this id was saved by an earlier install: read back once.
    if (!earlier) markFreshInstall();
  }
  return id;
}

/** Keeps `id` as the install's when it has none yet: the face copy saved before this file was. */
export function adoptDeviceId(id: string): void {
  if (!UUID.test(id) || read()) return;
  writeSealedAtomic(join(storeDir(), DEVICE_ID_FILE), Buffer.from(id, "utf8"));
}
