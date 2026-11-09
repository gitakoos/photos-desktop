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

// What the last copy written from here held, kept so a much smaller one is not written over it: a
// scan cut short or a store that came back empty would otherwise replace the good copy on Drive.

import { join } from "node:path";

import type { ShrinkReport } from "./sharedBackup.ts";
import { BACKUP_BASELINE_FILE, readSealedOrDiscard, storeDir, writeSealedAtomic } from "./store.ts";

/** The share of its photos or items a copy may lose against the last one. */
export const SHRINK_TOLERANCE = 0.02;

/** What a copy held: the faces on each photo by its link id, or 1 for each photo with a vector. */
export type Baseline = Record<string, number>;

type BaselineKind = "faces" | "search";
type Baselines = Partial<Record<BaselineKind, Baseline>>;

/**
 * How much `current` is smaller than `previous`, when it is too much to write; null when it is not.
 * Only the photos of `previous` that `eligible` still takes count: one gone from the library or
 * hidden is no loss, and a new one makes up for none. While a scan runs, no loss at all is let by.
 */
export function shrinkOf(
  previous: Baseline | null,
  current: Baseline,
  eligible: (link: string) => boolean,
  scanning: boolean,
): ShrinkReport | null {
  if (!previous) return null;
  const links = Object.keys(previous).filter((link) => eligible(link));
  const kept = links.filter((link) => Object.hasOwn(current, link));
  const report: ShrinkReport = {
    photosBefore: links.length,
    photosAfter: kept.length,
    itemsBefore: links.reduce((n, link) => n + previous[link], 0),
    itemsAfter: kept.reduce((n, link) => n + current[link], 0),
  };
  const fell = (before: number, after: number) => after < before && (scanning || (before - after) / before > SHRINK_TOLERANCE);
  return fell(report.photosBefore, report.photosAfter) || fell(report.itemsBefore, report.itemsAfter) ? report : null;
}

/** The reference of each kind of copy, kept in the store, so it survives a restart. */
export class BaselineStore {
  constructor(
    private readonly read: () => Baselines,
    private readonly write: (all: Baselines) => void,
  ) {}

  get(kind: BaselineKind): Baseline | null {
    return this.read()[kind] ?? null;
  }

  /** Remembers `baseline` as what the copy on Drive holds now. */
  record(kind: BaselineKind, baseline: Baseline): void {
    this.write({ ...this.read(), [kind]: baseline });
  }

  /** Forgets it, for a delete the user chose: the next copy has nothing to be held against. */
  clear(kind: BaselineKind): void {
    this.write({ ...this.read(), [kind]: undefined });
  }
}

export const backupBaseline = new BaselineStore(
  () => {
    try {
      return JSON.parse(readSealedOrDiscard(join(storeDir(), BACKUP_BASELINE_FILE))?.toString("utf8") ?? "{}");
    } catch {
      return {};
    }
  },
  (all) => writeSealedAtomic(join(storeDir(), BACKUP_BASELINE_FILE), Buffer.from(JSON.stringify(all), "utf8")),
);
