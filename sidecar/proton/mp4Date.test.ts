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

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseMvhdCreationTime, readMp4CreationTime } from "./mp4Date.ts";

const EPOCH_1904_TO_1970 = 2_082_844_800;

/** An mvhd box body (version + flags + creation_time + a little padding). */
function mvhdBody(unixMs: number, version: 0 | 1 = 0): Buffer {
  const secs1904 = Math.floor(unixMs / 1000) + EPOCH_1904_TO_1970;
  if (version === 1) {
    const b = Buffer.alloc(20);
    b[0] = 1;
    b.writeBigUInt64BE(BigInt(secs1904), 4);
    return b;
  }
  const b = Buffer.alloc(16);
  b[0] = 0;
  b.writeUInt32BE(secs1904, 4);
  return b;
}

/** A size+type box wrapping `body`. */
function box(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
}

describe("parseMvhdCreationTime", () => {
  it("reads a version-0 creation time", () => {
    const when = Date.UTC(2023, 5, 15, 12, 0, 0);
    expect(parseMvhdCreationTime(mvhdBody(when, 0))?.getTime()).toBe(when);
  });

  it("reads a version-1 (64-bit) creation time", () => {
    const when = Date.UTC(2024, 0, 2, 8, 30, 0);
    expect(parseMvhdCreationTime(mvhdBody(when, 1))?.getTime()).toBe(when);
  });

  it("returns null for an unset (0) time", () => {
    expect(parseMvhdCreationTime(Buffer.alloc(16))).toBeNull();
  });

  it("rejects an absurd stamp rather than dating a video to 1904", () => {
    const b = Buffer.alloc(16);
    b.writeUInt32BE(1, 4); // one second past the 1904 epoch
    expect(parseMvhdCreationTime(b)).toBeNull();
  });
});

describe("readMp4CreationTime", () => {
  it("finds mvhd inside moov, after an ftyp box", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pfp-mp4-"));
    try {
      const when = Date.UTC(2022, 10, 3, 9, 15, 0);
      const ftyp = box("ftyp", Buffer.concat([Buffer.from("isom"), Buffer.alloc(8)]));
      const moov = box("moov", box("mvhd", mvhdBody(when, 0)));
      const file = join(dir, "clip.mp4");
      writeFileSync(file, Buffer.concat([ftyp, moov]));
      expect((await readMp4CreationTime(file))?.getTime()).toBe(when);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for a file that is not an mp4/mov", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pfp-mp4-"));
    try {
      const file = join(dir, "notmp4.bin");
      writeFileSync(file, Buffer.from("this is plainly not an ISO base media file"));
      expect(await readMp4CreationTime(file)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
