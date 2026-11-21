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

// Writes a place into a JPEG's own EXIF, or takes it out, losslessly.
//
// The picture data and every existing EXIF value stay where they are. A new GPS directory
// is added at the end of the EXIF block; the main directory points to it, either by its
// existing GPS entry or, when it has none, by a copy of the main directory moved to the end
// with that entry added (the old one is left unused, so no offset in the block changes).
// Taking a place out leaves a GPS directory with no entries. A comment segment saying what
// was done goes in as well, so the result always differs from the input.

import { Buffer } from "node:buffer";

export type GpsPlace = { lat: number; lon: number };

export type Segment = { marker: number; start: number; end: number };

const GPS_POINTER = 0x8825;
const MAX_SEGMENT = 0xffff;

export function headerSegments(buf: Buffer): Segment[] | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const out: Segment[] = [];
  let at = 2;
  while (at + 4 <= buf.length) {
    if (buf[at] !== 0xff) return null;
    const marker = buf[at + 1]!;
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return out;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = buf.readUInt16BE(at + 2);
    if (length < 2 || at + 2 + length > buf.length) return null;
    out.push({ marker, start: at, end: at + 2 + length });
    at += 2 + length;
  }
  return null;
}

const isExif = (buf: Buffer, s: Segment) =>
  s.marker === 0xe1 && s.end - s.start >= 18 && buf.toString("latin1", s.start + 4, s.start + 10) === "Exif\0\0";

/** Whether `place` is a point on Earth. */
export function validPlace(place: GpsPlace | null | undefined): place is GpsPlace {
  return (
    !!place &&
    Number.isFinite(place.lat) &&
    Number.isFinite(place.lon) &&
    Math.abs(place.lat) <= 90 &&
    Math.abs(place.lon) <= 180
  );
}

/** Degrees, minutes and seconds as three EXIF rationals (seconds to a ten-thousandth). */
function dms(value: number): [number, number][] {
  const abs = Math.abs(value);
  let deg = Math.floor(abs);
  let min = Math.floor((abs - deg) * 60);
  let sec = Math.round(((abs - deg) * 60 - min) * 60 * 10000);
  if (sec >= 600000) {
    sec -= 600000;
    min++;
  }
  if (min >= 60) {
    min -= 60;
    deg++;
  }
  return [
    [deg, 1],
    [min, 1],
    [sec, 10000],
  ];
}

/**
 * A GPS directory for `place` (or an empty one for null), laid out to sit at `at` in a TIFF
 * block of byte order `le`: its entries, then the latitude and longitude rationals.
 */
function gpsDirectory(place: GpsPlace | null, at: number, le: boolean): Buffer {
  if (!place) {
    const empty = Buffer.alloc(6);
    return empty; // no entries, no next directory
  }
  const entries = 5;
  const head = 2 + entries * 12 + 4;
  const out = Buffer.alloc(head + 48);
  const u16 = (v: number, o: number) => (le ? out.writeUInt16LE(v, o) : out.writeUInt16BE(v, o));
  const u32 = (v: number, o: number) => (le ? out.writeUInt32LE(v, o) : out.writeUInt32BE(v, o));
  u16(entries, 0);
  const latAt = at + head;
  const lonAt = latAt + 24;
  const entry = (i: number, tag: number, type: number, count: number, fill: (o: number) => void) => {
    const o = 2 + i * 12;
    u16(tag, o);
    u16(type, o + 2);
    u32(count, o + 4);
    fill(o + 8);
  };
  entry(0, 0x0000, 1, 4, (o) => out.set([2, 3, 0, 0], o)); // GPSVersionID
  entry(1, 0x0001, 2, 2, (o) => out.write(place.lat >= 0 ? "N\0" : "S\0", o, "latin1"));
  entry(2, 0x0002, 5, 3, (o) => u32(latAt, o));
  entry(3, 0x0003, 2, 2, (o) => out.write(place.lon >= 0 ? "E\0" : "W\0", o, "latin1"));
  entry(4, 0x0004, 5, 3, (o) => u32(lonAt, o));
  u32(0, 2 + entries * 12);
  let o = head;
  for (const [num, den] of [...dms(place.lat), ...dms(place.lon)]) {
    u32(num, o);
    u32(den, o + 4);
    o += 8;
  }
  return out;
}

/** The new TIFF block for an existing EXIF one, or null when its structure cannot be read. */
function withGps(tiff: Buffer, place: GpsPlace | null): Buffer | null {
  if (tiff.length < 8) return null;
  const order = tiff.toString("latin1", 0, 2);
  if (order !== "II" && order !== "MM") return null;
  const le = order === "II";
  const r16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const r32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const ifd0 = r32(4);
  if (ifd0 < 8 || ifd0 + 2 > tiff.length) return null;
  const count = r16(ifd0);
  const entriesEnd = ifd0 + 2 + count * 12;
  if (entriesEnd + 4 > tiff.length) return null;

  const base = Buffer.from(tiff);
  const pad = base.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  const gpsAt = base.length + pad.length;
  const gps = gpsDirectory(place, gpsAt, le);

  let pointer = -1;
  for (let i = 0; i < count; i++) {
    if (r16(ifd0 + 2 + i * 12) === GPS_POINTER) pointer = ifd0 + 2 + i * 12;
  }
  if (pointer >= 0) {
    if (le) {
      base.writeUInt16LE(4, pointer + 2);
      base.writeUInt32LE(1, pointer + 4);
      base.writeUInt32LE(gpsAt, pointer + 8);
    } else {
      base.writeUInt16BE(4, pointer + 2);
      base.writeUInt32BE(1, pointer + 4);
      base.writeUInt32BE(gpsAt, pointer + 8);
    }
    return Buffer.concat([base, pad, gps]);
  }

  // The main directory, copied to the end with the GPS entry in tag order.
  const entries: Buffer[] = [];
  for (let i = 0; i < count; i++) entries.push(base.subarray(ifd0 + 2 + i * 12, ifd0 + 14 + i * 12));
  const gpsEntry = Buffer.alloc(12);
  if (le) {
    gpsEntry.writeUInt16LE(GPS_POINTER, 0);
    gpsEntry.writeUInt16LE(4, 2);
    gpsEntry.writeUInt32LE(1, 4);
    gpsEntry.writeUInt32LE(gpsAt, 8);
  } else {
    gpsEntry.writeUInt16BE(GPS_POINTER, 0);
    gpsEntry.writeUInt16BE(4, 2);
    gpsEntry.writeUInt32BE(1, 4);
    gpsEntry.writeUInt32BE(gpsAt, 8);
  }
  const tagOf = (e: Buffer) => (le ? e.readUInt16LE(0) : e.readUInt16BE(0));
  const at = entries.findIndex((e) => tagOf(e) > GPS_POINTER);
  entries.splice(at < 0 ? entries.length : at, 0, gpsEntry);
  const moved = Buffer.alloc(2 + entries.length * 12 + 4);
  if (le) moved.writeUInt16LE(entries.length, 0);
  else moved.writeUInt16BE(entries.length, 0);
  entries.forEach((e, i) => e.copy(moved, 2 + i * 12));
  base.copy(moved, 2 + entries.length * 12, entriesEnd, entriesEnd + 4); // the next directory
  const movedAt = gpsAt + gps.length + (gps.length % 2);
  if (le) base.writeUInt32LE(movedAt, 4);
  else base.writeUInt32BE(movedAt, 4);
  return Buffer.concat([base, pad, gps, Buffer.alloc(gps.length % 2), moved]);
}

/** A minimal big-endian TIFF block holding only the main directory and its GPS directory. */
function newTiff(place: GpsPlace | null): Buffer {
  const head = Buffer.alloc(8 + 2 + 12 + 4);
  head.write("MM", 0, "latin1");
  head.writeUInt16BE(42, 2);
  head.writeUInt32BE(8, 4);
  head.writeUInt16BE(1, 8);
  head.writeUInt16BE(GPS_POINTER, 10);
  head.writeUInt16BE(4, 12);
  head.writeUInt32BE(1, 14);
  head.writeUInt32BE(head.length, 18);
  head.writeUInt32BE(0, 22);
  return Buffer.concat([head, gpsDirectory(place, head.length, false)]);
}

function app1(tiff: Buffer): Buffer | null {
  const length = 2 + 6 + tiff.length;
  if (length > MAX_SEGMENT) return null;
  const header = Buffer.alloc(10);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(length, 2);
  header.write("Exif\0\0", 4, "latin1");
  return Buffer.concat([header, tiff]);
}

function comment(text: string): Buffer {
  const body = Buffer.from(text, "latin1");
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xfffe, 0);
  head.writeUInt16BE(2 + body.length, 2);
  return Buffer.concat([head, body]);
}

/**
 * `input` with `place` written into its EXIF, or its place taken out for null. Null when the
 * file is not a JPEG whose EXIF can be edited this way; the input is never modified.
 */
export function embedGps(input: Buffer, place: GpsPlace | null): Buffer | null {
  if (place && !validPlace(place)) return null;
  const segments = headerSegments(input);
  if (!segments) return null;
  const exif = segments.find((s) => isExif(input, s));
  let segment: Buffer | null;
  let from: number;
  let to: number;
  if (exif) {
    const tiff = withGps(input.subarray(exif.start + 10, exif.end), place);
    if (!tiff) return null;
    segment = app1(tiff);
    from = exif.start;
    to = exif.end;
  } else {
    segment = app1(newTiff(place));
    from = to = segments[0]?.marker === 0xe0 ? segments[0].end : 2;
  }
  if (!segment) return null;
  let commentAt = 2;
  for (const s of segments) {
    if (s.marker < 0xe0 || s.marker > 0xef) break;
    commentAt = s.end;
  }
  const shift = segment.length - (to - from);
  const at = Math.max(commentAt, to) + shift;
  const out = Buffer.concat([input.subarray(0, from), segment, input.subarray(to)]);
  const text = place
    ? `Place set by Photos for Proton: ${place.lat.toFixed(6)},${place.lon.toFixed(6)}`
    : "Place removed by Photos for Proton";
  return Buffer.concat([out.subarray(0, at), comment(text), out.subarray(at)]);
}
