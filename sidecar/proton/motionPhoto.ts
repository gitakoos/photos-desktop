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

// The short clip inside a motion photo.
//
import { readFile } from "node:fs/promises";

// An Android motion photo is one JPEG with the clip appended after the picture. The
// file says where the clip starts in its XMP: the older MicroVideo form gives the
// distance from the END of the file to the start of the clip, and the Motion Photo
// form lists the parts in a container directory, the clip being the item whose
// semantic is MotionPhoto, with its length. A file whose XMP is missing or lies falls
// back to the first MP4 `ftyp` box after the picture's own end.

/** Where the clip sits in the file, as the bytes `start` up to `end`. */
export type MotionClip = { start: number; end: number };

/** How much of the file's head is searched for the XMP packet. */
const XMP_SCAN_BYTES = 512 * 1024;

const isJpeg = (b: Buffer) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8;

/** Whether `at` holds the size and `ftyp` of an MP4 file's first box. */
function startsMp4(b: Buffer, at: number): boolean {
  if (at < 0 || at + 12 > b.length) return false;
  if (b.toString("latin1", at + 4, at + 8) !== "ftyp") return false;
  const size = b.readUInt32BE(at);
  return size >= 16 && size <= 256 && at + size <= b.length;
}

/** The length of the clip the file's XMP declares, or null when it declares none. */
export function declaredClipLength(b: Buffer): number | null {
  const head = b.toString("latin1", 0, Math.min(b.length, XMP_SCAN_BYTES));
  const from = head.indexOf("<x:xmpmeta");
  if (from < 0) return null;
  const close = head.indexOf("</x:xmpmeta>", from);
  const packet = close < 0 ? head.slice(from) : head.slice(from, close);

  const items = packet.match(/<Container:Item\b[^>]*>/g) ?? [];
  for (const tag of items) {
    if (!/Item:Semantic\s*=\s*"MotionPhoto"/.test(tag)) continue;
    const length = /Item:Length\s*=\s*"(\d+)"/.exec(tag);
    if (length && Number(length[1]) > 0) return Number(length[1]);
  }
  const micro = /MicroVideoOffset\s*=\s*"(\d+)"/.exec(packet);
  if (micro && Number(micro[1]) > 0) return Number(micro[1]);
  return null;
}

/** The first MP4 start after the picture's own bytes, when the XMP gave no usable length. */
function scanForClip(b: Buffer): number | null {
  let at = b.indexOf("ftyp", 4, "latin1");
  while (at >= 0) {
    if (startsMp4(b, at - 4)) return at - 4;
    at = b.indexOf("ftyp", at + 4, "latin1");
  }
  return null;
}

/**
 * Where the clip of a motion photo sits, or null when the file holds none.
 *
 * Only a JPEG carries one this way. The declared length is trusted only when an MP4
 * really starts there, so a wrong XMP never plays garbage.
 */
export function findMotionClip(b: Buffer): MotionClip | null {
  if (!isJpeg(b)) return null;
  const length = declaredClipLength(b);
  if (length !== null && length < b.length) {
    const start = b.length - length;
    if (startsMp4(b, start)) return { start, end: b.length };
  }
  const start = scanForClip(b);
  return start === null ? null : { start, end: b.length };
}

/** Whether the JPEG at `path` carries a motion clip. Only a JPEG is read; any other file is not one. */
export async function fileHasMotionClip(path: string, mediaType: string): Promise<boolean> {
  if (mediaType !== "image/jpeg") return false;
  try {
    return findMotionClip(await readFile(path)) !== null;
  } catch {
    return false;
  }
}
