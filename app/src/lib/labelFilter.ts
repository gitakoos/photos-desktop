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

// The label filter shared by the timeline and the search: the picked labels by their folded
// names, and whether a photo needs any of them or all of them.

import { labelKey } from "./labels";
import type { LabelUsage } from "./labelQuery";

export type LabelFilter = { keys: string[]; all: boolean };

export const NO_LABELS: LabelFilter = { keys: [], all: false };

/** How many labels the filter shows before its More chip. */
export const SECTION_TOP = 5;

/** The filter with `keys` picked; All holds only with two or more. */
export function withLabels(keys: readonly string[], all: boolean): LabelFilter {
  const distinct = [...new Set(keys)];
  return { keys: distinct, all: all && distinct.length >= 2 };
}

/** `filter` with `key` picked, or unpicked when it was. */
export function toggleLabel(filter: LabelFilter, key: string): LabelFilter {
  return withLabels(filter.keys.includes(key) ? filter.keys.filter((k) => k !== key) : [...filter.keys, key], filter.all);
}

/** Each photo's label keys, built once per label change. */
export function labelIndex(labels: readonly { name: string; uids: readonly string[] }[]): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const label of labels) {
    const key = labelKey(label.name);
    for (const uid of label.uids) {
      let keys = index.get(uid);
      if (!keys) index.set(uid, (keys = new Set()));
      keys.add(key);
    }
  }
  return index;
}

/** Whether the photo `uid` carries any of the picked labels, or every one of them with All. */
export function matchesLabels(uid: string, filter: LabelFilter, index: Map<string, Set<string>>): boolean {
  const held = index.get(uid);
  if (!held) return false;
  return filter.all ? filter.keys.every((k) => held.has(k)) : filter.keys.some((k) => held.has(k));
}

/** `items` narrowed to the picked labels, in their order; the same list when none is picked. */
export function applyLabels<T extends { uid: string }>(items: T[], filter: LabelFilter, index: Map<string, Set<string>>): T[] {
  return filter.keys.length === 0 ? items : items.filter((it) => matchesLabels(it.uid, filter, index));
}

/** `filter` without the picked labels the account no longer has, as after a delete or a rename. */
export function pruneLabels(filter: LabelFilter, names: readonly string[]): LabelFilter {
  if (filter.keys.length === 0) return filter;
  const existing = new Set(names.map(labelKey));
  const kept = filter.keys.filter((k) => existing.has(k));
  return kept.length === filter.keys.length ? filter : withLabels(kept, filter.all);
}

/** The labels with photos in the library, most used first. */
export function labelUsage(entries: readonly { name: string; uids: readonly string[] }[]): LabelUsage[] {
  return entries
    .map((e) => ({ key: labelKey(e.name), label: e.name, count: e.uids.length }))
    .sort((a, b) => b.count - a.count);
}

/** The labels the filter section shows: the `top` most used, then any picked one beyond them. */
export function shownInSection(usage: LabelUsage[], picked: readonly string[], top = SECTION_TOP): LabelUsage[] {
  return [...usage.slice(0, top), ...usage.slice(top).filter((u) => picked.includes(u.key))];
}
