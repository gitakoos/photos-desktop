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

/**
 * Reads the capture date a filename carries, for photos that reached the library with no
 * EXIF of their own (memes, downloads, screenshots) but whose name records when they were
 * taken or saved. The date in the name is the only original date such a file has, so
 * setting it beats letting the photo fall to its import date and scatter across the
 * timeline.
 *
 * Several strategies are tried, most specific first:
 *
 * 1. Unix millisecond stamps behind a known app prefix — Facebook's
 *    `FB_IMG_15756331575910230`, `FB_VID_…`, `FB_TEMP_…`, Messenger's
 *    `received_1608189165889774` (the leading 13 digits of the run are the stamp; whatever
 *    follows is a random id), and WeChat's `mmexport1575633157591` / `wx_camera_…`.
 * 2. Year-leading calendar shapes, with or without a time: `IMG_20230115_123456`,
 *    `20230115`, `2023-01-15`, `2023.01.15`, `Screenshot_2023-01-15-12-34-56`, the WhatsApp
 *    `IMG-20230115-WA0001`, Signal's `signal-2023-01-15-123456`, and the desktop
 *    `Screenshot 2023-01-15 at 1.34.56 PM` / `WhatsApp Image 2023-01-15 at 12.34.56`.
 * 3. Year-trailing calendar shapes (`15.01.2023`, `01-31-2023`), read ONLY when the
 *    day/month order is unambiguous (one side above 12, or both sides equal), since
 *    `03-04-2023` is March in one country and April in the next.
 *
 * 4. Any other unix stamp, last: a 13-digit millisecond run anywhere
 *    (`Censored Camera Editor_1541691423899`), or a 10-to-12-digit seconds run after a
 *    word (`IMG_156321213357F`). A bare ten-digit name stays unread, and so does any run
 *    shorter than ten (`219056359_4SZ`): those are ids as often as dates.
 *
 * Every candidate is validated as a real, non-future calendar date at or after its floor,
 * so a digit run that is not a date (`received_934356540367769` would be the year 2266) is
 * rejected rather than guessed.
 *
 * No time in the name lands the photo at local noon, so converting between zones can
 * never cross the day. The current instant is a parameter rather than a clock read, so
 * every rule here is verifiable in a plain test.
 */

/** Digital photography predates this by little; a 4-digit year below it is not a capture date. */
const MIN_YEAR = 1990;

/** Epoch-ms below this (1971-01-01) is treated as "no real timestamp", the same sanity floor
 *  that separates a real capture date from the sentinel a date-less record carries. */
const FLOOR_MS = 31_536_000_000;

/** Unix-ms floor for a social stamp (2004-01-31): the apps whose filenames carry one did
 *  not exist before, so a decoded date older than the app is a misread id, not a stamp. */
const SOCIAL_MS_FLOOR = 1_044_000_000_000;

/** Unix-ms floor for a stamp with no app prefix to vouch for it (2005-01-01): older than
 *  that, the name is far likelier an id than a phone's clock. */
const UNIX_STAMP_FLOOR = 1_104_537_600_000;

/**
 * `yyyy-MM-dd` (or `.`/`_` separators) with an optional time: separated `HH-mm(-ss)`,
 * compact `HHmmss` (Signal), or the desktop ` at HH.mm.ss` form, each with an optional
 * 12-hour `AM`/`PM` marker. Groups: 1-3 date, 4-6 separated time, 7-9 compact time,
 * 10 the meridiem letter.
 */
const SEPARATED =
  /(?<!\d)(\d{4})[-._](\d{1,2})[-._](\d{1,2})(?:(?:\s+at\s+|[ _tT-])(?:(\d{1,2})[-._:h](\d{2})(?:[-._:](\d{2}))?|(\d{2})(\d{2})(\d{2}))(?:\s*([AaPp])\.?[Mm]\.?)?)?(?!\d)/;
/** `yyyyMMdd` immediately followed (optional single separator) by `HHmmss`, tolerating an
 *  optional sub-second suffix (e.g. `...539`) so a millisecond tail does not block the match. */
const COMPACT_DATETIME = /(?<!\d)(\d{4})(\d{2})(\d{2})[ _tT.-]?(\d{2})(\d{2})(\d{2})(?:[.,]?\d{1,3})?(?!\d)/;
/** A bare `yyyyMMdd` run bounded by non-digits. */
const COMPACT_DATE = /(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/;
/** `dd.MM.yyyy` / `MM-dd-yyyy`: the two leading fields are resolved by `yearTrailingCapture`. */
const YEAR_TRAILING = /(?<!\d)(\d{1,2})[-._](\d{1,2})[-._](\d{4})(?!\d)/;

/**
 * The download names that carry a unix millisecond stamp followed by a random id:
 * Facebook's `FB_IMG_15756331575910230.jpg` (the leading 13 digits stamp the instant),
 * its video and temporary forms, Messenger's `received_1608189165889774.jpeg`, and
 * WeChat's `mmexport1575633157591.jpg` / `wx_camera_1575633157591.jpg`. The stamp is only
 * read when the whole run is 13 digits or more — a shorter run is an id, not a stamp — and
 * only when the decoded instant sits inside the app's lifetime, so a 15-digit id whose
 * stamp would decode to a date after today is refused entirely.
 */
const SOCIAL_UNIX_STAMP =
  /(?<![A-Za-z\d])(?:FB_(?:IMG|VID|TEMP)_|received_|mmexport|wx_camera_)(\d{13,})(?!\d)/i;

/** A missing or unreadable time component lands at noon. */
const NOON = 12;

/** A date the name is honest about: the instant, and whether the name recorded a time of
 *  day. The flag matters to whoever compares the date against what Drive already shows. */
export type FilenameCapture = { ms: number; withTime: boolean };

/**
 * Whether the filename date is worth replacing the cloud capture time: only when Drive
 * shows another calendar day. The fix answers for the year, month and day, never the time
 * of day, which is the clock of whatever device saved the file.
 *
 * Drive's capture time has been written two ways: Proton's uploaders long stored the
 * camera's wall clock as if it were UTC (a photo taken at 04:17 reads `04:17Z`), newer ones
 * the real instant. The cloud date therefore counts as the named day when either reading
 * of it — UTC or this machine's zone — lands on it. Comparing instants to the second
 * instead flagged thousands of correctly dated photos, hours apart only by zone. The
 * sidecar applies the same rule (`sameCaptureDay`) before it writes and when it confirms.
 */
export function dateNeedsFix(capture: FilenameCapture, cloudMs: number): boolean {
  if (!(capture.ms > 0)) return false;
  const cloud = Number(cloudMs);
  if (!Number.isFinite(cloud) || cloud <= 0) return true;
  const named = new Date(capture.ms);
  const cloudDate = new Date(cloud);
  const [y, m, d] = [named.getFullYear(), named.getMonth(), named.getDate()];
  const sameLocal = cloudDate.getFullYear() === y && cloudDate.getMonth() === m && cloudDate.getDate() === d;
  const sameUtc = cloudDate.getUTCFullYear() === y && cloudDate.getUTCMonth() === m && cloudDate.getUTCDate() === d;
  return !(sameLocal || sameUtc);
}

/** The capture instant `name` encodes, or null when it carries no readable date. */
export function parseFilenameDate(name: string, nowMs: number): number | null {
  return parseFilenameCapture(name, nowMs)?.ms ?? null;
}

/**
 * The capture `name` records with the time-honesty flag, or null when it carries no
 * readable date. `nowMs` is the ceiling (a future date is never returned). The
 * wall-clock date the name records is read in the local zone, which is the same basis a
 * hand-picked date would use, so a name and a picker can never disagree about where a
 * photo lands.
 */
export function parseFilenameCapture(name: string, nowMs: number): FilenameCapture | null {
  const dot = name.lastIndexOf(".");
  const stem = (dot > -1 ? name.slice(0, dot) : name).trim();
  if (stem.length === 0) return null;

  // A social stamp is tried first: a 13-digit instant after one of its prefixes is never
  // also a readable year-leading name, and Facebook's longer runs would otherwise be
  // half-eaten into a wrong calendar date by the patterns below.
  const social = socialStampCapture(stem, nowMs);
  if (social) return social;
  return yearLeadingCapture(stem, nowMs) ?? yearTrailingCapture(stem, nowMs) ?? unixStampCapture(stem, nowMs);
}

/**
 * A unix stamp anywhere else in the name, the last strategy tried, after every calendar
 * shape. Editors and other apps save under `<app name>_<Date.now()>`
 * (`Censored Camera Editor_1541691423899`), some under the time in seconds with a tail
 * after it (`IMG_156321213357F`). Two shapes are read:
 *   - a run of 13 digits or more: its leading 13 are milliseconds. Thirteen digits that
 *     decode inside the window below are a stamp far more often than an id.
 *   - a run of 10 to 12 digits right after a word and a separator (`IMG_`, `image-`):
 *     its leading 10 are seconds. A bare ten-digit name stays unread, since it is as
 *     often a random id (`1234567890.png`) as a stamp.
 * Either way the instant must fall between UNIX_STAMP_FLOOR and now, which is what turns
 * away an id like Messenger's `received_934356540367769` (it would be the year 2266).
 */
function unixStampCapture(stem: string, nowMs: number): FilenameCapture | null {
  for (const found of stem.matchAll(/(?<!\d)(\d{10,})(?!\d)/g)) {
    const run = found[1]!;
    let ms: number;
    if (run.length >= 13) {
      ms = Number(run.slice(0, 13));
    } else {
      const before = stem.slice(0, found.index);
      if (!/[A-Za-z][_\- ]$/.test(before)) continue;
      ms = Number(run.slice(0, 10)) * 1000;
    }
    if (Number.isFinite(ms) && ms >= UNIX_STAMP_FLOOR && ms <= nowMs) return { ms, withTime: true };
  }
  return null;
}

/** The unix-ms stamp a social download name carries, decoded and sanity-checked. */
function socialStampCapture(stem: string, nowMs: number): FilenameCapture | null {
  const found = SOCIAL_UNIX_STAMP.exec(stem);
  if (!found) return null;
  const stamp = Number(found[1].slice(0, 13));
  if (!Number.isFinite(stamp)) return null;
  if (stamp < SOCIAL_MS_FLOOR || stamp > nowMs) return null;
  return { ms: stamp, withTime: true };
}

/**
 * The year-leading calendar shapes: a run whose time is out of range (a counter, not a
 * clock, such as SquareQuick's `..594755`) still yields its date, so the fallback re-reads
 * the same valid `yyyyMMdd` at noon — with the honesty flag then saying the name did not
 * vouch for a time.
 */
function yearLeadingCapture(stem: string, nowMs: number): FilenameCapture | null {
  const separated = SEPARATED.exec(stem);
  if (separated) {
    // The time-bearing attempt carries the honesty flag only when it is what produced
    // the instant; the noon fallback means the name's "time" was not a clock.
    const [, y, mo, d, sepH, sepMi, sepS, cH, cMi, cS, meridiem] = separated;
    const hour = to24Hour(sepH ?? cH, meridiem);
    if (hour !== undefined) {
      const withClock = toEpochMs(y, mo, d, hour, sepMi ?? cMi, sepS ?? cS, nowMs);
      if (withClock !== null) return { ms: withClock, withTime: true };
    }
    const dateOnly = toEpochMs(y, mo, d, undefined, undefined, undefined, nowMs);
    if (dateOnly !== null) return { ms: dateOnly, withTime: false };
  }
  const compactDateTime = COMPACT_DATETIME.exec(stem);
  if (compactDateTime) {
    const withClock = toEpochMs(
      compactDateTime[1], compactDateTime[2], compactDateTime[3],
      compactDateTime[4], compactDateTime[5], compactDateTime[6], nowMs,
    );
    if (withClock !== null) return { ms: withClock, withTime: true };
    const dateOnly = toEpochMs(
      compactDateTime[1], compactDateTime[2], compactDateTime[3], undefined, undefined, undefined, nowMs,
    );
    if (dateOnly !== null) return { ms: dateOnly, withTime: false };
  }
  const compactDate = COMPACT_DATE.exec(stem);
  if (compactDate) {
    const at = toEpochMs(compactDate[1], compactDate[2], compactDate[3], undefined, undefined, undefined, nowMs);
    if (at !== null) return { ms: at, withTime: false };
  }
  return null;
}

/**
 * A year-trailing date, read only when its order is certain: a leading field above 12 can
 * only be a day (`31.01.2023`), a middle one above 12 can only be a day (`01-31-2023`), and
 * equal fields read the same either way. Anything else (`03-04-2023`) is left unread
 * rather than guessed by locale.
 */
function yearTrailingCapture(stem: string, nowMs: number): FilenameCapture | null {
  const found = YEAR_TRAILING.exec(stem);
  if (!found) return null;
  const [, first, second, year] = found;
  const a = Number(first);
  const b = Number(second);
  let day: number;
  let month: number;
  if (a === b || (a > 12 && b <= 12)) {
    day = a;
    month = b;
  } else if (b > 12 && a <= 12) {
    day = b;
    month = a;
  } else {
    return null;
  }
  const at = toEpochMs(year, String(month), String(day), undefined, undefined, undefined, nowMs);
  return at === null ? null : { ms: at, withTime: false };
}

/**
 * The 24-hour hour a name's time records: `undefined` when there is no time at all or a
 * 12-hour marker sits on an hour that is not 1-12, so the caller falls back to the date.
 */
function to24Hour(hour: string | undefined, meridiem: string | undefined): string | undefined {
  if (hour === undefined || hour === "") return undefined;
  if (!meridiem) return hour;
  const h = Number(hour);
  if (!Number.isInteger(h) || h < 1 || h > 12) return undefined;
  const pm = meridiem.toLowerCase() === "p";
  return String((h % 12) + (pm ? 12 : 0));
}

/**
 * Builds the instant from the captured fields, returning null when they are not a real
 * calendar date, predate the [MIN_YEAR] floor, or land after `nowMs`. A blank time component
 * lands at local noon.
 *
 * The calendar check is read back off the constructed Date rather than trusted: JavaScript
 * rolls an impossible day forward into the next month (`new Date(2023, 1, 30)` is March),
 * where the calendar arithmetic this mirrors refuses it outright.
 */
function toEpochMs(
  y: string | undefined,
  mo: string | undefined,
  d: string | undefined,
  h: string | undefined,
  mi: string | undefined,
  s: string | undefined,
  nowMs: number,
): number | null {
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (!Number.isInteger(year) || year < MIN_YEAR) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  // An absent time is the noon rule; a present one is validated like the date, because a
  // counter posing as a clock (an hour 25) must not move the photo to a wrong day.
  const hour = h === undefined || h === "" ? NOON : Number(h);
  const minute = mi === undefined || mi === "" ? 0 : Number(mi);
  const second = s === undefined || s === "" ? 0 : Number(s);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (!Number.isInteger(second) || second < 0 || second > 59) return null;

  const at = new Date(year, month - 1, day, hour, minute, second);
  if (
    at.getFullYear() !== year ||
    at.getMonth() !== month - 1 ||
    at.getDate() !== day ||
    at.getHours() !== hour ||
    at.getMinutes() !== minute ||
    at.getSeconds() !== second
  ) {
    return null;
  }
  const ms = at.getTime();
  if (!Number.isFinite(ms) || ms <= FLOOR_MS || ms > nowMs) return null;
  return ms;
}
