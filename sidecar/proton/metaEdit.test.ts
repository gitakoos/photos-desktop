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

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import exifr from "exifr";
import sharp from "sharp";
import { deflateSync } from "node:zlib";

import { applyMeta, applyStrip, applyTextMeta, canEditMeta, neededTextChange, parseMetaChange, PNG_TEXT_MAX_BYTES, readTextMeta } from "./metaEdit.ts";
import { crc32 } from "./embedDate.ts";
import { editTiff, readTiffText } from "./metaTiff.ts";
import { newXmpPacket, readXmpText, setXmpText, stripXmp, XMP_MAX_CHARS } from "./metaXmp.ts";

type E = { tag: number; type: number; count: number; data?: Buffer; long?: number };
const ascii = (tag: number, s: string): E => ({ tag, type: 2, count: s.length + 1, data: Buffer.from(s + "\0", "latin1") });

/** A big-endian TIFF block: main, EXIF and GPS directories, and a thumbnail directory when `thumb` is given. */
function tiff(main: E[], exif: E[], gps: E[], thumb?: Buffer): Buffer {
  const counts = [main.length + (exif.length ? 1 : 0) + (gps.length ? 1 : 0), exif.length, gps.length, ...(thumb ? [2] : [])];
  const at: number[] = [];
  let pos = 8;
  for (const n of counts) {
    at.push(pos);
    pos += 2 + 12 * n + 4;
  }
  const data: Buffer[] = [];
  let dataAt = pos;
  const place = (b: Buffer) => {
    const o = dataAt;
    data.push(b, Buffer.alloc(b.length % 2));
    dataAt += b.length + (b.length % 2);
    return o;
  };
  const table = (entries: E[], next: number) => {
    const out = Buffer.alloc(2 + entries.length * 12 + 4);
    out.writeUInt16BE(entries.length, 0);
    [...entries]
      .sort((a, b) => a.tag - b.tag)
      .forEach((e, i) => {
        const o = 2 + i * 12;
        out.writeUInt16BE(e.tag, o);
        out.writeUInt16BE(e.type, o + 2);
        out.writeUInt32BE(e.count, o + 4);
        if (e.long !== undefined) out.writeUInt32BE(e.long, o + 8);
        else if (e.data!.length <= 4) e.data!.copy(out, o + 8);
        else out.writeUInt32BE(place(e.data!), o + 8);
      });
    out.writeUInt32BE(next, 2 + entries.length * 12);
    return out;
  };
  const mainEntries = [...main];
  if (exif.length) mainEntries.push({ tag: 0x8769, type: 4, count: 1, long: at[1]! });
  if (gps.length) mainEntries.push({ tag: 0x8825, type: 4, count: 1, long: at[2]! });
  const tables = [table(mainEntries, thumb ? at[3]! : 0), table(exif, 0), table(gps, 0)];
  if (thumb) {
    const o = place(thumb);
    tables.push(
      table(
        [
          { tag: 0x0201, type: 4, count: 1, long: o },
          { tag: 0x0202, type: 4, count: 1, long: thumb.length },
        ],
        0,
      ),
    );
  }
  const head = Buffer.alloc(8);
  head.write("MM", 0, "latin1");
  head.writeUInt16BE(42, 2);
  head.writeUInt32BE(8, 4);
  return Buffer.concat([head, ...tables, ...data]);
}

function segment(marker: number, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xff00 | marker, 0);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

const SOI = Buffer.from([0xff, 0xd8]);
const SCAN = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 2, 3, 4, 5, 6, 0x11, 0x22, 0x33, 0x44, 0xff, 0xd9]);
const JFIF = segment(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"));
const exifSeg = (block: Buffer) => segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), block]));
const xmpSeg = (xml: string) => segment(0xe1, Buffer.concat([Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1"), Buffer.from(xml, "utf8")]));
const scanOf = (buf: Buffer) => buf.subarray(buf.indexOf(Buffer.from([0xff, 0xda])));

const rational = (n: number, d: number) => {
  const b = Buffer.alloc(8);
  b.writeUInt32BE(n, 0);
  b.writeUInt32BE(d, 4);
  return b;
};
const gpsEntries = (): E[] => [
  { tag: 1, type: 2, count: 2, data: Buffer.from("N\0", "latin1") },
  { tag: 2, type: 5, count: 3, data: Buffer.concat([rational(47, 1), rational(29, 1), rational(5000, 100)]) },
  { tag: 3, type: 2, count: 2, data: Buffer.from("E\0", "latin1") },
  { tag: 4, type: 5, count: 3, data: Buffer.concat([rational(19, 1), rational(2, 1), rational(3000, 100)]) },
];

const THUMB = Buffer.from("THUMBSECRETJPEGDATA");
const LAT = 47 + 29 / 60 + 50 / 3600;

function cameraBlock(): Buffer {
  return tiff(
    [
      ascii(0x010e, "Old caption"),
      ascii(0x010f, "SecretMaker"),
      ascii(0x0110, "ModelXYZ"),
      ascii(0x0131, "SoftwareABC"),
      ascii(0x013b, "Old Artist"),
      ascii(0x8298, "(c) Old"),
      { tag: 0x0112, type: 3, count: 1, data: Buffer.from([0, 6, 0, 0]) },
      ascii(0x0132, "2024:11:17 04:17:56"),
    ],
    [
      ascii(0x9003, "2024:11:17 04:17:56"),
      ascii(0xa431, "SERIAL123456"),
      ascii(0xa434, "LensModelQ"),
      ascii(0xa430, "OwnerPerson"),
      { tag: 0x927c, type: 7, count: 12, data: Buffer.from("MAKERNOTEDAT", "latin1") },
      { tag: 0xa001, type: 3, count: 1, data: Buffer.from([0, 1, 0, 0]) },
    ],
    gpsEntries(),
    THUMB,
  );
}

const jpegWith = (...segments: Buffer[]) => Buffer.concat([SOI, JFIF, ...segments, SCAN]);
const has = (buf: Buffer, text: string) => buf.includes(Buffer.from(text, "utf8"));

describe("metaTiff", () => {
  it("reads the text fields", () => {
    expect(readTiffText(cameraBlock())).toEqual({ description: "Old caption", author: "Old Artist", copyright: "(c) Old" });
  });

  it("sets, replaces and clears text fields and keeps the rest", async () => {
    const out = editTiff(cameraBlock(), { description: "New caption", author: "", copyright: "(c) New" })!;
    expect(readTiffText(out)).toEqual({ description: "New caption", author: null, copyright: "(c) New" });
    const tags = await exifr.parse(jpegWith(exifSeg(out)), { gps: true, exif: true });
    expect(tags.Make).toBe("SecretMaker");
    expect(tags.Orientation).toBeDefined();
    expect(tags.latitude).toBeCloseTo(LAT, 4);
  });

  it("answers the same block when nothing changes", () => {
    const block = cameraBlock();
    expect(editTiff(block, {})).toBe(block);
  });

  it("takes entries out and zeroes what they held", () => {
    const out = editTiff(cameraBlock(), {}, { main: [0x010f, 0x0110, 0x0131], exif: [0xa431, 0xa434, 0xa430, 0x927c], gps: true, thumbnail: true })!;
    for (const secret of ["SecretMaker", "ModelXYZ", "SoftwareABC", "SERIAL123456", "LensModelQ", "OwnerPerson", "MAKERNOTEDAT", "THUMBSECRET"]) {
      expect(has(out, secret), secret).toBe(false);
    }
    expect(has(out, "2024:11:17 04:17:56")).toBe(true);
  });

  it("refuses a block it cannot read", () => {
    expect(editTiff(Buffer.from("not a tiff block"), { description: "x" })).toBeNull();
  });
});

describe("metaXmp", () => {
  const packet =
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" xmlns:exif="http://ns.adobe.com/exif/1.0/" tiff:Make="SecretMaker" tiff:Orientation="6" exif:GPSLatitude="47,29.8N">' +
    '<dc:description><rdf:Alt><rdf:li xml:lang="x-default">Old &amp; caption</rdf:li></rdf:Alt></dc:description>' +
    "<dc:creator><rdf:Seq><rdf:li>Old Artist</rdf:li></rdf:Seq></dc:creator>" +
    '<xmpMM:History><rdf:Seq><rdf:li rdf:parseType="Resource"><stEvt:action>saved</stEvt:action></rdf:li></rdf:Seq></xmpMM:History>' +
    "<exif:GPSLongitude>19,2.5E</exif:GPSLongitude><exif:DateTimeOriginal>2024-11-17T04:17:56</exif:DateTimeOriginal>" +
    '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';

  it("reads description and creator in their forms", () => {
    expect(readXmpText(packet)).toEqual({ description: "Old & caption", copyright: null, author: "Old Artist" });
    expect(readXmpText('<rdf:Description dc:rights="(c) A"/>').copyright).toBe("(c) A");
  });

  it("sets, replaces and clears, escaping the text", () => {
    const out = setXmpText(packet, { description: 'A <b> & "c"', copyright: "(c) X", author: "" })!;
    expect(readXmpText(out)).toEqual({ description: 'A <b> & "c"', copyright: "(c) X", author: null });
    expect(out).toContain("tiff:Orientation");
    expect(out).toContain("exif:DateTimeOriginal");
  });

  it("declares the namespace when the packet lacks it and refuses a packet it cannot place text in", () => {
    const bare = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="r"><rdf:Description rdf:about=""/></rdf:RDF></x:xmpmeta>';
    const out = setXmpText(bare, { description: "Hello" })!;
    expect(out).toContain("xmlns:dc=");
    expect(readXmpText(out).description).toBe("Hello");
    expect(setXmpText("<nothing/>", { description: "x" })).toBeNull();
    expect(setXmpText("<nothing/>", { description: "" })).toBe("<nothing/>");
  });

  it("builds a packet and strips groups", () => {
    expect(readXmpText(newXmpPacket({ description: "D", author: "A" })!)).toEqual({ description: "D", copyright: null, author: "A" });
    expect(newXmpPacket({ description: "" })).toBeNull();
    const place = stripXmp(packet, { location: true, camera: false, text: false });
    expect(place).not.toContain("GPSLatitude");
    expect(place).not.toContain("GPSLongitude");
    expect(place).not.toContain("xmpMM:History");
    expect(place).toContain("tiff:Make");
    expect(place).toContain("exif:DateTimeOriginal");
    const camera = stripXmp(packet, { location: false, camera: true, text: false });
    expect(camera).not.toContain("tiff:Make");
    expect(camera).toContain("tiff:Orientation");
    expect(camera).toContain("dc:description");
    const text = stripXmp(packet, { location: false, camera: false, text: true });
    expect(text).not.toContain("dc:description");
    expect(text).not.toContain("dc:creator");
  });
});

describe("JPEG description and copyright", () => {
  it("reads from EXIF and XMP, XMP first", () => {
    expect(readTextMeta(jpegWith(exifSeg(cameraBlock())))).toEqual({ description: "Old caption", copyright: "(c) Old", author: "Old Artist" });
    const xmp = newXmpPacket({ description: "From XMP" })!;
    expect(readTextMeta(jpegWith(exifSeg(cameraBlock()), xmpSeg(xmp)))?.description).toBe("From XMP");
  });

  it("writes into a file with no metadata and keeps the picture", async () => {
    const input = jpegWith();
    const out = applyTextMeta(input, { description: "Sunset, Lisbon", copyright: "(c) 2026 Alex", author: "Alex Morgan" })!;
    expect(readTextMeta(out)).toEqual({ description: "Sunset, Lisbon", copyright: "(c) 2026 Alex", author: "Alex Morgan" });
    expect(scanOf(out).equals(SCAN)).toBe(true);
    expect(out.subarray(2, 2 + JFIF.length).equals(JFIF)).toBe(true);
    const tags = await exifr.parse(out);
    expect(tags.ImageDescription).toBe("Sunset, Lisbon");
    expect(tags.Artist).toBe("Alex Morgan");
    expect(tags.Copyright).toBe("(c) 2026 Alex");
  });

  it("replaces existing text in EXIF, XMP and IPTC and leaves the other fields", async () => {
    const dataset = Buffer.concat([Buffer.from([0x1c, 2, 120, 0, 7]), Buffer.from("Old IPT", "latin1")]);
    const head = Buffer.alloc(12);
    head.write("8BIM", 0, "latin1");
    head.writeUInt16BE(0x0404, 4);
    head.writeUInt32BE(dataset.length, 8);
    const iptc = segment(0xed, Buffer.concat([Buffer.from("Photoshop 3.0\0", "latin1"), head, dataset, Buffer.alloc(dataset.length % 2)]));
    const xmp = setXmpText(newXmpPacket({ description: "Old XMP" })!, { author: "Old A" })!;
    const input = jpegWith(exifSeg(cameraBlock()), xmpSeg(xmp), iptc);
    expect(readTextMeta(input)?.description).toBe("Old XMP");
    const out = applyTextMeta(input, { description: "Brand new", author: "" })!;
    expect(readTextMeta(out)).toEqual({ description: "Brand new", copyright: "(c) Old", author: null });
    expect(has(out, "Old XMP")).toBe(false);
    expect(has(out, "Old caption")).toBe(false);
    expect(has(out, "Old IPT")).toBe(false);
    const tags = await exifr.parse(out, { gps: true, exif: true });
    expect(tags.Make).toBe("SecretMaker");
    expect(scanOf(out).equals(SCAN)).toBe(true);
  });

  it("clears every field", () => {
    const input = jpegWith(exifSeg(cameraBlock()), xmpSeg(newXmpPacket({ description: "D", copyright: "C", author: "A" })!));
    const out = applyTextMeta(input, { description: "", copyright: "", author: "" })!;
    expect(readTextMeta(out)).toEqual({ description: null, copyright: null, author: null });
  });

  it("answers the same bytes when the values already match", () => {
    const input = jpegWith(exifSeg(cameraBlock()));
    expect(applyTextMeta(input, { description: "Old caption", copyright: "(c) Old" })).toBe(input);
    expect(neededTextChange({ description: "a", copyright: null, author: null }, { description: "a", author: "" })).toBeNull();
    expect(neededTextChange({ description: "a", copyright: null, author: null }, { description: "b" })).toEqual({ description: "b" });
  });

  it("keeps a real encoder's JPEG decodable and its pixels unchanged", async () => {
    const input = await sharp({ create: { width: 16, height: 12, channels: 3, background: "#c82864" } })
      .jpeg()
      .withExif({ IFD0: { Make: "TestCam" } })
      .toBuffer();
    const out = applyTextMeta(input, { description: "Café", copyright: "© me" })!;
    expect(readTextMeta(out)).toMatchObject({ description: "Café", copyright: "© me" });
    expect((await sharp(out).metadata()).width).toBe(16);
    expect((await sharp(out).raw().toBuffer()).equals(await sharp(input).raw().toBuffer())).toBe(true);
    expect((await exifr.parse(out)).Make).toBe("TestCam");
    expect((await exifr.parse(out)).XResolution).toBeCloseTo((await exifr.parse(input)).XResolution, 3);
  });

  it("refuses a format it cannot write", () => {
    expect(applyTextMeta(Buffer.from("RIFF....WEBPVP8 "), { description: "x" })).toBeNull();
    expect(readTextMeta(Buffer.from("GIF89a.........."))).toBeNull();
  });
});

describe("JPEG strip", () => {
  const xmp =
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="r"><rdf:Description rdf:about="" xmlns:exif="e" xmlns:tiff="t" xmlns:xmpMM="m" xmlns:dc="d" tiff:Make="XmpMaker" tiff:Orientation="6">' +
    "<exif:GPSLatitude>47,29.8N</exif:GPSLatitude><xmpMM:History><rdf:Seq/></xmpMM:History>" +
    '<dc:description><rdf:Alt><rdf:li xml:lang="x-default">Keep or drop</rdf:li></rdf:Alt></dc:description>' +
    "</rdf:Description></rdf:RDF></x:xmpmeta>";
  const ext = segment(0xe1, Buffer.from("http://ns.adobe.com/xmp/extension/\0EXTENDEDXMP", "latin1"));
  const dataset = (tag: number, text: string) => Buffer.concat([Buffer.from([0x1c, 2, tag, 0, text.length]), Buffer.from(text, "latin1")]);
  const iptc = () => {
    const data = Buffer.concat([dataset(90, "Lisbon"), dataset(120, "Sunset caption"), dataset(55, "20240101")]);
    const head = Buffer.alloc(12);
    head.write("8BIM", 0, "latin1");
    head.writeUInt16BE(0x0404, 4);
    head.writeUInt32BE(data.length, 8);
    const thumb = Buffer.concat([Buffer.from("8BIM", "latin1"), Buffer.from([0x04, 0x0c, 0, 0, 0, 0, 0, 4]), Buffer.from("PSTH")]);
    return segment(0xed, Buffer.concat([Buffer.from("Photoshop 3.0\0", "latin1"), head, data, Buffer.alloc(data.length % 2), thumb]));
  };
  const full = () => jpegWith(exifSeg(cameraBlock()), xmpSeg(xmp), ext, iptc(), segment(0xfe, Buffer.from("Place set: 47.1,19.0")));

  it("takes out the place and leaves the camera and the description", async () => {
    const out = applyStrip(full(), { location: true, camera: false, text: false })!;
    expect(out).not.toBeNull();
    for (const gone of ["Lisbon", "47.1,19.0", "THUMBSECRET", "GPSLatitude", "xmpMM:History", "EXTENDEDXMP", "PSTH"]) expect(has(out, gone), gone).toBe(false);
    for (const kept of ["SecretMaker", "SERIAL123456", "Sunset caption", "Old caption", "XmpMaker", "20240101"]) expect(has(out, kept), kept).toBe(true);
    const tags = await exifr.parse(out, { gps: true, exif: true });
    expect(tags.latitude).toBeUndefined();
    expect(tags.Orientation).toBeDefined();
    expect(tags.DateTimeOriginal).toBeInstanceOf(Date);
    expect(scanOf(out).equals(SCAN)).toBe(true);
  });

  it("takes out camera info and keeps the place, the date and the orientation", async () => {
    const out = applyStrip(full(), { location: false, camera: true, text: false })!;
    for (const gone of ["SecretMaker", "ModelXYZ", "SoftwareABC", "SERIAL123456", "LensModelQ", "OwnerPerson", "MAKERNOTEDAT", "XmpMaker", "Old Artist"]) expect(has(out, gone), gone).toBe(false);
    for (const kept of ["Old caption", "(c) Old", "Lisbon", "Sunset caption"]) expect(has(out, kept), kept).toBe(true);
    const tags = await exifr.parse(out, { gps: true, exif: true });
    expect(tags.latitude).toBeCloseTo(LAT, 4);
    expect(tags.Orientation).toBeDefined();
    expect(tags.Make).toBeUndefined();
    expect(tags.DateTimeOriginal).toBeInstanceOf(Date);
  });

  it("takes out the description and copyright when asked", () => {
    const out = applyStrip(full(), { location: false, camera: false, text: true })!;
    for (const gone of ["Old caption", "(c) Old", "Old Artist", "Sunset caption", "Keep or drop"]) expect(has(out, gone), gone).toBe(false);
    expect(readTextMeta(out)).toEqual({ description: null, copyright: null, author: null });
    expect(has(out, "SecretMaker")).toBe(true);
  });

  it("takes out everything private at once and still decodes", async () => {
    const input = await sharp({ create: { width: 16, height: 12, channels: 3, background: "#204080" } })
      .jpeg()
      .withExif({ IFD0: { Make: "RealMaker", Model: "RealModel", ImageDescription: "private note" }, IFD2: { DateTimeOriginal: "2024:11:17 04:17:56" } })
      .toBuffer();
    const out = applyStrip(input, { location: true, camera: true, text: true })!;
    expect(has(out, "RealMaker")).toBe(false);
    expect(has(out, "private note")).toBe(false);
    expect((await exifr.parse(out, { exif: true })).DateTimeOriginal).toBeInstanceOf(Date);
    expect((await sharp(out).raw().toBuffer()).equals(await sharp(input).raw().toBuffer())).toBe(true);
  });

  it("answers the same bytes for a file with nothing to remove, and refuses other formats", () => {
    const clean = jpegWith();
    expect(applyStrip(clean, { location: true, camera: true, text: false })).toBe(clean);
    expect(applyStrip(Buffer.from("RIFF....WEBPVP8 "), { location: true, camera: true, text: true })).toBeNull();
  });
});

describe("PNG", () => {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const text = (k: string, v: string) => chunk("tEXt", Buffer.from(`${k}\0${v}`, "latin1"));

  async function png(extra: Buffer[] = []): Promise<Buffer> {
    const base = await sharp({ create: { width: 6, height: 5, channels: 3, background: "#40a060" } }).png().toBuffer();
    const idat = base.indexOf(Buffer.from("IDAT")) - 4;
    return Buffer.concat([base.subarray(0, idat), ...extra, base.subarray(idat)]);
  }

  it("reads and writes the three fields, keeping the picture", async () => {
    const input = await png([text("Software", "ToolName")]);
    const out = applyTextMeta(input, { description: "Café au lait", copyright: "(c) A", author: "Ann" })!;
    expect(readTextMeta(out)).toEqual({ description: "Café au lait", copyright: "(c) A", author: "Ann" });
    expect((await sharp(out).metadata()).width).toBe(6);
    expect((await sharp(out).raw().toBuffer()).equals(await sharp(input).raw().toBuffer())).toBe(true);
    const again = applyTextMeta(out, { description: "Second", author: "" })!;
    expect(readTextMeta(again)).toEqual({ description: "Second", copyright: "(c) A", author: null });
    expect(has(again, "Café au lait")).toBe(false);
  });

  it("reads an old text chunk and replaces it", async () => {
    const input = await png([text("Description", "legacy"), text("Author", "Old")]);
    expect(readTextMeta(input)).toEqual({ description: "legacy", copyright: null, author: "Old" });
    const out = applyTextMeta(input, { description: "" })!;
    expect(readTextMeta(out)?.description).toBeNull();
    expect(readTextMeta(out)?.author).toBe("Old");
  });

  it("strips camera, text and place from text, XMP and EXIF chunks", async () => {
    const xmp = chunk(
      "iTXt",
      Buffer.concat([
        Buffer.from("XML:com.adobe.xmp\0\0\0\0\0", "latin1"),
        Buffer.from(
          '<x:xmpmeta xmlns:x="a"><rdf:RDF xmlns:rdf="r"><rdf:Description rdf:about="" xmlns:exif="e" xmlns:tiff="t"><exif:GPSLatitude>1,2N</exif:GPSLatitude><tiff:Make>PngMaker</tiff:Make></rdf:Description></rdf:RDF></x:xmpmeta>',
        ),
      ]),
    );
    const exif = chunk("eXIf", cameraBlock());
    const input = await png([text("Software", "ToolName"), text("Title", "My title"), text("Creation Time", "2024-01-01T00:00:00"), xmp, exif]);
    const out = applyStrip(input, { location: true, camera: true, text: true })!;
    for (const gone of ["ToolName", "My title", "GPSLatitude", "PngMaker", "SecretMaker", "THUMBSECRET", "SERIAL123456"]) expect(has(out, gone), gone).toBe(false);
    expect(has(out, "Creation Time")).toBe(true);
    expect((await sharp(out).metadata()).width).toBe(6);
  });

  it("answers the same bytes when a PNG has nothing to remove", async () => {
    const input = await png();
    expect(applyStrip(input, { location: true, camera: true, text: true })).toBe(input);
  });
});

describe("change requests", () => {
  it("accepts the supported media types only", () => {
    expect(canEditMeta("image/jpeg")).toBe(true);
    expect(canEditMeta("image/png; charset=x")).toBe(true);
    for (const t of ["image/heic", "image/webp", "image/gif", "video/mp4", null]) expect(canEditMeta(t)).toBe(false);
  });

  it("cleans what the window sends", () => {
    expect(parseMetaChange({ kind: "text", description: "  hi\r\nthere ", copyright: "", bogus: 1 })).toEqual({ kind: "text", description: "hi\nthere", copyright: "" });
    expect(parseMetaChange({ kind: "text" })).toBeNull();
    expect(parseMetaChange({ kind: "strip", location: true, camera: "yes" })).toEqual({ kind: "strip", location: true, camera: false, text: false });
    expect(parseMetaChange({ kind: "strip" })).toBeNull();
    expect(parseMetaChange(null)).toBeNull();
    expect(parseMetaChange({ kind: "other" })).toBeNull();
    expect((parseMetaChange({ kind: "text", copyright: "x".repeat(900) }) as any).copyright).toHaveLength(500);
  });

  it("applies either kind", () => {
    const input = jpegWith(exifSeg(cameraBlock()));
    expect(readTextMeta(applyMeta(input, { kind: "text", description: "z" })!)?.description).toBe("z");
    expect(applyMeta(input, { kind: "strip", location: true, camera: false, text: false })).not.toBe(input);
  });
});

describe("a large EXIF block and every segment", () => {
  const MAKER = Buffer.from("MKNT".repeat(7500), "latin1");
  const BIG_THUMB = Buffer.from("THMB".repeat(6000), "latin1");
  const exifSegOf = (buf: Buffer) => {
    const at = buf.indexOf(Buffer.from("Exif\0\0", "latin1"));
    return buf.subarray(at - 4, at - 2 + buf.readUInt16BE(at - 2));
  };

  /** A block just under the size a JPEG segment can hold, with a maker note, a place and a thumbnail. */
  function bigBlock(): Buffer {
    const build = (pad: number) =>
      tiff(
        [ascii(0x010e, "Big caption"), ascii(0x010f, "SecretMaker"), ascii(0x013b, "Some Artist")],
        [ascii(0x9003, "2024:11:17 04:17:56"), ascii(0xa431, "SERIAL123456"), { tag: 0x927c, type: 7, count: MAKER.length, data: MAKER }],
        gpsEntries(),
        Buffer.concat([BIG_THUMB, Buffer.alloc(pad, 0x55)]),
      );
    return build(0xffff - 8 - 1 - build(0).length);
  }

  it("strips a block near the segment limit without growing it, keeping the maker note in place when it stays", async () => {
    const input = jpegWith(exifSeg(bigBlock()));
    expect(exifSegOf(input).length).toBeGreaterThan(0xffff - 4);

    const text = applyStrip(input, { location: false, camera: false, text: true })!;
    expect(text).not.toBeNull();
    const seg = exifSegOf(text);
    expect(seg.length).toBeLessThan(exifSegOf(input).length - BIG_THUMB.length);
    expect(has(text, "Big caption")).toBe(false);
    expect(seg.indexOf(Buffer.from("MKNTMKNT"))).toBe(exifSegOf(input).indexOf(Buffer.from("MKNTMKNT")));
    expect(has(text, "THMB")).toBe(false);
    const tags = await exifr.parse(text, { gps: true, exif: true });
    expect(tags.latitude).toBeCloseTo(LAT, 4);
    expect(tags.DateTimeOriginal).toBeInstanceOf(Date);

    const place = applyStrip(input, { location: true, camera: false, text: false })!;
    expect(place).not.toBeNull();
    expect(has(place, "MKNT")).toBe(false);
    expect(has(place, "SecretMaker")).toBe(true);
    expect((await exifr.parse(place, { gps: true })).latitude).toBeUndefined();

    const all = applyStrip(input, { location: true, camera: true, text: true })!;
    for (const gone of ["MKNT", "THMB", "SecretMaker", "SERIAL123456", "Some Artist"]) expect(has(all, gone), gone).toBe(false);
    expect((await exifr.parse(all, { exif: true })).DateTimeOriginal).toBeInstanceOf(Date);
  });

  it("refuses rather than drop a pointer to a place or a thumbnail it cannot erase", () => {
    const block = cameraBlock();
    const count = block.readUInt16BE(8);
    let gpsAt = -1;
    for (let i = 0; i < count; i++) if (block.readUInt16BE(10 + i * 12) === 0x8825) gpsAt = 10 + i * 12 + 8;
    const badGps = Buffer.from(block);
    badGps.writeUInt32BE(block.length + 100, gpsAt);
    expect(editTiff(badGps, {}, { gps: true })).toBeNull();
    expect(applyStrip(jpegWith(exifSeg(badGps)), { location: true, camera: false, text: false })).toBeNull();
    expect(editTiff(badGps, {}, { main: [0x010f] })).not.toBeNull();

    const badThumb = Buffer.from(block);
    badThumb.writeUInt32BE(block.length + 100, 10 + count * 12);
    expect(editTiff(badThumb, {}, { thumbnail: true })).toBeNull();
  });

  it("strips every EXIF and XMP segment, not only the first", () => {
    const xmp = (n: number) =>
      `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="r"><rdf:Description rdf:about="" xmlns:exif="e"><exif:GPSLatitude>4${n},1N</exif:GPSLatitude></rdf:Description></rdf:RDF></x:xmpmeta>`;
    const input = jpegWith(exifSeg(cameraBlock()), xmpSeg(xmp(1)), exifSeg(cameraBlock()), xmpSeg(xmp(2)));
    const out = applyStrip(input, { location: true, camera: false, text: false })!;
    for (const gone of ["GPSLatitude", "THUMBSECRET", "MAKERNOTEDAT"]) expect(has(out, gone), gone).toBe(false);
    expect(out.toString("latin1").split("SecretMaker").length - 1).toBe(2);
  });

  it("writes the text into every EXIF segment", () => {
    const input = jpegWith(exifSeg(cameraBlock()), exifSeg(cameraBlock()));
    const out = applyTextMeta(input, { description: "Fresh" })!;
    expect(has(out, "Old caption")).toBe(false);
    expect(out.toString("latin1").split("Fresh").length - 1).toBe(3);
  });
});

describe("hostile metadata", () => {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  async function png(extra: Buffer[]): Promise<Buffer> {
    const base = await sharp({ create: { width: 6, height: 5, channels: 3, background: "#40a060" } }).png().toBuffer();
    const idat = base.indexOf(Buffer.from("IDAT")) - 4;
    return Buffer.concat([base.subarray(0, idat), ...extra, base.subarray(idat)]);
  }
  const ztxt = (key: string, body: Buffer) => chunk("zTXt", Buffer.concat([Buffer.from(`${key}\0\0`, "latin1"), deflateSync(body)]));

  it("never inflates a PNG text chunk past its cap", async () => {
    const bomb = ztxt("Description", Buffer.alloc(PNG_TEXT_MAX_BYTES * 8, 0x41));
    expect(bomb.length).toBeLessThan(100_000);
    const input = await png([bomb, ztxt("Author", Buffer.from("Ann"))]);
    expect(readTextMeta(input)).toEqual({ description: null, copyright: null, author: "Ann" });
  });

  it("refuses to strip a PNG whose XMP is too large to handle", async () => {
    const huge = chunk("iTXt", Buffer.concat([Buffer.from("XML:com.adobe.xmp\0\0\0\0\0", "latin1"), Buffer.alloc(XMP_MAX_CHARS + 10, 0x20)]));
    expect(applyStrip(await png([huge]), { location: true, camera: false, text: false })).toBeNull();
  });

  it("reads and strips unclosed tags in one pass, and handles no packet larger than the cap", () => {
    const opens = "<dc:description>".repeat(150_000);
    const spaces = " ".repeat(2_000_000);
    const started = Date.now();
    expect(readXmpText(`<x>${opens}</x>`).description).toBeNull();
    expect(readXmpText(`<x${spaces}dc:rights="(c) B"/>`).copyright).toBe("(c) B");
    expect(stripXmp(`<x>${opens}<exif:GPSLatitude>1N`, { location: true, camera: true, text: true })).toContain("<dc:description>");
    expect(stripXmp(`<x${spaces}dc:rights="(c) B"/>`, { location: false, camera: false, text: true })).toBe("<x/>");
    expect(readXmpText(`<x><dc:creator>${"<rdf:li>".repeat(150_000)}</dc:creator>`).author).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);

    const big = `<rdf:Description dc:rights="(c) A">${" ".repeat(XMP_MAX_CHARS)}</rdf:Description>`;
    expect(readXmpText(big).copyright).toBeNull();
    expect(setXmpText(big, { copyright: "x" })).toBeNull();
    expect(stripXmp(big, { location: true, camera: false, text: false })).toBeNull();
  });
});
