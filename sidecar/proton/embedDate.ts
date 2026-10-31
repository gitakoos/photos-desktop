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

// Writes a capture date into a photo or video file's own metadata, losslessly.
//
// Proton Drive cannot change the date of a photo already on it: the SDK has no call for
// it, and re-uploading the same bytes with a new capture time is folded into the photo
// already there, old date and all. So the date fix re-uploads a file whose bytes say the
// new date themselves. Only metadata is touched — the compressed picture or video
// stream is copied through byte for byte, never decoded or re-encoded:
//
//   - JPEG: the EXIF dates (DateTimeOriginal, CreateDate, DateTime and their offsets)
//     are rewritten in place where the file has them, or a small EXIF block carrying
//     them is added where it has none (messaging apps strip EXIF entirely). A comment
//     segment saying where the date came from goes in as well.
//   - PNG: a standard `Creation Time` text chunk.
//   - MP4 / MOV: the movie, track and media header times.
//   - HEIC and other ISO media files with no header times of their own, and GIF: a note
//     of the date in a free box or a comment block. The date then travels with the
//     upload's capture time and the signed claim beside it, as for every photo.
//
// Every result differs from what it was given, which is what keeps the upload from
// being taken for a duplicate of the original. A format not listed answers null.

import { Buffer } from "node:buffer";

/** How a date went into the file, for the log. */
export type EmbedHow = "exif-patched" | "exif-added" | "png-text" | "media-times" | "note";

export type Embedded = { bytes: Buffer; how: EmbedHow };

/** Seconds between the ISO media epoch (1904-01-01) and the Unix one. */
const MEDIA_EPOCH_OFFSET = 2_082_844_800;

const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, "0");

/** `ms` in this machine's zone: the wall clock the filename recorded. */
function wallClock(ms: number) {
  const at = new Date(ms);
  const offset = -at.getTimezoneOffset();
  return {
    date: `${at.getFullYear()}:${pad(at.getMonth() + 1)}:${pad(at.getDate())}`,
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`,
    iso:
      `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
      `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`,
    offset: `${offset >= 0 ? "+" : "-"}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`,
  };
}

/** The note every edited file carries, saying what was changed and why. */
function note(ms: number): string {
  const w = wallClock(ms);
  return `Capture date set from the filename by Photos for Proton: ${w.iso}${w.offset}`;
}

/**
 * Writes `captureMs` into `input`'s own metadata. Null when the format is not one this
 * knows how to edit without touching the picture; the input is never modified.
 */
export function embedCaptureDate(input: Buffer, captureMs: number): Embedded | null {
  if (!(captureMs > 0) || input.length < 12) return null;
  if (input[0] === 0xff && input[1] === 0xd8) return embedJpeg(input, captureMs);
  if (input.subarray(0, 8).equals(PNG_SIGNATURE)) return embedPng(input, captureMs);
  if (isGif(input)) return embedGif(input, captureMs);
  if (ISO_FIRST_BOXES.has(input.toString("latin1", 4, 8))) return embedIsoMedia(input, captureMs);
  return null;
}

// ---- JPEG ----

type Segment = { marker: number; start: number; end: number };

/** The segments ahead of the picture data, or null when the file is not a JPEG we can walk. */
function jpegHeaderSegments(buf: Buffer): Segment[] | null {
  const out: Segment[] = [];
  let at = 2;
  while (at + 4 <= buf.length) {
    if (buf[at] !== 0xff) return null;
    const marker = buf[at + 1]!;
    if (marker === 0xff) {
      at++; // a fill byte
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return out; // the picture data, or the end
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2; // a marker with no length
      continue;
    }
    const length = buf.readUInt16BE(at + 2);
    if (length < 2 || at + 2 + length > buf.length) return null;
    out.push({ marker, start: at, end: at + 2 + length });
    at += 2 + length;
  }
  return null;
}

const isExifSegment = (buf: Buffer, s: Segment) =>
  s.marker === 0xe1 && s.end - s.start >= 10 && buf.toString("latin1", s.start + 4, s.start + 10) === "Exif\0\0";

function embedJpeg(input: Buffer, ms: number): Embedded | null {
  const segments = jpegHeaderSegments(input);
  if (!segments) return null;
  const w = wallClock(ms);
  const stamp = `${w.date} ${w.time}`;

  const buf = Buffer.from(input); // a copy: the input is never written to
  const exif = segments.find((s) => isExifSegment(buf, s));
  const patched = exif ? patchExifDates(buf, exif.start + 10, exif.end, stamp, w.offset) : 0;

  // A new EXIF block goes right after a leading JFIF header, which has to stay first,
  // or right after the start-of-image marker. The note goes after the leading run of
  // application segments, ahead of the tables and the picture.
  const exifAt = segments[0]?.marker === 0xe0 ? segments[0].end : 2;
  let commentAt = 2;
  for (const s of segments) {
    if (s.marker < 0xe0 || s.marker > 0xef) break;
    commentAt = s.end;
  }
  // A file with EXIF but no date field in it keeps its block as it is: a second block
  // ahead of it would hide its place and camera from readers that read only the first.
  const added = exif ? Buffer.alloc(0) : exifSegment(stamp, w.offset);
  const comment = jpegComment(note(ms));
  const bytes = Buffer.concat([
    buf.subarray(0, exifAt),
    added,
    buf.subarray(exifAt, Math.max(exifAt, commentAt)),
    comment,
    buf.subarray(Math.max(exifAt, commentAt)),
  ]);
  return { bytes, how: !exif ? "exif-added" : patched > 0 ? "exif-patched" : "note" };
}

/** Rewrites the EXIF date fields that are there, in place. Returns how many were. */
function patchExifDates(buf: Buffer, tiff: number, end: number, stamp: string, offset: string): number {
  if (tiff + 8 > end) return 0;
  const order = buf.toString("latin1", tiff, tiff + 2);
  if (order !== "II" && order !== "MM") return 0;
  const le = order === "II";
  const u16 = (at: number) => (le ? buf.readUInt16LE(at) : buf.readUInt16BE(at));
  const u32 = (at: number) => (le ? buf.readUInt32LE(at) : buf.readUInt32BE(at));
  let patched = 0;

  const visit = (ifd: number, wanted: Map<number, string>): number | null => {
    const at = tiff + ifd;
    if (ifd < 8 || at + 2 > end) return null;
    const count = u16(at);
    let exifIfd: number | null = null;
    for (let i = 0; i < count; i++) {
      const entry = at + 2 + i * 12;
      if (entry + 12 > end) break;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const n = u32(entry + 4);
      if (tag === 0x8769) exifIfd = u32(entry + 8);
      const value = wanted.get(tag);
      // Only an ASCII field exactly the size of the new value is rewritten, so nothing
      // in the block moves.
      if (value === undefined || type !== 2 || n !== value.length + 1) continue;
      const where = n <= 4 ? entry + 8 : tiff + u32(entry + 8);
      if (where + n > end) continue;
      buf.write(value + "\0", where, "latin1");
      patched++;
    }
    return exifIfd;
  };

  const exifIfd = visit(u32(tiff + 4), new Map([[0x0132, stamp]]));
  if (exifIfd !== null) {
    visit(
      exifIfd,
      new Map([
        [0x9003, stamp],
        [0x9004, stamp],
        [0x9010, offset],
        [0x9011, offset],
        [0x9012, offset],
      ]),
    );
  }
  return patched;
}

/**
 * A minimal EXIF block (big-endian TIFF): DateTime in the main directory, and
 * DateTimeOriginal, CreateDate and their offsets in the EXIF directory.
 */
function exifSegment(stamp: string, offset: string): Buffer {
  const ascii = (s: string) => Buffer.from(s + "\0", "latin1");
  const dateValue = ascii(stamp); // 20 bytes
  const offsetValue = ascii(offset); // 7 bytes

  // Layout, as offsets from the TIFF header.
  const ifd0 = 8;
  const ifd0Entries = 2;
  const ifd0End = ifd0 + 2 + ifd0Entries * 12 + 4;
  const dateTimeAt = ifd0End;
  const exifIfd = dateTimeAt + dateValue.length;
  const exifEntries = 5;
  const exifEnd = exifIfd + 2 + exifEntries * 12 + 4;
  const originalAt = exifEnd;
  const digitizedAt = originalAt + dateValue.length;
  const offsetAt = digitizedAt + dateValue.length;
  const offsetOriginalAt = offsetAt + offsetValue.length;
  const offsetDigitizedAt = offsetOriginalAt + offsetValue.length;
  const size = offsetDigitizedAt + offsetValue.length;

  const tiff = Buffer.alloc(size);
  tiff.write("MM", 0, "latin1");
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(ifd0, 4);
  const entry = (at: number, tag: number, type: number, count: number, value: number) => {
    tiff.writeUInt16BE(tag, at);
    tiff.writeUInt16BE(type, at + 2);
    tiff.writeUInt32BE(count, at + 4);
    tiff.writeUInt32BE(value, at + 8);
  };
  tiff.writeUInt16BE(ifd0Entries, ifd0);
  entry(ifd0 + 2, 0x0132, 2, dateValue.length, dateTimeAt); // DateTime
  entry(ifd0 + 14, 0x8769, 4, 1, exifIfd); // the EXIF directory
  tiff.writeUInt32BE(0, ifd0 + 2 + ifd0Entries * 12); // no next directory
  dateValue.copy(tiff, dateTimeAt);

  tiff.writeUInt16BE(exifEntries, exifIfd);
  entry(exifIfd + 2, 0x9003, 2, dateValue.length, originalAt); // DateTimeOriginal
  entry(exifIfd + 14, 0x9004, 2, dateValue.length, digitizedAt); // CreateDate
  entry(exifIfd + 26, 0x9010, 2, offsetValue.length, offsetAt); // OffsetTime
  entry(exifIfd + 38, 0x9011, 2, offsetValue.length, offsetOriginalAt); // OffsetTimeOriginal
  entry(exifIfd + 50, 0x9012, 2, offsetValue.length, offsetDigitizedAt); // OffsetTimeDigitized
  tiff.writeUInt32BE(0, exifIfd + 2 + exifEntries * 12);
  dateValue.copy(tiff, originalAt);
  dateValue.copy(tiff, digitizedAt);
  offsetValue.copy(tiff, offsetAt);
  offsetValue.copy(tiff, offsetOriginalAt);
  offsetValue.copy(tiff, offsetDigitizedAt);

  const header = Buffer.alloc(10);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(2 + 6 + tiff.length, 2);
  header.write("Exif\0\0", 4, "latin1");
  return Buffer.concat([header, tiff]);
}

function jpegComment(text: string): Buffer {
  const body = Buffer.from(text, "latin1");
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xfffe, 0);
  head.writeUInt16BE(2 + body.length, 2);
  return Buffer.concat([head, body]);
}

// ---- PNG ----

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function embedPng(input: Buffer, ms: number): Embedded | null {
  // The text goes in before the first image data chunk, after the header chunks.
  let at = 8;
  while (at + 12 <= input.length) {
    const length = input.readUInt32BE(at);
    const type = input.toString("latin1", at + 4, at + 8);
    if (type === "IDAT" || type === "IEND") break;
    at += 12 + length;
  }
  if (at + 12 > input.length) return null;
  const w = wallClock(ms);
  const text = pngChunk("tEXt", Buffer.from(`Creation Time\0${w.iso}${w.offset}`, "latin1"));
  const comment = pngChunk("tEXt", Buffer.from(`Comment\0${note(ms)}`, "latin1"));
  return { bytes: Buffer.concat([input.subarray(0, at), text, comment, input.subarray(at)]), how: "png-text" };
}

// ---- GIF ----

const isGif = (buf: Buffer) => {
  const head = buf.toString("latin1", 0, 6);
  return head === "GIF87a" || head === "GIF89a";
};

function embedGif(input: Buffer, ms: number): Embedded | null {
  if (input[input.length - 1] !== 0x3b) return null; // no trailer to insert ahead of
  const text = Buffer.from(note(ms), "latin1");
  const blocks: Buffer[] = [Buffer.from([0x21, 0xfe])];
  for (let at = 0; at < text.length; at += 255) {
    const part = text.subarray(at, at + 255);
    blocks.push(Buffer.from([part.length]), part);
  }
  blocks.push(Buffer.from([0x00]));
  const bytes = Buffer.concat([input.subarray(0, input.length - 1), ...blocks, Buffer.from([0x3b])]);
  // A comment extension is GIF89a; an 87a file that gains one is declared 89a.
  bytes.write("GIF89a", 0, "latin1");
  return { bytes, how: "note" };
}

// ---- MP4 / MOV / HEIC (ISO base media) ----

/** Box types a file of this family may open with. */
const ISO_FIRST_BOXES = new Set(["ftyp", "moov", "wide", "free", "mdat", "skip"]);
/** Boxes whose contents are boxes, on the way to the header times. */
const ISO_CONTAINERS = new Set(["moov", "trak", "mdia"]);
/** Boxes holding a creation and a modification time. */
const ISO_TIMED = new Set(["mvhd", "tkhd", "mdhd"]);

type IsoWalk = { patched: number; openEnded: boolean; broken: boolean };

function walkIso(buf: Buffer, from: number, to: number, seconds: number, walk: IsoWalk, top: boolean): void {
  let at = from;
  while (at + 8 <= to) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) {
        walk.broken = true;
        return;
      }
      size = Number(buf.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) {
      if (top) walk.openEnded = true;
      size = to - at;
    }
    if (size < header || at + size > to) {
      walk.broken = true;
      return;
    }
    if (ISO_CONTAINERS.has(type)) {
      walkIso(buf, at + header, at + size, seconds, walk, false);
    } else if (ISO_TIMED.has(type) && size >= header + 4 + 16) {
      const body = at + header;
      const version = buf[body];
      if (version === 1 && size >= header + 4 + 16) {
        buf.writeBigUInt64BE(BigInt(seconds), body + 4);
        buf.writeBigUInt64BE(BigInt(seconds), body + 12);
        walk.patched++;
      } else if (version === 0) {
        buf.writeUInt32BE(seconds >>> 0, body + 4);
        buf.writeUInt32BE(seconds >>> 0, body + 8);
        walk.patched++;
      }
    }
    at += size;
  }
}

function embedIsoMedia(input: Buffer, ms: number): Embedded | null {
  const buf = Buffer.from(input);
  const seconds = Math.floor(ms / 1000) + MEDIA_EPOCH_OFFSET;
  const walk: IsoWalk = { patched: 0, openEnded: false, broken: false };
  walkIso(buf, 0, buf.length, seconds, walk, true);
  if (walk.broken) return null;
  // A free box at the end is ignored by every reader, and says where the date came from.
  // It cannot follow a last box that runs to the end of the file, which would swallow it.
  if (walk.openEnded) {
    return walk.patched > 0 && !buf.equals(input) ? { bytes: buf, how: "media-times" } : null;
  }
  const text = Buffer.from(note(ms), "latin1");
  const free = Buffer.alloc(8);
  free.writeUInt32BE(8 + text.length, 0);
  free.write("free", 4, "latin1");
  return { bytes: Buffer.concat([buf, free, text]), how: walk.patched > 0 ? "media-times" : "note" };
}
