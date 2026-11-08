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

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { coverSquare, decodeLikePhone, letterbox, sampleSizeFor, scaleBilinear, type Decoded } from "./phoneDecode.ts";

function picture(width: number, height: number, at: (x: number, y: number) => [number, number, number]): Decoded {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgb.set(at(x, y), (y * width + x) * 3);
  return { rgb, width, height };
}

describe("the phone's decode size", () => {
  it("halves while the long edge stays at 1600 or more", () => {
    expect(sampleSizeFor(1500, 1000)).toBe(1);
    expect(sampleSizeFor(3199, 2000)).toBe(1);
    expect(sampleSizeFor(3200, 2400)).toBe(2);
    expect(sampleSizeFor(4032, 3024)).toBe(2);
    expect(sampleSizeFor(6400, 4800)).toBe(4);
    expect(sampleSizeFor(3000, 8000)).toBe(4);
  });

  it("decodes a large photo at that fraction, upright by its EXIF orientation", async () => {
    // 4000 x 2000 stored, turned a quarter by orientation 6: upright it stands 1000 x 2000.
    const jpeg = await sharp({ create: { width: 4000, height: 2000, channels: 3, background: { r: 200, g: 50, b: 10 } } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const img = await decodeLikePhone(jpeg);
    expect([img.width, img.height]).toEqual([1000, 2000]);
    expect(img.rgb.length).toBe(1000 * 2000 * 3);
  });
});

describe("the phone's bitmap scaling", () => {
  it("leaves a picture at its own size as it is", () => {
    const src = picture(4, 3, (x, y) => [x * 10, y * 20, 7]);
    expect(Array.from(scaleBilinear(src, 4, 3))).toEqual(Array.from(src.rgb));
  });

  it("samples at pixel centres without smoothing over the rest", () => {
    // A stripe pattern halved: each output pixel reads between two stripes, not over four.
    const src = picture(4, 1, (x) => (x % 2 ? [255, 255, 255] : [0, 0, 0]));
    expect(Array.from(scaleBilinear(src, 2, 1))).toEqual([128, 128, 128, 128, 128, 128]);
    // A thin line kept at a third of the width falls between samples, as on the phone.
    const line = picture(9, 1, (x) => (x === 4 ? [255, 255, 255] : [0, 0, 0]));
    expect(Array.from(scaleBilinear(line, 3, 1))).toEqual([0, 0, 0, 255, 255, 255, 0, 0, 0]);
  });

  it("covers the CLIP square by the longer ratio and cuts out the middle", () => {
    const wide = picture(448, 224, (x) => [x < 224 ? 0 : 255, 0, 0]);
    const square = coverSquare(wide, 224);
    expect(square.length).toBe(224 * 224 * 3);
    // The middle of a wide picture: the dark half on the left, the light on the right.
    expect(square[0]).toBe(0);
    expect(square[(224 - 1) * 3]).toBe(255);
  });

  it("letterboxes into the detector's square with grey margins", () => {
    const tall = picture(100, 200, () => [9, 9, 9]);
    const { square, scale, padX, padY } = letterbox(tall, 640, 114);
    expect(scale).toBeCloseTo(3.2, 6);
    expect([padX, padY]).toEqual([160, 0]);
    expect(square[0]).toBe(114);
    expect(square[(320 * 640 + 320) * 3]).toBe(9);
  });
});
