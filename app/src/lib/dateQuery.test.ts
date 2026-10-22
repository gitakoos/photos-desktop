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
import { dateLabel, inDate, parseDateQuery } from "./dateQuery";

describe("a date typed into the search", () => {
  it("reads a month and a year in either order, whole or short", () => {
    expect(parseDateQuery("2026 január", "hu")).toEqual({ year: 2026, month: 1, rest: "" });
    expect(parseDateQuery("január 2026", "hu")).toEqual({ year: 2026, month: 1, rest: "" });
    expect(parseDateQuery("jan 2026", "hu")).toEqual({ year: 2026, month: 1, rest: "" });
    expect(parseDateQuery("2026 szept.", "hu")).toEqual({ year: 2026, month: 9, rest: "" });
    expect(parseDateQuery("Jan 2026", "en")).toEqual({ year: 2026, month: 1, rest: "" });
  });

  it("takes a year or a month alone, and keeps the words before it for the text search", () => {
    expect(parseDateQuery("budapest 2024", "en")).toEqual({ year: 2024, month: null, rest: "budapest" });
    expect(parseDateQuery("beach july", "en")).toEqual({ year: null, month: 7, rest: "beach" });
  });

  it("is no month for a word that only starts like one, or that names two", () => {
    expect(parseDateQuery("janu", "en")).toBeNull();
    expect(parseDateQuery("marble", "en")).toBeNull();
    // Czech "čer" starts both červen and červenec.
    expect(parseDateQuery("čer", "cs")).toBeNull();
  });

  it("counts another language's month from four letters only", () => {
    expect(parseDateQuery("januar 2025", "en")).toEqual({ year: 2025, month: 1, rest: "" });
    expect(parseDateQuery("set", "en")).toBeNull();
  });

  it("is no year outside the plausible range or of the wrong length", () => {
    expect(parseDateQuery("1234", "en")).toBeNull();
    expect(parseDateQuery("202", "en")).toBeNull();
  });

  it("matches the photos of the month, of the year, or of that month every year", () => {
    const jan26 = new Date(2026, 0, 10).getTime();
    const jan25 = new Date(2025, 0, 10).getTime();
    expect(inDate(jan26, { year: 2026, month: 1, rest: "" })).toBe(true);
    expect(inDate(jan25, { year: 2026, month: 1, rest: "" })).toBe(false);
    expect(inDate(jan25, { year: null, month: 1, rest: "" })).toBe(true);
    expect(inDate(jan25, { year: 2025, month: null, rest: "" })).toBe(true);
    expect(inDate(0, { year: 2025, month: null, rest: "" })).toBe(false);
  });

  it("labels the date in the app's language", () => {
    expect(dateLabel({ year: 2026, month: 1, rest: "" }, "en")).toBe("January 2026");
    expect(dateLabel({ year: 2026, month: null, rest: "" }, "en")).toBe("2026");
    expect(dateLabel({ year: null, month: 3, rest: "" }, "en")).toBe("March");
  });
});
