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

/** What the sidecar tells the date editor about a photo before anything is changed. */
export type DateEditInfo = {
  uid: string;
  name: string;
  captureMs: number;
  nameMs: number | null;
  blocked: "live" | "type" | "read" | null;
};

export type DateEditStatus = {
  running: boolean;
  total: number;
  done: number;
  changed: number;
  unchanged: number;
  failed: number;
  errors: { uid: string; error: string }[];
  cancelled: boolean;
};

/** One date for all, the same shift for each, or the date each file name records. */
export type DateEditMode = "set" | "shift" | "name";

export type Shift = { days: number; hours: number; minutes: number };

export type DateEditInput = {
  /** `YYYY-MM-DD`, as a date field gives it. */
  date: string;
  /** `HH:MM`; empty keeps each photo's own time of day. */
  time: string;
  shift: Shift;
};

/** A photo's new date, or why it keeps the one it has. */
export type NextDate =
  | { kind: "change"; captureMs: number }
  | { kind: "same" | "noName" | "live" | "type" | "read" | "invalid" };

/** Within a second counts as the date the photo already has. */
const SAME_MS = 1000;

/**
 * The capture time `item` gets under `mode`. Setting a date with no time keeps each photo's own
 * time of day, so photos moved to one day stay in the order they were taken.
 */
export function newCaptureTime(item: DateEditInfo, mode: DateEditMode, input: DateEditInput): NextDate {
  if (item.blocked) return { kind: item.blocked };
  let ms: number;
  if (mode === "name") {
    if (item.nameMs === null) return { kind: "noName" };
    ms = item.nameMs;
  } else if (mode === "shift") {
    if (!(item.captureMs > 0)) return { kind: "read" };
    const { days, hours, minutes } = input.shift;
    ms = item.captureMs + ((days * 24 + hours) * 60 + minutes) * 60_000;
  } else {
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.date);
    if (!day) return { kind: "invalid" };
    const [y, m, d] = [Number(day[1]), Number(day[2]) - 1, Number(day[3])];
    const clock = /^(\d{2}):(\d{2})$/.exec(input.time);
    if (clock) {
      ms = new Date(y, m, d, Number(clock[1]), Number(clock[2]), 0, 0).getTime();
    } else {
      const own = new Date(item.captureMs > 0 ? item.captureMs : 0);
      ms = new Date(y, m, d, own.getHours(), own.getMinutes(), own.getSeconds(), own.getMilliseconds()).getTime();
    }
  }
  if (!Number.isFinite(ms) || ms <= 0) return { kind: "invalid" };
  if (item.captureMs > 0 && Math.abs(ms - item.captureMs) < SAME_MS) return { kind: "same" };
  return { kind: "change", captureMs: ms };
}
