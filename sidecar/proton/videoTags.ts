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

// A video's place and camera, read from its MP4/MOV tags.
//
// `exifr` reads no video at all, so without this a video uploads with neither. A phone writes
// both into the movie box: an iPhone as QuickTime keys (`com.apple.quicktime.location.ISO6709`,
// `.make`, `.model`) in `moov > meta`, an Android phone its place as `©xyz` in `moov > udta`,
// and ffmpeg the same keys in `moov > udta > meta`. Only those boxes are read, never a frame.

import { open, type FileHandle } from "node:fs/promises";

import { findBox } from "./mp4Date.ts";

export type VideoTags = {
  latitude?: number;
  longitude?: number;
  make?: string;
  model?: string;
};

/** The most read of one tag box: far more than any phone writes there. */
const MAX_READ = 1 << 20;

type Box = { type: string; at: number; start: number; end: number };

/** The boxes laid one after another in `buf` between `from` and `to`. */
function* boxes(buf: Buffer, from: number, to: number): Generator<Box> {
  let pos = from;
  while (pos + 8 <= to) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > to) return;
      size = Number(buf.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = to - pos;
    }
    if (size < header || pos + size > to) return;
    yield { type, at: pos, start: pos + header, end: pos + size };
    pos += size;
  }
}

/**
 * One coordinate of an ISO 6709 string, in degrees: `±DD.D`, `±DDMM.M` or `±DDMMSS.S`, with one
 * more degree digit for a longitude.
 */
function iso6709Part(text: string, degreeDigits: number): number | null {
  const sign = text.startsWith("-") ? -1 : 1;
  const body = text.slice(1);
  const n = Number(body);
  if (!Number.isFinite(n)) return null;
  const whole = body.split(".")[0].length;
  if (whole <= degreeDigits) return sign * n;
  if (whole === degreeDigits + 2) return sign * (Math.floor(n / 100) + (n % 100) / 60);
  if (whole === degreeDigits + 4) {
    return sign * (Math.floor(n / 10000) + Math.floor((n % 10000) / 100) / 60 + (n % 100) / 3600);
  }
  return null;
}

/** The latitude and longitude of an ISO 6709 string such as `+47.4979+019.0402+120.000/`. */
export function parseIso6709(text: string): { latitude: number; longitude: number } | null {
  const m = /^([+-][\d.]+)([+-][\d.]+)/.exec(text.trim());
  if (!m) return null;
  const latitude = iso6709Part(m[1], 2);
  const longitude = iso6709Part(m[2], 3);
  if (latitude === null || longitude === null) return null;
  return { latitude, longitude };
}

/** The UTF-8 values of an `mdta` meta box, by key. A meta box is a full box in MP4, not in QuickTime. */
function keyedValues(buf: Buffer, meta: Box, into: Map<string, string>): void {
  const from = buf.toString("latin1", meta.start + 4, meta.start + 8) === "hdlr" ? meta.start : meta.start + 4;
  let mdta = false;
  const keys: string[] = [];
  let list: Box | null = null;
  for (const b of boxes(buf, from, meta.end)) {
    if (b.type === "hdlr" && b.end - b.start >= 12) {
      mdta = buf.toString("latin1", b.start + 8, b.start + 12) === "mdta";
    } else if (b.type === "keys") {
      for (const k of boxes(buf, b.start + 8, b.end)) keys.push(buf.toString("utf8", k.start, k.end));
    } else if (b.type === "ilst") {
      list = b;
    }
  }
  if (!mdta || !list) return;
  for (const item of boxes(buf, list.start, list.end)) {
    const key = keys[buf.readUInt32BE(item.at + 4) - 1];
    if (!key || into.has(key)) continue;
    for (const d of boxes(buf, item.start, item.end)) {
      // The type indicator: 1 is UTF-8 text.
      if (d.type === "data" && d.end - d.start >= 8 && (buf.readUInt32BE(d.start) & 0xffffff) === 1) {
        into.set(key, buf.toString("utf8", d.start + 8, d.end));
        break;
      }
    }
  }
}

/** A QuickTime text box in `udta`: a length, a language, then the text. */
function udtaText(buf: Buffer, box: Box): string {
  if (box.end - box.start < 4) return "";
  const length = buf.readUInt16BE(box.start);
  return buf.toString("utf8", box.start + 4, Math.min(box.end, box.start + 4 + length));
}

async function readContent(fh: FileHandle, box: { start: number; end: number }): Promise<Buffer> {
  const buf = Buffer.alloc(Math.max(0, Math.min(box.end - box.start, MAX_READ)));
  const { bytesRead } = await fh.read(buf, 0, buf.length, box.start);
  return buf.subarray(0, bytesRead);
}

/** What a video's tags say of where and on what it was filmed; empty when they say nothing. */
export async function readVideoTags(path: string): Promise<VideoTags> {
  let fh: FileHandle | undefined;
  const tags: VideoTags = {};
  try {
    fh = await open(path, "r");
    const moov = await findBox(fh, 0, null, "moov");
    if (!moov) return tags;
    const keyed = new Map<string, string>();
    const plain = new Map<string, string>();
    const meta = await findBox(fh, moov.start, moov.end, "meta");
    if (meta) {
      const buf = await readContent(fh, meta);
      keyedValues(buf, { type: "meta", at: 0, start: 0, end: buf.length }, keyed);
    }
    const udta = await findBox(fh, moov.start, moov.end, "udta");
    if (udta) {
      const buf = await readContent(fh, udta);
      for (const b of boxes(buf, 0, buf.length)) {
        if (b.type === "meta") keyedValues(buf, b, keyed);
        else if (b.type === "©xyz" || b.type === "©mak" || b.type === "©mod") {
          const text = udtaText(buf, b).trim();
          if (text) plain.set(b.type.slice(1), text);
        }
      }
    }
    const place =
      keyed.get("com.apple.quicktime.location.ISO6709") ?? plain.get("xyz") ?? keyed.get("location");
    const at = place ? parseIso6709(place) : null;
    if (at) Object.assign(tags, at);
    const make = (keyed.get("com.apple.quicktime.make") ?? plain.get("mak") ?? "").trim();
    const model = (keyed.get("com.apple.quicktime.model") ?? plain.get("mod") ?? "").trim();
    if (make) tags.make = make;
    if (model) tags.model = model;
  } catch {
    // not an MP4 or MOV, or unreadable: nothing to tell
  } finally {
    await fh?.close().catch(() => {});
  }
  return tags;
}
