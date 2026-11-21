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

import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseIso6709, readVideoTags } from "./videoTags.ts";

const dir = mkdtempSync(join(tmpdir(), "pfp-tags-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function box(type: string, ...body: Buffer[]): Buffer {
  const content = Buffer.concat(body);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + content.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, content]);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

/** A `meta` box of QuickTime keys, the way an iPhone writes it (`full` false) or ffmpeg (`full` true). */
function keyedMeta(entries: [string, string][], full: boolean, handler = "mdta"): Buffer {
  const hdlr = box("hdlr", u32(0), u32(0), Buffer.from(handler, "latin1"), Buffer.alloc(13));
  const keys = box("keys", u32(0), u32(entries.length), ...entries.map(([k]) => box("mdta", Buffer.from(k, "utf8"))));
  const items = entries.map(([, v], i) => box(String.fromCharCode(0, 0, 0, i + 1), box("data", u32(1), u32(0), Buffer.from(v, "utf8"))));
  return box("meta", ...(full ? [u32(0)] : []), hdlr, keys, box("ilst", ...items));
}

/** A QuickTime text box in `udta`. */
function udtaText(type: string, text: string): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt16BE(Buffer.byteLength(text, "utf8"), 0);
  length.writeUInt16BE(0x15c7, 2);
  return box(type, length, Buffer.from(text, "utf8"));
}

function video(name: string, ...moovChildren: Buffer[]): string {
  const path = join(dir, name);
  const ftyp = box("ftyp", Buffer.from("qt  ", "latin1"), u32(0));
  const mvhd = box("mvhd", Buffer.alloc(100));
  writeFileSync(path, Buffer.concat([ftyp, box("moov", mvhd, ...moovChildren), box("mdat", Buffer.alloc(64, 7))]));
  return path;
}

const IPHONE: [string, string][] = [
  ["com.apple.quicktime.location.accuracy.horizontal", "4.7"],
  ["com.apple.quicktime.location.ISO6709", "+47.4979+019.0402+120.000/"],
  ["com.apple.quicktime.make", "Apple"],
  ["com.apple.quicktime.model", "iPhone 15 Pro"],
  ["com.apple.quicktime.creationdate", "2024-05-01T14:30:00+0200"],
];

describe("parseIso6709", () => {
  it("reads degrees, with or without a height", () => {
    expect(parseIso6709("+47.4979+019.0402+120.000/")).toEqual({ latitude: 47.4979, longitude: 19.0402 });
    expect(parseIso6709("-33.8568+151.2153/")).toEqual({ latitude: -33.8568, longitude: 151.2153 });
    expect(parseIso6709("+5.5-3.25/")).toEqual({ latitude: 5.5, longitude: -3.25 });
  });

  it("reads degrees and minutes, and degrees, minutes and seconds", () => {
    const dm = parseIso6709("+4730.000-01902.400/")!;
    expect(dm.latitude).toBeCloseTo(47.5, 6);
    expect(dm.longitude).toBeCloseTo(-19.04, 6);
    const dms = parseIso6709("+473000+0190224/")!;
    expect(dms.latitude).toBeCloseTo(47.5, 6);
    expect(dms.longitude).toBeCloseTo(19.04, 6);
  });

  it("says nothing of text that is not a place", () => {
    expect(parseIso6709("")).toBeNull();
    expect(parseIso6709("Budapest")).toBeNull();
    expect(parseIso6709("+47.4979/")).toBeNull();
    expect(parseIso6709("+1.2.3+4/")).toBeNull();
  });
});

describe("readVideoTags", () => {
  it("reads an iPhone's place and camera from its QuickTime keys", async () => {
    expect(await readVideoTags(video("iphone.mov", keyedMeta(IPHONE, false)))).toEqual({
      latitude: 47.4979,
      longitude: 19.0402,
      make: "Apple",
      model: "iPhone 15 Pro",
    });
  });

  it("reads the same keys where ffmpeg writes them, in udta, as a full box", async () => {
    const path = video("copy.mp4", box("udta", keyedMeta(IPHONE, true)));
    expect(await readVideoTags(path)).toMatchObject({ latitude: 47.4979, make: "Apple", model: "iPhone 15 Pro" });
  });

  it("reads an Android phone's place from udta", async () => {
    const path = video("android.mp4", box("udta", udtaText("©xyz", "-33.8568+151.2153/")));
    expect(await readVideoTags(path)).toEqual({ latitude: -33.8568, longitude: 151.2153 });
  });

  it("reads a camera's make and model from udta", async () => {
    const path = video("camera.mov", box("udta", udtaText("©mak", "Canon"), udtaText("©mod", "EOS R6")));
    expect(await readVideoTags(path)).toEqual({ make: "Canon", model: "EOS R6" });
  });

  it("takes the QuickTime keys over udta when both are there", async () => {
    const path = video(
      "both.mov",
      keyedMeta(IPHONE, false),
      box("udta", udtaText("©xyz", "+01.0000+002.0000/"), udtaText("©mod", "Other")),
    );
    expect(await readVideoTags(path)).toMatchObject({ latitude: 47.4979, longitude: 19.0402, model: "iPhone 15 Pro" });
  });

  it("ignores keys under another handler", async () => {
    const path = video("itunes.mp4", box("udta", keyedMeta(IPHONE, true, "mdir")));
    expect(await readVideoTags(path)).toEqual({});
  });

  it("says nothing of a file with no tags, no movie box, or no MP4 at all", async () => {
    expect(await readVideoTags(video("bare.mp4"))).toEqual({});
    const noMoov = join(dir, "nomoov.mp4");
    writeFileSync(noMoov, box("ftyp", Buffer.from("isom", "latin1"), u32(0)));
    expect(await readVideoTags(noMoov)).toEqual({});
    const junk = join(dir, "junk.mov");
    writeFileSync(junk, Buffer.alloc(2048, 7));
    expect(await readVideoTags(junk)).toEqual({});
    expect(await readVideoTags(join(dir, "missing.mov"))).toEqual({});
  });

  it("stops at a box that runs past its parent rather than reading beyond it", async () => {
    const meta = keyedMeta(IPHONE, false);
    const ilst = meta.indexOf("ilst", 0, "latin1") - 4;
    meta.writeUInt32BE(meta.readUInt32BE(ilst) + 500, ilst);
    expect(await readVideoTags(video("broken.mov", meta))).toEqual({});
  });
});
