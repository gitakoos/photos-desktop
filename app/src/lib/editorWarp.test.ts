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
import { IDENTITY3, apply3, geometryWarp, invert3, mul3, quadToQuad, warpPixels } from "./editorWarp";

describe("quadToQuad", () => {
  it("takes each corner onto its target", () => {
    const src = [0, 0, 100, 0, 100, 60, 0, 60];
    const dst = [10, 5, 90, 0, 100, 60, 0, 55];
    const m = quadToQuad(src, dst)!;
    for (let i = 0; i < 4; i++) {
      const [x, y] = apply3(m, src[i * 2], src[i * 2 + 1]);
      expect(x).toBeCloseTo(dst[i * 2], 9);
      expect(y).toBeCloseTo(dst[i * 2 + 1], 9);
    }
  });

  it("is the identity for an unmoved quad and null for a degenerate one", () => {
    const sq = [0, 0, 1, 0, 1, 1, 0, 1];
    const m = quadToQuad(sq, sq)!;
    m.forEach((v, i) => expect(v).toBeCloseTo(IDENTITY3[i], 12));
    expect(quadToQuad([0, 0, 0, 0, 0, 0, 0, 0], sq)).toBeNull();
  });

  it("inverts back to the identity", () => {
    const m = quadToQuad([0, 0, 4, 0, 4, 3, 0, 3], [1, 0, 3, 0, 4, 3, 0, 3])!;
    mul3(m, invert3(m)!).forEach((v, i) => expect(v).toBeCloseTo(IDENTITY3[i], 9));
  });
});

describe("geometryWarp", () => {
  it("is nothing at all when every value is zero", () => {
    expect(geometryWarp(400, 300, 0, 0, 0)).toBeNull();
  });

  it("turns about the centre and grows until the frame is filled again", () => {
    const w = 400;
    const h = 300;
    const m = geometryWarp(w, h, 100, 0, 0)!;
    const [cx, cy] = apply3(m, w / 2, h / 2);
    expect(cx).toBeCloseTo(w / 2, 9);
    expect(cy).toBeCloseTo(h / 2, 9);
    // Every corner of the output frame comes from inside the picture: no empty corners.
    const inv = invert3(m)!;
    for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h]]) {
      const [sx, sy] = apply3(inv, x, y);
      expect(sx).toBeGreaterThanOrEqual(-1e-6);
      expect(sx).toBeLessThanOrEqual(w + 1e-6);
      expect(sy).toBeGreaterThanOrEqual(-1e-6);
      expect(sy).toBeLessThanOrEqual(h + 1e-6);
    }
  });

  it("turns clockwise for a positive straighten, 15 degrees at the end", () => {
    const m = geometryWarp(1000, 1000, 100, 0, 0)!;
    const [x, y] = apply3(m, 1000, 500);
    // A point right of centre moves down on screen, at the angle the slider names.
    expect(Math.atan2(y - 500, x - 500) * (180 / Math.PI)).toBeCloseTo(15, 6);
  });

  it("narrows the top for a positive vertical keystone and leaves the size alone", () => {
    const w = 400;
    const h = 300;
    const m = geometryWarp(w, h, 0, 50, 0)!;
    const [lx] = apply3(m, 0, 0);
    const [rx] = apply3(m, w, 0);
    const [blx] = apply3(m, 0, h);
    const [brx] = apply3(m, w, h);
    expect(rx - lx).toBeLessThan(brx - blx);
  });

  it("is the same picture at any size", () => {
    const a = geometryWarp(400, 300, 40, -30, 20)!;
    const b = geometryWarp(800, 600, 40, -30, 20)!;
    const [ax, ay] = apply3(a, 100, 75);
    const [bx, by] = apply3(b, 200, 150);
    expect(bx).toBeCloseTo(ax * 2, 6);
    expect(by).toBeCloseTo(ay * 2, 6);
  });
});

describe("warpPixels", () => {
  it("copies the picture through the identity", () => {
    const src = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]);
    expect([...warpPixels(src, 2, 2, IDENTITY3)]).toEqual([...src]);
  });

  it("leaves pixels mapped from well outside the picture transparent", () => {
    const src = new Uint8ClampedArray(4 * 4 * 4).fill(200);
    const shift = [1, 0, 3, 0, 1, 0, 0, 0, 1]; // everything moves 3 px right
    const out = warpPixels(src, 4, 4, shift);
    expect(out[3]).toBe(0);
    expect(out[(0 * 4 + 3) * 4 + 3]).toBe(200);
  });
});
