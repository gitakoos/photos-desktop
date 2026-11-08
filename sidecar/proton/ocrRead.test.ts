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

import { uprightQuad, type Quad } from "./ocrGeometry.ts";
import {
  CROP_HEIGHT_LIMIT,
  READ_HEIGHT,
  READ_MAX_BATCH,
  READ_MAX_WIDTH,
  READ_MIN_WIDTH,
  READ_WIDTH_BUDGET,
  UPSIDE_DOWN_THRESHOLD,
  buildCharacterDictionary,
  classifierTurnsCrop,
  cropSizeFor,
  cropTextQuad,
  ctcDecode,
  planReadBatches,
  readBatchWidth,
  readContentWidth,
  readHeightOf,
  readWidthOf,
  writeCropInto,
  type Rgb,
} from "./ocrRead.ts";

const box = (w: number, h: number) => uprightQuad(0, 0, w, h);

describe("how a region is cut", () => {
  it("cuts a level line at its own size and a slanted one straightened", () => {
    expect(cropSizeFor(box(200, 40))).toEqual({ width: 200, height: 40, turnsUpright: false });
    const slanted: Quad = [
      { x: 0, y: 30 },
      { x: 40, y: 0 },
      { x: 46, y: 8 },
      { x: 6, y: 38 },
    ];
    expect(cropSizeFor(slanted)).toMatchObject({ width: 50, height: 10 });
    const uneven: Quad = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 120, y: 40 },
      { x: 0, y: 40 },
    ];
    expect(cropSizeFor(uneven).width).toBe(120);
  });

  it("turns a column of text upright, from exactly the stated ratio", () => {
    const column = cropSizeFor(box(30, 200));
    expect(column.turnsUpright).toBe(true);
    expect([readWidthOf(column), readHeightOf(column)]).toEqual([200, 30]);
    expect(cropSizeFor(box(100, 149)).turnsUpright).toBe(false);
    expect(cropSizeFor(box(100, 150)).turnsUpright).toBe(true);
  });

  it("never cuts taller than the reader can use, on either side", () => {
    const wide = cropSizeFor(box(4000, 400));
    expect([readWidthOf(wide), readHeightOf(wide)]).toEqual([960, CROP_HEIGHT_LIMIT]);
    const tall = cropSizeFor(box(400, 4000));
    expect([readWidthOf(tall), readHeightOf(tall)]).toEqual([960, CROP_HEIGHT_LIMIT]);
    expect(cropSizeFor(box(120, 20))).toMatchObject({ width: 120, height: 20 });
    const none = cropSizeFor(box(0, 0));
    expect(none.width >= 1 && none.height >= 1).toBe(true);
  });

  it("warps a slanted quad into a level strip, and turns a column", () => {
    // A frame whose left half is black and right half white, read through a quad that covers it all.
    const frame: Rgb = { data: new Uint8Array(40 * 20 * 3), width: 40, height: 20 };
    for (let y = 0; y < 20; y++) for (let x = 20; x < 40; x++) frame.data.fill(255, (y * 40 + x) * 3, (y * 40 + x) * 3 + 3);
    const strip = cropTextQuad(frame, box(40, 20), { width: 40, height: 20, turnsUpright: false })!;
    expect(strip.data[(10 * 40 + 5) * 3]).toBe(0);
    expect(strip.data[(10 * 40 + 35) * 3]).toBe(255);
    // Turned a quarter clockwise, the frame's left edge lands at the strip's top.
    const turned = cropTextQuad(frame, box(40, 20), { width: 40, height: 20, turnsUpright: true })!;
    expect([turned.width, turned.height]).toEqual([20, 40]);
    expect(turned.data[(5 * 20 + 10) * 3]).toBe(0);
    expect(turned.data[(35 * 20 + 10) * 3]).toBe(255);
  });
});

describe("how crops are run through the reader", () => {
  it("pads ordinary lines to the narrowest input and widens up to the ceiling", () => {
    expect(readBatchWidth(1)).toBe(READ_MIN_WIDTH);
    expect(readBatchWidth(READ_MIN_WIDTH / READ_HEIGHT)).toBe(READ_MIN_WIDTH);
    expect(readBatchWidth(10)).toBe(480);
    expect(readBatchWidth(60)).toBe(READ_MAX_WIDTH);
    expect(readBatchWidth(0)).toBe(READ_MIN_WIDTH);
    expect(readBatchWidth(Number.NaN)).toBe(READ_MIN_WIDTH);
  });

  it("knows where the picture stops inside a padded run", () => {
    expect(readContentWidth(20, 320)).toBe(320);
    expect(readContentWidth(2, 320)).toBe(96);
    expect(readContentWidth(0, 320)).toBe(1);
  });

  it("plans runs within the batch size and the column budget, every crop exactly once", () => {
    expect(planReadBatches(Array(8).fill(2))).toEqual([READ_MAX_BATCH, 2]);
    expect(planReadBatches([])).toEqual([]);
    const wide = planReadBatches(Array(6).fill(40));
    expect(wide.every((s) => s <= 2) && wide.reduce((a, b) => a + b) === 6).toBe(true);
    const ratios = [1, 2, 5, 8, 14, 20, 30, 45];
    let start = 0;
    for (const size of planReadBatches(ratios)) {
      expect(size === 1 || readBatchWidth(ratios[start + size - 1]) * size <= READ_WIDTH_BUDGET).toBe(true);
      start += size;
    }
    expect(start).toBe(ratios.length);
    expect(planReadBatches([400])).toEqual([1]);
  });

  it("turns a crop only when upside down both wins and clears the bar", () => {
    expect(classifierTurnsCrop(0.99, 0.01)).toBe(false);
    expect(classifierTurnsCrop(0.02, 0.98)).toBe(true);
    expect(classifierTurnsCrop(0.45, 0.55)).toBe(false);
    expect(classifierTurnsCrop(0.11, UPSIDE_DOWN_THRESHOLD)).toBe(false);
    expect(classifierTurnsCrop(0.09, 0.91)).toBe(true);
    expect(classifierTurnsCrop(0.97, 0.95)).toBe(false);
  });

  it("lays a crop out blue first, centred on zero, reversed when upside down, padding left at zero", () => {
    const crop: Rgb = { data: new Uint8Array(96 * 48 * 3), width: 96, height: 48 };
    for (let i = 0; i < crop.data.length; i += 3) crop.data.set([255, 0, 0], i);
    crop.data.set([0, 0, 255], 0);
    const tensor = new Float32Array(3 * READ_HEIGHT * 320);
    const plane = READ_HEIGHT * 320;
    expect(writeCropInto(crop, false, tensor, 0, 320)).toBe(96);
    expect(tensor[0]).toBeCloseTo(1);
    expect(tensor[2 * plane]).toBeCloseTo(-1);
    expect(tensor[2 * plane + 1]).toBeCloseTo(1);
    expect(tensor[200]).toBe(0);
    const reversed = new Float32Array(tensor.length);
    writeCropInto(crop, true, reversed, 0, 320);
    expect(reversed[(READ_HEIGHT - 1) * 320 + 95]).toBeCloseTo(1);
  });
});

describe("reading the columns as text", () => {
  const dictionary = buildCharacterDictionary(["a", "b", "c"]);
  const decode = (...columns: number[]) => ctcDecode(columns, columns.map(() => 1), dictionary);

  it("puts the blank first and a space last", () => {
    expect(dictionary).toEqual(["", "a", "b", "c", " "]);
    expect(buildCharacterDictionary([])).toEqual(["", " "]);
  });

  it("collapses runs, drops blanks, keeps a double letter a blank splits, and skips unknown indices", () => {
    expect(ctcDecode([], [], dictionary)).toEqual({ text: "", confidence: 0 });
    expect(decode(0, 0, 0).text).toBe("");
    expect(decode(1, 1, 2, 2, 2, 3).text).toBe("abc");
    expect(decode(0, 1, 0, 0, 2, 0, 3, 0).text).toBe("abc");
    expect(decode(1, 0, 1).text).toBe("aa");
    expect(decode(1, 1, 1).text).toBe("a");
    expect(decode(1, 4, 3).text).toBe("a c");
    expect(decode(1, 99, 99, 3).text).toBe("ac");
    expect(ctcDecode([1, 2, 3], [1], dictionary).text).toBe("a");
  });

  it("averages confidence over characters, each run over its own columns", () => {
    expect(ctcDecode([1, 1, 1, 1, 0, 2], [1, 1, 1, 1, 0, 0.5], dictionary).confidence).toBeCloseTo(0.75);
    expect(ctcDecode([1, 1], [0.4, 0.8], dictionary).confidence).toBeCloseTo(0.6);
    expect(ctcDecode([0, 1, 0], [0.1, 0.9, 0.1], dictionary).confidence).toBeCloseTo(0.9);
    expect(ctcDecode([99, 1], [1, 0.5], dictionary).confidence).toBeCloseTo(0.5);
  });
});
