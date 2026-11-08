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
import { cardMatches, queryWords } from "./settingsSearch";

describe("the settings search", () => {
  it("needs every word, in any order and part of a word", () => {
    const words = queryWords("  explorer  FOLD ");
    expect(words).toEqual(["explorer", "fold"]);
    expect(cardMatches("Show the folder in File Explorer", words)).toBe(true);
    expect(cardMatches("File Explorer", words)).toBe(false);
  });

  it("finds a word whatever its accents", () => {
    expect(cardMatches("Arcfelismerés", queryWords("arcfelismeres"))).toBe(true);
    expect(cardMatches("Arcfelismeres", queryWords("ARCFELISMERÉS"))).toBe(true);
  });

  it("matches nothing for an empty search", () => {
    expect(cardMatches("Theme", queryWords("   "))).toBe(false);
    expect(cardMatches(null, queryWords("theme"))).toBe(false);
  });
});
