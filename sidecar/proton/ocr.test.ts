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

import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

import { OCR_DOWNLOAD_BYTES, ocrModelStatus, readText } from "./ocr.ts";
import { boundsOf } from "./ocrGeometry.ts";
import { initStore, setDataKey } from "./store.ts";

// The models' own release, where a checkout of it sits beside this one; without it the reads are skipped.
const ASSETS = process.env.PFP_OCR_ASSETS ?? join(process.cwd(), "..", "..", "ocr-models", "release-assets");
const present = existsSync(join(ASSETS, "rec_latin.onnx"));

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "pfp-ocr-"));
  initStore(dir);
  setDataKey(randomBytes(32));
  if (!present) return;
  mkdirSync(join(dir, "models"), { recursive: true });
  for (const [from, to] of [
    ["det.onnx", "ocr-det.onnx"],
    ["cls.onnx", "ocr-cls.onnx"],
    ["rec_latin.onnx", "ocr-rec-latin.onnx"],
    ["ppocrv5_latin_dict.txt", "ocr-latin-dict.txt"],
  ]) {
    copyFileSync(join(ASSETS, from), join(dir, "models", to));
  }
});

/** A picture of `lines`, black on white, one line under the other. */
function page(lines: string[], width = 1400, size = 56): Promise<Buffer> {
  const rows = lines
    .map((l, i) => `<text x="60" y="${110 + i * size * 2}" font-family="Arial" font-size="${size}" fill="#111">${l}</text>`)
    .join("");
  const height = 120 + lines.length * size * 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#fff"/>${rows}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

describe("copy text", () => {
  it("asks for the four model files, 13.4 MB together", () => {
    expect(OCR_DOWNLOAD_BYTES).toBe(4_748_769 + 582_663 + 8_064_539 + 2_616);
  });

  it.skipIf(!present)("reads printed lines, Hungarian letters included, in reading order and in the photo's pixels", async () => {
    expect(ocrModelStatus().state).toBe("ready");
    const stages: string[] = [];
    const result = await readText(await page(["Photos for Proton 2026", "Árvíztűrő tükörfúrógép"]), (s) => stages.push(s));
    expect(result).not.toBeNull();
    expect(stages).toEqual(["detecting", "reading"]);
    const texts = result!.blocks.map((b) => b.text);
    expect(texts.join(" | ")).toMatch(/Photos for Proton 2026/);
    expect(texts.join(" | ")).toMatch(/Árvíztűrő tükörfúrógép/);
    expect(result!.width).toBe(1400);
    const first = boundsOf(result!.blocks[0].quad);
    const second = boundsOf(result!.blocks[1].quad);
    expect(first.top).toBeLessThan(second.top);
    expect(first.left).toBeGreaterThan(30);
    expect(first.left).toBeLessThan(90);
  }, 60_000);

  it.skipIf(!present)("finds nothing on a picture without text", async () => {
    const blank = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#7aa" } }).jpeg().toBuffer();
    const result = await readText(blank);
    expect(result!.blocks).toEqual([]);
  }, 60_000);

  it.skipIf(!present)("reads an upside-down photo the right way round", async () => {
    const turned = await sharp(await page(["Upside down sign"])).rotate(180).toBuffer();
    const result = await readText(turned);
    expect(result!.blocks.map((b) => b.text).join(" ")).toMatch(/Upside down sign/);
  }, 60_000);

  it.skipIf(!present)("lets a newer read take over from one still waiting", async () => {
    const pictures = [await page(["first"]), await page(["second one"])];
    const [first, second] = await Promise.all(pictures.map((p) => readText(p)));
    expect(first).toBeNull();
    expect(second!.blocks.map((b) => b.text).join(" ")).toMatch(/second one/);
  }, 60_000);
});
