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
import type { DateEditInfo } from "./dateEdit";
import { placeChange } from "./placeEdit";
import { parseCities, searchCities } from "./geocoder";

const photo = (over: Partial<DateEditInfo> = {}): DateEditInfo => ({
  uid: "v~a",
  name: "IMG_1.jpg",
  captureMs: 1,
  nameMs: null,
  place: null,
  blocked: null,
  ...over,
});

describe("placeChange", () => {
  const budapest = { lat: 47.4979, lon: 19.0402 };

  it("waits for a choice, then sets the place", () => {
    expect(placeChange(photo(), undefined)).toEqual({ kind: "pick" });
    expect(placeChange(photo(), budapest)).toEqual({ kind: "change", place: budapest });
  });

  it("leaves a photo already there, and one with no place to take away, alone", () => {
    expect(placeChange(photo({ place: [47.4979, 19.0402] }), budapest)).toEqual({ kind: "same" });
    expect(placeChange(photo(), null)).toEqual({ kind: "nothing" });
    expect(placeChange(photo({ place: [1, 2] }), null)).toEqual({ kind: "change", place: null });
  });

  it("says why a photo cannot be changed", () => {
    expect(placeChange(photo({ blocked: "live" }), budapest)).toEqual({ kind: "live" });
    expect(placeChange(photo({ blocked: "type" }), null)).toEqual({ kind: "type" });
  });
});

describe("searchCities", () => {
  const index = parseCities(
    ["Budaörs\t47.46\t18.96\tHU", "Budapest\t47.50\t19.04\tHU", "Érd\t47.39\t18.91\tHU", "Szentendre\t47.67\t19.08\tHU"].join("\n"),
  );

  it("puts the names that start with the query first, the shorter first", () => {
    expect(searchCities(index, "bud", 5).map((c) => c.name)).toEqual(["Budaörs", "Budapest"]);
    expect(searchCities(index, "end", 5).map((c) => c.name)).toEqual(["Szentendre"]);
  });

  it("reads past accents and case, and answers nothing for an empty query", () => {
    expect(searchCities(index, "ERD", 5).map((c) => c.name)).toEqual(["Érd"]);
    expect(searchCities(index, "  ", 5)).toEqual([]);
  });
});
