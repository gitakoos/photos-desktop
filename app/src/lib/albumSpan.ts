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

/** The first and the last capture time of an album's photos, or null when none has one. */
export function photoSpan(photos: { captureTime: number }[]): [number, number] | null {
  let first = Infinity;
  let last = -Infinity;
  for (const p of photos) {
    if (!(p.captureTime > 0)) continue;
    if (p.captureTime < first) first = p.captureTime;
    if (p.captureTime > last) last = p.captureTime;
  }
  return first === Infinity ? null : [first, last];
}

/**
 * An album's dates as its photos have them: one day, or the first to the last in the reader's
 * language, with the parts both ends share said once ("3 to 9 May 2024").
 */
export function photoSpanLabel(span: [number, number], locale: string): string {
  const format = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric" });
  const [first, last] = span;
  const sameDay = format.format(first) === format.format(last);
  // `formatRange` is in every WebView this app runs in; the type library here predates it.
  const ranged = format as Intl.DateTimeFormat & { formatRange(a: number, b: number): string };
  return sameDay ? format.format(first) : ranged.formatRange(first, last);
}
