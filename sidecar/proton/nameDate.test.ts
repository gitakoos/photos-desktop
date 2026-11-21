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
const read = (name: string) => dateFromName(name, NOW);

describe("the date a file name gives", () => {
  it("reads what phones and cameras write", () => {
    expect(read("IMG_20230512_141502.jpg")).toBe(at(2023, 5, 12, 14, 15, 2));
    expect(read("VID_20230512_141502.mp4")).toBe(at(2023, 5, 12, 14, 15, 2));
    expect(read("PXL_20230512_141502123.jpg")).toBe(at(2023, 5, 12, 14, 15, 2));
    expect(read("Screenshot_2023-05-12-14-15-02.png")).toBe(at(2023, 5, 12, 14, 15, 2));
    expect(read("Screenshot_20230512-141502_Chrome.jpg")).toBe(at(2023, 5, 12, 14, 15, 2));
    expect(read("Screenshot_20251023-063422 (2).png")).toBe(at(2025, 10, 23, 6, 34, 22));
    expect(read("20230512_141502.heic")).toBe(at(2023, 5, 12, 14, 15, 2));
    expect(read("20230512141502.png")).toBe(at(2023, 5, 12, 14, 15, 2));
    expect(read("20201113115527539.png")).toBe(at(2020, 11, 13, 11, 55, 27));
    expect(read("20230512_14-15-02.jpg")).toBe(at(2023, 5, 12, 14, 15, 2));
    expect(read("Photo 2023-05-12 14.15.02.jpeg")).toBe(at(2023, 5, 12, 14, 15, 2));
    expect(read("Photo 2023-05-12 14.15.02")).toBe(at(2023, 5, 12, 14, 15, 2));
    expect(read("2023-05-12 09-05.jpg")).toBe(at(2023, 5, 12, 9, 5, 0));
    expect(read("2023-05-12 14h15m02.jpg")).toBe(at(2023, 5, 12, 14, 15, 2));
    expect(read("2023-05-12-141502123.jpg")).toBe(at(2023, 5, 12, 14, 15, 2));
    expect(read("VID_20230630_081542_edited.mp4")).toBe(at(2023, 6, 30, 8, 15, 42));
  });

  it("reads the desktop screenshot and download names, 24- and 12-hour", () => {
    expect(read("WhatsApp Image 2023-01-15 at 12.34.56.jpeg")).toBe(at(2023, 1, 15, 12, 34, 56));
    expect(read("Screenshot 2023-01-15 at 1.34.56 PM.png")).toBe(at(2023, 1, 15, 13, 34, 56));
    expect(read("Screen Shot 2023-01-15 at 12.05.00 AM.png")).toBe(at(2023, 1, 15, 0, 5, 0));
    // An hour that cannot carry PM is no clock, and a word starting with "am" is no marker.
    expect(read("Screenshot 2023-01-15 at 13.34.56 PM.png")).toBe(at(2023, 1, 15));
    expect(read("2023-01-15 12-34-56 amsterdam.jpg")).toBe(at(2023, 1, 15, 12, 34, 56));
  });

  it("takes a date with no time as noon of that day", () => {
    expect(read("IMG-20230512-WA0001.jpg")).toBe(at(2023, 5, 12));
    expect(read("signal-2023-05-12.jpg")).toBe(at(2023, 5, 12));
    expect(read("20230512.jpg")).toBe(at(2023, 5, 12));
    expect(read("2023.05.12.jpg")).toBe(at(2023, 5, 12));
    expect(read("2023_05_12.jpg")).toBe(at(2023, 5, 12));
    expect(read("2023-5-2.jpg")).toBe(at(2023, 5, 2));
    expect(read("download-2023-06-30-final.jpg")).toBe(at(2023, 6, 30));
  });

  it("reads the messengers that name a photo by when it was sent", () => {
    expect(read("signal-2023-01-15-123456.jpg")).toBe(at(2023, 1, 15, 12, 34, 56));
    expect(read("signal-2023-01-15-123456-789.jpg")).toBe(at(2023, 1, 15, 12, 34, 56));
    expect(read("photo_2023-01-15_12-34-56.jpg")).toBe(at(2023, 1, 15, 12, 34, 56));
    expect(read("wx_camera_1575633157591.jpg")).toBe(1575633157591);
  });

  it("does not read a save time or an id as the day a photo was taken", () => {
    expect(read("FB_IMG_15756331575910230.jpg")).toBeNull();
    expect(read("FB_IMG_1575633157591.jpg")).toBeNull();
    expect(read("FB_VID_1625978349123.mp4")).toBeNull();
    expect(read("received_1608189165889774.jpeg")).toBeNull();
    expect(read("received_677782159720702.jpeg")).toBeNull();
    expect(read("mmexport1575633157591.jpg")).toBeNull();
    expect(read("Censored Camera Editor_1541691423899.png")).toBeNull();
    expect(read("1575633157591.jpg")).toBeNull();
    expect(read("1673789696.jpg")).toBeNull();
    expect(read("1234567890123456789.jpg")).toBeNull();
    expect(read("219056359_4SZ.jpg")).toBeNull();
    // A WeChat camera stamp from before WeChat, or still to come, is no stamp.
    expect(read("wx_camera_1000000000000.jpg")).toBeNull();
    expect(read("wx_camera_2600000000000.jpg")).toBeNull();
  });

  it("reads a year-trailing date only when day and month cannot swap", () => {
    expect(read("Foto 31.01.2023.jpg")).toBe(at(2023, 1, 31));
    expect(read("scan_01-31-2023.jpg")).toBe(at(2023, 1, 31));
    expect(read("05.05.2023.jpg")).toBe(at(2023, 5, 5));
    expect(read("03-04-2023.jpg")).toBeNull();
    expect(read("31-13-2023.jpg")).toBeNull();
    expect(read("31.04.2023.jpg")).toBeNull();
  });

  it("gives nothing for a name that only looks like it holds a date", () => {
    expect(read("DSC_0042.JPG")).toBeNull();
    expect(read("IMG_1234.jpg")).toBeNull();
    expect(read("meme.jpg")).toBeNull();
    expect(read("")).toBeNull();
    expect(read("IMG_20231332_101010.jpg")).toBeNull();
    expect(read("IMG_20230431_101010.jpg")).toBeNull();
    expect(read("20210230.jpg")).toBeNull();
    expect(read("2023-13-01.jpg")).toBeNull();
    expect(read("20209913115527539.png")).toBeNull();
    expect(read("photo_120230512.jpg")).toBeNull();
    expect(read("IMG_19800101_120000.jpg")).toBeNull();
    expect(read("19891231.jpg")).toBeNull();
    expect(read("IMG_20990101_120000.jpg")).toBeNull();
    expect(read("2099-12-31.jpg")).toBeNull();
  });

  it("keeps the date when the digits after it are no time of day", () => {
    expect(read("IMG_20230512_256199.jpg")).toBe(at(2023, 5, 12));
    expect(read("SquareQuick_20191212594755")).toBe(at(2019, 12, 12));
  });

  it("allows a day ahead, for today's noon read in the morning, and no more", () => {
    const morning = new Date(2026, 9, 24, 9, 0, 0).getTime();
    expect(dateFromName("IMG-20261024-WA0001.jpg", morning)).toBe(at(2026, 10, 24));
    expect(dateFromName("IMG-20261026-WA0001.jpg", morning)).toBeNull();
    expect(dateFromName("IMG_20261026_090000.jpg", morning)).toBeNull();
    expect(dateFromName("IMG_20990101_120000.jpg", morning)).toBeNull();
  });
});
