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

import { describe, expect, it } from "vitest";
import { bucketByDay, dayKey, monthCells, monthTotals, monthsWithPhotos, stepMonth, weekStart, yearSpan } from "./calendarDays";

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe("dayKey", () => {
  it("uses the local day, so late evening and just after midnight stay on their own days", () => {
    expect(dayKey(at(2026, 3, 9, 23, 59))).toBe("2026-03-09");
    expect(dayKey(at(2026, 3, 10, 0, 0))).toBe("2026-03-10");
  });
});

describe("bucketByDay", () => {
  const items = [
    { uid: "c", captureTime: at(2026, 5, 2, 18) },
    { uid: "b", captureTime: at(2026, 5, 2, 9) },
    { uid: "a", captureTime: at(2026, 4, 30, 23, 59) },
  ];
  it("groups by day, keeping the newest first and as the cover", () => {
    const days = bucketByDay(items);
    expect(days.get("2026-05-02")).toEqual({ uids: ["c", "b"], cover: "c" });
    expect(days.get("2026-04-30")).toEqual({ uids: ["a"], cover: "a" });
    expect(days.size).toBe(2);
  });
  it("totals a month and lists the months and years that hold photos", () => {
    const days = bucketByDay(items);
    expect(monthTotals(days, 2026, 4)).toEqual({ photos: 2, days: 1 });
    expect(monthTotals(days, 2026, 3)).toEqual({ photos: 1, days: 1 });
    expect(monthTotals(days, 2026, 0)).toEqual({ photos: 0, days: 0 });
    expect([...monthsWithPhotos(days)].sort()).toEqual(["2026-04", "2026-05"]);
    expect(yearSpan(days)).toEqual([2026, 2026]);
    expect(yearSpan(new Map())).toBeNull();
  });
});

describe("monthCells", () => {
  it("pads before the 1st by the week's first day", () => {
    // 1 June 2026 is a Monday.
    expect(monthCells(2026, 5, 1).slice(0, 2)).toEqual([1, 2]);
    expect(monthCells(2026, 5, 7).slice(0, 2)).toEqual([null, 1]);
    expect(monthCells(2026, 5, 1)).toHaveLength(30);
  });
  it("puts a Sunday 1st at the end of a Monday-first row", () => {
    // 1 March 2026 is a Sunday.
    const cells = monthCells(2026, 2, 1);
    expect(cells.slice(0, 7)).toEqual([null, null, null, null, null, null, 1]);
    expect(monthCells(2026, 2, 7)[0]).toBe(1);
  });
  it("counts a leap February", () => {
    expect(monthCells(2024, 1, 1).filter((c) => c !== null)).toHaveLength(29);
  });
});

describe("stepMonth", () => {
  it("crosses year boundaries both ways", () => {
    expect(stepMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(stepMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
    expect(stepMonth(2026, 5, 12)).toEqual({ year: 2027, month: 5 });
  });
});

describe("weekStart", () => {
  it("answers a day from 1 to 7, Monday for an unreadable tag", () => {
    const d = weekStart("en-US");
    expect(d >= 1 && d <= 7).toBe(true);
    expect(weekStart("not a locale!!")).toBe(1);
  });
});
