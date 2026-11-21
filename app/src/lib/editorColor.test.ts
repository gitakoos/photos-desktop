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

import { describe, it, expect } from "vitest";
import {
  applyMatrix,
  buildColorMatrix,
  concat,
  filterMatrix,
  NEUTRAL_ADJUSTMENTS,
  saturationMatrix,
  type Adjustments,
} from "./editorColor";

const IDENTITY = [
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
];

/** One RGBA pixel through applyMatrix, returned as [r, g, b]. */
function pixel(m: number[], r: number, g: number, b: number): [number, number, number] {
  const data = new Uint8ClampedArray([r, g, b, 255]);
  applyMatrix(data, m);
  return [data[0], data[1], data[2]];
}

const adj = (over: Partial<Adjustments>): Adjustments => ({ ...NEUTRAL_ADJUSTMENTS, ...over });

describe("buildColorMatrix", () => {
  it("is a no-op (null) when nothing is set", () => {
    expect(buildColorMatrix(NEUTRAL_ADJUSTMENTS)).toBeNull();
  });

  it("is not null the moment any one slider moves", () => {
    expect(buildColorMatrix(adj({ brightness: 1 }))).not.toBeNull();
    expect(buildColorMatrix(adj({ filter: "sepia" }))).not.toBeNull();
  });

  it("brightness is additive: each channel gains 1.5 per step", () => {
    const m = buildColorMatrix(adj({ brightness: 10 }))!;
    // +10 -> +15 on every channel, no scaling.
    expect(pixel(m, 100, 100, 100)).toEqual([115, 115, 115]);
  });

  it("contrast pivots around 128", () => {
    const m = buildColorMatrix(adj({ contrast: 100 }))!; // contrast multiplier 2
    // out = 2*in + (1-2)*128 = 2*in - 128. A mid-grey stays put.
    expect(pixel(m, 128, 128, 128)).toEqual([128, 128, 128]);
    // 160 -> 2*160-128 = 192.
    expect(pixel(m, 160, 160, 160)).toEqual([192, 192, 192]);
  });

  it("clamps once at the end, not between channels", () => {
    const m = buildColorMatrix(adj({ brightness: 100 }))!; // +150 on each channel
    expect(pixel(m, 200, 10, 0)).toEqual([255, 160, 150]);
  });
});

describe("highlights", () => {
  it("brightens a bright pixel at +100", () => {
    const m = buildColorMatrix(adj({ highlights: 100 }))!;
    expect(pixel(m, 200, 200, 200)).toEqual([250, 250, 250]);
  });

  it("darkens a bright pixel at -100", () => {
    const m = buildColorMatrix(adj({ highlights: -100 }))!;
    expect(pixel(m, 200, 200, 200)).toEqual([150, 150, 150]);
  });

  it("keeps black black in both directions", () => {
    expect(pixel(buildColorMatrix(adj({ highlights: 100 }))!, 0, 0, 0)).toEqual([0, 0, 0]);
    expect(pixel(buildColorMatrix(adj({ highlights: -100 }))!, 0, 0, 0)).toEqual([0, 0, 0]);
  });

  it("moves a dark pixel less than a bright one", () => {
    const m = buildColorMatrix(adj({ highlights: 100 }))!;
    expect(pixel(m, 40, 40, 40)).toEqual([50, 50, 50]);
  });

  it("pulls a near-white pixel down at the auto-fix value of -14", () => {
    const m = buildColorMatrix(adj({ highlights: -14 }))!;
    expect(pixel(m, 240, 240, 240)).toEqual([232, 232, 232]);
  });
});

describe("slider directions", () => {
  it("exposure brightens when positive and darkens when negative", () => {
    expect(pixel(buildColorMatrix(adj({ exposure: 50 }))!, 100, 100, 100)).toEqual([150, 150, 150]);
    expect(pixel(buildColorMatrix(adj({ exposure: -50 }))!, 100, 100, 100)).toEqual([50, 50, 50]);
  });

  it("shadows lift the dark end when positive and sink it when negative", () => {
    expect(pixel(buildColorMatrix(adj({ shadows: 100 }))!, 40, 40, 40)).toEqual([90, 90, 90]);
    expect(pixel(buildColorMatrix(adj({ shadows: -100 }))!, 100, 100, 100)).toEqual([20, 20, 20]);
  });

  it("saturation spreads the channels when positive and draws them together when negative", () => {
    expect(pixel(buildColorMatrix(adj({ saturation: 50 }))!, 150, 100, 100)).toEqual([170, 95, 95]);
    expect(pixel(buildColorMatrix(adj({ saturation: -50 }))!, 150, 100, 100)).toEqual([130, 105, 105]);
  });

  it("temperature warms when positive and cools when negative", () => {
    expect(pixel(buildColorMatrix(adj({ temperature: 100 }))!, 100, 100, 100)).toEqual([150, 100, 50]);
    expect(pixel(buildColorMatrix(adj({ temperature: -100 }))!, 100, 100, 100)).toEqual([50, 100, 150]);
  });

  it("tone shifts toward green when positive and magenta when negative", () => {
    expect(pixel(buildColorMatrix(adj({ tone: 100 }))!, 100, 100, 100)).toEqual([100, 150, 100]);
    expect(pixel(buildColorMatrix(adj({ tone: -100 }))!, 100, 100, 100)).toEqual([100, 50, 100]);
  });

  it("contrast lowers a dark pixel when positive and raises it when negative", () => {
    expect(pixel(buildColorMatrix(adj({ contrast: 50 }))!, 64, 64, 64)).toEqual([32, 32, 32]);
    expect(pixel(buildColorMatrix(adj({ contrast: -50 }))!, 64, 64, 64)).toEqual([96, 96, 96]);
  });
});

describe("filters", () => {
  it("has no matrix for none", () => {
    expect(filterMatrix("none")).toBeNull();
  });

  it("B&W uses the BT.709 luma weights of setSaturation(0)", () => {
    const m = filterMatrix("bw")!;
    // A pure red 200 -> 0.213*200 = 42.6 -> 43 on every channel.
    expect(pixel(m, 200, 0, 0)).toEqual([43, 43, 43]);
    // A pure green 200 -> 0.715*200 = 143.
    expect(pixel(m, 0, 200, 0)).toEqual([143, 143, 143]);
    // A pure blue 200 -> 0.072*200 = 14.4 -> 14.
    expect(pixel(m, 0, 0, 200)).toEqual([14, 14, 14]);
  });

  it("sepia carries its exact first-row weights", () => {
    const m = filterMatrix("sepia")!;
    // R' of a white pixel = (0.393+0.769+0.189)*255 = 1.351*255 = 344.5 -> clamped 255.
    expect(pixel(m, 255, 255, 255)[0]).toBe(255);
    // R' of mid-grey 100 = 1.351*100 = 135.1 -> 135.
    expect(pixel(m, 100, 100, 100)[0]).toBe(135);
  });
});

describe("saturationMatrix", () => {
  it("is the identity at saturation 1", () => {
    const m = saturationMatrix(1);
    expect(m[0]).toBeCloseTo(1, 10);
    expect(m[1]).toBeCloseTo(0, 10);
    expect(m[6]).toBeCloseTo(1, 10);
    expect(pixel(m, 30, 90, 210)).toEqual([30, 90, 210]);
  });

  it("collapses to luma at saturation 0", () => {
    const m = saturationMatrix(0);
    const [r, g, b] = pixel(m, 30, 90, 210);
    expect(r).toBe(g);
    expect(g).toBe(b);
    // 0.213*30 + 0.715*90 + 0.072*210 = 6.39 + 64.35 + 15.12 = 85.86 -> 86.
    expect(r).toBe(86);
  });
});

describe("concat", () => {
  it("leaves a matrix unchanged against the identity", () => {
    const m = filterMatrix("sepia")!;
    expect(concat(m, IDENTITY)).toEqual(m);
    expect(concat(IDENTITY, m)).toEqual(m);
  });

  it("carries the offset column through the product", () => {
    // A pure +10 red offset, concatenated onto identity, keeps that offset.
    const shift = [
      1, 0, 0, 0, 10,
      0, 1, 0, 0, 0,
      0, 0, 1, 0, 0,
      0, 0, 0, 1, 0,
    ];
    expect(concat(shift, IDENTITY)[4]).toBe(10);
  });
});
