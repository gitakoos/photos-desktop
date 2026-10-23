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
import { decodeFaces, suppressFaces, toPlanes } from "./faces.ts";

/** One output row: box centre and size, objectness, five landmark pairs, class score. */
function row(cx: number, cy: number, w: number, h: number, obj: number, cls: number, eyes = [1, 2, 3, 4]): number[] {
  return [cx, cy, w, h, obj, ...eyes, 0, 0, 0, 0, 0, 0, cls];
}

describe("decodeFaces", () => {
  it("keeps a row whose objectness times class score passes, as a corner box with its eyes", () => {
    const out = new Float32Array([...row(100, 50, 40, 20, 0.9, 0.9, [90, 45, 110, 46]), ...row(10, 10, 5, 5, 0.9, 0.5)]);
    const hits = decodeFaces(out);
    expect(hits).toHaveLength(1);
    expect(hits[0].box).toEqual([80, 40, 120, 60]);
    expect(hits[0].eyes).toEqual([90, 45, 110, 46]);
    expect(hits[0].score).toBeCloseTo(0.81, 6);
  });

  it("drops a row just under the threshold", () => {
    expect(decodeFaces(new Float32Array(row(0, 0, 1, 1, 0.7, 0.85)))).toHaveLength(0);
  });
});

describe("suppressFaces", () => {
  it("keeps the surest of overlapping boxes and every separate face", () => {
    const hits = decodeFaces(
      new Float32Array([
        ...row(100, 100, 50, 50, 0.8, 0.9),
        ...row(104, 102, 50, 50, 0.95, 0.95),
        ...row(400, 100, 50, 50, 0.9, 0.9),
      ]),
    );
    const kept = suppressFaces(hits);
    expect(kept).toHaveLength(2);
    expect(kept[0].box[0]).toBeCloseTo(79, 6);
    expect(kept[1].box[0]).toBeCloseTo(375, 6);
  });
});

describe("toPlanes", () => {
  it("lays RGB bytes out as three planes from 0 to 1", () => {
    const planes = toPlanes(new Uint8Array([255, 0, 51, 0, 255, 102]), 1);
    // A 1x1 side reads only the first pixel: red, green and blue planes in turn.
    expect(planes).toHaveLength(3);
    [1, 0, 0.2].forEach((v, i) => expect(planes[i]).toBeCloseTo(v, 6));
  });
});
