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

// Which copies of each duplicate group the user marked to go. One copy of a group always
// stays unmarked: deleting a whole group is its own action, asked for on purpose.

/** The marked copies, by group key. */
export type Marks = Map<string, Set<string>>;

type Group = { key: string; uids: string[] };

/** Whether `uid` may change its mark: unmarking always, marking only while another copy stays. */
export function canMark(marks: Marks, group: Group, uid: string): boolean {
  const set = marks.get(group.key);
  if (set?.has(uid)) return true;
  return group.uids.filter((u) => u !== uid && !set?.has(u)).length > 0;
}

/** The marks with `uid` flipped, when that is allowed; the same marks otherwise. */
export function toggleMark(marks: Marks, group: Group, uid: string): Marks {
  if (!canMark(marks, group, uid)) return marks;
  const next: Marks = new Map(marks);
  const set = new Set(next.get(group.key));
  if (set.has(uid)) set.delete(uid);
  else set.add(uid);
  if (set.size) next.set(group.key, set);
  else next.delete(group.key);
  return next;
}

/** What to ask the finder for: each group with marks, its copies and the ones kept. */
export function picksFrom(marks: Marks, groups: Group[]): { uids: string[]; keep: string[] }[] {
  const out: { uids: string[]; keep: string[] }[] = [];
  for (const g of groups) {
    const set = marks.get(g.key);
    if (!set?.size) continue;
    const keep = g.uids.filter((u) => !set.has(u));
    if (keep.length) out.push({ uids: g.uids, keep });
  }
  return out;
}
