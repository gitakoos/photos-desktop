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
import { NEUTRAL_ADJUSTMENTS, buildColorMatrix } from "./editorColor";
import { hasPixelEffects, sharpenInto, vibranceAndGrain, vignetteStops } from "./editorEffects";

function px(...rgb: number[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray((rgb.length / 3) * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) out.set([rgb[i], rgb[i + 1], rgb[i + 2], 255], j);
  return out;
}

describe("sharpenInto", () => {
  it("moves each channel away from its blur by the amount, as Android's unsharp mask does", () => {
    const data = px(100, 150, 200);
    sharpenInto(data, px(80, 150, 220), 50);
    // 100 + 0.5 * 20, 150 + 0, 200 + 0.5 * -20
    expect([...data]).toEqual([110, 150, 190, 255]);
  });

  it("softens toward the blur for a negative amount and clamps the ends", () => {
    const data = px(100, 250, 5);
    sharpenInto(data, px(60, 150, 105), -50);
    expect([...data.slice(0, 3)]).toEqual([80, 200, 55]);
    const hot = px(250, 0, 128);
    sharpenInto(hot, px(150, 100, 128), 100);
    expect([...hot.slice(0, 3)]).toEqual([255, 0, 128]);
  });
});

describe("vibranceAndGrain", () => {
  it("boosts a muted colour by more than a saturated one", () => {
    // Muted: max-min = 40, boost = 1 + 0.5 * (1 - 40/255).
    const muted = px(120, 140, 160);
    vibranceAndGrain(muted, 50, 0);
    const gray = 0.299 * 120 + 0.587 * 140 + 0.114 * 160;
    const boost = 1 + 0.5 * (1 - 40 / 255);
    expect(muted[0]).toBe(Math.round(gray + (120 - gray) * boost));
    expect(muted[2]).toBe(Math.round(gray + (160 - gray) * boost));
    // Fully saturated red: sat = 1, so the boost is 1 and nothing moves.
    const red = px(255, 0, 0);
    vibranceAndGrain(red, 100, 0);
    expect([...red.slice(0, 3)]).toEqual([255, 0, 0]);
  });

  it("leaves a grey pixel grey under vibrance", () => {
    const g = px(90, 90, 90);
    vibranceAndGrain(g, 100, 0);
    expect([...g.slice(0, 3)]).toEqual([90, 90, 90]);
  });

  it("adds the same bounded, repeatable noise to all three channels", () => {
    const a = px(...Array(300).fill(128));
    const b = px(...Array(300).fill(128));
    vibranceAndGrain(a, 0, 100);
    vibranceAndGrain(b, 0, -100);
    expect([...a]).toEqual([...b]);
    let moved = 0;
    for (let i = 0; i < a.length; i += 4) {
      expect(a[i]).toBe(a[i + 1]);
      expect(a[i]).toBe(a[i + 2]);
      expect(Math.abs(a[i] - 128)).toBeLessThanOrEqual(40);
      if (a[i] !== 128) moved++;
    }
    expect(moved).toBeGreaterThan(50);
  });

  it("does nothing at zero", () => {
    const d = px(10, 20, 30);
    vibranceAndGrain(d, 0, 0);
    expect([...d]).toEqual([10, 20, 30, 255]);
  });
});

describe("vignette and fade", () => {
  it("darkens with black and lightens with white, 70 % at full strength", () => {
    expect(vignetteStops(100)).toEqual({ clear: "rgba(0, 0, 0, 0)", edge: "rgba(0, 0, 0, 0.7)" });
    expect(vignetteStops(-50).edge).toBe("rgba(255, 255, 255, 0.35)");
  });

  it("folds fade into the colour matrix with Android's scale and lift", () => {
    const m = buildColorMatrix({ ...NEUTRAL_ADJUSTMENTS, fade: 50 })!;
    expect(m[0]).toBeCloseTo(0.9, 10);
    expect(m[4]).toBeCloseTo(15, 10);
    expect(m[12]).toBeCloseTo(0.9, 10);
    expect(m[14]).toBeCloseTo(15, 10);
    const punch = buildColorMatrix({ ...NEUTRAL_ADJUSTMENTS, fade: -100 })!;
    expect(punch[0]).toBeCloseTo(1.2, 10);
    expect(punch[4]).toBeCloseTo(-30, 10);
  });

  it("counts only sharpen, vibrance and grain as per-pixel work", () => {
    expect(hasPixelEffects(NEUTRAL_ADJUSTMENTS)).toBe(false);
    expect(hasPixelEffects({ ...NEUTRAL_ADJUSTMENTS, vignette: 40, fade: 20 })).toBe(false);
    expect(hasPixelEffects({ ...NEUTRAL_ADJUSTMENTS, grain: 1 })).toBe(true);
  });
});
