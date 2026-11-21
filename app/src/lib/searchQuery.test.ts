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
import {
  FIELD,
  alternatives,
  dateAtEnd,
  dropTrailingWords,
  hasQuote,
  matchesAlternatives,
  metaText,
  pillText,
  restAfterPill,
  resultsTitle,
  stripped,
} from "./searchQuery";
import { termAtEnd, wordForms } from "./searchTerms";
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

/** The names a query finds among `names`, each name its own photo's text. */
const search = (names: string[], q: string) =>
  names.filter((n) => matchesAlternatives(alternatives(q), [metaText(n, "image/jpeg")]));

describe("quote marks", () => {
  it("are straight, curly, low and angle marks, never an apostrophe", () => {
    for (const q of ['"a', "“a", "a”", "„a", "«a", "a»"]) expect(hasQuote(q)).toBe(true);
    expect(hasQuote("l'annee ’s beach, sunset")).toBe(false);
  });

  it("are all that stripping removes", () => {
    expect(stripped("“Anna's trip”")).toBe("Anna's trip");
  });
});

describe("the results title", () => {
  const locales = { cs, de, en, es, fr, hu, it: itLocale, nl, pl, sk, sl };
  const count = (text: string, marks: string) => [...text].filter((c) => marks.includes(c)).length;

  for (const [lang, strings] of Object.entries(locales)) {
    const quoted = (q: string) => strings["search.resultsTitle"].replace("{query}", q);
    const wrapMarks = strings["search.resultsTitle"].replace("{query}", "").trim();

    it(`shows a query's own quote marks once and no other pair in ${lang}`, () => {
      for (const q of ['"my trip" June', '"sky"', "“Anna's trip” 2024", "„x“"]) {
        const title = resultsTitle(q, quoted);
        expect(title).toBe(q);
        expect(count(title, '"“”„«»‘’‚‹›')).toBe(count(q, '"“”„«»‘’‚‹›'));
      }
    });

    it(`puts an unquoted query in the language's marks in ${lang}`, () => {
      expect(wrapMarks.length).toBeGreaterThan(0);
      expect(resultsTitle("beach June", quoted)).toBe(quoted("beach June"));
      expect(resultsTitle("l'annee", quoted)).toBe(quoted("l'annee"));
    });
  }
});

describe("the query's alternatives", () => {
  it("split on commas, then spaces, without quotes", () => {
    expect(alternatives("Beach  June, , Sunset ")).toEqual([["beach", "june"], ["sunset"]]);
  });

  it("keep a quoted span as one folded term, commas and spaces in it", () => {
    expect(alternatives("“New York, NY” june, Café")).toEqual([["new york, ny", "june"], ["cafe"]]);
    expect(alternatives('beach "Summer party')).toEqual([["beach", "summer party"]]);
    expect(alternatives('"" , « »')).toEqual([]);
  });
});

describe("matching", () => {
  const phrases = ["summer beach party.jpg", "beach summer.jpg", "forest.jpg"];

  it("finds a quoted phrase only as that exact text, spaces included", () => {
    expect(search(phrases, "summer beach")).toEqual(["summer beach party.jpg", "beach summer.jpg"]);
    expect(search(phrases, '"summer beach"')).toEqual(["summer beach party.jpg"]);
  });

  it("takes curly, low and angle marks like straight ones", () => {
    for (const q of ["“summer beach”", "„summer beach“", "«summer beach»"]) {
      expect(search(phrases, q)).toEqual(["summer beach party.jpg"]);
    }
  });

  it("reads a comma inside quotes as text, not a separator", () => {
    const names = ["paris, france.jpg", "paris.jpg", "france.jpg"];
    expect(search(names, "paris, france")).toHaveLength(3);
    expect(search(names, '"paris, france"')).toEqual(["paris, france.jpg"]);
  });

  it("runs an unclosed quote to the end of the query", () => {
    expect(search(phrases, '"summer beach')).toEqual(["summer beach party.jpg"]);
  });

  it("keeps the comma and space rules beside a quoted term", () => {
    expect(search(phrases, '"summer beach" party, forest')).toEqual(["summer beach party.jpg", "forest.jpg"]);
    expect(search(phrases, '"summer beach" forest')).toEqual([]);
  });

  it("folds case and accents", () => {
    expect(search(phrases, '"SUMMÉR beach"')).toEqual(["summer beach party.jpg"]);
    expect(search(["José.jpg"], "jose")).toEqual(["José.jpg"]);
  });

  it("never lets a phrase span two fields", () => {
    const fields = [metaText("x.jpg", "image/jpeg"), ["anna", "beach trip"].join(FIELD)];
    expect(matchesAlternatives(alternatives("anna beach"), fields)).toBe(true);
    expect(matchesAlternatives(alternatives('"beach trip"'), fields)).toBe(true);
    expect(matchesAlternatives(alternatives('"anna beach"'), fields)).toBe(false);
    expect(matchesAlternatives(alternatives('"jpg image"'), fields)).toBe(false);
  });

  it("takes quote marks alone as no query", () => {
    expect(search(phrases, '""')).toEqual([]);
  });

  it("finds a photo by its names alone when its file name is not known yet", () => {
    expect(matchesAlternatives(alternatives("anna"), [undefined, "anna"])).toBe(true);
    expect(matchesAlternatives(alternatives("anna"), [undefined, undefined])).toBe(false);
  });
});

describe("what a pill may read", () => {
  it("is the words after a closed quote, nothing while one is open", () => {
    expect(pillText("beach june")).toBe("beach june");
    expect(pillText('"beach june" 2023')).toBe(" 2023");
    expect(pillText('"beach june 2023')).toBe("");
    expect(pillText('"beach"june 2023')).toBe(" 2023");
  });

  it("leaves a date inside quotes as text", () => {
    expect(dateAtEnd('"june"', "en")).toBeNull();
    expect(dateAtEnd('"beach 2023', "en")).toBeNull();
    expect(dateAtEnd("beach june", "en")).toEqual({ year: null, month: 6, rest: "beach" });
  });

  it("keeps the quoted text as typed when a date after it becomes a pill", () => {
    expect(dateAtEnd('"my  trip" june', "en")).toEqual({ year: null, month: 6, rest: '"my  trip"' });
    expect(dateAtEnd('«a, b» june 2024', "en")).toEqual({ year: 2024, month: 6, rest: "«a, b»" });
  });

  it("keeps the quoted text when a category after it becomes a pill", () => {
    const terms = [{ key: "type:video", label: "Videos", forms: wordForms("Videos", "en") }];
    const q = '"summer party" videos';
    const readable = pillText(q);
    const found = termAtEnd(readable, terms)!;
    expect(found.term.key).toBe("type:video");
    expect(restAfterPill(q, readable, found.rest)).toBe('"summer party"');
    expect(termAtEnd(pillText('"videos"'), terms)).toBeNull();
  });

  it("drops words from the end only", () => {
    expect(dropTrailingWords('"a b" c d ', 1)).toBe('"a b" c');
    expect(dropTrailingWords('"a b" c d', 2)).toBe('"a b"');
  });
});
