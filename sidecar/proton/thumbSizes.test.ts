/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { SmallThumbs, shrinkThumb, thumbWidthFor } from "./thumbSizes.ts";

const photo = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: "#8a6" } }).jpeg().toBuffer();

describe("the size a thumbnail is cut to", () => {
  it("rounds a tile up to the next size, and leaves a large tile the full thumbnail", () => {
    expect(thumbWidthFor(100)).toBe(128);
    expect(thumbWidthFor(128)).toBe(128);
    expect(thumbWidthFor(141)).toBe(192);
    expect(thumbWidthFor(384)).toBe(384);
    expect(thumbWidthFor(385)).toBeNull();
    expect(thumbWidthFor(Number.NaN)).toBeNull();
    expect(thumbWidthFor(0)).toBeNull();
  });
});

describe("cutting a thumbnail down", () => {
  it("makes its shorter side the size, keeping its shape", async () => {
    const small = await shrinkThumb(await photo(512, 384), 192);
    const meta = await sharp(small).metadata();
    expect([meta.width, meta.height]).toEqual([256, 192]);
  });

  it("never enlarges one already smaller", async () => {
    const small = await shrinkThumb(await photo(100, 80), 192);
    expect((await sharp(small).metadata()).width).toBe(100);
  });

  it("is made once for asks at the same moment, kept, and forgotten at clear", async () => {
    const full = await photo(512, 512);
    let reads = 0;
    const thumbs = new SmallThumbs();
    const read = async () => {
      reads++;
      return full;
    };
    const [a, b] = await Promise.all([thumbs.get("u", 128, read), thumbs.get("u", 128, read)]);
    expect(a).toBe(b);
    await thumbs.get("u", 128, read);
    expect(reads).toBe(1);
    expect(thumbs.bytes()).toBeGreaterThan(0);
    thumbs.clear();
    expect(thumbs.bytes()).toBe(0);
  });

  it("keeps no more bytes than it may", async () => {
    const thumbs = new SmallThumbs(1);
    const full = await photo(512, 512);
    await thumbs.get("a", 128, async () => full);
    await thumbs.get("b", 128, async () => full);
    // Nothing fits in one byte: each cut is handed out and let go of.
    expect(thumbs.bytes()).toBe(0);
  });

  it("answers nothing when there is no thumbnail", async () => {
    expect(await new SmallThumbs().get("u", 128, async () => null)).toBeNull();
  });
});

describe("cut thumbnails kept between runs", () => {
  it("are cut once for a size, and read back by a new run without the full thumbnail", async () => {
    const disk = new Map<string, Buffer>();
    const store = { get: (k: string) => disk.get(k) ?? null, put: (k: string, b: Buffer) => void disk.set(k, b) };
    const full = await sharp({ create: { width: 512, height: 384, channels: 3, background: "#888" } }).jpeg().toBuffer();
    let fetched = 0;
    const first = new SmallThumbs(undefined, store);
    await first.get("vol~a", 192, async () => {
      fetched++;
      return full;
    });
    expect(disk.size).toBe(1);
    const second = new SmallThumbs(undefined, store);
    const again = await second.get("vol~a", 192, async () => {
      fetched++;
      return full;
    });
    expect(fetched).toBe(1);
    expect((await sharp(again!).metadata()).height).toBe(192);
  });
});
