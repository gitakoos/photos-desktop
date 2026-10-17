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

// A video's real capture time, read from the MP4/MOV `mvhd` box.
//
// `exifr` reads a still's EXIF date, but for most .mp4/.mov files it finds none, so the
// upload would otherwise fall back to the file's copy time (mtime) and mis-date every
// video on the timeline. QuickTime/ISO-BMFF records the true creation time in the movie
// header (`moov > mvhd`) as seconds since 1904-01-01 UTC. This reads exactly that box and
// nothing else: it walks the container's box headers with small offset reads, never
// decoding a frame or loading the file, so a 4 GB video costs the same as a clip. The
// Android client reads the same box for the same reason.

import { open, type FileHandle } from "node:fs/promises";

// Seconds between the QuickTime epoch (1904-01-01) and the Unix epoch (1970-01-01).
const EPOCH_1904_TO_1970 = 2_082_844_800;

/**
 * Parse an `mvhd` box body (the bytes after its 8-byte size+type header) into a capture
 * `Date`, or null when it carries no usable time. A zero creation time means "unset", and
 * a time outside a sane year range is treated as garbage rather than trusted.
 */
export function parseMvhdCreationTime(body: Buffer): Date | null {
  if (body.length < 4) return null;
  const version = body[0];
  let secs1904: number;
  if (version === 1) {
    if (body.length < 12) return null;
    // 64-bit creation_time. A real capture time fits well inside 53 bits, so the Number
    // conversion is exact for any date this side of the year 285000.
    secs1904 = Number(body.readBigUInt64BE(4));
  } else {
    if (body.length < 8) return null;
    secs1904 = body.readUInt32BE(4);
  }
  if (!secs1904) return null; // 0 = unset
  const d = new Date((secs1904 - EPOCH_1904_TO_1970) * 1000);
  const year = d.getUTCFullYear();
  if (year < 1990 || year > 2100) return null; // reject an absurd/garbage stamp
  return d;
}

/**
 * The byte range of the first child box of `type` between `from` and `limit` (EOF when
 * null), or null. Reads only each box's header, then skips its length, so finding `mvhd`
 * costs a handful of tiny reads even in a huge file.
 */
async function findBox(
  fh: FileHandle,
  from: number,
  limit: number | null,
  type: string,
): Promise<{ start: number; end: number } | null> {
  const header = Buffer.alloc(16);
  let offset = from;
  for (let guard = 0; guard < 4096; guard++) {
    if (limit !== null && offset + 8 > limit) return null;
    const { bytesRead } = await fh.read(header, 0, 16, offset);
    if (bytesRead < 8) return null;
    let size = header.readUInt32BE(0);
    const boxType = header.toString("latin1", 4, 8);
    let headerLen = 8;
    if (size === 1) {
      if (bytesRead < 16) return null;
      size = Number(header.readBigUInt64BE(8)); // 64-bit extended size
      headerLen = 16;
    } else if (size === 0) {
      // Runs to the end of its container.
      size = (limit ?? Number.MAX_SAFE_INTEGER) - offset;
    }
    if (size < headerLen) return null; // malformed length
    const contentStart = offset + headerLen;
    const contentEnd = offset + size;
    if (boxType === type) return { start: contentStart, end: contentEnd };
    if (contentEnd <= offset) return null; // no forward progress: malformed
    offset = contentEnd;
  }
  return null;
}

/** The creation time from an MP4/MOV's `mvhd` box, or null if absent/unreadable. */
export async function readMp4CreationTime(path: string): Promise<Date | null> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(path, "r");
    const moov = await findBox(fh, 0, null, "moov");
    if (!moov) return null;
    const mvhd = await findBox(fh, moov.start, moov.end, "mvhd");
    if (!mvhd) return null;
    const len = Math.min(mvhd.end - mvhd.start, 32);
    if (len < 4) return null;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, mvhd.start);
    return parseMvhdCreationTime(buf);
  } catch {
    return null; // not an mp4/mov, truncated, or unreadable: no date to offer
  } finally {
    await fh?.close().catch(() => {});
  }
}
