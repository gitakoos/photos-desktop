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
 * The photo editor's colour pipeline, ported one for one from the Android app so the two
 * clients produce the same pixels. The single source of truth there is
 * `PhotoEditorViewModel.buildColorMatrix`; the values below are its exact constants.
 *
 * A colour matrix is Android's `android.graphics.ColorMatrix`: 4 rows of 5 (R, G, B, A,
 * offset), applied to a pixel as `out = M row-dot [R, G, B, A, 1]`. The offset column is
 * in 0..255 units, so every operation happens in 0..255 space and the result is clamped
 * to [0, 255] ONCE at the very end, never between stages. That single-clamp rule is what
 * makes a chain of adjustments match Android rather than drift.
 *
 * Two consumers read the same matrix: the save-time pass over the full-resolution
 * ImageData (exact, 0..255), and the live preview, which hands the matrix to an SVG
 * `feColorMatrix` filter on the GPU. SVG works in 0..1 space with the offset column also
 * in 0..1, so the preview form divides the offset column by 255. The preview is a visual
 * match; the saved bytes are the exact ones.
 */

/** A 4x5 colour matrix as 20 numbers, row-major, offsets in 0..255. */
export type ColorMatrix = number[];

export type FilterPreset =
  | "none"
  | "bw"
  | "sepia"
  | "vintage"
  | "vivid"
  | "cool"
  | "warm";

/** The eight adjustment sliders, each an integer in -100..100, 0 meaning untouched. */
export type Adjustments = {
  brightness: number;
  contrast: number;
  saturation: number;
  exposure: number;
  highlights: number;
  shadows: number;
  temperature: number;
  tone: number;
  filter: FilterPreset;
};

export const NEUTRAL_ADJUSTMENTS: Adjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  exposure: 0,
  highlights: 0,
  shadows: 0,
  temperature: 0,
  tone: 0,
  filter: "none",
};

const IDENTITY: ColorMatrix = [
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
];

/**
 * Android's `ColorMatrix.setSaturation`, weights and all. `invSat = 1 - s`; the luma
 * weights are BT.709 0.213 / 0.715 / 0.072, the exact three-decimal constants the
 * platform uses. This is what both the saturation slider and the B&W filter (s = 0) run
 * through, so B&W grayscale is 0.213 R + 0.715 G + 0.072 B, matching the saved output
 * (the on-screen filter chip in Android uses Rec.601 and is deliberately not matched).
 */
export function saturationMatrix(s: number): ColorMatrix {
  const invSat = 1 - s;
  const r = 0.213 * invSat;
  const g = 0.715 * invSat;
  const b = 0.072 * invSat;
  return [
    r + s, g, b, 0, 0,
    r, g + s, b, 0, 0,
    r, g, b + s, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

/**
 * The named filter presets, byte-identical to `PhotoEditorViewModel.filterMatrix`.
 * `none` returns null. B&W is `setSaturation(0)` rather than a hardcoded array.
 */
export function filterMatrix(filter: FilterPreset): ColorMatrix | null {
  switch (filter) {
    case "none":
      return null;
    case "bw":
      return saturationMatrix(0);
    case "sepia":
      return [
        0.393, 0.769, 0.189, 0, 0,
        0.349, 0.686, 0.168, 0, 0,
        0.272, 0.534, 0.131, 0, 0,
        0, 0, 0, 1, 0,
      ];
    case "vintage":
      return [
        0.9, 0.1, 0.1, 0, 20,
        0.1, 0.85, 0.1, 0, 10,
        0.1, 0.2, 0.7, 0, 0,
        0, 0, 0, 1, 0,
      ];
    case "vivid":
      return [
        1.3, -0.1, -0.1, 0, 0,
        -0.1, 1.3, -0.1, 0, 0,
        -0.1, -0.1, 1.3, 0, 0,
        0, 0, 0, 1, 0,
      ];
    case "cool":
      return [
        0.9, 0, 0.1, 0, 0,
        0, 1, 0, 0, 0,
        0.1, 0, 1.1, 0, 10,
        0, 0, 0, 1, 0,
      ];
    case "warm":
      return [
        1.1, 0, 0, 0, 10,
        0, 1.0, 0, 0, 5,
        0, 0, 0.9, 0, 0,
        0, 0, 0, 1, 0,
      ];
  }
}

/**
 * `result = a x b`, the exact arithmetic of Android's `ColorMatrix.setConcat(a, b)`: a
 * 4x5 by 4x5 product with an implicit fifth row [0 0 0 0 1], so the offset column of `a`
 * is carried through and added. `postConcat(m)` there means `this = m x this`, which is
 * why the caller folds each stage as `combined = concat(stage, combined)`.
 */
export function concat(a: ColorMatrix, b: ColorMatrix): ColorMatrix {
  const out = new Array<number>(20).fill(0);
  for (let j = 0; j < 20; j += 5) {
    for (let i = 0; i < 4; i++) {
      out[j + i] =
        a[j + 0] * b[i + 0] +
        a[j + 1] * b[i + 5] +
        a[j + 2] * b[i + 10] +
        a[j + 3] * b[i + 15];
    }
    out[j + 4] =
      a[j + 0] * b[4] +
      a[j + 1] * b[9] +
      a[j + 2] * b[14] +
      a[j + 3] * b[19] +
      a[j + 4];
  }
  return out;
}

/**
 * The combined colour matrix for a set of adjustments, mirroring `buildColorMatrix`
 * exactly: the same early-out when nothing is set, the same per-stage formulas, and the
 * same post-concat order (which does not commute). Returns null for a no-op, so a caller
 * can skip the pass entirely.
 *
 * Applied to a pixel, the stages run in this order: saturation, then contrast+brightness,
 * then exposure, highlights, shadows, temperature, tone, and the filter last.
 */
export function buildColorMatrix(adj: Adjustments): ColorMatrix | null {
  if (
    adj.brightness === 0 &&
    adj.contrast === 0 &&
    adj.saturation === 0 &&
    adj.exposure === 0 &&
    adj.highlights === 0 &&
    adj.shadows === 0 &&
    adj.temperature === 0 &&
    adj.tone === 0 &&
    adj.filter === "none"
  ) {
    return null;
  }

  const brightness = adj.brightness * 1.5; // -150..150 on a 0..255 channel
  const contrast = 1 + adj.contrast / 100; // 0..2 multiplier
  const saturation = 1 + adj.saturation / 100; // 0..2 multiplier
  const translate = (1 - contrast) * 128 + brightness;

  const mAdjust: ColorMatrix = [
    contrast, 0, 0, 0, translate,
    0, contrast, 0, 0, translate,
    0, 0, contrast, 0, translate,
    0, 0, 0, 1, 0,
  ];

  let combined = IDENTITY.slice();
  combined = concat(saturationMatrix(saturation), combined);
  combined = concat(mAdjust, combined);

  if (adj.exposure !== 0) {
    const expScale = 1 + adj.exposure / 100;
    combined = concat(
      [
        expScale, 0, 0, 0, 0,
        0, expScale, 0, 0, 0,
        0, 0, expScale, 0, 0,
        0, 0, 0, 1, 0,
      ],
      combined,
    );
  }

  if (adj.highlights !== 0) {
    const hScale = 1 - adj.highlights / 200;
    const hOffset = -adj.highlights * 0.3;
    combined = concat(
      [
        hScale, 0, 0, 0, hOffset,
        0, hScale, 0, 0, hOffset,
        0, 0, hScale, 0, hOffset,
        0, 0, 0, 1, 0,
      ],
      combined,
    );
  }

  if (adj.shadows !== 0) {
    const sScale = 1 + adj.shadows / 200;
    const sOffset = adj.shadows * 0.3;
    combined = concat(
      [
        sScale, 0, 0, 0, sOffset,
        0, sScale, 0, 0, sOffset,
        0, 0, sScale, 0, sOffset,
        0, 0, 0, 1, 0,
      ],
      combined,
    );
  }

  if (adj.temperature !== 0) {
    const t = adj.temperature * 0.5;
    combined = concat(
      [
        1, 0, 0, 0, t,
        0, 1, 0, 0, 0,
        0, 0, 1, 0, -t,
        0, 0, 0, 1, 0,
      ],
      combined,
    );
  }

  if (adj.tone !== 0) {
    const g = adj.tone * 0.5;
    combined = concat(
      [
        1, 0, 0, 0, 0,
        0, 1, 0, 0, g,
        0, 0, 1, 0, 0,
        0, 0, 0, 1, 0,
      ],
      combined,
    );
  }

  const mFilter = filterMatrix(adj.filter);
  if (mFilter) combined = concat(mFilter, combined);

  return combined;
}

/**
 * The same matrix in the form an SVG `feColorMatrix` wants: 20 values with the offset
 * column scaled from 0..255 into 0..1, since the filter operates on normalised colour.
 * Only the fifth entry of each row (indices 4, 9, 14, 19) is an offset.
 */
export function toSvgMatrix(m: ColorMatrix): string {
  const v = m.map((n, i) => (i % 5 === 4 ? n / 255 : n));
  return v.join(" ");
}

/**
 * Apply a colour matrix to raw RGBA bytes in place, in 0..255 space, clamping once at the
 * end. This is the save-time pass; the preview uses the SVG form instead. Alpha is left
 * untouched (every matrix here has an identity alpha row), which also keeps a transparent
 * pixel transparent.
 */
export function applyMatrix(data: Uint8ClampedArray, m: ColorMatrix): void {
  const m0 = m[0], m1 = m[1], m2 = m[2], m4 = m[4];
  const m5 = m[5], m6 = m[6], m7 = m[7], m9 = m[9];
  const m10 = m[10], m11 = m[11], m12 = m[12], m14 = m[14];
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const nr = m0 * r + m1 * g + m2 * b + m4;
    const ng = m5 * r + m6 * g + m7 * b + m9;
    const nb = m10 * r + m11 * g + m12 * b + m14;
    data[i] = nr < 0 ? 0 : nr > 255 ? 255 : nr;
    data[i + 1] = ng < 0 ? 0 : ng > 255 ? 255 : ng;
    data[i + 2] = nb < 0 ? 0 : nb > 255 ? 255 : nb;
  }
}
