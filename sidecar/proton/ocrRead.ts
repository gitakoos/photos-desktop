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
 * The crop sizing, the four-corner warp, the upright turn, the angle-classifier rule, the
 * alphabet layout and the CTC collapse below are derived from mobile_ocr, which is MIT licensed:
 *
 *   Copyright (c) 2025 Laurens Priem
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, subject to the conditions of the MIT License.
 */

// From a found region to its characters: the region cut out as a level strip, laid out the way
// the reader and the angle classifier take it, and the reader's per-column answer collapsed into
// text, as the phone does it.

import { distance, type Quad } from "./ocrGeometry.ts";

/** Height every crop is squeezed to before the reader. */
export const READ_HEIGHT = 48;
/** Narrowest reader input, where an ordinary run of lines lands. */
export const READ_MIN_WIDTH = 320;
/** Widest reader input: a full-width line of a large screenshot is read close to its own scale. */
export const READ_MAX_WIDTH = 2400;
/** Most crops one reader run carries. */
export const READ_MAX_BATCH = 6;
/** Total input columns one reader run may cover, which is what bounds its output. */
export const READ_WIDTH_BUDGET = READ_MIN_WIDTH * READ_MAX_BATCH;
/** Tallest a crop is cut at; the reader squeezes to 48 anyway. */
export const CROP_HEIGHT_LIMIT = 96;
/** Height over width at which a crop is a column of text, turned upright. */
export const UPRIGHT_TURN_RATIO = 1.5;
/** How sure the classifier has to be before a crop is read upside down. */
export const UPSIDE_DOWN_THRESHOLD = 0.9;
/** The angle classifier's fixed input width. */
export const CLASSIFIER_WIDTH = 192;

/** Raw interleaved RGB pixels. */
export type Rgb = { data: Uint8Array; width: number; height: number };

export type CropSize = { width: number; height: number; turnsUpright: boolean };

export const readWidthOf = (s: CropSize) => (s.turnsUpright ? s.height : s.width);
export const readHeightOf = (s: CropSize) => (s.turnsUpright ? s.width : s.height);

/**
 * The size a quad is cut at: its own edge lengths (the longer of each opposing pair), so a slanted
 * line comes out straightened; a column of text is marked to be turned; and the side that becomes
 * the height kept within `heightLimit`, since the reader squeezes to 48 anyway.
 */
export function cropSizeFor(quad: Quad, heightLimit = CROP_HEIGHT_LIMIT): CropSize {
  const [tl, tr, br, bl] = quad;
  const width = Math.max(distance(tl, tr), distance(br, bl));
  const height = Math.max(distance(tl, bl), distance(tr, br));
  const turns = width > 0 && height / width >= UPRIGHT_TURN_RATIO;
  const readHeight = turns ? width : height;
  const scale = readHeight > heightLimit && readHeight > 0 ? heightLimit / readHeight : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    turnsUpright: turns,
  };
}

/** The width a run is padded to, set by its widest crop. */
export function readBatchWidth(maxRatio: number): number {
  if (!Number.isFinite(maxRatio) || maxRatio <= 0) return READ_MIN_WIDTH;
  return Math.min(Math.max(Math.ceil(READ_HEIGHT * maxRatio), READ_MIN_WIDTH), READ_MAX_WIDTH);
}

/** How crops sorted narrowest first are split into runs: within the column budget and the batch size; one crop always runs. */
export function planReadBatches(ratiosAscending: number[]): number[] {
  const sizes: number[] = [];
  let index = 0;
  while (index < ratiosAscending.length) {
    let count = 1;
    while (index + count < ratiosAscending.length && count < READ_MAX_BATCH) {
      const width = readBatchWidth(ratiosAscending[index + count]);
      if (width * (count + 1) > READ_WIDTH_BUDGET) break;
      count++;
    }
    sizes.push(count);
    index += count;
  }
  return sizes;
}

/** The columns a crop of `ratio` covers inside a run `batchWidth` wide; the rest is padding. */
export function readContentWidth(ratio: number, batchWidth: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.min(Math.max(Math.ceil(READ_HEIGHT * ratio), 1), batchWidth);
}

/** A crop is turned only when the turned score both wins and clears the bar. */
export function classifierTurnsCrop(upright: number, upsideDown: number): boolean {
  return upsideDown > upright && upsideDown > UPSIDE_DOWN_THRESHOLD;
}

/**
 * The projective transform taking the four `from` points onto the four `to` points, as the
 * eight coefficients of [a b c; d e f; g h 1], or null for a degenerate quad.
 */
export function homography(from: number[], to: number[]): number[] | null {
  const m: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = [from[i * 2], from[i * 2 + 1]];
    const [u, v] = [to[i * 2], to[i * 2 + 1]];
    m.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    m.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-10) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c < 9; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[8] / row[i]);
}

/**
 * The quad cut out of the frame as a straightened strip: one projective warp takes the quad's
 * corners to the crop's, and a column of text is quarter-turned in the same warp. Each crop pixel
 * is sampled bilinearly from where it falls in the frame.
 */
export function cropTextQuad(frame: Rgb, quad: Quad, size: CropSize): Rgb | null {
  const w = size.width;
  const h = size.height;
  const outW = readWidthOf(size);
  const outH = readHeightOf(size);
  const source = quad.flatMap((p) => [p.x, p.y]);
  const destination = size.turnsUpright ? [h, 0, h, w, 0, w, 0, 0] : [0, 0, w, 0, w, h, 0, h];
  // From the crop back into the frame, so every crop pixel asks where it comes from.
  const back = homography(destination, source);
  if (!back) return null;
  const [a, b, c, d, e, f, g, k] = back;
  const out = new Uint8Array(outW * outH * 3);
  const fw = frame.width;
  const fh = frame.height;
  const px = frame.data;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      const z = g * cx + k * cy + 1;
      const sx = (a * cx + b * cy + c) / z - 0.5;
      const sy = (d * cx + e * cy + f) / z - 0.5;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const tx = sx - x0;
      const ty = sy - y0;
      const xa = Math.min(Math.max(x0, 0), fw - 1);
      const xb = Math.min(Math.max(x0 + 1, 0), fw - 1);
      const ya = Math.min(Math.max(y0, 0), fh - 1);
      const yb = Math.min(Math.max(y0 + 1, 0), fh - 1);
      const o = (y * outW + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const p00 = px[(ya * fw + xa) * 3 + ch];
        const p10 = px[(ya * fw + xb) * 3 + ch];
        const p01 = px[(yb * fw + xa) * 3 + ch];
        const p11 = px[(yb * fw + xb) * 3 + ch];
        const top = p00 + (p10 - p00) * tx;
        const bottom = p01 + (p11 - p01) * tx;
        out[o + ch] = Math.round(top + (bottom - top) * ty);
      }
    }
  }
  return { data: out, width: outW, height: outH };
}

/** `image` scaled to `width` by `height`, bilinear. */
export function scaleRgb(image: Rgb, width: number, height: number): Rgb {
  if (image.width === width && image.height === height) return image;
  const out = new Uint8Array(width * height * 3);
  const sx = image.width / width;
  const sy = image.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), image.height - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, image.height - 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), image.width - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, image.width - 1);
      const tx = fx - x0;
      const o = (y * width + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const p00 = image.data[(y0 * image.width + x0) * 3 + ch];
        const p10 = image.data[(y0 * image.width + x1) * 3 + ch];
        const p01 = image.data[(y1 * image.width + x0) * 3 + ch];
        const p11 = image.data[(y1 * image.width + x1) * 3 + ch];
        const top = p00 + (p10 - p00) * tx;
        const bottom = p01 + (p11 - p01) * tx;
        out[o + ch] = Math.round(top + (bottom - top) * ty);
      }
    }
  }
  return { data: out, width, height };
}

/**
 * Writes a crop into slot `slot` of a batch tensor `batchWidth` columns wide, as both networks
 * take it: squeezed to 48 tall, centred on zero, three planes in blue, green, red order, the rest
 * of the row left at zero. Upside down is a reversed read. Answers the columns the crop covers.
 */
export function writeCropInto(crop: Rgb, upsideDown: boolean, tensor: Float32Array, slot: number, batchWidth: number): number {
  const plane = READ_HEIGHT * batchWidth;
  const base = slot * 3 * plane;
  const contentWidth = readContentWidth(crop.width / Math.max(crop.height, 1), batchWidth);
  const scaled = scaleRgb(crop, contentWidth, READ_HEIGHT);
  for (let y = 0; y < READ_HEIGHT; y++) {
    const row = y * batchWidth;
    const sourceRow = (upsideDown ? READ_HEIGHT - 1 - y : y) * contentWidth;
    for (let x = 0; x < contentWidth; x++) {
      const s = (sourceRow + (upsideDown ? contentWidth - 1 - x : x)) * 3;
      const cell = row + x;
      tensor[base + cell] = (scaled.data[s + 2] / 255 - 0.5) / 0.5;
      tensor[base + plane + cell] = (scaled.data[s + 1] / 255 - 0.5) / 0.5;
      tensor[base + 2 * plane + cell] = (scaled.data[s] / 255 - 0.5) / 0.5;
    }
  }
  return contentWidth;
}

export type DecodedText = { text: string; confidence: number };

/** The reader's alphabet: the CTC blank first, the dictionary, and a space last. */
export function buildCharacterDictionary(lines: string[]): string[] {
  return ["", ...lines, " "];
}

/**
 * One crop's per-column best indices collapsed into text: each run of one index is one character,
 * the blank (0) separates runs and never appears. The confidence is the mean over characters of
 * each run's mean probability. An index the alphabet does not have is skipped.
 */
export function ctcDecode(indices: ArrayLike<number>, probabilities: ArrayLike<number>, dictionary: string[]): DecodedText {
  const columns = Math.min(indices.length, probabilities.length);
  if (columns === 0) return { text: "", confidence: 0 };
  let text = "";
  let sum = 0;
  let characters = 0;
  let column = 0;
  while (column < columns) {
    const index = indices[column];
    if (index === 0) {
      column++;
      continue;
    }
    let end = column;
    let runSum = 0;
    while (end < columns && indices[end] === index) {
      runSum += probabilities[end];
      end++;
    }
    if (index >= 0 && index < dictionary.length) {
      text += dictionary[index];
      sum += runSum / (end - column);
      characters++;
    }
    column = end;
  }
  return { text, confidence: characters > 0 ? sum / characters : 0 };
}

/**
 * The reader's output for one slot decoded: the winning entry per column over the columns the
 * crop itself covered (one of slack, so a letter against the edge survives), then collapsed.
 */
export function decodeSlot(
  output: Float32Array,
  slot: number,
  columns: number,
  alphabet: number,
  contentWidth: number,
  batchWidth: number,
  dictionary: string[],
): DecodedText {
  const used =
    batchWidth <= 0 || contentWidth >= batchWidth
      ? columns
      : Math.min(Math.max(Math.ceil((columns * contentWidth) / batchWidth) + 1, 1), columns);
  const indices = new Int32Array(used);
  const probabilities = new Float32Array(used);
  const slotOffset = slot * columns * alphabet;
  for (let column = 0; column < used; column++) {
    const at = slotOffset + column * alphabet;
    let best = 0;
    let bestScore = output[at];
    for (let entry = 1; entry < alphabet; entry++) {
      const v = output[at + entry];
      if (v > bestScore) {
        bestScore = v;
        best = entry;
      }
    }
    indices[column] = best;
    probabilities[column] = bestScore;
  }
  return ctcDecode(indices, probabilities, dictionary);
}
