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

import { BaselineStore, shrinkOf, type Baseline } from "./backupBaseline.ts";

const all = () => true;
/** The first `n` of a library's photos, one face on each. */
const first = (n: number): Baseline => Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, 1]));
const hundred = first(100);

describe("a copy against the last one written", () => {
  it("passes holding the same, photos with no face included", () => {
    expect(shrinkOf({ a: 2, b: 1, c: 0 }, { a: 2, b: 1, c: 0 }, all, false)).toBeNull();
  });

  it("does not count a photo gone from the library or hidden", () => {
    expect(shrinkOf({ a: 2, b: 1 }, { a: 2 }, (l) => l !== "b", false)).toBeNull();
  });

  it("may lose 2% and no more", () => {
    expect(shrinkOf(hundred, first(98), all, false)).toBeNull();
    expect(shrinkOf(hundred, first(97), all, false)).toEqual({ photosBefore: 100, photosAfter: 97, itemsBefore: 100, itemsAfter: 97 });
  });

  it("may lose nothing while a scan runs", () => {
    expect(shrinkOf(hundred, first(99), all, true)).toEqual({ photosBefore: 100, photosAfter: 99, itemsBefore: 100, itemsAfter: 99 });
    expect(shrinkOf(hundred, hundred, all, true)).toBeNull();
  });

  it("passes when it grew", () => {
    expect(shrinkOf({ a: 1 }, { a: 5, b: 1 }, all, false)).toBeNull();
  });

  it("passes when there is no last one", () => {
    expect(shrinkOf(null, {}, all, false)).toBeNull();
  });

  it("is held back for its faces alone, every photo still there", () => {
    expect(shrinkOf({ a: 50, b: 50 }, { a: 50, b: 40 }, all, false)).toEqual({ photosBefore: 2, photosAfter: 2, itemsBefore: 100, itemsAfter: 90 });
  });

  it("is held back for its photos alone, a photo with no face counting as one", () => {
    expect(shrinkOf({ a: 3, b: 0 }, { a: 3 }, all, false)).toEqual({ photosBefore: 2, photosAfter: 1, itemsBefore: 3, itemsAfter: 3 });
  });

  it("does not make up for a lost photo with a new one", () => {
    const swapped = { ...first(90), ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`new${i}`, 1])) };
    expect(shrinkOf(hundred, swapped, all, false)).toEqual({ photosBefore: 100, photosAfter: 90, itemsBefore: 100, itemsAfter: 90 });
  });
});

describe("the references kept", () => {
  function kept() {
    let held: Partial<Record<"faces" | "search", Baseline>> = {};
    return new BaselineStore(
      () => held,
      (next) => (held = next),
    );
  }

  it("have nothing until one is recorded", () => {
    expect(kept().get("faces")).toBeNull();
  });

  it("answer what was recorded, each kind apart", () => {
    const store = kept();
    store.record("faces", { a: 2 });
    store.record("search", { b: 1 });
    expect(store.get("faces")).toEqual({ a: 2 });
    expect(store.get("search")).toEqual({ b: 1 });
  });

  it("forget one kind and leave the other", () => {
    const store = kept();
    store.record("faces", { a: 2 });
    store.record("search", { b: 1 });
    store.clear("faces");
    expect(store.get("faces")).toBeNull();
    expect(store.get("search")).toEqual({ b: 1 });
  });
});
