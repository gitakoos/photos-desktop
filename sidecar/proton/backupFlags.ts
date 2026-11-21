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
// this install's own files on Drive were read back after a fresh install or a sign-out, the
// names the devices saved under, and the revision of each other device's copy last read.
// Sealed in the store, and gone with it on a sign-out.

import { join } from "node:path";

import { BACKUP_FLAGS_FILE, readSealedOrSetAside, rethrowLocked, storeDir, writeSealedAtomic } from "./store.ts";

export type BackupFlags = {
  /** The newest delete of the face data on every device this computer knows of, epoch ms, 0 for none. */
  knownWipe: number;
  /** A delete everywhere made here whose trashing of the other devices' face copies has not gone through. */
  trashPending: boolean;
  /** Whether this install's own files on Drive count as its own, not to be read back. */
  ownTaken: boolean;
  /** The same for this install's own settings copy, which is read only while the shared backup is on. */
  settingsOwnTaken: boolean;
  /** The same for this install's own album-order copy, which also travels only while the shared backup is on. */
  albumOrderOwnTaken: boolean;
  /** Each device's name as its copies carry it, by device id. */
  names: Record<string, string>;
  /** The revision of each other device's copy this computer last read, by uid. */
  seen: Record<string, string>;
};

/**
 * An install from before this file existed is not a fresh one: its own files on Drive are its own.
 * A fresh install says otherwise as it makes its id (`markFreshInstall`).
 */
const ABSENT: BackupFlags = { knownWipe: 0, trashPending: false, ownTaken: true, settingsOwnTaken: true, albumOrderOwnTaken: true, names: {}, seen: {} };

function path(): string {
  return join(storeDir(), BACKUP_FLAGS_FILE);
}

export function readBackupFlags(): BackupFlags {
  try {
    const raw = readSealedOrSetAside(path());
    if (!raw) return { ...ABSENT, names: {}, seen: {} };
    const parsed = JSON.parse(raw.toString("utf8")) as Partial<BackupFlags>;
    return {
      knownWipe: typeof parsed.knownWipe === "number" && parsed.knownWipe > 0 ? parsed.knownWipe : 0,
      trashPending: parsed.trashPending === true,
      ownTaken: parsed.ownTaken !== false,
      settingsOwnTaken: parsed.settingsOwnTaken !== false,
      albumOrderOwnTaken: parsed.albumOrderOwnTaken !== false,
      names: parsed.names && typeof parsed.names === "object" ? { ...parsed.names } : {},
      seen: parsed.seen && typeof parsed.seen === "object" ? { ...parsed.seen } : {},
    };
  } catch (e) {
    rethrowLocked(e);
    return { ...ABSENT, names: {}, seen: {} };
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
  writeBackupFlags({ ownTaken: false, settingsOwnTaken: false, albumOrderOwnTaken: false });
}

/**
 * Whether a round that read this install's own settings copy back can count it as taken: it was
 * asked for, the settings were put together here (backup on, choices stamped), and every copy read.
 */
export function settingsReadBackDone(asked: boolean, taken: boolean, unreadable: number): boolean {
  return asked && taken && unreadable === 0;
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

/**
 * Remembers the revisions a read of the other devices' copies opened, so a look at the listings
 * can tell which copy is newer than what this computer took in. Only copies still listed are kept.
 */
export function keepSeenRevisions(read: Iterable<[string, string]>, listed?: ReadonlySet<string>): boolean {
  const flags = readBackupFlags();
  const seen: Record<string, string> = {};
  for (const [uid, revision] of Object.entries(flags.seen)) if (!listed || listed.has(uid)) seen[uid] = revision;
  for (const [uid, revision] of read) seen[uid] = revision;
  const before = flags.seen;
  if (Object.keys(seen).length === Object.keys(before).length && Object.entries(seen).every(([k, v]) => before[k] === v)) return false;
  writeBackupFlags({ seen });
  return true;
}

/** How many listed copies differ from the revision this computer last read of them, or were never read. */
export function newerThanSeen(listed: Iterable<{ uid: string; revision: string }>): number {
  const seen = readBackupFlags().seen;
  let fresh = 0;
  for (const copy of listed) if (seen[copy.uid] !== copy.revision) fresh++;
  return fresh;
}
