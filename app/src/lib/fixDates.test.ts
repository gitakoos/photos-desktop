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

import { dateFromName, dateProblem } from "./fixDates";

const NOW = new Date(2026, 10, 6, 12, 0, 0).getTime();
const at = (y: number, mo: number, d: number, h = 12, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

describe("the photos the Fix dates page lists", () => {
  it("lists a photo with no date", () => {
    expect(dateProblem(0, "DSC_0042.JPG", NOW)).toEqual({ kind: "none" });
    expect(dateProblem(Date.UTC(1970, 0, 1, 5), null, NOW)).toEqual({ kind: "none" });
    expect(dateProblem(Number.NaN, null, NOW)).toEqual({ kind: "none" });
  });

  it("lists a date still to come, but not one a time zone away", () => {
    expect(dateProblem(at(2031, 3, 1), "DSC_0042.JPG", NOW)).toEqual({ kind: "future" });
    expect(dateProblem(NOW + 6 * 3600_000, "DSC_0042.JPG", NOW)).toBeNull();
  });

  it("lists a photo whose name records another day", () => {
    expect(dateProblem(at(2025, 1, 20), "IMG_20240312_101500.jpg", NOW)).toEqual({
      kind: "name",
      nameMs: at(2024, 3, 12, 10, 15, 0),
    });
    expect(dateProblem(at(2025, 1, 20), "IMG-20240312-WA0001.jpg", NOW)).toEqual({ kind: "name", nameMs: at(2024, 3, 12) });
  });

  it("leaves a name and a date that agree within a couple of days", () => {
    expect(dateProblem(at(2024, 3, 12, 23, 50), "IMG_20240313_005000.jpg", NOW)).toBeNull();
    expect(dateProblem(at(2024, 3, 13, 9), "IMG-20240312-WA0001.jpg", NOW)).toBeNull();
  });

  it("leaves a photo whose name holds no date, and an old photo dated on purpose", () => {
    expect(dateProblem(at(2019, 7, 1), "DSC_0042.JPG", NOW)).toBeNull();
    expect(dateProblem(at(1985, 7, 1), "scan_004.png", NOW)).toBeNull();
    expect(dateProblem(at(2019, 7, 1), null, NOW)).toBeNull();
  });

  it("reads a name the way the date editor does", () => {
    expect(dateFromName("Screenshot_2023-05-12-14-15-02.png", NOW)).toBe(at(2023, 5, 12, 14, 15, 2));
    expect(dateFromName("IMG_20230431_101010.jpg", NOW)).toBeNull();
    expect(dateFromName("IMG_20990101_120000.jpg", NOW)).toBeNull();
  });
});
