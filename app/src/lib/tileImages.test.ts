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
import { createKeep } from "./tileImages";

describe("the pictures kept for tiles that scroll back", () => {
  it("hands a kept thing back once", () => {
    const dropped: string[] = [];
    const keep = createKeep<string>(3, (v) => dropped.push(v));
    keep.put("a", "A");
    expect(keep.take("a")).toBe("A");
    expect(keep.take("a")).toBeUndefined();
    expect(keep.size).toBe(0);
    // Taken, not dropped: the tile has it now.
    expect(dropped).toEqual([]);
  });

  it("never holds more than its limit, dropping the least recently kept", () => {
    const dropped: string[] = [];
    const keep = createKeep<string>(3, (v) => dropped.push(v));
    for (const k of ["a", "b", "c", "d", "e"]) keep.put(k, k.toUpperCase());
    expect(keep.size).toBe(3);
    expect(dropped).toEqual(["A", "B"]);
    expect(keep.take("a")).toBeUndefined();
    expect(keep.take("e")).toBe("E");
  });

  it("counts a thing kept again as recent", () => {
    const dropped: string[] = [];
    const keep = createKeep<string>(2, (v) => dropped.push(v));
    keep.put("a", "A");
    keep.put("b", "B");
    keep.put("a", "A");
    keep.put("c", "C");
    // The same thing put back is not dropped for its own sake; the oldest other one is.
    expect(dropped).toEqual(["B"]);
    expect(keep.take("a")).toBe("A");
  });

  it("drops what a key held when something else takes its place", () => {
    const dropped: string[] = [];
    const keep = createKeep<string>(2, (v) => dropped.push(v));
    keep.put("a", "old");
    keep.put("a", "new");
    expect(dropped).toEqual(["old"]);
    expect(keep.take("a")).toBe("new");
  });

  it("drops everything at a lock", () => {
    const dropped: string[] = [];
    const keep = createKeep<string>(5, (v) => dropped.push(v));
    keep.put("a", "A");
    keep.put("b", "B");
    keep.clear();
    expect(keep.size).toBe(0);
    expect(dropped.sort()).toEqual(["A", "B"]);
    expect(keep.take("a")).toBeUndefined();
  });

  it("stays bounded over a library's worth of tiles", () => {
    let live = 0;
    const keep = createKeep<number>(1200, () => live--);
    for (let i = 0; i < 40_000; i++) {
      live++;
      keep.put(`u${i}`, i);
    }
    expect(keep.size).toBe(1200);
    expect(live).toBe(1200);
  });
});
