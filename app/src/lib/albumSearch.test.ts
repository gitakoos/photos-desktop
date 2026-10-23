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
import { filterAlbums, foldName } from "./albumSearch";

const albums = [{ name: "Budapest" }, { name: "Prága" }, { name: "Erasmus- Póvoa de Varzim - 2023" }, { name: "" }];

describe("the album search", () => {
  it("folds accents and case", () => {
    expect(foldName("  ÁRVÍZTŰRŐ Tükörfúrógép ")).toBe("arvizturo tukorfurogep");
  });

  it("matches a part of the name without accents or case", () => {
    expect(filterAlbums(albums, "praga").map((a) => a.name)).toEqual(["Prága"]);
    expect(filterAlbums(albums, "POVOA").map((a) => a.name)).toEqual(["Erasmus- Póvoa de Varzim - 2023"]);
    expect(filterAlbums(albums, "a").length).toBe(3);
  });

  it("keeps every album, in order, for an empty or blank query", () => {
    expect(filterAlbums(albums, "")).toBe(albums);
    expect(filterAlbums(albums, "   ")).toBe(albums);
  });

  it("finds nothing for a name that is not there", () => {
    expect(filterAlbums(albums, "wien")).toEqual([]);
  });
});
