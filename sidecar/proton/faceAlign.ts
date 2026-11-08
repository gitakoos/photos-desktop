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

/*
 * The 112x112 destination template and the similarity (Procrustes / umeyama-without-reflection)
 * alignment follow the published InsightFace ArcFace face-alignment format, which is Apache-2.0
 * licensed:
 *
 *   Copyright (c) 2021 InsightFace
 */

// A detected face turned into what the recognition model reads, exactly as the Android app does
// it, so a face found here and the same face found on the phone come out as the same numbers:
// the five landmarks warped onto the ArcFace template, graded for sharpness and turn, and laid
// out for the network.

/** Side of the square the recognition model reads. */
export const ALIGNED = 112;

/** The template landmarks: left eye, right eye, nose, left and right mouth corner. */
export const TEMPLATE_X = [38.2946, 73.5318, 56.0252, 41.5493, 70.7299];
export const TEMPLATE_Y = [51.6963, 51.5014, 71.7366, 92.3655, 92.2041];

/**
 * The affine [a, -b, tx, b, a, ty] that best lands the points (x0, y0, x1, y1, ...) on the
 * template: x' = a*x - b*y + tx, y' = b*x + a*y + ty. Points all in one place leave nothing to
 * scale or turn by, and give the plain shift between the two centres.
 */
export function similarityTransform(points: ArrayLike<number>): number[] {
  const count = Math.min(Math.floor(points.length / 2), TEMPLATE_X.length);
  if (count === 0) return [1, 0, 0, 0, 1, 0];
  // Single precision throughout, as on the phone.
  const f = Math.fround;
  let msx = 0;
  let msy = 0;
  let mdx = 0;
  let mdy = 0;
  for (let i = 0; i < count; i++) {
    msx = f(msx + points[2 * i]);
    msy = f(msy + points[2 * i + 1]);
    mdx = f(mdx + TEMPLATE_X[i]);
    mdy = f(mdy + TEMPLATE_Y[i]);
  }
  msx = f(msx / count);
  msy = f(msy / count);
  mdx = f(mdx / count);
  mdy = f(mdy / count);
  let sxx = 0;
  let a = 0;
  let b = 0;
  for (let i = 0; i < count; i++) {
    const px = f(points[2 * i] - msx);
    const py = f(points[2 * i + 1] - msy);
    const qx = f(TEMPLATE_X[i] - mdx);
    const qy = f(TEMPLATE_Y[i] - mdy);
    sxx = f(sxx + f(f(px * px) + f(py * py)));
    a = f(a + f(f(px * qx) + f(py * qy)));
    b = f(b + f(f(px * qy) - f(py * qx)));
  }
  if (sxx === 0 || Number.isNaN(sxx)) return [1, 0, f(mdx - msx), 0, 1, f(mdy - msy)];
  const scap = f(a / sxx);
  const ssin = f(b / sxx);
  const tx = f(f(mdx - f(scap * msx)) + f(ssin * msy));
  const ty = f(f(mdy - f(ssin * msx)) - f(scap * msy));
  return [scap, -ssin, tx, ssin, scap, ty];
}

/**
 * The `ALIGNED` square of RGB bytes the affine carries `rgb` (width by height, three bytes a
 * pixel) onto, sampled bilinearly. What falls outside the picture is black, as on the phone.
 */
export function warpAligned(rgb: Uint8Array, width: number, height: number, affine: number[]): Uint8Array {
  const [a, , tx, b, , ty] = affine;
  // The inverse of x' = a*x - b*y + tx, y' = b*x + a*y + ty.
  const det = a * a + b * b;
  const out = new Uint8Array(ALIGNED * ALIGNED * 3);
  if (det === 0) return out;
  const ia = a / det;
  const ib = b / det;
  for (let oy = 0; oy < ALIGNED; oy++) {
    for (let ox = 0; ox < ALIGNED; ox++) {
      // Pixel centres, as a canvas draws them.
      const dx = ox + 0.5 - tx;
      const dy = oy + 0.5 - ty;
      const sx = ia * dx + ib * dy - 0.5;
      const sy = -ib * dx + ia * dy - 0.5;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const o = (oy * ALIGNED + ox) * 3;
      for (let c = 0; c < 3; c++) {
        let v = 0;
        for (let k = 0; k < 4; k++) {
          const px = x0 + (k & 1);
          const py = y0 + (k >> 1);
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          const w = (k & 1 ? fx : 1 - fx) * (k >> 1 ? fy : 1 - fy);
          v += w * rgb[(py * width + px) * 3 + c];
        }
        out[o + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }
  return out;
}

/** Variance of the Laplacian over a grey image, the usual sharpness measure; 0 for a degenerate one. */
export function laplacianVariance(gray: ArrayLike<number>, width: number, height: number): number {
  if (width < 3 || height < 3 || gray.length < width * height) return 0;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const lap = gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

/** The sharpness of an aligned crop, read in grey with the phone's weights. */
export function alignedBlur(aligned: Uint8Array): number {
  const n = ALIGNED * ALIGNED;
  const gray = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    gray[i] = (aligned[i * 3] * 77 + aligned[i * 3 + 1] * 150 + aligned[i * 3 + 2] * 29) >> 8;
  }
  return Math.fround(laplacianVariance(gray, ALIGNED, ALIGNED));
}

/**
 * How far from frontal a face is turned, about 0 to 1, from its five landmarks: the nose of a
 * straight-on face sits as far from one eye, and one mouth corner, as from the other.
 */
export function sidewaysMeasure(points: ArrayLike<number>): number | null {
  if (points.length < 10) return null;
  const d = (i: number) => Math.hypot(points[2 * i] - points[4], points[2 * i + 1] - points[5]);
  const asym = (l: number, r: number) => {
    const dl = d(l);
    const dr = d(r);
    return dl + dr <= 0 ? 0 : Math.abs(dl - dr) / (dl + dr);
  };
  return Math.fround((asym(0, 1) + asym(3, 4)) / 2);
}

/** A face must score this, objectness times class, to anchor a person. */
export const FACE_MIN_CONFIDENT_SCORE = 0.62;
/** ... be at least this sharp ... */
export const FACE_MIN_CONFIDENT_BLUR = 12.0;
/** ... and turned no further than this. */
export const FACE_MAX_CONFIDENT_SIDEWAYS = 0.18;
/** A crop below this sharpness is not kept at all. */
export const MIN_SHARPNESS = 2.0;

/** A face clear enough to anchor a person; a weaker one joins only at a stricter distance. */
export function isConfidentFace(score: number, blur: number | null, sideways: number | null): boolean {
  if (score < FACE_MIN_CONFIDENT_SCORE) return false;
  if (blur !== null && blur < FACE_MIN_CONFIDENT_BLUR) return false;
  if (sideways !== null && sideways > FACE_MAX_CONFIDENT_SIDEWAYS) return false;
  return true;
}

/** The aligned crop as the recognition model's (1, 112, 112, 3) input. */
export function embedInput(aligned: Uint8Array): Float32Array {
  const out = new Float32Array(aligned.length);
  for (let i = 0; i < aligned.length; i++) out[i] = (aligned[i] - 127.5) / 128;
  return out;
}

/** `vector` scaled to unit length in place; a zero vector stays as it is. */
export function normalizeInPlace(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  const norm = Math.fround(Math.sqrt(sum));
  if (!(norm > 0) || !Number.isFinite(norm)) return vector;
  for (let i = 0; i < vector.length; i++) vector[i] = vector[i] / norm;
  return vector;
}
