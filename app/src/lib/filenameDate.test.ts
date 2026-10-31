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

import { dateNeedsFix, parseFilenameCapture, parseFilenameDate } from "./filenameDate";

/**
 * Pins the filename date reader: the whole point is that a no-EXIF meme gets its real date
 * from its name and never a wrong one from a random digit run, so the assertions hold every
 * shape it must read and every non-date it must reject. Both sides convert through the
 * same local-zone Date, so the assertions hold in whatever zone the runner sits in.
 */
describe("parseFilenameDate", () => {
  // A ceiling far enough ahead that every 2023 date is in the past and a 2099 one is the future.
  const now = ms(2030, 1, 1, 0, 0, 0);

  function ms(y: number, mo: number, d: number, h: number, mi: number, s: number): number {
    return new Date(y, mo - 1, d, h, mi, s).getTime();
  }

  const parse = (name: string) => parseFilenameDate(name, now);

  it("reads a camera date and time", () => {
    const expected = ms(2023, 1, 15, 12, 34, 56);
    expect(parse("IMG_20230115_123456.jpg")).toBe(expected);
    expect(parse("VID_20230115_123456.mp4")).toBe(expected);
    expect(parse("PXL_20230115_123456.jpg")).toBe(expected);
    expect(parse("20230115_123456")).toBe(expected);
    expect(parse("20230115123456.png")).toBe(expected);
    expect(parse("20230115-123456.jpg")).toBe(expected);
  });

  it("reads a compact screenshot name with a copy suffix", () => {
    // The exact shape a duplicated Android screenshot carries: a Screenshot_ prefix, the
    // compact yyyyMMdd-HHmmss, then a " (2)" copy marker after the time. The date is read,
    // the marker ignored.
    expect(parse("Screenshot_20251023-063422 (2).png")).toBe(ms(2025, 10, 23, 6, 34, 22));
  });

  it("reads a separated date with a time", () => {
    expect(parse("Screenshot_2023-01-15-12-34-56.png")).toBe(ms(2023, 1, 15, 12, 34, 56));
    expect(parse("2023-01-15 09-05.jpg")).toBe(ms(2023, 1, 15, 9, 5, 0));
  });

  it("lands a date-only name at noon", () => {
    const noon = ms(2023, 1, 15, 12, 0, 0);
    expect(parse("IMG-20230115-WA0001.jpg")).toBe(noon);
    expect(parse("20230115.jpg")).toBe(noon);
    expect(parse("2023-01-15.png")).toBe(noon);
    expect(parse("2023.01.15.jpg")).toBe(noon);
    expect(parse("2023_01_15.jpg")).toBe(noon);
    expect(parse("Screenshot_2023-01-15.png")).toBe(noon);
  });

  it("falls back to the date when the time is invalid", () => {
    // Hour 25 is not a real time, so the date alone is read and lands at noon.
    expect(parse("20230115_256789.jpg")).toBe(ms(2023, 1, 15, 12, 0, 0));
  });

  it("falls back to the date when a contiguous run carries a non-time counter", () => {
    // SquareQuick appends a counter, not a clock: 20191212 then 594755 (an impossible
    // 59:47:55). With no separator the bare-date pattern cannot split the run, so the
    // datetime match's date is read.
    expect(parse("SquareQuick_20191212594755")).toBe(ms(2019, 12, 12, 12, 0, 0));
  });

  it("tolerates a sub-second suffix after the time", () => {
    // A 14-digit yyyyMMddHHmmss immediately followed by a 3-digit millisecond tail still reads.
    expect(parse("20201113115527539.png")).toBe(ms(2020, 11, 13, 11, 55, 27));
    expect(parse("20209913115527539.png")).toBeNull(); // month 99, even with a millis tail, stays rejected
  });

  it("returns null when there is no readable date", () => {
    expect(parse("meme.jpg")).toBeNull();
    expect(parse("funny_cat.png")).toBeNull();
    expect(parse("")).toBeNull();
    expect(parse("photo")).toBeNull();
    expect(parse("IMG_1234.jpg")).toBeNull();
  });

  it("rejects impossible calendar dates", () => {
    expect(parse("20211345.jpg")).toBeNull(); // month 13
    expect(parse("20210230.jpg")).toBeNull(); // 30 February
    expect(parse("2023-13-01.jpg")).toBeNull(); // month 13, separated
  });

  it("rejects dates before 1990 and in the future", () => {
    expect(parse("19891231.jpg")).toBeNull(); // before the floor
    expect(parse("20991231.jpg")).toBeNull(); // after now (2030)
    expect(parse("2099-12-31.jpg")).toBeNull();
  });

  it("does not read a bare ten-digit number as a date", () => {
    // A random 10-digit meme id must not be guessed into a plausible date.
    expect(parse("1673789696.jpg")).toBeNull();
    expect(parse("1234567890.png")).toBeNull();
  });

  it("reads a unix stamp an app saved the file under", () => {
    // `<app>_<Date.now()>`: thirteen digits are milliseconds, wherever they sit.
    expect(parse("Censored Camera Editor_1541691423899.png")).toBe(1541691423899);
    expect(parse("1575633157591.jpg")).toBe(1575633157591);
    expect(parse("IMG_1575633157591.jpg")).toBe(1575633157591);
    // Seconds with a tail after a word: the leading ten digits.
    expect(parse("IMG_156321213357F.jpg")).toBe(1563212133000);
    expect(parse("image-1563212133.jpg")).toBe(1563212133000);
    // Outside the window it is an id, not a date: the year 2266, or before 2005.
    expect(parse("received_934356540367769.jpeg")).toBeNull();
    expect(parse("photo_1000000000000.jpg")).toBeNull();
  });

  it("reads the unix millisecond stamp the social download names carry", () => {
    // Facebook's FB_IMG_…: the leading 13 digits are the stamp, the rest is a random id.
    expect(parse("FB_IMG_15756331575910230.jpg")).toBe(1575633157591);
    // An exact 13-digit stamp past the same prefix reads the same way.
    expect(parse("FB_IMG_1575633157591.jpg")).toBe(1575633157591);
    // Its video and temporary forms share the stamp.
    expect(parse("FB_VID_1625978349123.jpg")).toBe(1625978349123);
    expect(parse("FB_TEMP_1625978349123904.jpg")).toBe(1625978349123);
    // Messenger's received_…: same rule, whatever the id's length over 13.
    expect(parse("received_1608189165889774.jpeg")).toBe(1608189165889);
    expect(parse("received_1608189165889.jpg")).toBe(1608189165889);
  });

  it("rejects social runs that do not decode to a sane stamp", () => {
    // A 15-digit id whose leading stamp would decode to a date inside 2184 stays unread.
    expect(parse("received_677782159720702.jpeg")).toBeNull();
    // Future stamps (after the 2030 ceiling) exceed any capture time the file could claim.
    expect(parse("received_2600000000000000.jpeg")).toBeNull();
    // A stamp older than the app that writes the name is a misread id, not a date.
    expect(parse("FB_IMG_1000000000000.jpg")).toBeNull();
    // Too short to be a millisecond stamp is just an id.
    expect(parse("FB_IMG_163003211.jpg")).toBeNull();
    // A _4SZ-style suffix without a stamp-shaped run stays unread, like any random id.
    expect(parse("219056359_4SZ.jpg")).toBeNull();
  });

  it("reads the messaging-app and desktop shapes", () => {
    // Signal: a separated date with a compact time, sometimes a millisecond tail.
    expect(parse("signal-2023-01-15-123456.jpg")).toBe(ms(2023, 1, 15, 12, 34, 56));
    expect(parse("signal-2023-01-15-123456-789.jpg")).toBe(ms(2023, 1, 15, 12, 34, 56));
    // Telegram desktop.
    expect(parse("photo_2023-01-15_12-34-56.jpg")).toBe(ms(2023, 1, 15, 12, 34, 56));
    // WhatsApp desktop and the macOS screenshot, 24- and 12-hour.
    expect(parse("WhatsApp Image 2023-01-15 at 12.34.56.jpeg")).toBe(ms(2023, 1, 15, 12, 34, 56));
    expect(parse("Screenshot 2023-01-15 at 1.34.56 PM.png")).toBe(ms(2023, 1, 15, 13, 34, 56));
    expect(parse("Screen Shot 2023-01-15 at 12.05.00 AM.png")).toBe(ms(2023, 1, 15, 0, 5, 0));
    // A 12-hour marker on an hour that cannot be one is not a clock: date at noon.
    expect(parse("Screenshot 2023-01-15 at 13.34.56 PM.png")).toBe(ms(2023, 1, 15, 12, 0, 0));
    // WeChat exports carry a unix millisecond stamp.
    expect(parse("mmexport1575633157591.jpg")).toBe(1575633157591);
    expect(parse("wx_camera_1575633157591.jpg")).toBe(1575633157591);
  });

  it("reads a year-trailing date only when its day/month order is certain", () => {
    expect(parse("Foto 31.01.2023.jpg")).toBe(ms(2023, 1, 31, 12, 0, 0));
    expect(parse("scan_01-31-2023.jpg")).toBe(ms(2023, 1, 31, 12, 0, 0));
    expect(parse("05.05.2023.jpg")).toBe(ms(2023, 5, 5, 12, 0, 0));
    // 03-04 is March in one locale and April in another: left unread.
    expect(parse("03-04-2023.jpg")).toBeNull();
    expect(parse("31-13-2023.jpg")).toBeNull();
  });

  it("handles every sample shape a real library throws at it", () => {
    expect(parse("FB_IMG_15756331575910230.jpg")).toBe(1575633157591);
    expect(parse("219056359_4SZ.jpg")).toBeNull();
    expect(parse("IMG-20261011-WA0009.jpg")).toBe(ms(2026, 10, 11, 12, 0, 0));
    expect(parse("20261003_090328.mp4")).toBe(ms(2026, 10, 3, 9, 3, 28));
    expect(parse("received_1608189165889774.jpeg")).toBe(1608189165889);
    expect(parse("received_677782159720702.jpeg")).toBeNull();
  });

  it("finds a date embedded among other text", () => {
    expect(parse("download-2023-06-30-final.jpg")).toBe(ms(2023, 6, 30, 12, 0, 0));
    expect(parse("VID_20230630_081542_edited.mp4")).toBe(ms(2023, 6, 30, 8, 15, 42));
  });
});

describe("parseFilenameCapture", () => {
  const now = new Date(2030, 0, 1, 0, 0, 0).getTime();
  const parse = (name: string) => parseFilenameCapture(name, now);

  it("vouches for a time only when the name really records one", () => {
    expect(parse("IMG_20230115_123456.jpg")).toEqual({ ms: new Date(2023, 0, 15, 12, 34, 56).getTime(), withTime: true });
    expect(parse("Screenshot_2023-01-15-12-34.png")).toEqual({ ms: new Date(2023, 0, 15, 12, 34, 0).getTime(), withTime: true });
    // A date-only name lands at noon and wears the noon rule, not a claimed time.
    expect(parse("IMG-20230115-WA0001.jpg")).toEqual({ ms: new Date(2023, 0, 15, 12, 0, 0).getTime(), withTime: false });
    // A counter posing as a clock is not a time either: the fallback is noon and honest.
    expect(parse("20230115_256789.jpg")).toEqual({ ms: new Date(2023, 0, 15, 12, 0, 0).getTime(), withTime: false });
    // A social stamp is what it is: an exact millisecond instant.
    expect(parse("FB_IMG_15756331575910230.jpg")).toEqual({ ms: 1575633157591, withTime: true });
  });
});

describe("dateNeedsFix", () => {
  const day = (y: number, mo: number, d: number, h: number, mi: number, s: number) =>
    new Date(y, mo - 1, d, h, mi, s).getTime();

  it("is true only when Drive shows another calendar day", () => {
    const full = { ms: day(2023, 1, 15, 12, 34, 56), withTime: true };
    expect(dateNeedsFix(full, day(2023, 1, 15, 12, 34, 56))).toBe(false);
    // Another time on the same day is not the fix's business: only the day is.
    expect(dateNeedsFix(full, day(2023, 1, 15, 18, 5, 0))).toBe(false);
    expect(dateNeedsFix(full, day(2023, 1, 15, 0, 0, 1))).toBe(false);
    // Another day, month or year is exactly what the tool exists to repair.
    expect(dateNeedsFix(full, day(2023, 1, 17, 12, 0, 0))).toBe(true);
    expect(dateNeedsFix(full, day(2023, 2, 15, 12, 0, 0))).toBe(true);
    expect(dateNeedsFix(full, day(2024, 1, 15, 12, 0, 0))).toBe(true);
  });

  it("accepts the camera's wall clock stored as UTC, the way Proton long saved it", () => {
    // Taken at 04:17:56 on 17 Nov; Drive reads 04:17:56Z. Whatever this machine's zone,
    // that is the named day, even where the same instant is the 16th or 18th locally.
    const named = { ms: day(2024, 11, 17, 4, 17, 56), withTime: true };
    expect(dateNeedsFix(named, Date.UTC(2024, 10, 17, 4, 17, 56))).toBe(false);
    expect(dateNeedsFix(named, Date.UTC(2024, 10, 17, 23, 59, 0))).toBe(false);
    expect(dateNeedsFix(named, Date.UTC(2024, 10, 19, 4, 17, 56))).toBe(true);
  });

  it("is true when the photo carries no cloud date and false for an empty capture", () => {
    expect(dateNeedsFix({ ms: day(2023, 1, 15, 12, 0, 0), withTime: false }, 0)).toBe(true);
    expect(dateNeedsFix({ ms: day(2023, 1, 15, 12, 0, 0), withTime: false }, NaN)).toBe(true);
    expect(dateNeedsFix({ ms: 0, withTime: true }, 0)).toBe(false);
  });
});
