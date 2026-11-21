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

// Reads and writes a photo's description, copyright and author, and strips private metadata,
// in a JPEG or PNG file, touching only metadata: the picture data is copied through byte for
// byte.
//
//   - JPEG: the text goes into the EXIF fields (ImageDescription, Artist, Copyright), the XMP
//     packet (dc:description, dc:creator, dc:rights) and the IPTC record when the file has one,
//     in every such segment it has. Stripping works in all three, drops the EXIF thumbnail, the
//     XMP history, the comment segments and the Photoshop resources other than IPTC, and takes
//     the maker note out with the location, as makers keep a position in it too.
//   - PNG: the same fields as text chunks (Description, Author, Copyright), the XMP chunk and
//     the EXIF chunk when the file has one.
//
// Every other format answers null: the caller refuses it with a message rather than writing a
// file that only looks edited.

import { Buffer } from "node:buffer";
import { inflateSync } from "node:zlib";

import { crc32 } from "./embedDate.ts";
import { headerSegments, type Segment } from "./embedGps.ts";
import { editTiff, newTiffWithText, readTiffText, TAG, type TiffDrop, type TiffText, type TiffTextChange } from "./metaTiff.ts";
import { newXmpPacket, readXmpText, setXmpText, stripXmp, XMP_MAX_CHARS, type XmpStrip } from "./metaXmp.ts";

export type TextMeta = { description: string | null; copyright: string | null; author: string | null };

/** Text to write: a string sets, an empty one takes the field out, a missing key keeps it. */
export type TextChange = { description?: string; copyright?: string; author?: string };

export type StripOptions = XmpStrip;

/** A change a photo can be replaced by a copy for. */
export type MetaChange = ({ kind: "text" } & TextChange) | ({ kind: "strip" } & StripOptions);

const MAX_DESCRIPTION = 8000;
const MAX_LINE = 500;

/** The most a PNG text chunk is read to: a larger one, inflated or not, is passed over. */
export const PNG_TEXT_MAX_BYTES = 1024 * 1024;

/** The media types whose files this can edit. */
const SUPPORTED = new Set(["image/jpeg", "image/jpg", "image/png"]);

export function canEditMeta(mediaType: string | null | undefined): boolean {
  return SUPPORTED.has(String(mediaType ?? "").toLowerCase().split(";")[0]!.trim());
}

/** A change as the window sent it, cleaned, or null when it asks for nothing valid. */
export function parseMetaChange(raw: unknown): MetaChange | null {
  const r = raw as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== "object") return null;
  if (r.kind === "strip") {
    const out = { kind: "strip" as const, location: r.location === true, camera: r.camera === true, text: r.text === true };
    return out.location || out.camera || out.text ? out : null;
  }
  if (r.kind === "text") {
    const out: { kind: "text" } & TextChange = { kind: "text" };
    for (const [key, max] of [
      ["description", MAX_DESCRIPTION],
      ["copyright", MAX_LINE],
      ["author", MAX_LINE],
    ] as const) {
      const v = r[key];
      if (typeof v === "string") out[key] = v.replace(/\r\n?/g, "\n").trim().slice(0, max);
    }
    return out.description !== undefined || out.copyright !== undefined || out.author !== undefined ? out : null;
  }
  return null;
}

const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (b: Buffer) => b.length > 8 && b.subarray(0, 8).equals(PNG_SIGNATURE);

// ---- Text read and write ----

/** The fields of `change` that differ from what `held` shows, or null when none does. */
export function neededTextChange(held: TextMeta, change: TextChange): TextChange | null {
  const out: TextChange = {};
  for (const key of ["description", "copyright", "author"] as const) {
    const wanted = change[key];
    if (wanted !== undefined && wanted !== (held[key] ?? "")) out[key] = wanted;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The description, copyright and author a file holds, or null for a format this does not read. */
export function readTextMeta(buf: Buffer): TextMeta | null {
  if (isJpeg(buf)) return readJpegText(buf);
  if (isPng(buf)) return readPngText(buf);
  return null;
}

/** The file with `change` written into it; the input itself when nothing differs, null when the file cannot take it. */
export function applyTextMeta(buf: Buffer, change: TextChange): Buffer | null {
  const held = readTextMeta(buf);
  if (!held) return null;
  const need = neededTextChange(held, change);
  if (!need) return buf;
  return isJpeg(buf) ? writeJpegText(buf, need) : writePngText(buf, need);
}

/** The file with the private metadata `options` names taken out; the input itself when it held none. */
export function applyStrip(buf: Buffer, options: StripOptions): Buffer | null {
  if (!isJpeg(buf) && !isPng(buf)) return null;
  if (!options.location && !options.camera && !options.text) return buf;
  return isJpeg(buf) ? stripJpeg(buf, options) : stripPng(buf, options);
}

export function applyMeta(buf: Buffer, change: MetaChange): Buffer | null {
  return change.kind === "strip" ? applyStrip(buf, change) : applyTextMeta(buf, change);
}

const firstOf = (values: (string | null | undefined)[]): string | null => values.find((v) => !!v) ?? null;

function merge(sources: (TiffText | TextMeta | null)[]): TextMeta {
  return {
    description: firstOf(sources.map((s) => s?.description)),
    copyright: firstOf(sources.map((s) => s?.copyright)),
    author: firstOf(sources.map((s) => s?.author)),
  };
}

// ---- Tags to take out ----

const MAIN_CAMERA = [0x010f, 0x0110, 0x0131, 0x013c, 0xc614, 0xc62f, 0x02bc, 0x83bb, 0x8649];
const MAIN_TEXT = [TAG.imageDescription, TAG.copyright, 0x9c9b, 0x9c9c, 0x9c9d, 0x9c9e, 0x9c9f];
const MAKER_NOTE = 0x927c;
const EXIF_CAMERA = [MAKER_NOTE, 0xa420, 0xa430, 0xa431, 0xa432, 0xa433, 0xa434, 0xa435];
const EXIF_TEXT = [0x9286];

function tiffDrop(o: StripOptions): TiffDrop {
  return {
    main: [...(o.camera || o.text ? [TAG.artist] : []), ...(o.camera ? MAIN_CAMERA : []), ...(o.text ? MAIN_TEXT : [])],
    exif: [...new Set([...(o.camera ? EXIF_CAMERA : []), ...(o.location ? [MAKER_NOTE] : []), ...(o.text ? EXIF_TEXT : [])])],
    gps: o.location,
    thumbnail: true,
  };
}

function tiffText(c: TextChange): TiffTextChange {
  return { description: c.description, author: c.author, copyright: c.copyright };
}

// ---- IPTC ----

const IPTC_LOCATION = new Set([26, 27, 90, 92, 95, 100, 101]);
const IPTC_TEXT = new Set([5, 25, 40, 80, 85, 105, 110, 115, 116, 120, 122]);
const IPTC_FIELD = { description: 120, copyright: 116, author: 80 } as const;

type Resource = { id: number; raw: Buffer; data: Buffer };

/** The resources of a Photoshop segment body, or null when it cannot be walked. */
function photoshopResources(body: Buffer): Resource[] | null {
  const out: Resource[] = [];
  let at = 0;
  while (at + 12 <= body.length) {
    if (body.toString("latin1", at, at + 4) !== "8BIM") return null;
    const id = body.readUInt16BE(at + 4);
    const nameLen = body[at + 6]!;
    const nameEnd = at + 7 + nameLen + ((nameLen + 1) % 2);
    if (nameEnd + 4 > body.length) return null;
    const size = body.readUInt32BE(nameEnd);
    const dataEnd = nameEnd + 4 + size;
    if (dataEnd > body.length) return null;
    const end = dataEnd + (size % 2);
    out.push({ id, raw: body.subarray(at, Math.min(end, body.length)), data: body.subarray(nameEnd + 4, dataEnd) });
    at = end;
  }
  return out;
}

type Dataset = { record: number; tag: number; raw: Buffer; value: Buffer };

function iptcDatasets(data: Buffer): Dataset[] | null {
  const out: Dataset[] = [];
  let at = 0;
  while (at + 5 <= data.length) {
    if (data[at] !== 0x1c) return null;
    const size = data.readUInt16BE(at + 3);
    if (size & 0x8000 || at + 5 + size > data.length) return null;
    out.push({ record: data[at + 1]!, tag: data[at + 2]!, raw: data.subarray(at, at + 5 + size), value: data.subarray(at + 5, at + 5 + size) });
    at += 5 + size;
  }
  return at === data.length ? out : null;
}

function iptcDataset(tag: number, text: string): Buffer {
  const value = Buffer.from(text, "utf8").subarray(0, 0xffff);
  const head = Buffer.alloc(5);
  head[0] = 0x1c;
  head[1] = 2;
  head[2] = tag;
  head.writeUInt16BE(value.length, 3);
  return Buffer.concat([head, value]);
}

function resourceBlock(id: number, data: Buffer): Buffer {
  const head = Buffer.alloc(12);
  head.write("8BIM", 0, "latin1");
  head.writeUInt16BE(id, 4);
  head.writeUInt32BE(data.length, 8);
  return Buffer.concat([head, data, Buffer.alloc(data.length % 2)]);
}

function decodeText(b: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b).trim();
  } catch {
    return b.toString("latin1").trim();
  }
}

function readIptcText(body: Buffer): TextMeta | null {
  const iptc = photoshopResources(body)?.find((r) => r.id === 0x0404);
  const sets = iptc ? iptcDatasets(iptc.data) : null;
  if (!sets) return null;
  const text = (tag: number) => {
    const d = sets.find((s) => s.record === 2 && s.tag === tag);
    return d ? decodeText(d.value) || null : null;
  };
  return { description: text(120), copyright: text(116), author: text(80) };
}

/**
 * A Photoshop segment body rebuilt: its IPTC record filtered by `keep` with `add` appended, the
 * other resources kept or dropped. Empty when nothing is left, null when it cannot be read.
 */
function rebuildPhotoshop(body: Buffer, keep: (d: Dataset) => boolean, add: Buffer[], keepOthers: boolean): Buffer | null {
  const resources = photoshopResources(body);
  if (!resources) return null;
  const parts: Buffer[] = [];
  let iptcDone = false;
  const writeIptc = (existing: Buffer | null) => {
    const sets = existing ? iptcDatasets(existing) : [];
    if (!sets) return false;
    const data = Buffer.concat([...sets.filter(keep).map((d) => d.raw), ...add]);
    if (data.length > 0) parts.push(resourceBlock(0x0404, data));
    iptcDone = true;
    return true;
  };
  for (const r of resources) {
    if (r.id === 0x0404) {
      if (!writeIptc(r.data)) return null;
    } else if (keepOthers) parts.push(r.raw);
  }
  if (!iptcDone) writeIptc(null);
  return Buffer.concat(parts);
}

// ---- JPEG ----

const XMP_ID = "http://ns.adobe.com/xap/1.0/\0";
const XMP_EXT_ID = "http://ns.adobe.com/xmp/extension/\0";
const EXIF_ID = "Exif\0\0";
const PS_ID = "Photoshop 3.0\0";

const idAt = (buf: Buffer, s: Segment, id: string) => s.marker === 0xe1 && buf.toString("latin1", s.start + 4, s.start + 4 + id.length) === id;
const isPhotoshop = (buf: Buffer, s: Segment) => s.marker === 0xed && buf.toString("latin1", s.start + 4, s.start + 4 + PS_ID.length) === PS_ID;

function appSegment(marker: number, id: string, body: Buffer): Buffer | null {
  const length = 2 + id.length + body.length;
  if (length > 0xffff) return null;
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xff00 | marker, 0);
  head.writeUInt16BE(length, 2);
  return Buffer.concat([head, Buffer.from(id, "latin1"), body]);
}

type JpegParts = { segments: Segment[]; exif: Segment[]; xmp: Segment[]; iptc: Segment[] };

function jpegParts(buf: Buffer): JpegParts | null {
  const segments = headerSegments(buf);
  if (!segments) return null;
  return {
    segments,
    exif: segments.filter((s) => idAt(buf, s, EXIF_ID)),
    xmp: segments.filter((s) => idAt(buf, s, XMP_ID)),
    iptc: segments.filter((s) => isPhotoshop(buf, s)),
  };
}

const exifBlock = (buf: Buffer, s: Segment) => buf.subarray(s.start + 10, s.end);
const xmpText = (buf: Buffer, s: Segment) => buf.toString("utf8", s.start + 4 + XMP_ID.length, s.end);
const photoshopBody = (buf: Buffer, s: Segment) => buf.subarray(s.start + 4 + PS_ID.length, s.end);

function readJpegText(buf: Buffer): TextMeta | null {
  const p = jpegParts(buf);
  if (!p) return null;
  return merge([
    ...p.xmp.map((s) => readXmpText(xmpText(buf, s))),
    ...p.exif.map((s) => readTiffText(exifBlock(buf, s))),
    ...p.iptc.map((s) => readIptcText(photoshopBody(buf, s))),
  ]);
}

/** What replaces a segment or chunk: its own bytes, other bytes, or nothing. */
type Decision = Buffer | "keep" | null;

/** The file with each header segment decided on, and `inserts` placed after the EXIF segment or the leading JFIF one. */
function assemble(buf: Buffer, p: JpegParts, decide: (s: Segment) => Decision, inserts: Buffer[]): Buffer {
  const anchor = p.exif[0] ?? (p.segments[0]?.marker === 0xe0 ? p.segments[0] : undefined);
  const parts: Buffer[] = [buf.subarray(0, 2)];
  if (!anchor) parts.push(...inserts);
  let prev = 2;
  for (const s of p.segments) {
    parts.push(buf.subarray(prev, s.start));
    const d = decide(s);
    if (d === "keep") parts.push(buf.subarray(s.start, s.end));
    else if (d) parts.push(d);
    if (s === anchor) parts.push(...inserts);
    prev = s.end;
  }
  parts.push(buf.subarray(prev));
  return Buffer.concat(parts);
}

function writeJpegText(buf: Buffer, change: TextChange): Buffer | null {
  const p = jpegParts(buf);
  if (!p) return null;
  const inserts: Buffer[] = [];
  const replaced = new Map<Segment, Buffer>();

  for (const s of p.exif) {
    const block = editTiff(exifBlock(buf, s), tiffText(change));
    const seg = block && appSegment(0xe1, EXIF_ID, block);
    if (!seg) return null;
    replaced.set(s, seg);
  }
  if (p.exif.length === 0) {
    const block = newTiffWithText(tiffText(change));
    if (block) {
      const seg = appSegment(0xe1, EXIF_ID, block);
      if (!seg) return null;
      inserts.push(seg);
    }
  }

  for (const s of p.xmp) {
    const xml = setXmpText(xmpText(buf, s), change);
    const seg = xml !== null ? appSegment(0xe1, XMP_ID, Buffer.from(xml, "utf8")) : null;
    if (!seg) return null;
    replaced.set(s, seg);
  }
  if (p.xmp.length === 0) {
    const xml = newXmpPacket(change);
    if (xml) {
      const seg = appSegment(0xe1, XMP_ID, Buffer.from(xml, "utf8"));
      if (!seg) return null;
      inserts.push(seg);
    }
  }

  const fields = Object.keys(change) as (keyof typeof IPTC_FIELD)[];
  const dropped = new Set<number>(fields.map((k) => IPTC_FIELD[k]));
  // The new values go into the first Photoshop segment only, so a record split over two is not doubled.
  for (const [i, s] of p.iptc.entries()) {
    const add = i === 0 ? fields.filter((k) => change[k]).map((k) => iptcDataset(IPTC_FIELD[k], change[k]!)) : [];
    const body = rebuildPhotoshop(photoshopBody(buf, s), (d) => !(d.record === 2 && dropped.has(d.tag)), add, true);
    const seg = !body ? null : body.length > 0 ? appSegment(0xed, PS_ID, body) : Buffer.alloc(0);
    if (!seg) return null;
    replaced.set(s, seg);
  }

  return assemble(buf, p, (s) => replaced.get(s) ?? "keep", inserts);
}

function stripJpeg(buf: Buffer, o: StripOptions): Buffer | null {
  const p = jpegParts(buf);
  if (!p) return null;
  const decisions = new Map<Segment, Decision>();

  for (const s of p.segments) {
    if (s.marker === 0xfe || idAt(buf, s, XMP_EXT_ID)) decisions.set(s, null);
  }
  for (const s of p.exif) {
    const held = exifBlock(buf, s);
    const block = editTiff(held, {}, tiffDrop(o));
    if (!block) return null;
    if (block !== held) {
      const seg = appSegment(0xe1, EXIF_ID, block);
      if (!seg) return null;
      decisions.set(s, seg);
    }
  }
  for (const s of p.xmp) {
    const xml = xmpText(buf, s);
    const stripped = stripXmp(xml, o);
    if (stripped === null) return null;
    if (stripped !== xml) {
      const seg = appSegment(0xe1, XMP_ID, Buffer.from(stripped, "utf8"));
      if (!seg) return null;
      decisions.set(s, seg);
    }
  }
  for (const s of p.iptc) {
    const rebuilt = rebuildPhotoshop(
      photoshopBody(buf, s),
      (d) => !(d.record === 2 && ((o.location && IPTC_LOCATION.has(d.tag)) || (o.text && IPTC_TEXT.has(d.tag)))),
      [],
      false,
    );
    if (!rebuilt) return null;
    const seg = rebuilt.length > 0 ? appSegment(0xed, PS_ID, rebuilt) : Buffer.alloc(0);
    if (!seg) return null;
    decisions.set(s, seg);
  }

  const out = assemble(buf, p, (s) => (decisions.has(s) ? decisions.get(s)! : "keep"), []);
  return out.equals(buf) ? buf : out;
}

// ---- PNG ----

type Chunk = { type: string; start: number; end: number; data: Buffer };

function pngChunks(buf: Buffer): Chunk[] | null {
  const out: Chunk[] = [];
  let at = 8;
  while (at + 12 <= buf.length) {
    const length = buf.readUInt32BE(at);
    const end = at + 12 + length;
    if (end > buf.length) return null;
    const type = buf.toString("latin1", at + 4, at + 8);
    out.push({ type, start: at, end, data: buf.subarray(at + 8, at + 8 + length) });
    at = end;
    if (type === "IEND") break;
  }
  return out.length > 0 ? out : null;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const XMP_KEYWORD = "XML:com.adobe.xmp";

const isTextChunk = (c: Chunk) => c.type === "tEXt" || c.type === "zTXt" || c.type === "iTXt";

function keywordOf(c: Chunk): string {
  const z = c.data.indexOf(0);
  return z > 0 ? c.data.toString("latin1", 0, z) : "";
}

/** At most `max` bytes inflated, or null for a stream that holds more or cannot be read. */
function inflateCapped(data: Buffer, max: number): Buffer | null {
  try {
    return inflateSync(data, { maxOutputLength: max });
  } catch {
    return null;
  }
}

/** The text of a text chunk, or null when it cannot be read or is larger than `max` bytes. */
function pngTextOf(c: Chunk, max = PNG_TEXT_MAX_BYTES): string | null {
  const z = c.data.indexOf(0);
  if (z <= 0) return null;
  let raw: Buffer | null;
  let utf8 = false;
  if (c.type === "tEXt") raw = c.data.subarray(z + 1);
  else if (c.type === "zTXt") raw = inflateCapped(c.data.subarray(z + 2), max);
  else {
    const compressed = c.data[z + 1] === 1;
    const lang = c.data.indexOf(0, z + 3);
    const translated = lang < 0 ? -1 : c.data.indexOf(0, lang + 1);
    if (translated < 0) return null;
    const body = c.data.subarray(translated + 1);
    raw = compressed ? inflateCapped(body, max) : body;
    utf8 = true;
  }
  if (!raw || raw.length > max) return null;
  return raw.toString(utf8 ? "utf8" : "latin1");
}

/** The XMP packet of a chunk, read up to the packet size handled. */
const pngXmpOf = (c: Chunk) => pngTextOf(c, XMP_MAX_CHARS);

const PNG_FIELD = { description: "Description", copyright: "Copyright", author: "Author" } as const;

function readPngText(buf: Buffer): TextMeta | null {
  const chunks = pngChunks(buf);
  if (!chunks) return null;
  // Only the chunks named here are inflated, one at a time, the first of each keyword.
  const byKeyword = (k: string) => {
    const c = chunks.find((x) => isTextChunk(x) && keywordOf(x) === k);
    return (c ? (k === XMP_KEYWORD ? pngXmpOf(c) : pngTextOf(c))?.trim() : null) || null;
  };
  const xmp = byKeyword(XMP_KEYWORD);
  const exif = chunks.find((c) => c.type === "eXIf");
  return merge([
    xmp ? readXmpText(xmp) : null,
    exif ? readTiffText(exif.data) : null,
    { description: byKeyword("Description"), copyright: byKeyword("Copyright"), author: byKeyword("Author") },
  ]);
}

function itxt(keyword: string, text: string): Buffer {
  return pngChunk("iTXt", Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0, 0, 0, 0, 0]), Buffer.from(text, "utf8")]));
}

/** The file with each chunk replaced, dropped or kept, and `adds` placed ahead of the first image data. */
function reassemblePng(buf: Buffer, chunks: Chunk[], decide: (c: Chunk) => Decision, adds: Buffer[]): Buffer {
  const parts: Buffer[] = [buf.subarray(0, 8)];
  let added = false;
  for (const c of chunks) {
    if (!added && (c.type === "IDAT" || c.type === "IEND")) {
      parts.push(...adds);
      added = true;
    }
    const d = decide(c);
    if (d === "keep") parts.push(buf.subarray(c.start, c.end));
    else if (d) parts.push(d);
  }
  parts.push(buf.subarray(chunks[chunks.length - 1]!.end));
  return Buffer.concat(parts);
}

function writePngText(buf: Buffer, change: TextChange): Buffer | null {
  const chunks = pngChunks(buf);
  if (!chunks) return null;
  const fields = Object.keys(change) as (keyof TextChange)[];
  const keys = new Set<string>(fields.map((k) => PNG_FIELD[k]));
  const adds: Buffer[] = [];
  const replaced = new Map<Chunk, Buffer>();

  const xmpChunk = chunks.find((c) => isTextChunk(c) && keywordOf(c) === XMP_KEYWORD);
  if (xmpChunk) {
    const xml = pngXmpOf(xmpChunk);
    const next = xml !== null ? setXmpText(xml, change) : null;
    if (next === null) return null;
    replaced.set(xmpChunk, itxt(XMP_KEYWORD, next));
  } else {
    const xml = newXmpPacket(change);
    if (xml) adds.push(itxt(XMP_KEYWORD, xml));
  }
  for (const exif of chunks.filter((c) => c.type === "eXIf")) {
    const block = editTiff(exif.data, tiffText(change));
    if (!block) return null;
    replaced.set(exif, pngChunk("eXIf", block));
  }
  for (const k of fields) if (change[k]) adds.push(itxt(PNG_FIELD[k], change[k]!));

  return reassemblePng(buf, chunks, (c) => replaced.get(c) ?? (isTextChunk(c) && keys.has(keywordOf(c)) ? null : "keep"), adds);
}

const PNG_CAMERA = new Set(["Software", "Source", "Hardware", "Comment"]);
const PNG_TEXT = new Set(["Title", "Author", "Description", "Copyright", "Comment"]);

function stripPng(buf: Buffer, o: StripOptions): Buffer | null {
  const chunks = pngChunks(buf);
  if (!chunks) return null;
  const decisions = new Map<Chunk, Decision>();
  for (const c of chunks) {
    if (c.type === "eXIf") {
      const block = editTiff(c.data, {}, tiffDrop(o));
      if (!block) return null;
      if (block !== c.data) decisions.set(c, pngChunk("eXIf", block));
    } else if (isTextChunk(c)) {
      const key = keywordOf(c);
      if (key === XMP_KEYWORD) {
        const xml = pngXmpOf(c);
        const stripped = xml === null ? null : stripXmp(xml, o);
        if (xml === null || stripped === null) return null;
        if (stripped !== xml) decisions.set(c, itxt(XMP_KEYWORD, stripped));
      } else if (key.startsWith("Raw profile type") || (o.camera && PNG_CAMERA.has(key)) || (o.text && PNG_TEXT.has(key))) {
        decisions.set(c, null);
      }
    }
  }
  const out = reassemblePng(buf, chunks, (c) => (decisions.has(c) ? decisions.get(c)! : "keep"), []);
  return out.equals(buf) ? buf : out;
}
