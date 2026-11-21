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
  NO_LABELS,
  applyLabels,
  labelIndex,
  labelUsage,
  pruneLabels,
  shownInSection,
  toggleLabel,
  withLabels,
} from "./labelFilter";
import { labelKey } from "./labels";
import { alternatives, matchesAlternatives, metaText } from "./searchQuery";

const keys = (...names: string[]) => names.map(labelKey);
const photo = (uid: string) => ({ uid });
const uids = (items: { uid: string }[]) => items.map((it) => it.uid);

describe("the label filter", () => {
  it("matches a label by its exact name, not as part of another", () => {
    const index = labelIndex([
      { name: "beach", uids: ["a"] },
      { name: "Be", uids: ["b"] },
    ]);
    expect(uids(applyLabels([photo("a"), photo("b")], withLabels(keys("be"), false), index))).toEqual(["b"]);
  });

  it("ignores case, accents and spacing", () => {
    const index = labelIndex([{ name: "Nyaralás  2024", uids: ["a"] }]);
    expect(uids(applyLabels([photo("a")], withLabels(keys("NYARALAS 2024"), false), index))).toEqual(["a"]);
  });

  it("lets any label through by default, only every label with All", () => {
    const index = labelIndex([
      { name: "beach", uids: ["a", "b"] },
      { name: "trip", uids: ["a", "c"] },
    ]);
    const all = [photo("a"), photo("b"), photo("c"), photo("d")];
    expect(uids(applyLabels(all, withLabels(keys("beach", "trip"), false), index))).toEqual(["a", "b", "c"]);
    expect(uids(applyLabels(all, withLabels(keys("beach", "trip"), true), index))).toEqual(["a"]);
  });

  it("leaves the list as it is with no label picked", () => {
    const items = [photo("a")];
    expect(applyLabels(items, NO_LABELS, new Map())).toBe(items);
    expect(applyLabels(items, withLabels(keys("x"), false), new Map())).toEqual([]);
  });

  it("keeps All only with two or more labels", () => {
    const two = withLabels(keys("a", "b"), true);
    expect(two.all).toBe(true);
    expect(withLabels(keys("a"), two.all).all).toBe(false);
    expect(withLabels([], true)).toEqual(NO_LABELS);
    expect(toggleLabel(two, labelKey("b"))).toEqual({ keys: keys("a"), all: false });
    expect(toggleLabel(withLabels(keys("a"), false), labelKey("b")).keys).toEqual(keys("a", "b"));
  });

  it("drops a label the account no longer has", () => {
    const filter = withLabels(keys("beach", "trip"), true);
    expect(pruneLabels(filter, ["Beach"])).toEqual({ keys: keys("beach"), all: false });
    expect(pruneLabels(filter, ["beach", "trip"])).toBe(filter);
    expect(pruneLabels(withLabels(keys("x"), false), [])).toEqual(NO_LABELS);
  });

  it("filters again with the labels as they are now", () => {
    const filter = withLabels(keys("beach"), false);
    const items = [photo("a"), photo("b")];
    expect(uids(applyLabels(items, filter, labelIndex([{ name: "beach", uids: ["a"] }])))).toEqual(["a"]);
    expect(uids(applyLabels(items, filter, labelIndex([{ name: "beach", uids: ["a"] }, { name: "Beach", uids: ["b"] }])))).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("the labels section", () => {
  it("counts each label's photos, most used first", () => {
    expect(labelUsage([{ name: "trip", uids: ["a"] }, { name: "Beach", uids: ["a", "b"] }])).toEqual([
      { key: "beach", label: "Beach", count: 2 },
      { key: "trip", label: "trip", count: 1 },
    ]);
  });

  it("shows the most used labels and any picked one beyond them", () => {
    const usage = labelUsage(["a", "b", "c", "d", "e", "f", "g"].map((name, i) => ({ name, uids: Array(9 - i).fill("x") })));
    expect(shownInSection(usage, []).map((u) => u.label)).toEqual(["a", "b", "c", "d", "e"]);
    expect(shownInSection(usage, keys("g", "b")).map((u) => u.label)).toEqual(["a", "b", "c", "d", "e", "g"]);
  });
});

describe("a label pill with typed text", () => {
  it("narrows the labelled photos with and and or", () => {
    const names: Record<string, string> = { a: "beach.jpg", b: "sunset.jpg", c: "dog.jpg", d: "beach2.jpg" };
    const index = labelIndex([{ name: "trip", uids: ["a", "b", "c"] }]);
    const filter = withLabels(keys("trip"), false);
    const run = (q: string) =>
      uids(
        applyLabels(Object.keys(names).map(photo), filter, index).filter(
          (it) => !q || matchesAlternatives(alternatives(q), [metaText(names[it.uid], "image/jpeg")]),
        ),
      );
    expect(run("")).toEqual(["a", "b", "c"]);
    expect(run("beach")).toEqual(["a"]);
    expect(run("beach, dog")).toEqual(["a", "c"]);
    expect(run("beach jpg dog")).toEqual([]);
  });
});
