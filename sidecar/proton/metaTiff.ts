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

// Edits the text fields of an EXIF block and takes private entries out of it, losslessly.
//
// Nothing already in the block moves, so offsets a maker note keeps inside itself stay right. A
// directory that loses entries is written again in its own place; only one that gains entries
// is written at the end of the block, with its parent pointing to the new copy. The data of
// every entry taken out (a place, a serial number, a thumbnail) is overwritten with zeros, and
// what was erased at the end of the block is cut off, so a strip never makes the block larger.
// A directory that has to go but cannot be read refuses the whole edit, so a pointer is never
// dropped while what it pointed to stays behind.

import { Buffer } from "node:buffer";

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

export const TAG = {
  imageDescription: 0x010e,
  artist: 0x013b,
  copyright: 0x8298,
  exifPointer: 0x8769,
  gpsPointer: 0x8825,
  thumbOffset: 0x0201,
  thumbLength: 0x0202,
} as const;

type Entry = { tag: number; type: number; count: number; field: Buffer };

export type TiffText = { description: string | null; author: string | null; copyright: string | null };

/** What to change in the main directory's text fields: a string sets, an empty one takes the field out, a missing key keeps it. */
export type TiffTextChange = { description?: string; author?: string; copyright?: string };

/** What to take out of an EXIF block. */
export type TiffDrop = {
  /** Tags of the main directory. */
  main?: readonly number[];
  /** Tags of the EXIF directory. */
  exif?: readonly number[];
  /** The GPS directory and the entry pointing to it. */
  gps?: boolean;
  /** The thumbnail directory and the picture in it. */
  thumbnail?: boolean;
};

class Tiff {
  buf: Buffer;
  /** The ranges this edit overwrote with zeros, which nothing points into any more. */
  private erased: [number, number][] = [];
  private constructor(
    block: Buffer,
    readonly le: boolean,
  ) {
    this.buf = Buffer.from(block);
  }

  static parse(block: Buffer): Tiff | null {
    if (block.length < 8) return null;
    const order = block.toString("latin1", 0, 2);
    if (order !== "II" && order !== "MM") return null;
    const t = new Tiff(block, order === "II");
    return t.r16(2) === 42 ? t : null;
  }

  r16(o: number): number {
    return this.le ? this.buf.readUInt16LE(o) : this.buf.readUInt16BE(o);
  }
  r32(o: number): number {
    return this.le ? this.buf.readUInt32LE(o) : this.buf.readUInt32BE(o);
  }
  private w16(b: Buffer, v: number, o: number) {
    if (this.le) b.writeUInt16LE(v, o);
    else b.writeUInt16BE(v, o);
  }
  private w32(b: Buffer, v: number, o: number) {
    if (this.le) b.writeUInt32LE(v, o);
    else b.writeUInt32BE(v, o);
  }
  private field32(e: Entry): number {
    return this.le ? e.field.readUInt32LE(0) : e.field.readUInt32BE(0);
  }

  /** The entries of the directory at `off` and the offset of the next one, or null when it cannot be read. */
  read(off: number): { entries: Entry[]; next: number } | null {
    if (off < 8 || off + 2 > this.buf.length) return null;
    const n = this.r16(off);
    if (off + 2 + n * 12 + 4 > this.buf.length) return null;
    const entries: Entry[] = [];
    for (let i = 0; i < n; i++) {
      const at = off + 2 + i * 12;
      entries.push({
        tag: this.r16(at),
        type: this.r16(at + 2),
        count: this.r32(at + 4),
        field: Buffer.from(this.buf.subarray(at + 8, at + 12)),
      });
    }
    return { entries, next: this.r32(off + 2 + n * 12) };
  }

  private size(e: Entry): number {
    return (TYPE_SIZE[e.type] ?? 0) * e.count;
  }

  /** The bytes of an entry's value, or null when they lie outside the block. */
  value(e: Entry): Buffer | null {
    const size = this.size(e);
    if (size <= 4) return e.field.subarray(0, size);
    const at = this.field32(e);
    return at + size <= this.buf.length ? this.buf.subarray(at, at + size) : null;
  }

  private zero(from: number, to: number): void {
    const end = Math.min(this.buf.length, to);
    if (from >= end) return;
    this.buf.fill(0, from, end);
    this.erased.push([from, end]);
  }

  private valueInside(e: Entry): boolean {
    const size = this.size(e);
    if (size <= 4) return true;
    const at = this.field32(e);
    return at >= 8 && at + size <= this.buf.length;
  }

  /** Overwrites the data an entry holds outside its own twelve bytes. False when it lies outside the block. */
  zeroData(e: Entry): boolean {
    if (!this.valueInside(e)) return false;
    const size = this.size(e);
    if (size > 4) this.zero(this.field32(e), this.field32(e) + size);
    return true;
  }

  zeroTable(off: number, count: number): void {
    this.zero(off, off + 2 + count * 12 + 4);
  }

  private append(data: Buffer): number {
    const at = this.buf.length + (this.buf.length % 2);
    this.buf = Buffer.concat([this.buf, Buffer.alloc(at - this.buf.length), data]);
    return at;
  }

  private entry(tag: number, type: number, count: number, data: Buffer): Entry {
    const field = Buffer.alloc(4);
    if (data.length <= 4) data.copy(field);
    else this.w32(field, this.append(data), 0);
    return { tag, type, count, field };
  }

  ascii(tag: number, text: string): Entry {
    const data = Buffer.concat([Buffer.from(text, "utf8"), Buffer.alloc(1)]);
    return this.entry(tag, 2, data.length, data);
  }

  long(tag: number, value: number): Entry {
    const data = Buffer.alloc(4);
    this.w32(data, value, 0);
    return this.entry(tag, 4, 1, data);
  }

  private table(entries: Entry[], next: number): Buffer {
    const sorted = [...entries].sort((a, b) => a.tag - b.tag);
    const table = Buffer.alloc(2 + sorted.length * 12 + 4);
    this.w16(table, sorted.length, 0);
    sorted.forEach((e, i) => {
      const at = 2 + i * 12;
      this.w16(table, e.tag, at);
      this.w16(table, e.type, at + 2);
      this.w32(table, e.count, at + 4);
      e.field.copy(table, at + 8);
    });
    this.w32(table, next, 2 + sorted.length * 12);
    return table;
  }

  /**
   * Writes the directory that held `count` entries at `off` again: in its own place when the
   * new one is no longer, the rest of the old table zeroed, else at the end of the block.
   * Answers where it now is.
   */
  rewrite(off: number, count: number, entries: Entry[], next: number): number {
    const table = this.table(entries, next);
    const old = 2 + count * 12 + 4;
    if (table.length <= old) {
      table.copy(this.buf, off);
      this.zero(off + table.length, off + old);
      return off;
    }
    this.zeroTable(off, count);
    return this.append(table);
  }

  /**
   * The block with the main directory at `off`, and what was erased at its end cut off: only
   * bytes this edit zeroed go, with the few padding zeros between them.
   */
  finish(off: number): Buffer {
    this.w32(this.buf, off, 4);
    const erasedUpTo = (at: number) => this.erased.find(([from, to]) => from < at && to >= at);
    let end = this.buf.length;
    for (;;) {
      let pad = end;
      while (pad > end - 3 && pad > 8 && this.buf[pad - 1] === 0 && !erasedUpTo(pad)) pad--;
      const range = erasedUpTo(pad);
      if (!range) break;
      end = Math.max(8, range[0]);
    }
    return end < this.buf.length ? Buffer.from(this.buf.subarray(0, end)) : this.buf;
  }

  /** The place a pointer entry names. */
  target(e: Entry): number {
    return this.field32(e);
  }

  /** A directory and all it holds, zeroed. False when it cannot be read whole, and then nothing is changed. */
  erase(off: number): boolean {
    const dir = this.read(off);
    if (!dir || !dir.entries.every((e) => this.valueInside(e))) return false;
    for (const e of dir.entries) this.zeroData(e);
    this.zeroTable(off, dir.entries.length);
    return true;
  }

  /** The thumbnail directory: its picture, its values and its table, zeroed. False when it cannot be read whole. */
  eraseThumbnail(off: number): boolean {
    const dir = this.read(off);
    if (!dir) return false;
    const at = dir.entries.find((e) => e.tag === TAG.thumbOffset);
    const len = dir.entries.find((e) => e.tag === TAG.thumbLength);
    let picture: [number, number] | null = null;
    if (at && len) {
      const num = (e: Entry) => (e.type === 3 ? (this.le ? e.field.readUInt16LE(0) : e.field.readUInt16BE(0)) : this.field32(e));
      const from = num(at);
      const size = num(len);
      if (from < 8 || from + size > this.buf.length) return false;
      picture = [from, from + size];
    }
    if (!this.erase(off)) return false;
    if (picture) this.zero(picture[0], picture[1]);
    return true;
  }
}

const asciiText = (b: Buffer | null): string | null => {
  if (!b) return null;
  const end = b.indexOf(0);
  const text = b.toString("utf8", 0, end < 0 ? b.length : end).trim();
  return text || null;
};

/** The description, author and copyright line the main directory holds, or null for each it lacks. Null when unreadable. */
export function readTiffText(block: Buffer): TiffText | null {
  const t = Tiff.parse(block);
  const main = t?.read(t.r32(4));
  if (!t || !main) return null;
  const text = (tag: number) => {
    const e = main.entries.find((x) => x.tag === tag && x.type === 2);
    return e ? asciiText(t.value(e)) : null;
  };
  return { description: text(TAG.imageDescription), author: text(TAG.artist), copyright: text(TAG.copyright) };
}

/**
 * The block with `change` applied to the text fields of its main directory and `drop` taken out.
 * Answers the input itself when there is nothing to do, and null when the block cannot be read.
 */
export function editTiff(block: Buffer, change: TiffTextChange, drop: TiffDrop = {}): Buffer | null {
  const t = Tiff.parse(block);
  if (!t) return null;
  const ifd0 = t.r32(4);
  const main = t.read(ifd0);
  if (!main) return null;

  let entries = [...main.entries];
  let next = main.next;
  let changed = false;
  let outside = false;
  const take = (tag: number) => {
    const found = entries.find((e) => e.tag === tag);
    if (!found) return;
    if (!t.zeroData(found)) outside = true;
    entries = entries.filter((e) => e.tag !== tag);
    changed = true;
  };

  // The EXIF directory stays where it is, so the main directory's pointer to it holds.
  const exifEntry = entries.find((e) => e.tag === TAG.exifPointer);
  const wanted = drop.exif ?? [];
  if (exifEntry && wanted.length > 0) {
    const off = t.target(exifEntry);
    const exif = t.read(off);
    if (!exif) return null;
    if (exif.entries.some((e) => wanted.includes(e.tag))) {
      const keep = exif.entries.filter((e) => !wanted.includes(e.tag));
      for (const e of exif.entries) if (!keep.includes(e) && !t.zeroData(e)) return null;
      t.rewrite(off, exif.entries.length, keep, exif.next);
      changed = true;
    }
  }

  for (const tag of drop.main ?? []) take(tag);
  if (drop.gps) {
    const gps = entries.find((e) => e.tag === TAG.gpsPointer);
    if (gps) {
      if (!t.erase(t.target(gps))) return null;
      take(TAG.gpsPointer);
    }
  }
  if (drop.thumbnail && next) {
    if (!t.eraseThumbnail(next)) return null;
    next = 0;
    changed = true;
  }
  // An entry to be taken out whose data lies outside the block cannot be erased.
  if (outside) return null;

  for (const [tag, key] of [
    [TAG.imageDescription, "description"],
    [TAG.artist, "author"],
    [TAG.copyright, "copyright"],
  ] as const) {
    const value = change[key];
    if (value === undefined) continue;
    take(tag);
    if (value !== "") entries.push(t.ascii(tag, value));
    changed = true;
  }

  if (!changed) return block;
  return t.finish(t.rewrite(ifd0, main.entries.length, entries, next));
}

/** A minimal big-endian block holding only the text fields in `text`, or null when none has a value. */
export function newTiffWithText(text: TiffTextChange): Buffer | null {
  const fields: [number, string][] = [];
  if (text.description) fields.push([TAG.imageDescription, text.description]);
  if (text.author) fields.push([TAG.artist, text.author]);
  if (text.copyright) fields.push([TAG.copyright, text.copyright]);
  if (fields.length === 0) return null;
  const head = Buffer.alloc(8);
  head.write("MM", 0, "latin1");
  head.writeUInt16BE(42, 2);
  head.writeUInt32BE(8, 4);
  const empty = Buffer.concat([head, Buffer.alloc(6)]);
  // An empty main directory, then the same edit as for any block: the fields are added to it.
  return editTiff(empty, text);
}
