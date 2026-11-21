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

// The labels as the window lists them: found by part of a name, accents aside, and marked by how
// many of the selected photos carry each.

import { foldText } from "./searchQuery";

/** A label's comparison key: blanks collapsed, trimmed, lower-cased and without accents. */
export const labelKey = (text: string): string => foldText(text.replace(/\s+/g, " ").trim());
const fold = labelKey;

/** Two spellings of one label: case, accents and spacing aside. */
export function sameLabel(a: string, b: string): boolean {
  return fold(a) === fold(b);
}

/** The labels whose name holds what was typed, the ones that start with it first. */
export function matchingLabels<T extends { name: string }>(labels: T[], query: string): T[] {
  const q = fold(query);
  if (!q) return labels;
  const hits = labels.filter((l) => fold(l.name).includes(q));
  return [...hits.filter((l) => fold(l.name).startsWith(q)), ...hits.filter((l) => !fold(l.name).startsWith(q))];
}

/** Whether every photo of `keys`, some of them, or none carries `name`. */
export function labelState(name: string, keys: string[], carried: Record<string, string[]>): "all" | "some" | "none" {
  let count = 0;
  for (const key of keys) if ((carried[key] ?? []).some((l) => sameLabel(l, name))) count++;
  return count === 0 ? "none" : count === keys.length ? "all" : "some";
}
