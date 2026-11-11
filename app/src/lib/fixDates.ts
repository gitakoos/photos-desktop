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

import { parseFilenameDate } from "./filenameDate";

// The photos whose date cannot be right, for the Fix dates page: no date at all (shown as
// 1 January 1970), a date still to come, or a file name that records another day.

const DAY = 24 * 3600_000;
/** How far a name and the date may part before it counts: time zones and midnight stay inside. */
const NAME_SLACK = 2 * DAY;
/** Anything before this is the empty date, not a photo from 1970. */
const NO_DATE_BEFORE = Date.UTC(1971, 0, 2);

/**
 * The capture time a file name gives, read as local time, the way the sidecar reads it for
 * the date editor: `IMG_20230512_141502.jpg`, `Screenshot_2023-05-12-14-15-02.png`,
 * `VID-20230512-WA0001.mp4`. A date with no time is noon of that day. Null when the name gives
 * no real date. Up to a day ahead is let by, for that noon read in the morning.
 */
export function dateFromName(name: string, now = Date.now()): number | null {
  return parseFilenameDate(name, now + DAY);
}

export type DateProblem =
  | { kind: "none" }
  | { kind: "future" }
  | { kind: "name"; nameMs: number };

/** What is wrong with a photo's date, or null when nothing shows that it is wrong. */
export function dateProblem(captureMs: number, name: string | null, now = Date.now()): DateProblem | null {
  if (!Number.isFinite(captureMs) || captureMs < NO_DATE_BEFORE) return { kind: "none" };
  if (captureMs > now + DAY) return { kind: "future" };
  const nameMs = name ? dateFromName(name, now) : null;
  if (nameMs !== null && Math.abs(captureMs - nameMs) > NAME_SLACK) return { kind: "name", nameMs };
  return null;
}
