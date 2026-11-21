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

// Which kinds of this computer's changes have not reached Drive yet, kept where a locked app can
// read it: a sign-out from the lock screen deletes the labels, the hidden list and the settings
// with the rest of the store, and the in-memory backup that knows what is unsaved is gone with the
// lock. Only the kind names are written ("labels", "hidden", ...), nothing of the data itself.

import { renameSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { storeDir } from "./store.ts";
import type { BackupKind } from "./sharedBackup.ts";

export const SIGN_OUT_HOLD_FILE = "signout-hold.json";

const KINDS: readonly BackupKind[] = ["labels", "hidden", "settings", "albumOrder", "faces"];

function path(): string {
  return join(storeDir(), SIGN_OUT_HOLD_FILE);
}

/** Records what is not on Drive now; nothing unsaved removes the record. */
export function writeSignOutHold(kinds: readonly BackupKind[]): void {
  try {
    const keep = KINDS.filter((k) => kinds.includes(k));
    if (keep.length === 0) {
      rmSync(path(), { force: true });
      return;
    }
    const tmp = `${path()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ kinds: keep }));
    renameSync(tmp, path());
  } catch {
    // No store yet, or a full disk: the sign-out in the open app still checks the backup itself.
  }
}

/** What the last record said was not on Drive; nothing for no record or one that does not parse. */
export function readSignOutHold(): BackupKind[] {
  try {
    const parsed = JSON.parse(readFileSync(path(), "utf8")) as { kinds?: unknown };
    return Array.isArray(parsed.kinds) ? KINDS.filter((k) => (parsed.kinds as unknown[]).includes(k)) : [];
  } catch {
    return [];
  }
}

export function clearSignOutHold(): void {
  try {
    rmSync(path(), { force: true });
  } catch {
    // Already gone with the store.
  }
}
