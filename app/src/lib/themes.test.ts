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
import { cs } from "./locales/cs";
import { de } from "./locales/de";
import { en } from "./locales/en";
import { es } from "./locales/es";
import { fr } from "./locales/fr";
import { hu } from "./locales/hu";
import { it as itLocale } from "./locales/it";
import { nl } from "./locales/nl";
import { pl } from "./locales/pl";
import { sk } from "./locales/sk";
import { sl } from "./locales/sl";
import { foldThemeText, matchTheme, pillsByItself, themeEntries, themeNameKey, themePhotos, THEME_NAMES } from "./themes";

const SLUGS = [
  "food", "pets", "animals", "beach", "mountains", "nature", "flowers", "city", "night", "sunsets",
  "sky", "snow", "portraits", "group_photos", "celebrations", "sports", "cars", "documents",
  "screenshots", "drawings",
];

describe("the theme names", () => {
  it("exist for all twenty themes and the section title in every locale", () => {
    const dicts = { en, cs, de, es, fr, hu, it: itLocale, nl, pl, sk, sl } as Record<string, Record<string, string>>;
    expect(Object.keys(dicts)).toHaveLength(11);
    for (const [lang, dict] of Object.entries(dicts)) {
      expect(dict["library.themes"], `${lang} library.themes`).toBeTruthy();
      for (const slug of SLUGS) expect(dict[themeNameKey(slug)], `${lang} ${slug}`).toBeTruthy();
    }
  });
});

describe("matching a typed word to a theme", () => {
  it("finds a theme by its name in any language, ignoring case and accents", () => {
    expect(matchTheme("Beach")).toBe("beach");
    expect(matchTheme("  strand ")).toBe("beach");
    expect(matchTheme("PLAYA")).toBe("beach");
    expect(matchTheme("Tengerpart")).toBe("beach");
    expect(matchTheme("naplementek")).toBe("sunsets");
    expect(matchTheme("Sonnenuntergange")).toBe("sunsets");
    expect(matchTheme("Cibo")).toBe("food");
  });

  it("accepts a simple plural of a name, in either direction", () => {
    expect(matchTheme("beaches")).toBe("beach");
    expect(matchTheme("flower")).toBe("flowers");
    expect(matchTheme("flowers")).toBe("flowers");
    expect(matchTheme("pet")).toBe("pets");
    expect(matchTheme("cars")).toBe("cars");
  });

  it("never matches under three characters or an unrelated word", () => {
    expect(matchTheme("be")).toBeNull();
    expect(matchTheme("a")).toBeNull();
    expect(matchTheme("")).toBeNull();
    expect(matchTheme("beachball")).toBeNull();
    expect(matchTheme("mum and dad")).toBeNull();
  });

  it("matches against any table it is given", () => {
    const names = new Map([["x", new Set([foldThemeText("Dîner")])]]);
    expect(matchTheme("diner", names)).toBe("x");
    expect(matchTheme("beach", names)).toBeNull();
    expect(THEME_NAMES.has("food")).toBe(true);
  });
});

describe("the theme cards", () => {
  const lib = new Map(
    [
      ["a", 100],
      ["b", 300],
      ["c", 200],
      ["d", 400],
    ].map(([k, t]) => [k as string, { uid: `v~${k}`, captureTime: t as number }]),
  );
  const groups = [
    { id: 0, slug: "food", keys: ["a", "gone"] },
    { id: 3, slug: "beach", keys: ["c", "a", "b"] },
    { id: 4, slug: "mountains", keys: ["hiddenOnly"] },
    { id: 9, slug: "sunsets", keys: ["d", "b"] },
  ];
  const cards = themeEntries(groups, lib, (s) => s.toUpperCase());

  it("leaves out photos the library does not hold and themes left empty", () => {
    expect(cards.map((c) => c.name)).toEqual(["BEACH", "SUNSETS", "FOOD"]);
    expect(cards.find((c) => c.name === "FOOD")!.uids).toEqual(["v~a"]);
  });

  it("lists photos newest first, covers with the best-scoring one, and orders by size", () => {
    const beach = cards[0];
    expect(beach.uids).toEqual(["v~b", "v~c", "v~a"]);
    expect(beach.cover).toBe("v~c");
    expect(cards[1].cover).toBe("v~d");
    expect(beach.key).toBe("theme:beach");
  });

  it("returns a theme's photos best first for the search", () => {
    expect(themePhotos(groups, "beach", lib).map((p) => p.uid)).toEqual(["v~c", "v~a", "v~b"]);
    expect(themePhotos(groups, "cars", lib)).toEqual([]);
  });
});

describe("a category named like a theme", () => {
  it("stays text while the theme is named, so the theme's photos are not narrowed away", () => {
    expect(pillsByItself("cat:portrait", matchTheme("Portraits"))).toBe(false);
    expect(pillsByItself("cat:screen", matchTheme("Screenshots"))).toBe(false);
  });

  it("becomes its pill as before when no theme is named or the term is not a category", () => {
    expect(pillsByItself("cat:selfie", matchTheme("Selfies"))).toBe(true);
    expect(pillsByItself("cat:portrait", null)).toBe(true);
    expect(pillsByItself("people:Ann", matchTheme("Portraits"))).toBe(true);
  });
});
