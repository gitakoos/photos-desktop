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
 * Straighten and keystone, as the Android editor's `geometryTransform` builds them: the
 * frame's corners move onto a trapezoid, the picture turns about the centre by up to 15
 * degrees, and it grows about the centre until the frame is filled again. The result is
 * one projective matrix, applied per pixel, because a canvas can only draw affine maps.
 */

/** A 3x3 matrix, row-major, acting on column vectors (x, y, 1). */
export type Mat3 = number[];

export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** `a` after `b`: the matrix that applies `b` first, then `a`. */
export function mul3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

export function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  return [
    A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k,
  ];
}

/** Where `m` takes the point (x, y). */
export function apply3(m: Mat3, x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

/**
 * The projective map taking the four points of `src` onto those of `dst`, each given as
 * x0, y0, x1, y1, ... in the same corner order; null when the points are degenerate.
 */
export function quadToQuad(src: number[], dst: number[]): Mat3 | null {
  // Eight equations in the eight unknowns h0..h7 (h8 = 1), solved by elimination.
  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const x = src[i * 2];
    const y = src[i * 2 + 1];
    const u = dst[i * 2];
    const v = dst[i * 2 + 1];
    a.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    a.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      if (f === 0) continue;
      for (let c = col; c < 9; c++) a[r][c] -= f * a[col][c];
    }
  }
  const h = a.map((row, r) => row[8] / row[r]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function about(cx: number, cy: number, m: Mat3): Mat3 {
  return mul3([1, 0, cx, 0, 1, cy, 0, 0, 1], mul3(m, [1, 0, -cx, 0, 1, -cy, 0, 0, 1]));
}

/**
 * The straighten and keystone warp over a `w` x `h` frame, or null when none is set.
 * Positive `perspectiveV` narrows the top, positive `perspectiveH` the left; each value
 * is -100..100, the straighten angle reaching 15 degrees at the ends. The insets are
 * fractions of the frame, so the same values give the same picture at any size.
 */
export function geometryWarp(
  w: number,
  h: number,
  straighten: number,
  perspectiveV: number,
  perspectiveH: number,
): Mat3 | null {
  if (straighten === 0 && perspectiveV === 0 && perspectiveH === 0) return null;
  const angle = (straighten / 100) * 15;
  const pv = (perspectiveV / 100) * 0.28 * (w / 2);
  const ph = (perspectiveH / 100) * 0.28 * (h / 2);
  const topInset = pv > 0 ? pv : 0;
  const botInset = pv < 0 ? -pv : 0;
  const leftInset = ph > 0 ? ph : 0;
  const rightInset = ph < 0 ? -ph : 0;
  const src = [0, 0, w, 0, w, h, 0, h];
  const dst = [
    topInset, leftInset,
    w - topInset, rightInset,
    w - botInset, h - rightInset,
    botInset, h - leftInset,
  ];
  const keystone = quadToQuad(src, dst) ?? IDENTITY3;
  // Grow until the narrowed edge and the turned corners reach the frame again.
  const maxInset = Math.max(topInset, botInset, leftInset, rightInset);
  const perspScale = maxInset > 0 ? Math.min(1.7, Math.max(1, w / (w - 2 * maxInset))) : 1;
  const rad = (Math.abs(angle) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rotScale = Math.max((w * cos + h * sin) / w, (w * sin + h * cos) / h);
  const grow = perspScale * rotScale;
  const turn = (angle * Math.PI) / 180;
  const rotate = about(w / 2, h / 2, [Math.cos(turn), -Math.sin(turn), 0, Math.sin(turn), Math.cos(turn), 0, 0, 0, 1]);
  const scale = about(w / 2, h / 2, [grow, 0, 0, 0, grow, 0, 0, 0, 1]);
  return mul3(scale, mul3(rotate, keystone));
}

/**
 * The picture `src` (RGBA, `w` x `h`) drawn through `m` into a frame of the same size,
 * sampled bilinearly at each output pixel's centre. A point that lands just past an edge
 * takes the edge's colour; one well outside the picture stays transparent.
 */
export function warpPixels(src: Uint8ClampedArray, w: number, h: number, m: Mat3): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  const inv = invert3(m);
  if (!inv) return out;
  const [a, b, c, d, e, f, g, hh, i] = inv;
  for (let y = 0; y < h; y++) {
    const py = y + 0.5;
    for (let x = 0; x < w; x++) {
      const px = x + 0.5;
      const q = g * px + hh * py + i;
      const sx = (a * px + b * py + c) / q - 0.5;
      const sy = (d * px + e * py + f) / q - 0.5;
      if (sx < -1 || sy < -1 || sx > w || sy > h) continue;
      const x0f = Math.floor(sx);
      const y0f = Math.floor(sy);
      const fx = sx - x0f;
      const fy = sy - y0f;
      const x0 = x0f < 0 ? 0 : x0f > w - 1 ? w - 1 : x0f;
      const x1 = x0f + 1 < 0 ? 0 : x0f + 1 > w - 1 ? w - 1 : x0f + 1;
      const y0 = y0f < 0 ? 0 : y0f > h - 1 ? h - 1 : y0f;
      const y1 = y0f + 1 < 0 ? 0 : y0f + 1 > h - 1 ? h - 1 : y0f + 1;
      const i00 = (y0 * w + x0) * 4;
      const i10 = (y0 * w + x1) * 4;
      const i01 = (y1 * w + x0) * 4;
      const i11 = (y1 * w + x1) * 4;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const o = (y * w + x) * 4;
      out[o] = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
      out[o + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
      out[o + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
      out[o + 3] = src[i00 + 3] * w00 + src[i10 + 3] * w10 + src[i01 + 3] * w01 + src[i11 + 3] * w11;
    }
  }
  return out;
}
