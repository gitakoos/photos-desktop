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
import { onThisDay, seasons } from "./memories";

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

describe("on this day", () => {
  it("finds today's date 1, 2, 5 and 10 years back, the day itself only", () => {
    const now = new Date(2026, 9, 19, 9);
    const items = [
      { uid: "1y", captureTime: at(2025, 10, 19) },
      { uid: "1y-late", captureTime: at(2025, 10, 19, 23) },
      { uid: "1y-next", captureTime: at(2025, 10, 20, 0) },
      { uid: "3y", captureTime: at(2023, 10, 19) },
      { uid: "5y", captureTime: at(2021, 10, 19) },
    ];
    expect(onThisDay(items, now)).toEqual([
      { yearsAgo: 1, uids: ["1y", "1y-late"] },
      { yearsAgo: 5, uids: ["5y"] },
    ]);
  });

  it("reads 29 February as the 28th in a year without one", () => {
    const now = new Date(2028, 1, 29, 9);
    expect(onThisDay([{ uid: "a", captureTime: at(2027, 2, 28) }], now)).toEqual([{ yearsAgo: 1, uids: ["a"] }]);
  });
});

describe("seasons", () => {
  it("puts January and February into the winter that began the December before, latest first", () => {
    const items = [
      { uid: "feb24", captureTime: at(2024, 2, 10) },
      { uid: "dec23", captureTime: at(2023, 12, 25) },
      { uid: "jul23", captureTime: at(2023, 7, 1) },
      { uid: "apr23", captureTime: at(2023, 4, 1) },
      { uid: "unknown", captureTime: 0 },
    ];
    expect(seasons(items)).toEqual([
      { season: "winter", year: 2023, uids: ["feb24", "dec23"] },
      { season: "summer", year: 2023, uids: ["jul23"] },
      { season: "spring", year: 2023, uids: ["apr23"] },
    ]);
  });
});
