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

// The moment a file's name says it was taken, as cameras and phones name them:
// `IMG_20230512_141502.jpg`, `PXL_20230512_141502123.jpg`, `Screenshot_2023-05-12-14-15-02.png`,
// `VID-20230512-WA0001.mp4`. Read as local time, the way the device wrote it.

/** A year, month and day, and after it maybe an hour, minute and second (and milliseconds). */
const STAMP =
  /(?<!\d)((?:19|20)\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:[ _T.-]?(\d{2})[-_.:h]?(\d{2})[-_.:m]?(\d{2})\d{0,3})?(?!\d)/;

/** The earliest year a name is believed for. */
const FIRST_YEAR = 1990;

/**
 * The capture time the file name gives, in milliseconds, or null when it gives none that is
 * a real date. A name with a date and no time is taken as noon of that day, so the day stays
 * the same in every time zone.
 */
export function dateFromName(name: string, now = Date.now()): number | null {
  const m = STAMP.exec(name);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < FIRST_YEAR || month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Digits after the date that are no time of day leave the date alone.
  const time = m[4] !== undefined ? [Number(m[4]), Number(m[5]), Number(m[6])] : null;
  const [hour, minute, second] = time && time[0] < 24 && time[1] < 60 && time[2] < 60 ? time : [12, 0, 0];
  const date = new Date(year, month - 1, day, hour, minute, second);
  // A day the month does not have (31 April) rolls into the next month: not a date.
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  const ms = date.getTime();
  // A stamp in the future is a number that only looks like a date.
  return ms > now + 24 * 3600_000 ? null : ms;
}
