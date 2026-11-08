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
import exifr from "exifr";

import { crc32, embedCaptureDate } from "./embedDate.ts";

// 17 Nov 2024, 04:17:56 on this machine's clock: what a name like 20241117_041756 records.
const WHEN = new Date(2024, 10, 17, 4, 17, 56).getTime();

/** The picture data a JPEG carries after its headers, which no edit may touch. */
const SCAN = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6, 0x11, 0x22, 0x33, 0x44, 0xff, 0xd9]);

function segment(marker: number, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xff00 | marker, 0);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

/** A JPEG as a messaging app saves it: a JFIF header, a table, the picture, no EXIF. */
function strippedJpeg(): Buffer {
  const jfif = Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1");
  return Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xe0, jfif), segment(0xdb, Buffer.alloc(65, 7)), SCAN]);
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function tinyPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", Buffer.from([9, 8, 7, 6])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function box(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}

/** A full box at version 0 holding a creation and a modification time, then padding. */
function timed(type: string, seconds: number, rest = 80): Buffer {
  const body = Buffer.alloc(4 + 8 + rest);
  body.writeUInt32BE(seconds, 4);
  body.writeUInt32BE(seconds, 8);
  return box(type, body);
}

function tinyMp4(seconds: number): Buffer {
  return Buffer.concat([
    box("ftyp", Buffer.from("isom\0\0\0\0isomiso2mp41", "latin1")),
    box("moov", Buffer.concat([
      timed("mvhd", seconds),
      box("trak", Buffer.concat([timed("tkhd", seconds), box("mdia", timed("mdhd", seconds))])),
    ])),
    box("mdat", Buffer.from("the video stream itself")),
  ]);
}

describe("embedCaptureDate, JPEG", () => {
  it("adds the dates to a JPEG that carries no EXIF, leaving the picture untouched", async () => {
    const input = strippedJpeg();
    const out = embedCaptureDate(input, WHEN)!;

    expect(out.how).toBe("exif-added");
    const tags = await exifr.parse(out.bytes, { pick: ["DateTimeOriginal", "CreateDate", "OffsetTimeOriginal"], reviveValues: false });
    expect(tags.DateTimeOriginal).toBe("2024:11:17 04:17:56");
    expect(tags.CreateDate).toBe("2024:11:17 04:17:56");
    expect(tags.OffsetTimeOriginal).toMatch(/^[+-]\d{2}:\d{2}$/);
    // The JFIF header stays first, and every byte of the picture data is the same.
    expect(out.bytes.subarray(2, 4)).toEqual(Buffer.from([0xff, 0xe0]));
    expect(out.bytes.subarray(out.bytes.length - SCAN.length)).toEqual(SCAN);
    expect(input).toEqual(strippedJpeg()); // the input itself is never written to
  });

  it("rewrites the dates an existing EXIF block carries, in place", async () => {
    const before = embedCaptureDate(strippedJpeg(), new Date(2019, 0, 2, 3, 4, 5).getTime())!.bytes;
    const out = embedCaptureDate(before, WHEN)!;

    expect(out.how).toBe("exif-patched");
    const tags = await exifr.parse(out.bytes, { pick: ["DateTimeOriginal", "CreateDate", "ModifyDate"], reviveValues: false });
    expect(tags.DateTimeOriginal).toBe("2024:11:17 04:17:56");
    expect(tags.CreateDate).toBe("2024:11:17 04:17:56");
    expect(out.bytes.subarray(out.bytes.length - SCAN.length)).toEqual(SCAN);
  });

  it("always comes out different from what it was given", () => {
    const once = embedCaptureDate(strippedJpeg(), WHEN)!.bytes;
    // Even a file already carrying exactly this date changes: the note goes in again,
    // so the upload is never taken for the photo already on Drive.
    expect(embedCaptureDate(once, WHEN)!.bytes.equals(once)).toBe(false);
  });

  it("refuses a JPEG it cannot walk", () => {
    expect(embedCaptureDate(Buffer.from([0xff, 0xd8, 0x00, 0x01, 2, 3, 4, 5, 6, 7, 8, 9, 10]), WHEN)).toBeNull();
  });
});

describe("embedCaptureDate, real encoder output", () => {
  // Files made by a real encoder, decoded again after the edit: the pixels must be the
  // very same, which is the whole promise of editing the metadata only.
  async function pixels(file: Buffer): Promise<Buffer> {
    const { default: sharp } = await import("sharp");
    return sharp(file).raw().toBuffer();
  }

  it("keeps a real JPEG decodable with identical pixels, with or without EXIF", async () => {
    const { default: sharp } = await import("sharp");
    const image = sharp({ create: { width: 16, height: 12, channels: 3, background: { r: 200, g: 40, b: 90 } } });
    for (const jpeg of [
      await image.clone().jpeg({ quality: 80 }).toBuffer(),
      await image.clone().jpeg({ quality: 80 }).withExif({ IFD0: { Make: "Phone", DateTime: "2019:01:02 03:04:05" } }).toBuffer(),
    ]) {
      const out = embedCaptureDate(jpeg, WHEN)!;
      expect(await pixels(out.bytes)).toEqual(await pixels(jpeg));
      const tags = await exifr.parse(out.bytes, { reviveValues: false });
      expect(tags.DateTimeOriginal ?? tags.ModifyDate).toBe("2024:11:17 04:17:56");
    }
  });

  it("keeps a real PNG decodable with identical pixels", async () => {
    const { default: sharp } = await import("sharp");
    const png = await sharp({ create: { width: 9, height: 7, channels: 4, background: "#33aa55" } }).png().toBuffer();
    const out = embedCaptureDate(png, WHEN)!;
    expect(await pixels(out.bytes)).toEqual(await pixels(png));
  });
});

describe("embedCaptureDate, PNG, video, GIF and the rest", () => {
  it("adds a valid Creation Time text chunk to a PNG ahead of its image data", () => {
    const out = embedCaptureDate(tinyPng(), WHEN)!;
    expect(out.how).toBe("png-text");
    // Every chunk still checks out, and the new text sits before the image data.
    const types: string[] = [];
    for (let at = 8; at < out.bytes.length; ) {
      const length = out.bytes.readUInt32BE(at);
      const type = out.bytes.toString("latin1", at + 4, at + 8);
      const crc = out.bytes.readUInt32BE(at + 8 + length);
      expect(crc32(out.bytes.subarray(at + 4, at + 8 + length))).toBe(crc);
      types.push(type);
      at += 12 + length;
    }
    expect(types).toEqual(["IHDR", "tEXt", "tEXt", "IDAT", "IEND"]);
    expect(out.bytes.toString("latin1")).toContain("Creation Time\u00002024-11-17T04:17:56");
  });

  it("sets an MP4's movie, track and media times and keeps its stream", () => {
    const out = embedCaptureDate(tinyMp4(3_000_000_000), WHEN)!;
    expect(out.how).toBe("media-times");
    const want = Math.floor(WHEN / 1000) + 2_082_844_800;
    for (const type of ["mvhd", "tkhd", "mdhd"]) {
      const at = out.bytes.indexOf(type, 0, "latin1");
      expect(out.bytes.readUInt32BE(at + 4 + 4)).toBe(want);
      expect(out.bytes.readUInt32BE(at + 4 + 8)).toBe(want);
    }
    expect(out.bytes.includes(Buffer.from("the video stream itself"))).toBe(true);
  });

  it("changes a HEIC-like file with no header times by a trailing free box", () => {
    const heic = Buffer.concat([box("ftyp", Buffer.from("heic\0\0\0\0mif1heic", "latin1")), box("mdat", Buffer.alloc(32, 5))]);
    const out = embedCaptureDate(heic, WHEN)!;
    expect(out.how).toBe("note");
    expect(out.bytes.subarray(0, heic.length)).toEqual(heic);
    expect(out.bytes.toString("latin1", heic.length + 4, heic.length + 8)).toBe("free");
  });

  it("adds a comment block to a GIF ahead of its trailer", () => {
    const gif = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(20, 1), Buffer.from([0x3b])]);
    const out = embedCaptureDate(gif, WHEN)!;
    expect(out.bytes[out.bytes.length - 1]).toBe(0x3b);
    expect(out.bytes.subarray(0, gif.length - 1)).toEqual(gif.subarray(0, gif.length - 1));
  });

  it("answers null for a format it does not know", () => {
    expect(embedCaptureDate(Buffer.from("RIFF\0\0\0\0WEBPVP8 whatever", "latin1"), WHEN)).toBeNull();
    expect(embedCaptureDate(Buffer.from("not a picture at all"), WHEN)).toBeNull();
  });
});
