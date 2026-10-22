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
import { halfToFloatTable, rank } from "./semantic.ts";

/** Half-precision patterns of a few exact values. */
const H = { zero: 0x0000, one: 0x3c00, half: 0x3800, minusOne: 0xbc00, two: 0x4000 };

describe("half-precision values", () => {
  it("read back exactly, sign, zero and the subnormal range included", () => {
    const t = halfToFloatTable();
    expect(t[H.one]).toBe(1);
    expect(t[H.half]).toBe(0.5);
    expect(t[H.minusOne]).toBe(-1);
    expect(t[H.two]).toBe(2);
    expect(t[0x0001]).toBeCloseTo(2 ** -24, 30);
    expect(t[0x7c00]).toBe(Infinity);
  });
});

describe("ranking the phone's vectors against a query", () => {
  const copy = (keys: string[], rows: number[][]) => ({ keys, vectors: Uint16Array.from(rows.flat()) });
  const q = Float32Array.from([1, 0]);

  it("orders by closeness, keeps those over the floor, and stops at the limit", () => {
    const hits = rank(
      [copy(["a", "b", "c"], [[H.one, H.zero], [H.half, H.half], [H.zero, H.one]])],
      q,
      10,
      0.5,
    );
    expect(hits.map((h) => h.key)).toEqual(["a", "b"]);
    expect(hits[0].score).toBeCloseTo(1, 5);
    expect(hits[1].score).toBeCloseTo(Math.SQRT1_2, 5);
    expect(rank([copy(["a", "b"], [[H.one, H.zero], [H.one, H.zero]])], q, 1, 0)).toHaveLength(1);
  });

  it("scores a stored vector as a unit one, whatever half precision left of its length", () => {
    const [hit] = rank([copy(["a"], [[H.two, H.zero]])], q, 10, 0);
    expect(hit.score).toBeCloseTo(1, 5);
  });

  it("counts a photo in two devices' copies once, at its better score", () => {
    const hits = rank([copy(["a"], [[H.half, H.half]]), copy(["a"], [[H.one, H.zero]])], q, 10, 0);
    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBeCloseTo(1, 5);
  });
});
