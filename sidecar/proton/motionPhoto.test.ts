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

import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { declaredClipLength, fileHasMotionClip, findMotionClip } from "./motionPhoto.ts";

const MP4 = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from("ftypisom", "latin1"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("isommp41", "latin1"),
  Buffer.from("moov-and-the-rest-of-the-clip", "latin1"),
]);

const SCAN = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6, 0x11, 0x22, 0xff, 0xd9]);

/** A JPEG whose APP1 carries `xmp`, with `tail` appended after the picture. */
function jpeg(xmp: string | null, tail: Buffer): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (xmp !== null) {
    const body = Buffer.concat([Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1"), Buffer.from(xmp, "latin1")]);
    const head = Buffer.alloc(4);
    head.writeUInt16BE(0xffe1, 0);
    head.writeUInt16BE(body.length + 2, 2);
    parts.push(head, body);
  }
  parts.push(SCAN, tail);
  return Buffer.concat(parts);
}

const packet = (inner: string) => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF>${inner}</rdf:RDF></x:xmpmeta>`;

describe("findMotionClip", () => {
  it("finds the clip a Motion Photo container names", () => {
    const xmp = packet(
      `<Container:Directory><rdf:Seq>` +
        `<rdf:li><Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0"/></rdf:li>` +
        `<rdf:li><Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="${MP4.length}"/></rdf:li>` +
        `</rdf:Seq></Container:Directory>`,
    );
    const file = jpeg(xmp, MP4);
    const clip = findMotionClip(file);
    expect(clip).toEqual({ start: file.length - MP4.length, end: file.length });
    expect(file.subarray(clip!.start, clip!.end).equals(MP4)).toBe(true);
  });

  it("reads the attributes in either order", () => {
    const xmp = packet(`<Container:Item Item:Length="${MP4.length}" Item:Mime="video/mp4" Item:Semantic="MotionPhoto"/>`);
    expect(findMotionClip(jpeg(xmp, MP4))).not.toBeNull();
  });

  it("finds the clip a MicroVideo offset names", () => {
    const xmp = packet(`<rdf:Description GCamera:MicroVideo="1" GCamera:MicroVideoOffset="${MP4.length}"/>`);
    const file = jpeg(xmp, MP4);
    expect(findMotionClip(file)?.start).toBe(file.length - MP4.length);
  });

  it("falls back to the first MP4 box when the XMP is missing", () => {
    const file = jpeg(null, MP4);
    const clip = findMotionClip(file);
    expect(file.subarray(clip!.start, clip!.end).equals(MP4)).toBe(true);
  });

  it("falls back when the declared length points at no MP4", () => {
    const xmp = packet(`<rdf:Description GCamera:MicroVideoOffset="7"/>`);
    const file = jpeg(xmp, MP4);
    const clip = findMotionClip(file);
    expect(file.subarray(clip!.start, clip!.end).equals(MP4)).toBe(true);
  });

  it("finds nothing in a plain JPEG", () => {
    expect(findMotionClip(jpeg(packet(`<rdf:Description/>`), Buffer.alloc(0)))).toBeNull();
  });

  it("finds nothing in a file that is not a JPEG", () => {
    expect(findMotionClip(Buffer.concat([Buffer.from("not a jpeg at all"), MP4]))).toBeNull();
    expect(findMotionClip(Buffer.alloc(0))).toBeNull();
  });

  it("ignores a ftyp whose box size is not an MP4 header", () => {
    const fake = Buffer.concat([Buffer.from([0, 0, 0xff, 0xff]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(32)]);
    expect(findMotionClip(jpeg(null, fake))).toBeNull();
  });
});

describe("declaredClipLength", () => {
  it("is null without an XMP packet", () => {
    expect(declaredClipLength(jpeg(null, MP4))).toBeNull();
  });

  it("prefers the container item over the legacy offset", () => {
    const xmp = packet(
      `<rdf:Description GCamera:MicroVideoOffset="99"/><Container:Item Item:Semantic="MotionPhoto" Item:Length="42"/>`,
    );
    expect(declaredClipLength(jpeg(xmp, MP4))).toBe(42);
  });
});

describe("fileHasMotionClip", () => {
  const dir = mkdtempSync(join(tmpdir(), "pfp-motion-test-"));

  it("is true for a JPEG with a clip and false for a plain one or another type", async () => {
    const motion = join(dir, "motion.jpg");
    await writeFile(motion, jpeg(null, MP4));
    const plain = join(dir, "plain.jpg");
    await writeFile(plain, jpeg(null, Buffer.alloc(0)));
    expect(await fileHasMotionClip(motion, "image/jpeg")).toBe(true);
    expect(await fileHasMotionClip(plain, "image/jpeg")).toBe(false);
    expect(await fileHasMotionClip(motion, "image/png")).toBe(false);
    expect(await fileHasMotionClip(join(dir, "missing.jpg"), "image/jpeg")).toBe(false);
  });
});
