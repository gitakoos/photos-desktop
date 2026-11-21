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
import sharp from "sharp";

import { embedGps } from "./embedGps.ts";

const SCAN = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6, 0x11, 0x22, 0x33, 0x44, 0xff, 0xd9]);

function segment(marker: number, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xff00 | marker, 0);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

const SOI = Buffer.from([0xff, 0xd8]);
const JFIF = segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"));

/** The bytes from the picture data on, which no edit may touch. */
const scanOf = (buf: Buffer) => buf.subarray(buf.indexOf(Buffer.from([0xff, 0xda])));

const BUDAPEST = { lat: 47.497913, lon: 19.040236 };
const SANTIAGO = { lat: -33.44889, lon: -70.669265 };

async function cameraJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 16, height: 12, channels: 3, background: { r: 200, g: 40, b: 90 } } })
    .jpeg()
    .withExif({ IFD0: { Make: "TestCam", Model: "One" }, IFD2: { DateTimeOriginal: "2024:11:17 04:17:56" } })
    .toBuffer();
}

describe("embedGps", () => {
  it("adds a place to a JPEG with no EXIF, keeping the picture", async () => {
    const input = Buffer.concat([SOI, JFIF, SCAN]);
    const out = embedGps(input, BUDAPEST)!;
    expect(out).not.toBeNull();
    const gps = await exifr.gps(out);
    expect(gps.latitude).toBeCloseTo(BUDAPEST.lat, 5);
    expect(gps.longitude).toBeCloseTo(BUDAPEST.lon, 5);
    expect(scanOf(out).equals(SCAN)).toBe(true);
    expect(out.subarray(2, 2 + JFIF.length).equals(JFIF)).toBe(true);
  });

  it("adds a place to a camera's EXIF and keeps its other fields", async () => {
    const input = await cameraJpeg();
    const out = embedGps(input, SANTIAGO)!;
    const tags = await exifr.parse(out, { gps: true, exif: true });
    expect(tags.Make).toBe("TestCam");
    expect(tags.Model).toBe("One");
    expect(tags.latitude).toBeCloseTo(SANTIAGO.lat, 5);
    expect(tags.longitude).toBeCloseTo(SANTIAGO.lon, 5);
    expect(tags.DateTimeOriginal).toBeInstanceOf(Date);
    expect(scanOf(out).equals(scanOf(input))).toBe(true);
    expect((await sharp(out).metadata()).width).toBe(16);
  });

  it("replaces a place already there, and takes it out", async () => {
    const placed = embedGps(await cameraJpeg(), BUDAPEST)!;
    const moved = embedGps(placed, SANTIAGO)!;
    const gps = await exifr.gps(moved);
    expect(gps.latitude).toBeCloseTo(SANTIAGO.lat, 5);
    expect(gps.longitude).toBeCloseTo(SANTIAGO.lon, 5);

    const removed = embedGps(moved, null)!;
    expect(await exifr.gps(removed)).toBeUndefined();
    expect((await exifr.parse(removed)).Make).toBe("TestCam");
    expect(scanOf(removed).equals(scanOf(placed))).toBe(true);
  });

  it("works on little-endian EXIF too", async () => {
    // A little-endian TIFF block with one ASCII Make entry, as many phones write.
    const tiff = Buffer.alloc(8 + 2 + 12 + 4 + 8);
    tiff.write("II", 0, "latin1");
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8);
    tiff.writeUInt16LE(0x010f, 10);
    tiff.writeUInt16LE(2, 12);
    tiff.writeUInt32LE(8, 14);
    tiff.writeUInt32LE(26, 18);
    tiff.writeUInt32LE(0, 22);
    tiff.write("Phone\0\0\0", 26, "latin1");
    const exif = segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]));
    const out = embedGps(Buffer.concat([SOI, exif, SCAN]), BUDAPEST)!;
    const tags = await exifr.parse(out, { gps: true });
    expect(tags.Make).toBe("Phone");
    expect(tags.latitude).toBeCloseTo(BUDAPEST.lat, 5);
    expect(tags.longitude).toBeCloseTo(BUDAPEST.lon, 5);
  });

  it("always changes the file, even when taking out a place that was not there", () => {
    const input = Buffer.concat([SOI, JFIF, SCAN]);
    const out = embedGps(input, null)!;
    expect(out.equals(input)).toBe(false);
  });

  it("answers null for anything but a JPEG, and for a point not on Earth", () => {
    expect(embedGps(Buffer.from("\x89PNG\r\n\x1a\n0000", "latin1"), BUDAPEST)).toBeNull();
    expect(embedGps(Buffer.concat([SOI, JFIF, SCAN]), { lat: 95, lon: 0 })).toBeNull();
  });
});
