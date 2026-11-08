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

// A photo read the way the Android app reads it before its models see it, so a photo indexed here
// and the same photo indexed on the phone come out as the same numbers: decoded at a power-of-two
// fraction of its size that keeps the long edge at SOURCE_MAX_EDGE or more, turned upright by its
// EXIF orientation, and scaled from there the way the phone's bitmap scaling does, sampling
// bilinearly at pixel centres with no smoothing on the way down.

import sharp from "sharp";

/** The long edge the phone decodes down towards, never below. */
export const SOURCE_MAX_EDGE = 1600;

/** A decoded picture: three bytes a pixel, red, green, blue, row after row. */
export type Decoded = { rgb: Uint8Array; width: number; height: number };

/** The phone's decode fraction: halved while the long edge stays at SOURCE_MAX_EDGE or more. */
export function sampleSizeFor(width: number, height: number): number {
  const longEdge = Math.max(width, height);
  let sample = 1;
  while (Math.floor(longEdge / (sample * 2)) >= SOURCE_MAX_EDGE) sample *= 2;
  return sample;
}

/** Throws on a picture the decoder cannot read at all. */
export async function decodeLikePhone(bytes: Buffer): Promise<Decoded> {
  const meta = await sharp(bytes, { failOn: "none" }).metadata();
  if (!meta.width || !meta.height) throw new Error("not a picture");
  const sample = sampleSizeFor(meta.width, meta.height);
  // EXIF orientations 5 to 8 lie on their side: the decoded size swaps once turned upright.
  const sideways = (meta.orientation ?? 1) >= 5;
  let image = sharp(bytes, { failOn: "none" }).rotate();
  if (sample > 1) {
    const w = Math.ceil(meta.width / sample);
    const h = Math.ceil(meta.height / sample);
    // An exact power-of-two shrink, which a JPEG decodes at that scale, as the phone's decoder does.
    image = image.resize(sideways ? h : w, sideways ? w : h, { fit: "fill", kernel: "linear" });
  }
  const { data, info } = await image.removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error("not an RGB picture");
  return { rgb: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}

/**
 * The window (`cropX`, `cropY`, `cropW` by `cropH`) of `src` scaled to `outW` by `outH`, sampled
 * bilinearly at pixel centres with the edges held, as an Android bitmap is drawn scaled with
 * filtering on.
 */
export function scaleBilinear(
  src: Decoded,
  outW: number,
  outH: number,
  cropX = 0,
  cropY = 0,
  cropW = outW,
  cropH = outH,
): Uint8Array {
  const { rgb, width, height } = src;
  const out = new Uint8Array(cropW * cropH * 3);
  const sx = width / outW;
  const sy = height / outH;
  for (let y = 0; y < cropH; y++) {
    const fy = Math.min(height - 1, Math.max(0, (cropY + y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < cropW; x++) {
      const fx = Math.min(width - 1, Math.max(0, (cropX + x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(width - 1, x0 + 1);
      const tx = fx - x0;
      const a = (y0 * width + x0) * 3;
      const b = (y0 * width + x1) * 3;
      const c = (y1 * width + x0) * 3;
      const d = (y1 * width + x1) * 3;
      const o = (y * cropW + x) * 3;
      for (let k = 0; k < 3; k++) {
        const top = rgb[a + k] + (rgb[b + k] - rgb[a + k]) * tx;
        const bottom = rgb[c + k] + (rgb[d + k] - rgb[c + k]) * tx;
        out[o + k] = Math.round(top + (bottom - top) * ty);
      }
    }
  }
  return out;
}

/** A part of the picture, copied out as a picture of its own. */
export function cropRegion(src: Decoded, x: number, y: number, w: number, h: number): Decoded {
  const out = new Uint8Array(w * h * 3);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * src.width + x) * 3;
    out.set(src.rgb.subarray(from, from + w * 3), row * w * 3);
  }
  return { rgb: out, width: w, height: h };
}

/**
 * The picture fitted into a `side` square as the phone's detector input is made: scaled to fit
 * with its shape kept, centred, and the margins filled with `pad` grey. Returns the square and
 * how it was placed, to map what is found back.
 */
export function letterbox(
  src: Decoded,
  side: number,
  pad: number,
): { square: Uint8Array; scale: number; padX: number; padY: number } {
  const scale = Math.min(side / src.width, side / src.height);
  const fw = Math.min(side, Math.max(1, Math.round(src.width * scale)));
  const fh = Math.min(side, Math.max(1, Math.round(src.height * scale)));
  const padX = Math.floor((side - fw) / 2);
  const padY = Math.floor((side - fh) / 2);
  const fitted = fw === src.width && fh === src.height ? src.rgb : scaleBilinear(src, fw, fh);
  const square = new Uint8Array(side * side * 3).fill(pad);
  for (let row = 0; row < fh; row++) {
    square.set(fitted.subarray(row * fw * 3, (row + 1) * fw * 3), ((padY + row) * side + padX) * 3);
  }
  return { square, scale, padX, padY };
}

/**
 * The picture as the CLIP encoder's square, as the phone makes it: scaled to cover the square by
 * the longer ratio, each side rounded, then the middle cut out.
 */
export function coverSquare(src: Decoded, side: number): Uint8Array {
  const fill = Math.max(side / src.width, side / src.height);
  const scaledW = Math.max(side, Math.round(src.width * fill));
  const scaledH = Math.max(side, Math.round(src.height * fill));
  const startX = Math.floor((scaledW - side) / 2);
  const startY = Math.floor((scaledH - side) / 2);
  return scaleBilinear(src, scaledW, scaledH, startX, startY, side, side);
}
