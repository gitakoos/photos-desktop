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
  isLabelSearch,
  labelKeywords,
  labelTextOf,
  namedLabel,
  offeredLabels,
  parseLabelTyping,
  type LabelUsage,
} from "./labelQuery";
import { labelKey } from "./labels";
import { dateAtEnd } from "./searchQuery";
import { en } from "./locales/en";
import { hu } from "./locales/hu";

// English plus Hungarian, as the window builds them for a Hungarian app language.
const keywords = labelKeywords([hu["search.labelKeyword"], en["search.labelKeyword"]]);
const parse = (q: string) => parseLabelTyping(q, keywords);
const usage = (...names: [string, number][]): LabelUsage[] =>
  names.map(([label, count]) => ({ key: labelKey(label), label, count }));

describe("the label keyword", () => {
  it("has its variants folded, the longest first", () => {
    expect(labelKeywords([en["search.labelKeyword"], hu["search.labelKeyword"]])).toEqual([
      "labels",
      "cimkek",
      "label",
      "cimke",
    ]);
  });

  it("is found bare in English and in the app language", () => {
    for (const q of ["labels", "label", "címkék", "CIMKE", "  Labels  "]) expect(parse(q)).toEqual({ rest: "", name: null });
  });

  it("leaves the words before it as the text", () => {
    expect(parse("beach june labels")).toEqual({ rest: "beach june", name: null });
    expect(parse("beach, labels:trip")).toEqual({ rest: "beach", name: "trip" });
    expect(labelTextOf("beach june labels", keywords)).toBe("beach june");
    expect(labelTextOf("beach june", keywords)).toBe("beach june");
  });

  it("is no keyword inside another word, or followed by more words", () => {
    for (const q of ["mylabels", "labelsx", "lab", "labels beach", ""]) expect(parse(q)).toBeNull();
    expect(parseLabelTyping("labels", [])).toBeNull();
  });

  it("stays exact text inside quotes", () => {
    expect(parse('"labels:trip"')).toBeNull();
    expect(parse('"labels')).toBeNull();
    expect(parse("“beach labels")).toBeNull();
    expect(parse('"beach"labels')).toBeNull();
    expect(parse('"my trip" labels:x')).toEqual({ rest: '"my trip"', name: "x" });
    expect(parse("«a, b» labels")).toEqual({ rest: "«a, b»", name: null });
  });

  it("names nothing yet with an empty colon", () => {
    expect(parse("labels:")).toEqual({ rest: "", name: "" });
    expect(parse("címkék: ")).toEqual({ rest: "", name: "" });
  });

  it("keeps the spaces and colons of a label name", () => {
    expect(parse("labels:summer trip")).toEqual({ rest: "", name: "summer trip" });
    expect(parse("labels: a:b c")).toEqual({ rest: "", name: "a:b c" });
    expect(parse("sea label:10:30 ferry")).toEqual({ rest: "sea", name: "10:30 ferry" });
  });

  it("holds back a label named like a month from the date pill", () => {
    const q = "labels:my june";
    expect(dateAtEnd(q, "en")).not.toBeNull();
    expect(parse(q)).toEqual({ rest: "", name: "my june" });
  });
});

describe("the labels it offers", () => {
  it("picks by a typed name only the label of exactly that name", () => {
    const labels = usage(["beach", 4], ["be", 1], ["Nyaralás", 2]);
    expect(namedLabel({ rest: "", name: "BE" }, labels)?.label).toBe("be");
    expect(namedLabel({ rest: "", name: "nyaralas" }, labels)?.label).toBe("Nyaralás");
    expect(namedLabel({ rest: "", name: "bea" }, labels)).toBeNull();
    expect(namedLabel({ rest: "", name: "" }, labels)).toBeNull();
    expect(namedLabel({ rest: "", name: null }, labels)).toBeNull();
  });

  it("offers the labels the typed part holds, picked ones left out", () => {
    const labels = usage(["beach", 4], ["trip", 3], ["be", 1]);
    const names = (list: LabelUsage[]) => list.map((l) => l.label);
    expect(names(offeredLabels({ rest: "", name: null }, labels, []))).toEqual(["beach", "trip", "be"]);
    expect(names(offeredLabels({ rest: "", name: "BE" }, labels, []))).toEqual(["beach", "be"]);
    expect(names(offeredLabels({ rest: "", name: "" }, labels, [labelKey("beach")]))).toEqual(["trip", "be"]);
  });

  it("makes a label search of a picked label or the typed keyword", () => {
    expect(isLabelSearch("", ["beach"], keywords)).toBe(true);
    expect(isLabelSearch("sunset", ["beach"], keywords)).toBe(true);
    expect(isLabelSearch("labels:jun", [], keywords)).toBe(true);
    expect(isLabelSearch("sunset", [], keywords)).toBe(false);
    expect(isLabelSearch("", [], keywords)).toBe(false);
  });
});
