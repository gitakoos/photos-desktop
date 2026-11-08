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

// The near-duplicate fingerprint the phone's duplicate finder uses, the same recipe with the
// same calibrated bars, so the two sides group the same photos. A photo is reduced to a 64x64
// luminance field, its 2-D cosine transform is taken, the 16x16 block of lowest frequencies is
// kept (without the DC term, so overall brightness does not count), and each of the 256 bits
// says whether its coefficient is above the block's median. Beside it go a detail score, so a
// near-flat frame (black, white, evenly grey) is left out instead of matching every other flat
// frame, and a coarse 4x4 colour grid, so two shots with one layout but different colours are
// told apart.

/** Bumped when the recipe changes, so fingerprints of two recipes are never compared. */
export const ALGO_VERSION = 1;

/**
 * Structural distance (of 256 bits) at or below which two photos are the same image, before
 * the colour gate. Measured on a real library: true near-duplicates sit up to the mid-60s and
 * unrelated photos start past ~90, so the bar sits in that gap. The textbook ~31 keeps far
 * too few.
 */
export const MATCH_THRESHOLD = 64;
/** Below this detail score (0..100) a frame is too flat to fingerprint. */
export const MIN_QUALITY = 10;
/** Mean per-channel gap (0..255) allowed between two colour grids for a match. */
export const MAX_COLOR_DISTANCE = 40;

const COLOR_CELLS = 4;
export const COLOR_BYTES = COLOR_CELLS * COLOR_CELLS * 3;
/** The 256 bits as eight 32-bit words, bit k in word k >> 5. */
export const HASH_WORDS = 8;
/** The 32 eight-bit bands the clustering looks candidates up by. */
const BAND_COUNT = 32;

const GRID = 64;
const COEFFS = 16;
/** Mean neighbour luminance step that counts as full detail. */
const FULL_DETAIL_STEP = 24;

export type Fingerprint = { bits: Uint32Array; quality: number; color: Uint8Array };

/** DCT-II rows for frequencies 1..16 over 64 samples. */
const BASIS: Float64Array[] = Array.from({ length: COEFFS }, (_, k) => {
  const row = new Float64Array(GRID);
  for (let n = 0; n < GRID; n++) row[n] = Math.cos((Math.PI * (n + 0.5) * (k + 1)) / GRID);
  return row;
});

/**
 * The fingerprint of raw interleaved pixels, `channels` bytes each (RGB first; a fourth is
 * ignored). The downscale is an area average done here, so any size works.
 */
export function fingerprintFromPixels(px: Uint8Array, width: number, height: number, channels: number): Fingerprint {
  const lum = new Float32Array(GRID * GRID);
  const lumCount = new Int32Array(GRID * GRID);
  const cells = COLOR_CELLS * COLOR_CELLS;
  const colR = new Float64Array(cells);
  const colG = new Float64Array(cells);
  const colB = new Float64Array(cells);
  const colCount = new Int32Array(cells);
  const w = width > 0 ? width : 1;
  const h = height > 0 ? height : 1;
  let i = 0;
  for (let y = 0; y < h; y++) {
    const gy = Math.min(Math.floor((y * GRID) / h), GRID - 1);
    const cy = Math.min(Math.floor((y * COLOR_CELLS) / h), COLOR_CELLS - 1);
    for (let x = 0; x < w; x++) {
      const r = px[i] ?? 0;
      const g = px[i + 1] ?? 0;
      const b = px[i + 2] ?? 0;
      i += channels;
      const gx = Math.min(Math.floor((x * GRID) / w), GRID - 1);
      const li = gy * GRID + gx;
      lum[li] += 0.299 * r + 0.587 * g + 0.114 * b;
      lumCount[li]++;
      const cx = Math.min(Math.floor((x * COLOR_CELLS) / w), COLOR_CELLS - 1);
      const ci = cy * COLOR_CELLS + cx;
      colR[ci] += r;
      colG[ci] += g;
      colB[ci] += b;
      colCount[ci]++;
    }
  }
  fillEmptyCells(lum, lumCount);

  const quality = qualityOf(lum);
  const dct = lowFreqDct(lum);
  const median = medianOf(dct);
  const bits = new Uint32Array(HASH_WORDS);
  for (let k = 0; k < dct.length; k++) {
    if (dct[k] > median) bits[k >>> 5] |= 1 << (k & 31);
  }
  const color = new Uint8Array(COLOR_BYTES);
  for (let c = 0; c < cells; c++) {
    const n = colCount[c] > 0 ? colCount[c] : 1;
    color[c * 3] = Math.trunc(colR[c] / n);
    color[c * 3 + 1] = Math.trunc(colG[c] / n);
    color[c * 3 + 2] = Math.trunc(colB[c] / n);
  }
  return { bits, quality, color };
}

function popcount(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Structural distance between two hashes, in differing bits. */
export function distance(a: Uint32Array, b: Uint32Array): number {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) d += popcount((a[i] ^ b[i]) >>> 0);
  return d;
}

/** Mean per-channel difference between two colour grids (0..255). */
export function colorDistance(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return Math.trunc(sum / n);
}

/** Whether two fingerprints are the same photo: structure within the bar AND colour within its gate. */
export function matches(a: Fingerprint, b: Fingerprint): boolean {
  return distance(a.bits, b.bits) <= MATCH_THRESHOLD && colorDistance(a.color, b.color) <= MAX_COLOR_DISTANCE;
}

/** Whether a fingerprint carries enough detail to be trusted. */
export function isUsable(fp: Fingerprint): boolean {
  return fp.quality >= MIN_QUALITY;
}

/**
 * Single-link clusters of the fingerprints: two join when they match, transitively, so a burst
 * A~B~C is one group even when A and C are just past the bar. Answers each index's root (same
 * root, same cluster). Only fingerprints sharing one of 32 eight-bit bands are compared: exact up
 * to a distance of 31 by the pigeonhole principle, and above it a near-duplicate still almost
 * always shares a band, which is what a best-effort finder needs on a large library.
 */
export function clusterSimilar(fps: Fingerprint[]): Int32Array {
  const steps = clusterSteps(fps);
  for (let r = steps.next(); ; r = steps.next()) if (r.done) return r.value;
}

/**
 * The same clusters, made a slice at a time with `pause` awaited between slices, so a large
 * library's grouping never holds everything else up for seconds.
 */
export async function clusterSimilarAsync(fps: Fingerprint[], pause: () => Promise<void>): Promise<Int32Array> {
  const steps = clusterSteps(fps);
  for (let r = steps.next(); ; r = steps.next()) {
    if (r.done) return r.value;
    await pause();
  }
}

/** Comparisons made between two pauses. */
const SLICE = 200_000;

function* clusterSteps(fps: Fingerprint[]): Generator<void, Int32Array, void> {
  const n = fps.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  if (n < 2) return parent;

  const buckets = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const bits = fps[i].bits;
    for (let band = 0; band < BAND_COUNT; band++) {
      const key = (band << 8) | ((bits[band >>> 2] >>> ((band & 3) * 8)) & 0xff);
      const members = buckets.get(key);
      if (members) members.push(i);
      else buckets.set(key, [i]);
    }
  }
  let work = 0;
  for (const members of buckets.values()) {
    if (members.length < 2) continue;
    for (let a = 0; a < members.length; a++) {
      const i = members[a];
      for (let b = a + 1; b < members.length; b++) {
        const j = members[b];
        if (find(i) === find(j)) continue;
        if (matches(fps[i], fps[j])) parent[find(i)] = find(j);
        if (++work >= SLICE) {
          work = 0;
          yield;
        }
      }
    }
  }
  for (let i = 0; i < n; i++) parent[i] = find(i);
  return parent;
}

/** Finish the area average; a cell no pixel fell in takes the mean of the others. */
function fillEmptyCells(lum: Float32Array, count: Int32Array): void {
  let sum = 0;
  let filled = 0;
  for (let i = 0; i < lum.length; i++) {
    if (count[i] > 0) {
      lum[i] /= count[i];
      sum += lum[i];
      filled++;
    }
  }
  if (filled === 0) return;
  const mean = sum / filled;
  for (let i = 0; i < lum.length; i++) if (count[i] === 0) lum[i] = mean;
}

/** The 16x16 lowest non-DC frequencies of the field's 2-D DCT-II, row-major. */
function lowFreqDct(lum: Float32Array): Float32Array {
  const rowT = new Float32Array(GRID * COEFFS);
  for (let r = 0; r < GRID; r++) {
    const off = r * GRID;
    for (let ku = 0; ku < COEFFS; ku++) {
      const b = BASIS[ku];
      let acc = 0;
      for (let n = 0; n < GRID; n++) acc += lum[off + n] * b[n];
      rowT[r * COEFFS + ku] = acc;
    }
  }
  const out = new Float32Array(COEFFS * COEFFS);
  for (let kv = 0; kv < COEFFS; kv++) {
    const b = BASIS[kv];
    for (let ku = 0; ku < COEFFS; ku++) {
      let acc = 0;
      for (let r = 0; r < GRID; r++) acc += rowT[r * COEFFS + ku] * b[r];
      out[kv * COEFFS + ku] = acc;
    }
  }
  return out;
}

function medianOf(values: Float32Array): number {
  const sorted = Float32Array.from(values).sort();
  const mid = sorted.length >>> 1;
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Detail 0..100: the mean step between neighbouring cells, full detail at FULL_DETAIL_STEP. */
function qualityOf(lum: Float32Array): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < GRID; y++) {
    const off = y * GRID;
    for (let x = 0; x < GRID; x++) {
      if (x + 1 < GRID) {
        sum += Math.abs(lum[off + x] - lum[off + x + 1]);
        n++;
      }
      if (y + 1 < GRID) {
        sum += Math.abs(lum[off + x] - lum[off + GRID + x]);
        n++;
      }
    }
  }
  if (n === 0) return 0;
  return Math.round(Math.min(100, ((sum / n) * 100) / FULL_DETAIL_STEP));
}
