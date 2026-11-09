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

import { dateFromName } from "./nameDate.ts";

const NOW = new Date(2026, 9, 24, 12, 0, 0).getTime();
const at = (y: number, mo: number, d: number, h = 12, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

describe("the date a file name gives", () => {
  it("reads what phones and cameras write", () => {
    expect(dateFromName("IMG_20230512_141502.jpg", NOW)).toBe(at(2023, 5, 12, 14, 15, 2));
    expect(dateFromName("VID_20230512_141502.mp4", NOW)).toBe(at(2023, 5, 12, 14, 15, 2));
    expect(dateFromName("PXL_20230512_141502123.jpg", NOW)).toBe(at(2023, 5, 12, 14, 15, 2));
    expect(dateFromName("Screenshot_2023-05-12-14-15-02.png", NOW)).toBe(at(2023, 5, 12, 14, 15, 2));
    expect(dateFromName("Screenshot_20230512-141502_Chrome.jpg", NOW)).toBe(at(2023, 5, 12, 14, 15, 2));
    expect(dateFromName("20230512_141502.heic", NOW)).toBe(at(2023, 5, 12, 14, 15, 2));
    expect(dateFromName("Photo 2023-05-12 14.15.02.jpeg", NOW)).toBe(at(2023, 5, 12, 14, 15, 2));
  });

  it("takes a date with no time as noon of that day", () => {
    expect(dateFromName("IMG-20230512-WA0001.jpg", NOW)).toBe(at(2023, 5, 12));
    expect(dateFromName("signal-2023-05-12.jpg", NOW)).toBe(at(2023, 5, 12));
  });

  it("gives nothing for a name that only looks like it holds a date", () => {
    expect(dateFromName("DSC_0042.JPG", NOW)).toBeNull();
    expect(dateFromName("IMG_20231332_101010.jpg", NOW)).toBeNull();
    expect(dateFromName("IMG_20230431_101010.jpg", NOW)).toBeNull();
    expect(dateFromName("IMG_20230512_256199.jpg", NOW)).toBe(at(2023, 5, 12));
    expect(dateFromName("photo_120230512.jpg", NOW)).toBeNull();
    expect(dateFromName("IMG_19800101_120000.jpg", NOW)).toBeNull();
    expect(dateFromName("IMG_20990101_120000.jpg", NOW)).toBeNull();
  });

  it("allows a day ahead, for today's noon read in the morning, and no more", () => {
    const morning = new Date(2026, 9, 24, 9, 0, 0).getTime();
    expect(dateFromName("IMG-20261024-WA0001.jpg", morning)).toBe(at(2026, 10, 24));
    expect(dateFromName("IMG-20261026-WA0001.jpg", morning)).toBeNull();
    expect(dateFromName("IMG_20261026_090000.jpg", morning)).toBeNull();
    expect(dateFromName("IMG_20990101_120000.jpg", morning)).toBeNull();
  });
});
