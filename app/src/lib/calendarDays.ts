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

import { type Dated } from "./memories";

/** The photos of one local calendar day, newest first; `cover` is the newest. */
export type DayBucket = { uids: string[]; cover: string };

/** `YYYY-MM-DD` of the local day a time falls on, the same rule the timeline's month groups use. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** `YYYY-MM` for a year and a 0-based month. */
export function monthKeyOf(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** The photos by local day. `items` arrive newest first, as the timeline holds them, and each day keeps that order. */
export function bucketByDay(items: Dated[]): Map<string, DayBucket> {
  const out = new Map<string, DayBucket>();
  for (const it of items) {
    const key = dayKey(it.captureTime);
    const bucket = out.get(key);
    if (bucket) bucket.uids.push(it.uid);
    else out.set(key, { uids: [it.uid], cover: it.uid });
  }
  return out;
}

/** What a month holds: the photos, and the days that have any. */
export function monthTotals(days: Map<string, DayBucket>, year: number, month: number): { photos: number; days: number } {
  const prefix = monthKeyOf(year, month) + "-";
  let photos = 0;
  let dayCount = 0;
  for (const [key, bucket] of days) {
    if (!key.startsWith(prefix)) continue;
    photos += bucket.uids.length;
    dayCount += 1;
  }
  return { photos, days: dayCount };
}

/** The months that hold photos, as `YYYY-MM` keys. */
export function monthsWithPhotos(days: Map<string, DayBucket>): Set<string> {
  const out = new Set<string>();
  for (const key of days.keys()) out.add(key.slice(0, 7));
  return out;
}

/** The first and last year that hold photos, or null with none. */
export function yearSpan(days: Map<string, DayBucket>): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const key of days.keys()) {
    const y = Number(key.slice(0, 4));
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  return lo === Infinity ? null : [lo, hi];
}

/** The cells of a month: a day number, or null for the blanks before the 1st. `firstDay` is 1 for Monday to 7 for Sunday. */
export function monthCells(year: number, month: number, firstDay: number): (number | null)[] {
  const length = new Date(year, month + 1, 0).getDate();
  const startDow = new Date(year, month, 1).getDay() || 7;
  const lead = (startDow - firstDay + 7) % 7;
  const cells: (number | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= length; d++) cells.push(d);
  return cells;
}

/** The weekday a week starts on in a locale, 1 (Monday) to 7 (Sunday); Monday where the runtime does not say. */
export function weekStart(locale: string): number {
  try {
    const loc = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const day = loc.getWeekInfo?.().firstDay ?? loc.weekInfo?.firstDay;
    if (typeof day === "number" && day >= 1 && day <= 7) return day;
  } catch {
    /* an unreadable tag falls through */
  }
  return 1;
}

/** The month before or after, as year and 0-based month. */
export function stepMonth(year: number, month: number, by: number): { year: number; month: number } {
  const n = year * 12 + month + by;
  return { year: Math.floor(n / 12), month: ((n % 12) + 12) % 12 };
}
