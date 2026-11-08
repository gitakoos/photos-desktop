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
  ALIGNED,
  TEMPLATE_X,
  TEMPLATE_Y,
  alignedBlur,
  embedInput,
  isConfidentFace,
  laplacianVariance,
  sidewaysMeasure,
  similarityTransform,
  warpAligned,
} from "./faceAlign.ts";
import { decodeFaces } from "./faces.ts";

const template = TEMPLATE_X.flatMap((x, i) => [x, TEMPLATE_Y[i]]);

function apply(affine: number[], x: number, y: number): [number, number] {
  return [affine[0] * x + affine[1] * y + affine[2], affine[3] * x + affine[4] * y + affine[5]];
}

describe("aligning a face", () => {
  it("leaves a face already on the template where it is", () => {
    const m = similarityTransform(template);
    expect(m[0]).toBeCloseTo(1, 5);
    expect(m[1]).toBeCloseTo(0, 5);
    expect(m[2]).toBeCloseTo(0, 3);
    expect(m[5]).toBeCloseTo(0, 3);
  });

  it("undoes a turn, a scale and a shift", () => {
    const angle = 0.3;
    const scale = 2.5;
    const src = template.map((_, i) => {
      const k = Math.floor(i / 2);
      const x = TEMPLATE_X[k];
      const y = TEMPLATE_Y[k];
      const rx = scale * (Math.cos(angle) * x - Math.sin(angle) * y) + 400;
      const ry = scale * (Math.sin(angle) * x + Math.cos(angle) * y) + 120;
      return i % 2 === 0 ? rx : ry;
    });
    const m = similarityTransform(src);
    for (let k = 0; k < 5; k++) {
      const [x, y] = apply(m, src[2 * k], src[2 * k + 1]);
      expect(x).toBeCloseTo(TEMPLATE_X[k], 2);
      expect(y).toBeCloseTo(TEMPLATE_Y[k], 2);
    }
  });

  it("falls back to a shift for points all in one place", () => {
    const m = similarityTransform([10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
    expect(m.every(Number.isFinite)).toBe(true);
    expect(m[0]).toBe(1);
  });

  it("copies the picture through an identity, black outside it", () => {
    const rgb = new Uint8Array(ALIGNED * ALIGNED * 3);
    for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 7) % 256;
    const same = warpAligned(rgb, ALIGNED, ALIGNED, [1, 0, 0, 0, 1, 0]);
    expect(Array.from(same.subarray(0, 300))).toEqual(Array.from(rgb.subarray(0, 300)));
    const away = warpAligned(rgb, ALIGNED, ALIGNED, [1, 0, 500, 0, 1, 500]);
    expect(away.every((v) => v === 0)).toBe(true);
  });
});

describe("grading a face", () => {
  it("reads a flat crop as fully blurred and an edge as sharp", () => {
    expect(laplacianVariance(new Int32Array(25).fill(9), 5, 5)).toBe(0);
    const crop = new Uint8Array(ALIGNED * ALIGNED * 3);
    for (let y = 0; y < ALIGNED; y++) for (let x = 0; x < ALIGNED; x++) if ((x + y) % 2) crop.fill(255, (y * ALIGNED + x) * 3, (y * ALIGNED + x) * 3 + 3);
    expect(alignedBlur(crop)).toBeGreaterThan(1000);
  });

  it("measures a straight-on face as not turned and a turned one as turned", () => {
    expect(sidewaysMeasure(template)!).toBeLessThan(0.05);
    const turned = [...template];
    turned[4] = 44; // the nose moved toward the left eye
    expect(sidewaysMeasure(turned)!).toBeGreaterThan(0.18);
  });

  it("trusts a clear face and holds a weak one back", () => {
    expect(isConfidentFace(0.8, 50, 0.05)).toBe(true);
    expect(isConfidentFace(0.6, 50, 0.05)).toBe(false);
    expect(isConfidentFace(0.8, 5, 0.05)).toBe(false);
    expect(isConfidentFace(0.8, 50, 0.3)).toBe(false);
    expect(isConfidentFace(0.8, null, null)).toBe(true);
  });

  it("lays the crop out as the network reads it", () => {
    const input = embedInput(Uint8Array.from([0, 255, 128]));
    expect(input[0]).toBeCloseTo(-127.5 / 128, 6);
    expect(input[1]).toBeCloseTo(127.5 / 128, 6);
  });
});

describe("the detector's output", () => {
  it("carries all five landmarks", () => {
    const row = new Float32Array(16);
    row.set([100, 100, 40, 50, 0.9, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0.95]);
    const [hit] = decodeFaces(row);
    expect(hit.points).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(hit.eyes).toEqual([1, 2, 3, 4]);
    expect(hit.box).toEqual([80, 75, 120, 125]);
  });
});
