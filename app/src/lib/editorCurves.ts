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

/**
 * The Colour tool's tone curves and per-colour HSL, with the Android editor's maths: a
 * curve is straight between its points and flat past its ends, each channel's curve runs
 * after the master, and each of the eight HSL bands reaches 60 degrees either side of its
 * hue, blending into its neighbours. Both are folded into tables once per render, so the
 * pixel loop is lookups.
 */

/** A tone-curve control point, input level across and output level up, both 0..1. */
export type CurvePoint = { x: number; y: number };

export type CurveChannel = "rgb" | "r" | "g" | "b";

export type Curves = Record<CurveChannel, CurvePoint[]>;

/** One HSL band's shifts, each -100..100. */
export type HslBand = { hue: number; sat: number; light: number };

/** The tone curves and the HSL bands of an edit. */
export type ColorEdit = { curves: Curves; hsl: HslBand[] };

export const IDENTITY_CURVE: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

/** The centre hue of each band: red, orange, yellow, green, aqua, blue, purple, magenta. */
export const HSL_BAND_CENTERS = [0, 30, 60, 120, 180, 240, 280, 320];

/** A swatch for each band, the Android editor's. */
export const HSL_SWATCHES = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#00c7be", "#007aff", "#8e5ce6", "#ff2d92"];

export function neutralColor(): ColorEdit {
  return {
    curves: { rgb: [...IDENTITY_CURVE], r: [...IDENTITY_CURVE], g: [...IDENTITY_CURVE], b: [...IDENTITY_CURVE] },
    hsl: HSL_BAND_CENTERS.map(() => ({ hue: 0, sat: 0, light: 0 })),
  };
}

export function isIdentityCurve(points: CurvePoint[]): boolean {
  return points.length === 2 && points[0].x === 0 && points[0].y === 0 && points[1].x === 1 && points[1].y === 1;
}

export function hslIsNeutral(hsl: HslBand[]): boolean {
  return hsl.every((b) => b.hue === 0 && b.sat === 0 && b.light === 0);
}

export function colorIsNeutral(c: ColorEdit): boolean {
  return (["rgb", "r", "g", "b"] as const).every((k) => isIdentityCurve(c.curves[k])) && hslIsNeutral(c.hsl);
}

/** The output level a curve gives `x`: straight between its sorted points, flat past the ends. */
export function curveValueAt(points: CurvePoint[], x: number): number {
  if (points.length === 0) return x;
  const pts = [...points].sort((a, b) => a.x - b.x);
  if (x <= pts[0].x) return pts[0].y;
  if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (x >= a.x && x <= b.x) {
      const t = b.x > a.x ? (x - a.x) / (b.x - a.x) : 0;
      return a.y + (b.y - a.y) * t;
    }
  }
  return x;
}

/** A curve as a 256-entry table, 0..255 in and out. */
export function curveLut(points: CurvePoint[]): Uint8Array {
  const out = new Uint8Array(256);
  for (let i = 0; i < 256; i++) out[i] = Math.min(255, Math.max(0, Math.round(curveValueAt(points, i / 255) * 255)));
  return out;
}

/** Shortest distance between two hues on the wheel. */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** How much a band centred at `center` moves a pixel of `hue`: 1 at the centre, 0 by 60 degrees. */
export function hslBandWeight(hue: number, center: number): number {
  return Math.max(0, 1 - hueDistance(hue, center) / 60);
}

/** Per whole degree of hue: the hue shift in degrees, the saturation factor, the lightness added. */
export function hslLuts(bands: HslBand[]): { shift: Float32Array; sat: Float32Array; light: Float32Array } {
  const shift = new Float32Array(360);
  const sat = new Float32Array(360);
  const light = new Float32Array(360);
  for (let deg = 0; deg < 360; deg++) {
    let hs = 0;
    let sm = 0;
    let la = 0;
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      if (b.hue === 0 && b.sat === 0 && b.light === 0) continue;
      const w = hslBandWeight(deg, HSL_BAND_CENTERS[i]);
      if (w <= 0) continue;
      hs += w * (b.hue / 100) * 30;
      sm += w * (b.sat / 100);
      la += w * (b.light / 100) * 0.3;
    }
    shift[deg] = hs;
    sat[deg] = sm;
    light[deg] = la;
  }
  return { shift, sat, light };
}

/**
 * The tone curves (each channel's after the master) and then the HSL bands, in place over
 * RGBA bytes. A near-grey pixel has no hue to speak of, so HSL leaves it alone.
 */
export function applyCurvesHsl(data: Uint8ClampedArray, color: ColorEdit): void {
  const curved = !(["rgb", "r", "g", "b"] as const).every((k) => isIdentityCurve(color.curves[k]));
  const hsl = !hslIsNeutral(color.hsl);
  if (!curved && !hsl) return;
  let lr: Uint8Array | null = null;
  let lg: Uint8Array | null = null;
  let lb: Uint8Array | null = null;
  if (curved) {
    const master = curveLut(color.curves.rgb);
    const r = curveLut(color.curves.r);
    const g = curveLut(color.curves.g);
    const b = curveLut(color.curves.b);
    lr = new Uint8Array(256);
    lg = new Uint8Array(256);
    lb = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      lr[i] = r[master[i]];
      lg[i] = g[master[i]];
      lb[i] = b[master[i]];
    }
  }
  const luts = hsl ? hslLuts(color.hsl) : null;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];
    if (lr && lg && lb) {
      r = lr[r];
      g = lg[g];
      b = lb[b];
    }
    if (luts) {
      const rf = r / 255;
      const gf = g / 255;
      const bf = b / 255;
      const max = Math.max(rf, gf, bf);
      const min = Math.min(rf, gf, bf);
      const delta = max - min;
      if (delta >= 1e-4) {
        const l = (max + min) / 2;
        const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
        let hue = (max === rf ? ((gf - bf) / delta) % 6 : max === gf ? (bf - rf) / delta + 2 : (rf - gf) / delta + 4) * 60;
        if (hue < 0) hue += 360;
        const hi = Math.min(359, Math.max(0, Math.trunc(hue)));
        const hs = luts.shift[hi];
        const sm = luts.sat[hi];
        const la = luts.light[hi];
        if (hs !== 0 || sm !== 0 || la !== 0) {
          let nh = (hue + hs) % 360;
          if (nh < 0) nh += 360;
          const ns = Math.min(1, Math.max(0, s * (1 + sm)));
          const nl = Math.min(1, Math.max(0, l + la));
          const c = (1 - Math.abs(2 * nl - 1)) * ns;
          const x = c * (1 - Math.abs(((nh / 60) % 2) - 1));
          const m = nl - c / 2;
          let rr: number;
          let gg: number;
          let bb: number;
          if (nh < 60) [rr, gg, bb] = [c, x, 0];
          else if (nh < 120) [rr, gg, bb] = [x, c, 0];
          else if (nh < 180) [rr, gg, bb] = [0, c, x];
          else if (nh < 240) [rr, gg, bb] = [0, x, c];
          else if (nh < 300) [rr, gg, bb] = [x, 0, c];
          else [rr, gg, bb] = [c, 0, x];
          r = Math.round((rr + m) * 255);
          g = Math.round((gg + m) * 255);
          b = Math.round((bb + m) * 255);
        }
      }
    }
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
}
