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

// What the shared backup keeps of its own on this computer between rounds, apart from the
// copies' fingerprints: the newest "delete face data everywhere" it knows of, whether the
// other devices' face copies still wait to go to the Drive trash after one made here, whether
// this install's own files on Drive were read back after a fresh install or a sign-out, and the
// names the devices saved under. Sealed in the store, and gone with it on a sign-out.

import { join } from "node:path";

import { BACKUP_FLAGS_FILE, readSealedOrDiscard, storeDir, writeSealedAtomic } from "./store.ts";

export type BackupFlags = {
  /** The newest delete of the face data on every device this computer knows of, epoch ms, 0 for none. */
  knownWipe: number;
  /** A delete everywhere made here whose trashing of the other devices' face copies has not gone through. */
  trashPending: boolean;
  /** Whether this install's own files on Drive count as its own, not to be read back. */
  ownTaken: boolean;
  /** Each device's name as its copies carry it, by device id. */
  names: Record<string, string>;
};

/**
 * An install from before this file existed is not a fresh one: its own files on Drive are its own.
 * A fresh install says otherwise as it makes its id (`markFreshInstall`).
 */
const ABSENT: BackupFlags = { knownWipe: 0, trashPending: false, ownTaken: true, names: {} };

function path(): string {
  return join(storeDir(), BACKUP_FLAGS_FILE);
}

export function readBackupFlags(): BackupFlags {
  try {
    const raw = readSealedOrDiscard(path());
    if (!raw) return { ...ABSENT, names: {} };
    const parsed = JSON.parse(raw.toString("utf8")) as Partial<BackupFlags>;
    return {
      knownWipe: typeof parsed.knownWipe === "number" && parsed.knownWipe > 0 ? parsed.knownWipe : 0,
      trashPending: parsed.trashPending === true,
      ownTaken: parsed.ownTaken !== false,
      names: parsed.names && typeof parsed.names === "object" ? { ...parsed.names } : {},
    };
  } catch {
    return { ...ABSENT, names: {} };
  }
}

/** Changes what is given and keeps the rest; answers the flags as they are now. */
export function writeBackupFlags(change: Partial<BackupFlags>): BackupFlags {
  const next = { ...readBackupFlags(), ...change };
  writeSealedAtomic(path(), Buffer.from(JSON.stringify(next), "utf8"));
  return next;
}

/** A new install, or the first one after a sign-out: what Drive holds under its id is read back once. */
export function markFreshInstall(): void {
  writeBackupFlags({ ownTaken: false });
}

/** Keeps the names `seen` carries (device id to name), answering whether any was new. */
export function keepDeviceNames(seen: Iterable<[string, string]>): boolean {
  const flags = readBackupFlags();
  let changed = false;
  for (const [id, name] of seen) {
    const clean = name.trim().slice(0, 80);
    if (!id || !clean || flags.names[id] === clean) continue;
    flags.names[id] = clean;
    changed = true;
  }
  if (changed) writeBackupFlags({ names: flags.names });
  return changed;
}
