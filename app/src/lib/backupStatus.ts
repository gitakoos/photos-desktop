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

// What the backup settings show of the shared backup's status. The types mirror the sidecar's
// proton/sharedBackup.ts.

import { formatBytes } from "./format";

export type BackupKind = "faces" | "labels" | "search" | "hidden";

type SkipReason = "recognition-off" | "index-off" | "names-held" | "library-unlisted" | "nothing-to-save";
type FailReason = "network" | "drive-full" | "signed-out" | "copy-invalid" | "drive-error";
type CopyCounts = { faces?: number; photos?: number; vectors?: number };
type ShrinkReport = { photosBefore: number; photosAfter: number; itemsBefore: number; itemsAfter: number };

export type PartStatus =
  | { result: "saved" | "unchanged"; at: number; counts?: CopyCounts }
  | { result: "skipped"; at: number; reason: SkipReason }
  | { result: "blocked"; at: number; report: ShrinkReport }
  | { result: "failed"; at: number; reason: FailReason };

export type BackupStatus = {
  on: boolean;
  running: boolean;
  lastAt: number | null;
  failed: boolean;
  parts: Partial<Record<BackupKind, PartStatus>>;
  progress: { kind: BackupKind; sent: number; total: number } | null;
};

/** The order the parts are listed in. */
export const BACKUP_KINDS: BackupKind[] = ["faces", "search", "labels", "hidden"];

/** A text to show and what fills it; the window adds `part`, the part's name in its language. */
export type BackupPartLine = { key: string; values: Record<string, string | number> };

const SKIP_KEYS: Record<SkipReason, string> = {
  "recognition-off": "backup.skip.recognitionOff",
  "index-off": "backup.skip.indexOff",
  "names-held": "backup.skip.namesHeld",
  "library-unlisted": "backup.skip.libraryUnlisted",
  "nothing-to-save": "backup.skip.nothing",
};

const FAIL_KEYS: Record<FailReason, string> = {
  network: "backup.failed.network",
  "drive-full": "backup.failed.driveFull",
  "signed-out": "backup.failed.signedOut",
  "copy-invalid": "backup.failed.invalid",
  "drive-error": "backup.failed.drive",
};

/** What the last round did with a part. A part with nothing new reads the same as one just saved. */
export function backupPartLine(kind: BackupKind, part: PartStatus, date: (at: number) => string): BackupPartLine {
  switch (part.result) {
    case "skipped":
      return { key: SKIP_KEYS[part.reason], values: {} };
    case "failed":
      return { key: FAIL_KEYS[part.reason], values: {} };
    case "blocked":
      return { key: "backup.blocked", values: { ...part.report } };
    default: {
      const { faces, photos, vectors } = part.counts ?? {};
      const values = { date: date(part.at) };
      if (kind === "faces" && faces !== undefined && photos !== undefined) {
        return { key: "backup.savedFaces", values: { ...values, faces, photos } };
      }
      if (kind === "search" && vectors !== undefined) return { key: "backup.savedSearch", values: { ...values, vectors } };
      return { key: "backup.saved", values };
    }
  }
}

/** How far the copy being sent has come. */
export function backupSendingLine(progress: NonNullable<BackupStatus["progress"]>): BackupPartLine {
  return { key: "backup.sending", values: { sent: formatBytes(progress.sent), total: formatBytes(progress.total) } };
}

/** Whether the last round held back a smaller copy of any part. */
export function backupBlocked(parts: BackupStatus["parts"]): boolean {
  return Object.values(parts).some((part) => part.result === "blocked");
}

/** Whether the last round left at least one part's copy on Drive up to date. */
export function backupSynced(parts: BackupStatus["parts"]): boolean {
  return Object.values(parts).some((part) => part.result === "saved" || part.result === "unchanged");
}
