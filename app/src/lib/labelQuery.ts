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

// The label keyword typed into the search ("labels", "labels:beach"), as on Android: it offers the
// labels as chips, and a settled "labels:<name>" naming one becomes its pill.

import { labelKey } from "./labels";
import { foldText, pillText } from "./searchQuery";

/** The text before the keyword, and what follows its colon (null for a bare keyword). */
export type LabelTyping = { rest: string; name: string | null };

/** A label with its folded key and how many photos carry it. */
export type LabelUsage = { key: string; label: string; count: number };

const keyOf = (text: string): string => foldText(text).replace(/\s+/g, " ").trim();

/** The keyword variants of each bar-separated `phrases` string, folded, longest first. */
export function labelKeywords(phrases: string[]): string[] {
  const all = phrases.flatMap((p) => p.split("|")).map(keyOf).filter(Boolean);
  return [...new Set(all)].sort((a, b) => b.length - a.length);
}

/** The keyword `q` ends with, or null when it holds none. */
export function parseLabelTyping(q: string, keywords: string[]): LabelTyping | null {
  if (keywords.length === 0 || !q.trim()) return null;
  const readable = pillText(q);
  if (!readable.trim()) return null;
  const start = Math.max(q.lastIndexOf(",") + 1, q.length - readable.length);
  for (let i = start; i < q.length; i++) {
    if (/\s/.test(q[i]) || (i > 0 && !/\s/.test(q[i - 1]) && q[i - 1] !== ",")) continue;
    const tail = q.slice(i);
    const colon = tail.indexOf(":");
    const head = colon >= 0 ? tail.slice(0, colon) : tail;
    if (!keywords.includes(keyOf(head))) continue;
    const rest = q.slice(0, i).trimEnd().replace(/,+$/, "").trimEnd();
    return { rest, name: colon >= 0 ? tail.slice(colon + 1).trim() : null };
  }
  return null;
}

/** A label is picked, or `q` ends with the keyword: content search and name matches stay out. */
export function isLabelSearch(q: string, picked: readonly string[], keywords: string[]): boolean {
  return picked.length > 0 || parseLabelTyping(q, keywords) !== null;
}

/** `q` without the label keyword it ends with, the text the rest of the search works on. */
export function labelTextOf(q: string, keywords: string[]): string {
  return parseLabelTyping(q, keywords)?.rest ?? q;
}

/** The labels the chips offer while `typing`: those whose name holds what follows the colon, the
 *  picked ones left out, in the order of `usage`. */
export function offeredLabels(typing: LabelTyping, usage: LabelUsage[], picked: readonly string[]): LabelUsage[] {
  const needle = typing.name ? labelKey(typing.name) : "";
  return usage.filter((u) => !picked.includes(u.key) && (!needle || u.key.includes(needle)));
}

/** The label `typing` names exactly, or null for none or a bare keyword. */
export function namedLabel(typing: LabelTyping, usage: LabelUsage[]): LabelUsage | null {
  if (typing.name === null) return null;
  const wanted = labelKey(typing.name);
  if (!wanted) return null;
  return usage.find((u) => u.key === wanted) ?? null;
}
