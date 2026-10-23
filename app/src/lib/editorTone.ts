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

import type { Adjustments } from "./editorColor";

/** The edge of the square sample the auto-fix reads, as the Android editor samples it. */
export const AUTO_FIX_SAMPLE = 100;

/** The adjustments auto-fix sets; everything else is left as it is. */
export type AutoFix = Pick<
  Adjustments,
  "brightness" | "contrast" | "saturation" | "exposure" | "highlights" | "shadows"
>;

/**
 * The Android editor's auto-fix, value for value: one luma histogram of an RGBA sample.
 * Luminance is corrected through exposure, a blown top is pulled down, crushed shadows
 * are lifted, and a flat photo gets a little contrast and saturation. Temperature and
 * tone stay alone, since white balance off one luma histogram is unreliable.
 */
export function autoFix(rgba: Uint8ClampedArray): AutoFix {
  const n = Math.floor(rgba.length / 4);
  if (n === 0) return { brightness: 0, contrast: 0, saturation: 0, exposure: 0, highlights: 0, shadows: 0 };
  let sum = 0;
  let minL = 255;
  let maxL = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const luma = Math.min(255, Math.max(0, Math.trunc(0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2])));
    sum += luma;
    if (luma < minL) minL = luma;
    if (luma > maxL) maxL = luma;
  }
  const mean = Math.trunc(sum / n);
  const spread = maxL - minL;
  const exposure = mean < 85 ? 10 : mean < 110 ? 5 : mean > 175 ? -8 : 0;
  return {
    brightness: 0,
    contrast: spread < 140 ? 8 : 0,
    saturation: spread < 200 ? 6 : 3,
    exposure,
    highlights: maxL > 232 ? -14 : 0,
    shadows: minL < 22 ? 12 : 0,
  };
}

/** The ruler's inner margin, in CSS pixels, so the end ticks are not clipped. */
export const RULER_PAD = 4;

/** The value under a pointer `x` pixels from a ruler's left edge, snapped to whole steps. */
export function rulerValueAt(x: number, width: number, min: number, max: number): number {
  const usable = Math.max(1, width - 2 * RULER_PAD);
  const f = Math.min(1, Math.max(0, (x - RULER_PAD) / usable));
  return Math.round(min + f * (max - min));
}

/** The lit span of a ruler, as fractions of its width: from zero (or the low end) to the value. */
export function rulerSpan(value: number, min: number, max: number): { lo: number; hi: number; at: number } {
  const span = max - min;
  if (span <= 0) return { lo: 0, hi: 0, at: 0 };
  const at = Math.min(1, Math.max(0, (value - min) / span));
  const zero = min < 0 ? Math.min(1, Math.max(0, -min / span)) : 0;
  return { lo: Math.min(zero, at), hi: Math.max(zero, at), at };
}
