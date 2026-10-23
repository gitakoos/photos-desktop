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
  IDENTITY_CURVE,
  applyCurvesHsl,
  colorIsNeutral,
  curveLut,
  curveValueAt,
  hslBandWeight,
  hslLuts,
  hueDistance,
  neutralColor,
} from "./editorCurves";

function px(...rgb: number[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray((rgb.length / 3) * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) out.set([rgb[i], rgb[i + 1], rgb[i + 2], 255], j);
  return out;
}

describe("curves", () => {
  it("is straight between its points and flat past its ends", () => {
    const pts = [
      { x: 0.2, y: 0.1 },
      { x: 0.6, y: 0.9 },
    ];
    expect(curveValueAt(pts, 0)).toBeCloseTo(0.1, 9);
    expect(curveValueAt(pts, 0.4)).toBeCloseTo(0.5, 9);
    expect(curveValueAt(pts, 1)).toBeCloseTo(0.9, 9);
  });

  it("sorts its points before reading them", () => {
    expect(curveValueAt([{ x: 1, y: 0 }, { x: 0, y: 1 }], 0.25)).toBeCloseTo(0.75, 9);
  });

  it("makes an identity table from the straight line", () => {
    const lut = curveLut(IDENTITY_CURVE);
    for (let i = 0; i < 256; i++) expect(lut[i]).toBe(i);
  });

  it("runs a channel's curve after the master", () => {
    const c = neutralColor();
    c.curves.rgb = [{ x: 0, y: 0 }, { x: 1, y: 0.5 }]; // halves everything
    c.curves.r = [{ x: 0, y: 1 }, { x: 1, y: 0 }]; // then inverts red
    const d = px(200, 200, 200);
    applyCurvesHsl(d, c);
    expect(d[0]).toBe(155);
    expect(d[1]).toBe(100);
    expect(d[2]).toBe(100);
  });
});

describe("hsl", () => {
  it("measures hue distance the short way round", () => {
    expect(hueDistance(350, 10)).toBe(20);
    expect(hueDistance(90, 270)).toBe(180);
  });

  it("weighs a band from 1 at its centre to 0 at 60 degrees", () => {
    expect(hslBandWeight(30, 30)).toBe(1);
    expect(hslBandWeight(60, 30)).toBeCloseTo(0.5, 9);
    expect(hslBandWeight(100, 30)).toBe(0);
  });

  it("folds the bands into per-degree tables", () => {
    const c = neutralColor();
    c.hsl[0] = { hue: 100, sat: 50, light: -100 };
    const t = hslLuts(c.hsl);
    expect(t.shift[0]).toBeCloseTo(30, 6);
    expect(t.sat[0]).toBeCloseTo(0.5, 6);
    expect(t.light[0]).toBeCloseTo(-0.3, 6);
    expect(t.shift[90]).toBe(0);
  });

  it("moves a red pixel's hue and leaves grey and other hues alone", () => {
    const c = neutralColor();
    c.hsl[0] = { hue: 100, sat: 0, light: 0 }; // red turns 30 degrees toward orange
    const d = px(255, 0, 0, 128, 128, 128, 0, 0, 255);
    applyCurvesHsl(d, c);
    expect([d[0], d[1], d[2]]).toEqual([255, 128, 0]);
    expect([d[4], d[5], d[6]]).toEqual([128, 128, 128]);
    expect([d[8], d[9], d[10]]).toEqual([0, 0, 255]);
  });

  it("knows a fresh edit is neutral", () => {
    expect(colorIsNeutral(neutralColor())).toBe(true);
    const c = neutralColor();
    c.hsl[3].sat = 1;
    expect(colorIsNeutral(c)).toBe(false);
  });
});
