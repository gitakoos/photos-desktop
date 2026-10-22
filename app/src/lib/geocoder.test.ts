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
import { groupByCity, nearestCity, parseCities } from "./geocoder";
import citiesText from "../assets/geo/cities15000.tsv?raw";

const shipped = parseCities(citiesText);

describe("the town a place is in", () => {
  it("is the nearest town of the shipped list", () => {
    expect(nearestCity(shipped, 47.4979, 19.0402)).toMatchObject({ name: "Budapest", country: "HU" });
    expect(nearestCity(shipped, 41.3874, 2.1686)?.country).toBe("ES");
    expect(nearestCity(shipped, 51.5072, -0.1276)?.country).toBe("GB");
  });

  it("looks past its own cell when the nearest town is across a line of longitude", () => {
    const index = parseCities("West\t10.5\t9.95\tAA\nFar\t10.5\t9.0\tAA\n");
    expect(nearestCity(index, 10.5, 10.02)?.name).toBe("West");
  });

  it("is none in the middle of the ocean", () => {
    expect(nearestCity(shipped, -40, -120)).toBeNull();
  });
});

describe("photos grouped by town", () => {
  it("puts the town with the most photos first", () => {
    const index = parseCities("A\t1.5\t1.5\tAA\nB\t5.5\t5.5\tBB\n");
    const places = groupByCity(index, [{ lat: 1.4, lon: 1.6 }, { lat: 5.4, lon: 5.6 }, { lat: 5.6, lon: 5.4 }], (p) => p);
    expect(places.map((p) => [p.city.name, p.items.length])).toEqual([
      ["B", 2],
      ["A", 1],
    ]);
  });
});
