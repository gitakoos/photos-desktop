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

// The moment a file's name says it was taken. Read as local time, the way the device wrote it;
// a date with no time is noon of that day, so the day stays the same in every time zone. The
// sidecar reads it for uploads and the date editor, the UI's Fix dates page imports this same
// file, so it stays free of Node APIs.
//
// Read: a year-leading date with or without a time (`IMG_20230512_141502`,
// `PXL_20230512_141502123`, `Screenshot_2023-05-12-14-15-02`, `Screenshot 2023-05-12 at
// 2.15.02 PM`), a year-trailing date only when day and month cannot swap (`Foto 31.01.2023`,
// `scan_01-31-2023`), and the WeChat camera's `wx_camera_<ms>`. A bare run of digits is never
// read as a Unix time.
//
// Messenger names: WhatsApp `IMG-20230512-WA0001`, Signal `signal-2023-05-12-141502` and
// Telegram `photo_2023-05-12_14-15-02` keep when the photo was sent in the chat, the only date
// their stripped file has (Android reads them too). Facebook `FB_IMG_<ms>` and WeChat
// `mmexport<ms>` are when a picture was saved, often years after it was taken, and Messenger
// `received_<digits>` is an id: none of these is read.

/** The earliest year a name is believed for. */
const MIN_YEAR = 1990;

/**
 * `yyyy-MM-dd` (or `.` / `_`) with maybe a time after it: `HH-mm(-ss)`, compact `HHmmss`, or
 * ` at H.mm.ss`, each maybe with `AM` / `PM`. Groups: 1-3 date, 4-6 separated time, 7-9
 * compact time, 10 the meridiem letter.
 */
const SEPARATED =
  /(?<!\d)(\d{4})[-._](\d{1,2})[-._](\d{1,2})(?:(?:\s+at\s+|[ _tT-])(?:(\d{1,2})[-._:h](\d{2})(?:[-._:m](\d{2}))?|(\d{2})(\d{2})(\d{2})\d{0,3})(?:\s*([AaPp])\.?[Mm]\.?(?![A-Za-z]))?)?(?!\d)/;
/** `yyyyMMdd`, then `HHmmss` or `HH-mm-ss`, maybe with milliseconds after it. */
const COMPACT_DATETIME =
  /(?<!\d)(\d{4})(\d{2})(\d{2})[ _tT.-]?(\d{2})[-_.:h]?(\d{2})[-_.:m]?(\d{2})(?:[.,]?\d{1,3})?(?!\d)/;
/** A bare `yyyyMMdd`. */
const COMPACT_DATE = /(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/;
/** `dd.MM.yyyy` or `MM-dd-yyyy`: which is which is settled by `yearTrailing`. */
const YEAR_TRAILING = /(?<!\d)(\d{1,2})[-._](\d{1,2})[-._](\d{4})(?!\d)/;
/** The WeChat camera's own shot, named by the millisecond it was taken. */
const WECHAT_CAMERA = /(?<![A-Za-z\d])wx_camera_(\d{13})(?!\d)/i;
/** WeChat came out in January 2011: a camera stamp before it is not one. */
const WECHAT_FROM = Date.UTC(2011, 0, 1);

const DAY = 24 * 3600_000;

/**
 * The capture time the file name gives, in milliseconds, or null when it gives none that is
 * a real date. Up to a day ahead is let by, for today's noon read in the morning.
 */
export function dateFromName(name: string, now = Date.now()): number | null {
  const stem = name.replace(/\.[A-Za-z][A-Za-z0-9]{0,4}$/, "").trim();
  if (!stem) return null;
  const latest = now + DAY;
  return wechatCamera(stem, latest) ?? yearLeading(stem, latest) ?? yearTrailing(stem, latest);
}

function wechatCamera(stem: string, latest: number): number | null {
  const m = WECHAT_CAMERA.exec(stem);
  if (!m) return null;
  const ms = Number(m[1]);
  return ms >= WECHAT_FROM && ms <= latest ? ms : null;
}

/** A time that is no clock (a counter such as `_256199`) leaves the date at noon. */
function yearLeading(stem: string, latest: number): number | null {
  const s = SEPARATED.exec(stem);
  if (s) {
    const [, y, mo, d, sepH, sepMi, sepS, cH, cMi, cS, meridiem] = s;
    const hour = to24Hour(sepH ?? cH, meridiem);
    const withTime = hour !== undefined ? toMs(latest, y, mo, d, hour, sepMi ?? cMi, sepS ?? cS) : null;
    const at = withTime ?? toMs(latest, y, mo, d);
    if (at !== null) return at;
  }
  const c = COMPACT_DATETIME.exec(stem);
  if (c) {
    const at = toMs(latest, c[1], c[2], c[3], c[4], c[5], c[6]) ?? toMs(latest, c[1], c[2], c[3]);
    if (at !== null) return at;
  }
  const b = COMPACT_DATE.exec(stem);
  return b ? toMs(latest, b[1], b[2], b[3]) : null;
}

/** Read only when the order is certain: a field above 12 is the day, equal fields read the same. */
function yearTrailing(stem: string, latest: number): number | null {
  const m = YEAR_TRAILING.exec(stem);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === b || (a > 12 && b <= 12)) return toMs(latest, m[3], m[2], m[1]);
  if (b > 12 && a <= 12) return toMs(latest, m[3], m[1], m[2]);
  return null;
}

/** The 24-hour hour, or undefined when there is none or `AM` / `PM` sits on an hour outside 1 to 12. */
function to24Hour(hour: string | undefined, meridiem: string | undefined): string | undefined {
  if (!hour || !meridiem) return hour || undefined;
  const h = Number(hour);
  if (h < 1 || h > 12) return undefined;
  return String((h % 12) + (meridiem.toLowerCase() === "p" ? 12 : 0));
}

/**
 * The local time the fields give, or null when they are no real date and time, come before
 * MIN_YEAR or after `latest`. No hour is noon.
 */
function toMs(latest: number, y: string, mo: string, d: string, h?: string, mi?: string, s?: string): number | null {
  const [year, month, day] = [Number(y), Number(mo), Number(d)];
  const [hour, minute, second] = [h ? Number(h) : 12, mi ? Number(mi) : 0, s ? Number(s) : 0];
  if (year < MIN_YEAR || month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(year, month - 1, day, hour, minute, second);
  // A day the month does not have (31 April) rolls into the next month: not a date.
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  const ms = date.getTime();
  return ms <= latest ? ms : null;
}
