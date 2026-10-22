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
import { termAtEnd, termsStartedAtEnd, wordForms, type SearchTerm } from "./searchTerms";

const term = (key: string, label: string, lang = "en", extra: string[] = []): SearchTerm => ({
  key,
  label,
  forms: [...wordForms(label, lang), ...extra],
});

describe("the spellings of a label", () => {
  it("take the singular where the plural ending comes off cleanly", () => {
    expect(wordForms("Videos", "en")).toEqual(["videos", "video"]);
    expect(wordForms("Videók", "hu")).toEqual(["videok", "video"]);
    expect(wordForms("Képernyőképek", "hu")).toEqual(["kepernyokepek", "kepernyokep"]);
    expect(wordForms("Szelfik", "hu")).toEqual(["szelfik", "szelfi"]);
    expect(wordForms("RAW", "en")).toEqual(["raw"]);
  });
});

describe("a term typed at the end of the search", () => {
  const terms = [
    term("cat:screen", "Screenshots"),
    term("type:video", "Videos", "en", ["movies"]),
    term("people:Anna Kovács", "Anna Kovács"),
    term("cat:screen-hu", "Képernyőképek", "hu"),
  ];

  it("is found whole, singular or plural, with the text before it kept", () => {
    expect(termAtEnd("budapest videos", terms)).toEqual({ term: terms[1], rest: "budapest" });
    expect(termAtEnd("Screenshot", terms)?.term.key).toBe("cat:screen");
    expect(termAtEnd("képernyőkép", terms)?.term.key).toBe("cat:screen-hu");
    expect(termAtEnd("beach anna kovacs", terms)).toEqual({ term: terms[2], rest: "beach" });
    expect(termAtEnd("movies", terms)?.term.key).toBe("type:video");
  });

  it("is not found for a word that only starts like one", () => {
    expect(termAtEnd("vid", terms)).toBeNull();
    expect(termAtEnd("screens", terms)).toBeNull();
  });

  it("is offered while it is still being typed, a name from two letters", () => {
    expect(termsStartedAtEnd("scr", terms).map((m) => m.term.key)).toEqual(["cat:screen"]);
    expect(termsStartedAtEnd("an", terms).map((m) => m.term.key)).toEqual(["people:Anna Kovács"]);
    expect(termsStartedAtEnd("kov", terms).map((m) => m.term.key)).toEqual(["people:Anna Kovács"]);
    expect(termsStartedAtEnd("vi", terms)).toEqual([]);
  });
});
