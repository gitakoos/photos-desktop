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
import { RULER_PAD, autoFix, rulerSpan, rulerValueAt } from "./editorTone";

/** An RGBA buffer of grey pixels, one per luma value given. */
function greys(...values: number[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(values.length * 4);
  values.forEach((v, i) => {
    out.set([v, v, v, 255], i * 4);
  });
  return out;
}

describe("autoFix", () => {
  it("leaves a well exposed, full-range photo almost alone", () => {
    expect(autoFix(greys(30, 128, 150, 220))).toEqual({
      brightness: 0,
      contrast: 0,
      saturation: 6,
      exposure: 0,
      highlights: 0,
      shadows: 0,
    });
  });

  it("lifts a dark, flat photo through exposure, contrast and saturation", () => {
    expect(autoFix(greys(40, 60, 80, 100))).toEqual({
      brightness: 0,
      contrast: 8,
      saturation: 6,
      exposure: 10,
      highlights: 0,
      shadows: 0,
    });
  });

  it("uses the gentler step for a slightly dark photo", () => {
    expect(autoFix(greys(100, 100)).exposure).toBe(5);
  });

  it("pulls a bright photo with a blown top down and lifts crushed shadows", () => {
    const fix = autoFix(greys(10, 240, 250, 250));
    expect(fix.exposure).toBe(-8);
    expect(fix.highlights).toBe(-14);
    expect(fix.shadows).toBe(12);
    expect(fix.saturation).toBe(3);
  });

  it("weights the channels with Rec. 601 luma", () => {
    // Pure green has luma 149 (0.587 * 255), pure blue 29: a spread of 120, so it is flat.
    const px = new Uint8ClampedArray([0, 255, 0, 255, 0, 0, 255, 255]);
    const fix = autoFix(px);
    expect(fix.contrast).toBe(8);
    expect(fix.exposure).toBe(5);
  });

  it("returns all zeros for an empty sample", () => {
    expect(autoFix(new Uint8ClampedArray(0))).toEqual({
      brightness: 0,
      contrast: 0,
      saturation: 0,
      exposure: 0,
      highlights: 0,
      shadows: 0,
    });
  });
});

describe("ruler", () => {
  const width = 200 + 2 * RULER_PAD;

  it("maps the ends and the middle of the track to the range", () => {
    expect(rulerValueAt(RULER_PAD, width, -100, 100)).toBe(-100);
    expect(rulerValueAt(RULER_PAD + 100, width, -100, 100)).toBe(0);
    expect(rulerValueAt(RULER_PAD + 200, width, -100, 100)).toBe(100);
    expect(rulerValueAt(RULER_PAD + 150, width, 0, 100)).toBe(75);
  });

  it("clamps a pointer outside the track", () => {
    expect(rulerValueAt(-50, width, -100, 100)).toBe(-100);
    expect(rulerValueAt(width + 50, width, -100, 100)).toBe(100);
  });

  it("lights the span between zero and the value on a two-sided range", () => {
    expect(rulerSpan(50, -100, 100)).toEqual({ lo: 0.5, hi: 0.75, at: 0.75 });
    expect(rulerSpan(-100, -100, 100)).toEqual({ lo: 0, hi: 0.5, at: 0 });
    expect(rulerSpan(0, -100, 100)).toEqual({ lo: 0.5, hi: 0.5, at: 0.5 });
  });

  it("lights from the low end on a one-sided range", () => {
    expect(rulerSpan(40, 0, 100)).toEqual({ lo: 0, hi: 0.4, at: 0.4 });
  });
});
