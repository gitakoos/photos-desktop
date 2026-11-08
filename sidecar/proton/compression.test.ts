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
import { readFile, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import exifr from "exifr";
import sharp, { type Sharp } from "sharp";

import {
  NO_COMPRESSION,
  compressPhoto,
  jpegName,
  mp4Name,
  planVideo,
  readCompressionSettings,
  resolveCodec,
  setMp4Times,
  targetBitrate,
  type VideoProbe,
} from "./compression.ts";
import { readMp4CreationTime } from "./mp4Date.ts";

const dir = mkdtempSync(join(tmpdir(), "pfp-compress-test-"));
const on = { ...NO_COMPRESSION, photos: true, videos: true };

/** A grainy picture, like a photo's, so a JPEG of it has real weight to lose. */
async function noisy(width: number, height: number): Promise<Sharp> {
  const grain = await sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).blur(1).png().toBuffer();
  return sharp(grain);
}

describe("a photo compressed for upload", () => {
  it("is a smaller JPEG, upright, with its EXIF kept, and the same bytes every time", async () => {
    const src = join(dir, "IMG_1.jpg");
    await (await noisy(1200, 800))
      .jpeg({ quality: 98 })
      .withExif({ IFD0: { Make: "Pixel", Model: "8" }, IFD2: { DateTimeOriginal: "2024:05:06 07:08:09" } })
      .withMetadata({ orientation: 6 })
      .toFile(src);
    const first = await compressPhoto(src, "image/jpeg", on);
    expect("copy" in first).toBe(true);
    if (!("copy" in first)) return;
    expect(first.copy.name).toBe("IMG_1.jpg");
    expect(first.copy.size).toBeLessThan(first.copy.sourceSize);
    const meta = await sharp(first.copy.path).metadata();
    // Turned upright: the sideways picture is now taller than wide, with no rotation left to apply.
    expect([meta.width, meta.height]).toEqual([800, 1200]);
    expect(meta.orientation ?? 1).toBe(1);
    const exif = await exifr.parse(first.copy.path, { pick: ["Make", "DateTimeOriginal"] });
    expect(exif.Make).toBe("Pixel");
    expect(exif.DateTimeOriginal).toBeInstanceOf(Date);
    const bytes = await readFile(first.copy.path);
    const again = await compressPhoto(src, "image/jpeg", on);
    expect("copy" in again && (await readFile(again.copy.path)).equals(bytes)).toBe(true);
  });

  it("caps the longest edge on the smaller levels, and a PNG goes up as a JPEG", async () => {
    const src = join(dir, "shot.png");
    await (await noisy(3000, 1000)).png().toFile(src);
    const out = await compressPhoto(src, "image/png", { ...on, tier: "small" });
    expect("copy" in out).toBe(true);
    if (!("copy" in out)) return;
    expect(out.copy.name).toBe("shot.jpg");
    const meta = await sharp(out.copy.path).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 2560, 853]);
  });

  it("goes up as it is when transparent, animated, of another format, or no smaller", async () => {
    const clear = join(dir, "clear.png");
    const pixels = Buffer.alloc(64 * 64 * 4, 0);
    await sharp(pixels, { raw: { width: 64, height: 64, channels: 4 } }).png().toFile(clear);
    expect(await compressPhoto(clear, "image/png", on)).toEqual({ skipped: "transparent" });

    const animated = join(dir, "anim.webp");
    await sharp([
      await sharp({ create: { width: 32, height: 32, channels: 3, background: "red" } }).png().toBuffer(),
      await sharp({ create: { width: 32, height: 32, channels: 3, background: "blue" } }).png().toBuffer(),
    ], { join: { animated: true } }).webp().toFile(animated);
    expect(await compressPhoto(animated, "image/webp", on)).toEqual({ skipped: "animated" });

    expect(await compressPhoto(join(dir, "x.heic"), "image/heic", on)).toEqual({ skipped: "format" });

    const small = join(dir, "small.jpg");
    await sharp({ create: { width: 16, height: 16, channels: 3, background: "white" } }).jpeg({ quality: 30 }).toFile(small);
    expect(await compressPhoto(small, "image/jpeg", on)).toEqual({ skipped: "not-smaller" });
  });

  it("names a copy as a JPEG or an MP4", () => {
    expect(jpegName("a.PNG")).toBe("a.jpg");
    expect(jpegName("b.jpeg")).toBe("b.jpeg");
    expect(mp4Name("c.MOV")).toBe("c.mp4");
    expect(mp4Name("d.mp4")).toBe("d.mp4");
  });
});

describe("the settings the window sends", () => {
  it("fall back to the defaults for anything unknown", () => {
    expect(readCompressionSettings({ photos: true, tier: "huge", codec: "vp9", videoTier: "small" })).toEqual({
      ...NO_COMPRESSION,
      photos: true,
      videoTier: "small",
    });
    expect(readCompressionSettings(null)).toEqual(NO_COMPRESSION);
  });
});

describe("a video's plan", () => {
  const all = { avc: true, hevc: true, av1: true };
  const probe = (over: Partial<VideoProbe> = {}): VideoProbe => ({
    width: 3840,
    height: 2160,
    fps: 60,
    durationMs: 10_000,
    videoBitrate: 50_000_000,
    audioBitrate: 192_000,
    hasAudio: true,
    codec: "hevc",
    hdr: false,
    size: 62_000_000,
    ...over,
  });

  it("caps the short side and the frame rate by the level, never scaling up", () => {
    const balanced = planVideo(probe(), { ...on, codec: "avc" }, all);
    expect(balanced).toMatchObject({ codec: "avc", width: 1920, height: 1080, fps: null });
    const small = planVideo(probe(), { ...on, codec: "avc", videoTier: "small" }, all);
    expect(small).toMatchObject({ width: 1280, height: 720, fps: 30 });
    const portrait = planVideo(probe({ width: 1080, height: 1920, fps: 30.02 }), { ...on, videoTier: "small" }, all);
    expect(portrait).toMatchObject({ width: 720, height: 1280, fps: null });
    const high = planVideo(probe({ width: 640, height: 360 }), { ...on, videoTier: "high" }, all);
    expect(high).toMatchObject({ width: 640, height: 360 });
  });

  it("aims at the phone's bitrate, under 80% of the source's", () => {
    expect(targetBitrate("avc", "balanced", 1920, 1080, 30)).toBe(Math.floor(0.08 * 1920 * 1080 * 30));
    // 1080p60 H.264 aims at 9.95 Mbit/s; a 12 Mbit/s source gets 80% of its own.
    const plan = planVideo(probe({ videoBitrate: 12_000_000 }), { ...on, codec: "avc" }, all);
    expect(plan).toMatchObject({ bitrate: 9_600_000 });
    const lean = planVideo(probe({ videoBitrate: 50_000_000 }), { ...on, codec: "avc" }, all);
    expect(lean).toMatchObject({ bitrate: targetBitrate("avc", "balanced", 1920, 1080, 60) });
  });

  it("goes up as it is when already about as small, HDR, too short or unreadable", () => {
    expect(planVideo(probe({ videoBitrate: 5_000_000 }), { ...on, codec: "avc", videoTier: "balanced" }, all)).toEqual({ skipped: "efficient" });
    expect(planVideo(probe({ hdr: true }), on, all)).toEqual({ skipped: "hdr" });
    expect(planVideo(probe({ durationMs: 400 }), on, all)).toEqual({ skipped: "too-short" });
    expect(planVideo(probe({ size: 0 }), on, all)).toEqual({ skipped: "unreadable" });
  });

  it("takes the codec asked for when this PC has its encoder, else the next one down", () => {
    const none = { avc: true, hevc: false, av1: false };
    expect(resolveCodec("auto", "avc", all)).toBe("hevc");
    expect(resolveCodec("auto", "avc", none)).toBe("avc");
    expect(resolveCodec("av1", "avc", { avc: true, hevc: true, av1: false })).toBe("hevc");
    expect(resolveCodec("keep", "hevc", all)).toBe("hevc");
    expect(resolveCodec("keep", "other", all)).toBe("avc");
    expect(resolveCodec("avc", "hevc", { avc: false, hevc: false, av1: false })).toBeNull();
  });
});

/** An MP4 box: size, type, body. */
function box(type: string, ...body: Buffer[]): Buffer {
  const inner = Buffer.concat(body);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + inner.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, inner]);
}

describe("the capture time of a transcoded MP4", () => {
  it("is written into the movie, every track and its media, in either header version", async () => {
    const v0 = Buffer.alloc(100);
    const v1 = Buffer.alloc(112);
    v1[0] = 1;
    const file = Buffer.concat([
      box("ftyp", Buffer.from("isom")),
      box("moov", box("mvhd", v0), box("trak", box("tkhd", Buffer.alloc(84)), box("mdia", box("mdhd", v1)))),
      box("mdat", Buffer.alloc(32)),
    ]);
    const path = join(dir, "clip.mp4");
    await writeFile(path, file);
    const at = new Date("2023-07-01T10:20:30Z");
    expect(await setMp4Times(path, at)).toBe(3);
    expect((await readMp4CreationTime(path))?.getTime()).toBe(at.getTime());
    const back = await readFile(path);
    expect(back.length).toBe(file.length);
    const mdhd = back.indexOf(Buffer.from("mdhd")) + 4;
    expect(Number(back.readBigUInt64BE(mdhd + 4))).toBe(at.getTime() / 1000 + 2_082_844_800);
  });
});
