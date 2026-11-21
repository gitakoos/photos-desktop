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

// Marking many duplicate groups at once, and sending the marked copies to the trash in parts.

import { picksFrom, type Marks } from "./duplicateMarks";

export type BulkGroup = { key: string; kind: string; uids: string[] };

/** A group's copies but its first, the oldest, which stays. */
export const allBut = (g: BulkGroup): Set<string> => new Set(g.uids.slice(1));

/**
 * Whether a group's extras may be marked together with every other group's. Identical copies
 * are one file, so any of them may stay. Similar photos are different pictures, picked one
 * group at a time.
 */
export function bulkMarkable(g: BulkGroup): boolean {
  return g.kind === "identical";
}

/**
 * The groups marking every group at once would mark: bulk-markable, more than one copy, and
 * nothing marked yet. A group with marks keeps exactly those, so the user's choice of which
 * copy stays is never undone.
 */
export function unmarkedBulkGroups<G extends BulkGroup>(marks: Marks, groups: G[]): G[] {
  return groups.filter((g) => bulkMarkable(g) && g.uids.length > 1 && !marks.get(g.key)?.size);
}

/** The marks with the extras of every group `unmarkedBulkGroups` names marked, each keeping its oldest. */
export function markEvery(marks: Marks, groups: BulkGroup[]): Marks {
  const next: Marks = new Map(marks);
  for (const g of unmarkedBulkGroups(marks, groups)) next.set(g.key, allBut(g));
  return next;
}

export type TrashCall = {
  /** The groups this call takes, so their marks go once it is through. */
  keys: string[];
  groups: { uids: string[]; keep: string[] }[];
  whole: string[][];
};

/** How many photos a call is to move. */
export const plannedCount = (c: TrashCall): number =>
  c.groups.reduce((m, g) => m + g.uids.length - g.keep.length, 0) + c.whole.reduce((m, w) => m + w.length, 0);

/** The marked copies in calls of whole groups, each of about `chunk` photos. */
export function planTrashCalls(marks: Marks, groups: BulkGroup[], chunk: number): TrashCall[] {
  const calls: TrashCall[] = [];
  let call: TrashCall = { keys: [], groups: [], whole: [] };
  let size = 0;
  for (const g of groups) {
    const pick = picksFrom(marks, [g])[0];
    if (!pick) continue;
    call.keys.push(g.key);
    call.groups.push(pick);
    size += pick.uids.length - pick.keep.length;
    if (size >= chunk) {
      calls.push(call);
      call = { keys: [], groups: [], whole: [] };
      size = 0;
    }
  }
  if (call.keys.length) calls.push(call);
  return calls;
}

/** The marks left once the calls taking these groups are through. */
export function marksWithout(marks: Marks, keys: Iterable<string>): Marks {
  const next: Marks = new Map(marks);
  for (const k of keys) next.delete(k);
  return next;
}
