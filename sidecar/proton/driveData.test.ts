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

import "@protontech/crypto/polyfill";
import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { CryptoProxy, initCrypto } from "./crypto.ts";
import {
  copyPresent,
  facesFileDevice,
  labelsFileDevice,
  listDriveBackups,
  loadDriveData,
  otherFaceCopies,
  mergeCollections,
  openEnvelope,
  readFacesSnapshot,
  readLabelCopy,
  readLabelsSnapshot,
  readFaceCopy,
  readSearchSnapshot,
  saveCopy,
  searchFileDevice,
  verifyFaceCopy,
  verifySearchCopy,
  writeFaceCopy,
  writeLabelCopy,
  writeSearchCopy,
  type CopyCache,
  type FaceCopyToWrite,
} from "./driveData.ts";

/** Seals `plain` the way the Android app's MlSnapshotEnvelope does, chunk by chunk. */
async function seal(plain: Buffer, key: any, chunkSize = 64): Promise<Buffer> {
  const sessionKey = await CryptoProxy.generateSessionKey({ recipientKeys: [key] } as any);
  const wrapped = Buffer.from(
    (await CryptoProxy.encryptSessionKey({ ...sessionKey, encryptionKeys: [key], format: "binary" } as any)) as unknown as Uint8Array,
  );
  const ints = Buffer.alloc(12);
  ints.writeInt32BE(1, 0);
  ints.writeInt32BE(chunkSize, 4);
  ints.writeInt32BE(wrapped.length, 8);
  const header = Buffer.concat([Buffer.from("PPMLSEAL", "ascii"), ints, wrapped]);
  const parts: Buffer[] = [header];
  const hashes: Buffer[] = [];
  for (let at = 0; at < plain.length; at += chunkSize) {
    const { message } = (await CryptoProxy.encryptMessage({
      binaryData: plain.subarray(at, at + chunkSize),
      sessionKey,
      format: "binary",
    } as any)) as any;
    const cipher = Buffer.from(message as Uint8Array);
    const len = Buffer.alloc(5);
    len.writeUInt8(1, 0);
    len.writeInt32BE(cipher.length, 1);
    parts.push(len, cipher);
    hashes.push(createHash("sha256").update(cipher).digest());
  }
  const count = Buffer.alloc(4);
  count.writeInt32BE(hashes.length, 0);
  const manifest = Buffer.concat([Buffer.from("eu.akoos.photos.mlsync.envelope", "ascii"), header, count, ...hashes]);
  const signature = Buffer.from(
    (await CryptoProxy.signMessage({ binaryData: manifest, signingKeys: [key], detached: true } as any)) as string,
    "utf8",
  );
  const trailer = Buffer.alloc(5);
  trailer.writeUInt8(2, 0);
  trailer.writeInt32BE(hashes.length, 1);
  const sigLen = Buffer.alloc(4);
  sigLen.writeInt32BE(signature.length, 0);
  parts.push(trailer, ...hashes, sigLen, signature);
  return Buffer.concat(parts);
}

/** A version-4 face snapshot, written field by field as the Android app's MlSnapshotWriter does. */
class SnapshotWriter {
  private parts: Buffer[] = [];
  u8(v: number) {
    this.parts.push(Buffer.from([v]));
    return this;
  }
  u32(v: number) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0, 0);
    this.parts.push(b);
    return this;
  }
  i64(v: number) {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(v), 0);
    this.parts.push(b);
    return this;
  }
  f32(v: number) {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v, 0);
    this.parts.push(b);
    return this;
  }
  str(s: string) {
    const bytes = Buffer.from(s, "utf8");
    const len = Buffer.alloc(2);
    len.writeUInt16LE(bytes.length, 0);
    this.parts.push(len, bytes);
    return this;
  }
  raw(bytes: Buffer) {
    this.parts.push(bytes);
    return this;
  }
  done() {
    return Buffer.concat(this.parts);
  }
}

const NONE = 0xffffffff;
const DIM = 3;

function face(w: SnapshotWriter, key: number, index: number, flags: number, person: number, confirmed = NONE) {
  w.u8(0x03).u32(key).u32(index);
  for (let i = 0; i < 6; i++) w.f32(0.5);
  w.u8(flags).u32(person).u32(confirmed).u8(1).f32(1).f32(2);
  for (let i = 0; i < DIM; i++) w.f32(0.1);
}

/**
 * Keys: k0..k4. People: Anna (0), Bence (1). Anna is on k0 and k1; her face on k2 was removed
 * from People; she is marked "not this person" on k3's face; k4 was attached to her by hand.
 * Bence's only face is confirmed by hand rather than grouped.
 */
function facesSnapshot(): Buffer {
  const s = new SnapshotWriter();
  s.u32(4).u8(1).str("3f2a1b4c-0000-4000-8000-000000000001").str("Pixel 8").i64(1_700_000_000_000);
  s.u32(2).str("abc").u32(1).u32(DIM);
  s.u32(5).u32(2).u32(5).u32(1).u32(1).u32(1).u32(1);
  for (const k of ["k0", "k1", "k2", "k3", "k4"]) s.u8(0x01).str(k);
  s.u8(0x02).str("Anna").u8(0x02).str("Bence");
  face(s, 0, 0, 0, 0);
  face(s, 1, 0, 0, 0);
  face(s, 2, 0, 0x01, 0);
  face(s, 3, 1, 0, 0);
  face(s, 3, 0, 0, NONE, 1);
  s.u8(0x04).u32(0).u32(4); // manual photo: Anna on k4
  s.u8(0x05).u32(0).u32(3).u32(1); // not Anna: k3#1
  s.u8(0x06).u32(0).u32(1); // Anna's cover: k1
  s.u8(0x07).u32(0).u8(0);
  s.u8(0xff);
  return Buffer.concat([Buffer.from("PPMLSNAP", "ascii"), s.done()]);
}

let key: any;
let otherKey: any;

beforeAll(async () => {
  initCrypto();
  key = await CryptoProxy.generateKey({ userIDs: [{ name: "Owner", email: "owner@example.com" }] } as any);
  otherKey = await CryptoProxy.generateKey({ userIDs: [{ name: "Other", email: "other@example.com" }] } as any);
}, 30_000);

describe("the envelope the Android app writes", () => {
  it("opens, in several chunks, with the account's key", async () => {
    const plain = Buffer.from("x".repeat(200) + "the end");
    const opened = await openEnvelope(await seal(plain, key), [key], [key]);
    expect(opened).toEqual({ ok: true, plain });
  });

  it("tries the next key when the first one is not the owner", async () => {
    const plain = Buffer.from("labels");
    const opened = await openEnvelope(await seal(plain, key), [otherKey, key], [key]);
    expect(opened).toEqual({ ok: true, plain });
  });

  it("refuses another account's file", async () => {
    const opened = await openEnvelope(await seal(Buffer.from("x"), key), [otherKey], [otherKey]);
    expect(opened).toEqual({ ok: false, reason: "wrong-key" });
  });

  it("refuses a file changed after it was signed, or cut short", async () => {
    const file = await seal(Buffer.from("y".repeat(150)), key);
    const changed = Buffer.from(file);
    changed[changed.length - 600] ^= 0x01;
    expect((await openEnvelope(changed, [key], [key])).ok).toBe(false);
    expect((await openEnvelope(file.subarray(0, file.length - 10), [key], [key])).ok).toBe(false);
  });

  it("refuses a file signed by someone else", async () => {
    const opened = await openEnvelope(await seal(Buffer.from("z"), key), [key], [otherKey]);
    expect(opened).toEqual({ ok: false, reason: "damaged" });
  });

  it("says when it is not an envelope at all", async () => {
    expect(await openEnvelope(Buffer.from("{}"), [key], [key])).toEqual({ ok: false, reason: "not-envelope" });
  });
});

describe("the people of a face snapshot", () => {
  it("are the grouped faces, less the removed and the not-them, plus the photos added by hand", () => {
    const snap = readFacesSnapshot(facesSnapshot());
    expect(snap.deviceLabel).toBe("Pixel 8");
    const anna = snap.people.find((p) => p.name === "Anna")!;
    expect([...anna.keys].sort()).toEqual(["k0", "k1", "k4"]);
    expect(anna.cover).toBe("k1");
    expect(anna.box).toEqual([0.5, 0.5, 0.5, 0.5]);
    const bence = snap.people.find((p) => p.name === "Bence")!;
    expect([...bence.keys]).toEqual(["k3"]);
    // No cover picked on the phone: the clearest face's photo, with its box.
    expect(bence.cover).toBe("k3");
    expect(bence.box).not.toBeNull();
  });

  it("refuses a file cut short or of another version", () => {
    const whole = facesSnapshot();
    expect(() => readFacesSnapshot(whole.subarray(0, whole.length - 1))).toThrow();
    for (const version of [3, 7]) {
      const other = Buffer.from(whole);
      other.writeUInt32LE(version, 8);
      expect(() => readFacesSnapshot(other)).toThrow(`face snapshot version ${version}`);
    }
  });
});

/** The body of the phone's golden face snapshot from the counts on, the same in versions 5 and 6. */
const GOLDEN_V5_BODY = `
02 00 00 00  02 00 00 00  01 00 00 00  01 00 00 00  01 00 00 00  01 00 00 00  01 00 00 00  01 00 00 00  02 00 00 00
01 02 00 6B 31   01 02 00 6B 32
02 03 00 41 6E 6E 05 00 00 00 00 00 00 00
02 04 00 5A 6F C3 AB 00 00 00 00 00 00 00 00
09 02 00 41 6C 03 00 41 6E 6E 08 00 00 00 00 00 00 00
0A 01 03 00 41 6E 6E 02 00 6B 33 00 00 00 00 0A 00 00 00 00 00 00 00
03 00 00 00 00 01 00 00 00 00 00 80 3E 00 00 00 3F 00 00 40 3F 00 00 80 3F 00 00 60 3F 00 00 00 40 02
   00 00 00 00 FF FF FF FF 01 00 00 80 3F 00 00 00 40 00 00 80 3F 00 00 80 BF
04 01 00 00 00 01 00 00 00 06 00 00 00 00 00 00 00
05 00 00 00 00 00 00 00 00 01 00 00 00 07 00 00 00 00 00 00 00
06 00 00 00 00 00 00 00 00 09 00 00 00 00 00 00 00
07 00 00 00 00 00   07 01 00 00 00 01
FF`;

/** The phone's golden face snapshot, version 6: the same bytes its format test pins. */
const GOLDEN_V6 = `
50 50 4D 4C 53 4E 41 50  06 00 00 00  01  02 00 64 31  05 00 50 68 6F 6E 65  08 07 06 05 04 03 02 01
07 00 00 00  02 00 61 62  01 00 00 00  02 00 00 00
0B 00 00 00 00 00 00 00
${GOLDEN_V5_BODY}`;

/** The same file as version 5: no time of a delete everywhere in the header. */
const GOLDEN_V5 = `
50 50 4D 4C 53 4E 41 50  05 00 00 00  01  02 00 64 31  05 00 50 68 6F 6E 65  08 07 06 05 04 03 02 01
07 00 00 00  02 00 61 62  01 00 00 00  02 00 00 00
${GOLDEN_V5_BODY}`;

/** The same file as version 4: 7 counts, people and curation without a time, no name changes or removals. */
const GOLDEN_V4 = `
50 50 4D 4C 53 4E 41 50  04 00 00 00  01  02 00 64 31  05 00 50 68 6F 6E 65  08 07 06 05 04 03 02 01
07 00 00 00  02 00 61 62  01 00 00 00  02 00 00 00
02 00 00 00  02 00 00 00  01 00 00 00  01 00 00 00  01 00 00 00  01 00 00 00  02 00 00 00
01 02 00 6B 31   01 02 00 6B 32
02 03 00 41 6E 6E
02 04 00 5A 6F C3 AB
03 00 00 00 00 01 00 00 00 00 00 80 3E 00 00 00 3F 00 00 40 3F 00 00 80 3F 00 00 60 3F 00 00 00 40 02
   00 00 00 00 FF FF FF FF 01 00 00 80 3F 00 00 00 40 00 00 80 3F 00 00 80 BF
04 01 00 00 00 01 00 00 00
05 00 00 00 00 00 00 00 00 01 00 00 00
06 00 00 00 00 00 00 00 00
07 00 00 00 00 00   07 01 00 00 00 01
FF`;

const hex = (text: string) => Buffer.from(text.replace(/\s+/g, ""), "hex");

describe("the face copy, version 6", () => {
  it("is written in the phone's golden byte layout, and reads back", () => {
    const written = writeFaceCopy({
      deviceId: "d1",
      deviceLabel: "Phone",
      // The golden time is past what a double holds exactly; the writer takes it whole.
      createdAt: 0x0102030405060708n as unknown as number,
      faceModelVersion: 7,
      faceModelSha256: "ab",
      clusterParamsVersion: 1,
      embeddingDim: 2,
      facesWipedAt: 11,
      faces: [
        {
          key: "k1",
          index: 1,
          box: [0.25, 0.5, 0.75, 1],
          score: 0.875,
          blur: 2,
          rejected: false,
          person: "Ann",
          confirmed: null,
          points: [1, 2],
          embedding: new Float32Array([1, -1]),
        },
      ],
      manual: [{ name: "Zoë", key: "k2", at: 6 }],
      notPerson: [{ name: "Ann", key: "k1", index: 1, at: 7 }],
      covers: [{ name: "Ann", key: "k1", at: 9 }],
      namedAt: (name) => (name === "Ann" ? 5 : 0),
      nameChanges: [{ from: "Al", to: "Ann", at: 8 }],
      removals: [{ kind: 1, name: "Ann", key: "k3", index: 0, at: 10 }],
      markers: [
        { key: "k1", swept: false },
        { key: "k2", swept: true },
      ],
    });
    expect(written.toString("hex")).toBe(hex(GOLDEN_V6).toString("hex"));
    const { copy } = readFaceCopy(hex(GOLDEN_V6));
    expect(copy.deviceId).toBe("d1");
    expect(copy.facesWipedAt).toBe(11);
    expect(copy.namedAt).toEqual(new Map([["Ann", 5], ["Zoë", 0]]));
    expect(copy.nameChanges).toEqual([{ from: "Al", to: "Ann", at: 8 }]);
    expect(copy.faces[0]).toMatchObject({ key: "k1", index: 1, person: "Ann", confirmed: null, blur: 2, points: [1, 2] });
    expect(copy.removals).toEqual([{ kind: 1, name: "Ann", key: "k3", index: 0, at: 10 }]);
    expect(copy.notPerson).toEqual([{ name: "Ann", key: "k1", index: 1, at: 7 }]);
    expect(copy.covers).toEqual(new Map([["Ann", "k1"]]));
    expect(copy.coverSetAt).toEqual(new Map([["Ann", 9]]));
    expect(copy.scanned).toEqual(["k1", "k2"]);
  });

  it("still reads version 5, as written before any delete everywhere", () => {
    const v5 = readFaceCopy(hex(GOLDEN_V5)).copy;
    const v6 = readFaceCopy(hex(GOLDEN_V6)).copy;
    expect(v5.facesWipedAt).toBe(0);
    expect({ ...v5, facesWipedAt: 11 }).toEqual(v6);
  });

  it("refuses a negative delete time", () => {
    const bad = hex(GOLDEN_V6);
    bad.writeBigInt64LE(-1n, hex(GOLDEN_V6).indexOf(Buffer.from([0x0b, 0, 0, 0, 0, 0, 0, 0])));
    expect(() => readFaceCopy(bad)).toThrow("a negative delete time");
  });

  it("still reads version 4, as people named at no known time and no changes", () => {
    const { copy, snapshot } = readFaceCopy(hex(GOLDEN_V4));
    expect(copy.facesWipedAt).toBe(0);
    expect(copy.namedAt).toEqual(new Map([["Ann", 0], ["Zoë", 0]]));
    expect(copy.nameChanges).toEqual([]);
    expect(copy.removals).toEqual([]);
    expect(copy.notPerson).toEqual([{ name: "Ann", key: "k1", index: 1, at: 0 }]);
    expect(copy.coverSetAt).toEqual(new Map([["Ann", 0]]));
    expect(copy.faces).toHaveLength(1);
    // Ann's one face is marked as not her; Zoë is on the photo added by hand.
    expect(snapshot.people.map((p) => p.name)).toEqual(["Zoë"]);
  });

  it("refuses a negative change time and a removal of an unknown kind", () => {
    const bad = hex(GOLDEN_V5);
    const at = bad.indexOf(Buffer.from([0x09, 0x02, 0x00, 0x41, 0x6c])) + 11;
    bad.writeBigInt64LE(-1n, at);
    expect(() => readFaceCopy(bad)).toThrow("a negative change time");
    const kind = hex(GOLDEN_V5);
    kind[kind.indexOf(Buffer.from([0x0a, 0x01, 0x03, 0x00])) + 1] = 4;
    expect(() => readFaceCopy(kind)).toThrow("a removal of kind 4");
  });
});

describe("the labels of a label snapshot", () => {
  it("are read per label, without the keys that name a photo on one phone only", () => {
    const snap = readLabelsSnapshot(
      Buffer.from(
        JSON.stringify({
          v: 1,
          d: "x",
          n: "Pixel 8",
          c: 5,
          p: [
            { k: "k0", l: ["Beach", "Summer"] },
            { k: "content://media/external/images/1", l: ["Beach"] },
            { k: "k1", l: ["Beach"] },
          ],
          m: ["Empty"],
        }),
      ),
    );
    expect([...snap.labels.keys()]).toEqual(["Beach", "Summer"]);
    expect([...snap.labels.get("Beach")!]).toEqual(["k0", "k1"]);
  });
});

describe("a label copy", () => {
  it("reads a copy without change times as changed at no known time", () => {
    const copy = readLabelCopy(
      Buffer.from(JSON.stringify({ v: 1, d: "dev", n: "Pixel", c: 50, p: [{ k: "k0", l: [" Beach "] }], m: ["Empty"] })),
    );
    expect(copy.photos).toEqual([{ key: "k0", labels: ["Beach"], changedAt: 0 }]);
    expect(copy.names).toEqual([{ name: "Empty", changedAt: 0 }]);
    expect(copy.deleted).toEqual([]);
  });

  it("is written with the fields the phone reads, and the change times beside them", () => {
    const copy = {
      deviceId: "dev",
      deviceLabel: "Desk",
      createdAt: 90,
      photos: [
        { key: "k0", labels: ["Beach", "Summer"], changedAt: 70 },
        { key: "k1", labels: [], changedAt: 80 },
      ],
      names: [{ name: "Later", changedAt: 60 }],
      deleted: [{ name: "Old", at: 85 }],
    };
    const bytes = writeLabelCopy(copy);
    const json = JSON.parse(bytes.toString("utf8"));
    expect(json).toMatchObject({ v: 1, d: "dev", n: "Desk", c: 90, m: ["Later"] });
    expect(json.p[0]).toEqual({ k: "k0", l: ["Beach", "Summer"], t: 70 });
    expect(readLabelCopy(bytes)).toEqual(copy);
    expect([...readLabelsSnapshot(bytes).labels.keys()]).toEqual(["Beach", "Summer"]);
  });
});

describe("several devices' copies", () => {
  it("make one entry per name, case and accents aside, newest spelling first", () => {
    const merged = mergeCollections([
      { createdAt: 1, entries: [{ name: "andras", keys: ["a"], cover: "a" }] },
      { createdAt: 2, entries: [{ name: "András", keys: ["b"] }, { name: "Bea", keys: ["c", "d", "e"] }] },
    ]);
    expect(merged).toEqual([
      { name: "Bea", keys: ["c", "d", "e"], cover: null, box: null },
      { name: "András", keys: ["b", "a"], cover: "a", box: null },
    ]);
  });
});

describe("the file names", () => {
  it("name the writing install, and nothing else is taken", () => {
    const id = "3f2a1b4c-0000-4000-8000-000000000001";
    expect(facesFileDevice(`faces-${id}.pfpml`)).toBe(id);
    expect(facesFileDevice(`search-${id}.pfpml`)).toBeNull();
    expect(labelsFileDevice(`labels-${id}.pfplb`)).toBe(id);
    expect(labelsFileDevice("labels-x.pfplb")).toBeNull();
    expect(searchFileDevice(`search-${id}.pfpml`)).toBe(id);
    expect(searchFileDevice(`faces-${id}.pfpml`)).toBeNull();
  });
});

/** Half-precision patterns of the few values the search snapshot below holds. */
const HALF: Record<number, number> = { 0: 0x0000, 1: 0x3c00, 0.5: 0x3800 };

/**
 * A version-4 search snapshot as the Android app writes it: keys k0, k1, k2, a device key and
 * k3; a vector for k0, k1 and the device key, and a tombstone for k2.
 */
function searchSnapshot(modelId = "space-a", dim = 4): Buffer {
  const s = new SnapshotWriter();
  s.u32(4).u8(2).str("3f2a1b4c-0000-4000-8000-000000000001").str("Pixel 8").i64(1_700_000_000_000);
  s.str(modelId).u32(dim).u32(5).u32(4);
  for (const k of ["k0", "k1", "k2", "content://media/1", "k3"]) s.u8(0x01).str(k);
  const vec = (at: number, values: number[]) => {
    s.u8(0x08).u32(at).u8(0);
    const b = Buffer.alloc(dim * 2);
    values.forEach((v, i) => b.writeUInt16LE(HALF[v], i * 2));
    s.raw(b);
  };
  vec(0, [1, 0, 0, 0]);
  vec(1, [0, 1, 0, 0]);
  s.u8(0x08).u32(2).u8(0x01);
  vec(3, [0.5, 0.5, 0.5, 0.5]);
  s.u8(0xff);
  return Buffer.concat([Buffer.from("PPMLSNAP", "ascii"), s.done()]);
}

describe("a search snapshot", () => {
  it("brings each readable photo's vector, without tombstones or keys of one phone only", () => {
    const snap = readSearchSnapshot(searchSnapshot());
    expect(snap.modelId).toBe("space-a");
    expect(snap.dim).toBe(4);
    expect(snap.keys).toEqual(["k0", "k1"]);
    expect([...snap.vectors]).toEqual([0x3c00, 0, 0, 0, 0, 0x3c00, 0, 0]);
  });

  it("refuses a header that claims more vectors than the file holds, before allocating them", () => {
    const s = new SnapshotWriter();
    s.u32(4).u8(2).str("d").str("Pixel").i64(0).str("space-a").u32(512).u32(1).u32(4_000_000_000);
    s.u8(0x01).str("k0").u8(0xff);
    expect(() => readSearchSnapshot(Buffer.concat([Buffer.from("PPMLSNAP", "ascii"), s.done()]))).toThrow(
      /more vectors/,
    );
  });

  it("is written the way it is read, a photo that could not be read as a tombstone", () => {
    const one = new Uint16Array([0x3c00, 0, 0, 0x3800]);
    const bytes = writeSearchCopy({
      deviceId: "0f0e0d0c-0b0a-4908-8706-050403020100",
      deviceLabel: "Desk",
      createdAt: 1234,
      modelId: "space-a",
      dim: 4,
      entries: [
        ["k0", one],
        ["k1", null],
        ["content://media/1", one],
      ],
    });
    // Version 5 changed only the face copy: a search copy stays at 4.
    expect(bytes.readUInt32LE(8)).toBe(4);
    const snap = readSearchSnapshot(bytes);
    expect(snap.deviceId).toBe("0f0e0d0c-0b0a-4908-8706-050403020100");
    expect([snap.deviceLabel, snap.createdAt, snap.modelId, snap.dim]).toEqual(["Desk", 1234, "space-a", 4]);
    expect(snap.keys).toEqual(["k0"]);
    expect([...snap.vectors]).toEqual([...one]);
  });

  it("refuses a face snapshot and a file cut short", () => {
    expect(() => readSearchSnapshot(facesSnapshot())).toThrow();
    const whole = searchSnapshot();
    expect(() => readSearchSnapshot(whole.subarray(0, whole.length - 3))).toThrow();
  });
});

/** A stand-in for the My files client: the app folder with its ML data and Labels folders. */
function fakeDrive(files: { uid: string; name: string; revision: string; bytes: Buffer; at?: number; trashed?: boolean }[]) {
  const node = (uid: string, name: string, type: string, revision = "", at = 0, trashed = false) => ({
    uid,
    type,
    name: { ok: true, value: name },
    activeRevision: { ok: true, value: { uid: revision } },
    modificationTime: new Date(at),
    trashTime: trashed ? new Date(1) : undefined,
  });
  const fileNode = (f: (typeof files)[number]) => node(f.uid, f.name, "file", f.revision, f.at, f.trashed);
  const downloads: string[] = [];
  const children: Record<string, any[]> = {
    root: [node("app", "Photos for Proton", "folder")],
    app: [node("ml", "ML data", "folder"), node("labels", "Labels", "folder"), node("hidden", "Hidden", "folder")],
    ml: files.filter((f) => !f.name.startsWith("labels") && !f.name.startsWith("hidden")).map(fileNode),
    labels: files.filter((f) => f.name.startsWith("labels")).map(fileNode),
    hidden: files.filter((f) => f.name.startsWith("hidden")).map(fileNode),
  };
  const client = {
    getMyFilesRootFolder: async () => ({ uid: "root" }),
    async *iterateFolderChildren(uid: string) {
      yield* children[uid] ?? [];
    },
    getFileDownloader: async (uid: string) => ({
      downloadToStream(sink: WritableStream<Uint8Array>) {
        downloads.push(uid);
        const bytes = files.find((f) => f.uid === uid)!.bytes;
        return {
          completion: async () => {
            const w = sink.getWriter();
            await w.write(new Uint8Array(bytes));
            await w.close();
          },
        };
      },
    }),
  };
  return { client, downloads };
}

function memoryCache(): CopyCache & { entries: Map<string, { revision: string; bytes: Buffer }> } {
  const entries = new Map<string, { revision: string; bytes: Buffer }>();
  return {
    entries,
    get: (uid, revision) => (entries.get(uid)?.revision === revision ? entries.get(uid)!.bytes : null),
    put: (uid, revision, bytes) => void entries.set(uid, { revision, bytes }),
    keepOnly: (uids) => {
      for (const uid of [...entries.keys()]) if (!uids.has(uid)) entries.delete(uid);
    },
  };
}

describe("reading the phone's copies", () => {
  const id = "3f2a1b4c-0000-4000-8000-000000000001";
  const other = "3f2a1b4c-0000-4000-8000-000000000002";
  const labelCopy = (label: string) => Buffer.from(JSON.stringify({ v: 1, d: id, n: label, c: 5, p: [{ k: "k0", l: ["Beach"] }], m: [] }));
  const account = () => ({ getOwnAddresses: async () => [{ keys: [{ key }], primaryKeyIndex: 0 }] });

  it("downloads a copy once, and again only when its revision on Drive changes", async () => {
    const files = [{ uid: "s1", name: `search-${id}.pfpml`, revision: "r1", bytes: await seal(searchSnapshot(), key) }];
    const cache = memoryCache();
    const kinds = { faces: false, labels: false, search: true };
    const drive = fakeDrive(files);
    const first = await loadDriveData(drive.client, account(), kinds, cache, "space-a");
    expect(first.search.map((c) => c.keys)).toEqual([["k0", "k1"]]);
    await loadDriveData(drive.client, account(), kinds, cache, "space-a");
    expect(drive.downloads).toEqual(["s1"]);
    files[0].revision = "r2";
    const changed = fakeDrive(files);
    await loadDriveData(changed.client, account(), kinds, cache, "space-a");
    expect(changed.downloads).toEqual(["s1"]);
    expect(cache.entries.get("s1")?.revision).toBe("r2:0");
  }, 30_000);

  it("reads only the kinds asked for, and counts a search copy of another model apart", async () => {
    const files = [
      { uid: "f1", name: `faces-${id}.pfpml`, revision: "r", bytes: await seal(facesSnapshot(), key) },
      { uid: "s1", name: `search-${id}.pfpml`, revision: "r", bytes: await seal(searchSnapshot("space-b"), key) },
    ];
    const drive = fakeDrive(files);
    const onlyFaces = await loadDriveData(drive.client, account(), { faces: true, labels: false, search: false }, null, "space-a");
    expect(drive.downloads).toEqual(["f1"]);
    expect(onlyFaces.people.map((p) => p.name).sort()).toEqual(["Anna", "Bence"]);
    const both = await loadDriveData(fakeDrive(files).client, account(), { faces: true, labels: false, search: true }, null, "space-a");
    expect(both.search).toEqual([]);
    expect(both.searchOtherModel).toBe(1);
  }, 30_000);

  it("passes over files in the trash and those moved there from here", async () => {
    const files = [
      { uid: "s1", name: `search-${id}.pfpml`, revision: "r", bytes: await seal(searchSnapshot(), key), trashed: true },
      { uid: "s2", name: `search-${other}.pfpml`, revision: "r", bytes: await seal(searchSnapshot(), key) },
    ];
    const drive = fakeDrive(files);
    const data = await loadDriveData(drive.client, account(), { faces: false, labels: false, search: true, trashed: new Set(["s2"]) }, null, "space-a");
    expect(data.search).toEqual([]);
    expect(drive.downloads).toEqual([]);
  });

  it("reads this install's own files back only when asked, and says whether all of them were", async () => {
    const files = [
      { uid: "f1", name: `faces-${id}.pfpml`, revision: "r", bytes: await seal(facesSnapshot(), key) },
      { uid: "l1", name: `labels-${id}.pfplb`, revision: "r", bytes: await seal(labelCopy("Desk"), key) },
    ];
    const own = { faces: false, faceData: true, labels: true, search: false, ownDeviceId: id };
    const skipped = await loadDriveData(fakeDrive(files).client, account(), own, null, "space-a");
    expect(skipped.faceCopies).toEqual([]);
    expect(skipped.labelCopies).toEqual([]);
    const back = await loadDriveData(fakeDrive(files).client, account(), { ...own, readBack: true }, null, "space-a");
    expect(back.faceCopies.map((c) => c.deviceId)).toEqual([id]);
    expect(back.labelCopies).toHaveLength(1);
    expect(back.ownRead).toBe(true);
    expect(back.deviceNames).toEqual(expect.arrayContaining([[id, "Desk"]]));
    // Labels not read this time: the next round reads them back still.
    const part = await loadDriveData(fakeDrive(files).client, account(), { ...own, labels: false, readBack: true }, null, "space-a");
    expect(part.ownRead).toBe(false);
  }, 30_000);

  it("lists the backups device by device, newest first, named from a small copy", async () => {
    const files = [
      { uid: "f1", name: `faces-${id}.pfpml`, revision: "r", bytes: Buffer.alloc(0), at: 3_000 },
      { uid: "s1", name: `search-${id}.pfpml`, revision: "r", bytes: Buffer.alloc(0), at: 1_000 },
      { uid: "f2", name: `faces-${other}.pfpml`, revision: "r", bytes: Buffer.alloc(0), at: 1_000 },
      { uid: "l2", name: `labels-${other}.pfplb`, revision: "r", bytes: await seal(labelCopy("Pixel 8"), key), at: 9_000 },
      { uid: "x", name: "notes.txt", revision: "r", bytes: Buffer.alloc(0), at: 9_000 },
    ];
    const drive = fakeDrive(files);
    const { backups, names } = await listDriveBackups(drive.client, account(), null, id, {});
    expect(backups).toEqual([
      { device: other, own: false, name: "Pixel 8", savedAt: 9_000, files: ["f2", "l2"] },
      { device: id, own: true, name: null, savedAt: 3_000, files: ["f1", "s1"] },
    ]);
    expect(names).toEqual([[other, "Pixel 8"]]);
    expect(drive.downloads).toEqual(["l2"]);
    // A name kept from before is not read again.
    const again = fakeDrive(files);
    await listDriveBackups(again.client, account(), null, id, { [other]: "Pixel 8" });
    expect(again.downloads).toEqual([]);
    expect(await otherFaceCopies(drive.client, id)).toEqual(["f2"]);
  }, 30_000);

  it("drops the cached copies of files no longer on Drive", async () => {
    const cache = memoryCache();
    cache.put("gone", "r", Buffer.from("x"));
    await loadDriveData(fakeDrive([]).client, account(), { faces: true, labels: true, search: true }, cache, "space-a");
    expect(cache.entries.size).toBe(0);
  });
});

describe("saving this install's copy", () => {
  /** A Drive with the app's folder and one sub-folder, whose uploads are recorded. */
  function drive(conflict: { existingNodeUid?: string; isUnfinishedUpload?: boolean } | null, trashed: string[] = [], present = false) {
    const calls: { kind: string; target: string; override?: boolean }[] = [];
    const folder = (uid: string, name: string) => ({ uid, type: "folder", name: { ok: true, value: name } });
    const uploader = (fail: boolean) => ({
      uploadFromStream: async (_stream: unknown, _thumbnails: unknown, onProgress?: (sent: number) => void) => {
        onProgress?.(4);
        onProgress?.(8);
        return {
          completion: async () => {
            if (fail && conflict) {
              const e = Object.assign(new Error("exists"), { name: "NodeWithSameNameExistsValidationError", ...conflict });
              throw e;
            }
            return { nodeUid: "saved" };
          },
        };
      },
    });
    return {
      calls,
      client: {
        getMyFilesRootFolder: async () => ({ uid: "root" }),
        iterateFolderChildren: async function* (uid: string) {
          if (uid === "root") yield folder("app", "Photos for Proton");
          if (uid === "app") yield folder("labels", "Labels");
          if (uid === "labels" && trashed.includes("old")) {
            yield { uid: "old", type: "file", name: { ok: true, value: "labels-x.pfplb" }, trashTime: new Date(1) };
          }
          if (uid === "labels" && present) yield { uid: "file-1", type: "file", name: { ok: true, value: "labels-x.pfplb" } };
        },
        getNode: async (uid: string) => ({ uid, trashTime: trashed.includes(uid) ? new Date(1) : undefined }),
        restoreNodes: async function* (uids: string[]) {
          for (const uid of uids) {
            calls.push({ kind: "restore", target: uid });
            yield { uid, ok: true };
          }
        },
        createFolder: async () => {
          throw new Error("no new folders here");
        },
        getFileUploader: async (parent: string, _name: string, meta: any) => {
          calls.push({ kind: "new", target: parent, override: meta.overrideExistingDraftByOtherClient });
          return uploader(true);
        },
        getFileRevisionUploader: async (uid: string, meta: any) => {
          calls.push({ kind: "revision", target: uid, override: meta.overrideExistingDraftByOtherClient });
          return uploader(false);
        },
      },
    };
  }

  it("replaces a draft of its own name rather than failing every save", async () => {
    const d = drive(null);
    await saveCopy(d.client, "Labels", "labels-x.pfplb", Buffer.from("x"), new Date(1));
    expect(d.calls).toEqual([{ kind: "new", target: "labels", override: true }]);
  });

  it("saves as the next revision of a finished file the listing did not show", async () => {
    const d = drive({ existingNodeUid: "file-1", isUnfinishedUpload: false });
    expect(await saveCopy(d.client, "Labels", "labels-x.pfplb", Buffer.from("x"), new Date(1))).toBe("saved");
    expect(d.calls.map((c) => [c.kind, c.target])).toEqual([
      ["new", "labels"],
      ["revision", "file-1"],
    ]);
  });

  it("brings a copy another device moved to the trash back out before saving into it", async () => {
    const d = drive({ existingNodeUid: "file-1", isUnfinishedUpload: false }, ["file-1", "old"]);
    expect(await saveCopy(d.client, "Labels", "labels-x.pfplb", Buffer.from("x"), new Date(1))).toBe("saved");
    // The trashed file the listing showed is not taken for the one to write on.
    expect(d.calls.map((c) => [c.kind, c.target])).toEqual([
      ["new", "labels"],
      ["restore", "file-1"],
      ["revision", "file-1"],
    ]);
  });

  it("does not take over anything else that fails", async () => {
    const d = drive({ existingNodeUid: "file-1", isUnfinishedUpload: true });
    await expect(saveCopy(d.client, "Labels", "labels-x.pfplb", Buffer.from("x"), new Date(1))).rejects.toThrow("exists");
  });

  it("tells how far the upload got", async () => {
    const d = drive(null);
    const seen: number[] = [];
    await saveCopy(d.client, "Labels", "labels-x.pfplb", Buffer.from("x"), new Date(1), (sent) => seen.push(sent));
    expect(seen).toEqual([4, 8]);
  });

  it("finds a copy that is there", async () => {
    expect(await copyPresent(drive(null, [], true).client, "Labels", "labels-x.pfplb")).toBe(true);
  });

  it("does not find a copy that is gone", async () => {
    expect(await copyPresent(drive(null).client, "Labels", "labels-x.pfplb")).toBe(false);
    expect(await copyPresent(drive(null).client, "ML data", "labels-x.pfplb")).toBe(false);
    expect(await copyPresent(drive(null, ["old"]).client, "Labels", "labels-x.pfplb")).toBe(false);
  });

  const invalid = expect.objectContaining({ name: "CopyInvalid" });
  const faceCopy: FaceCopyToWrite = {
    deviceId: "d1",
    deviceLabel: "Phone",
    createdAt: 1,
    faceModelVersion: 7,
    faceModelSha256: "ab",
    clusterParamsVersion: 1,
    embeddingDim: 2,
    faces: [
      {
        key: "k1",
        index: 0,
        box: [0, 0, 1, 1],
        score: 1,
        blur: null,
        rejected: false,
        person: null,
        confirmed: null,
        points: [],
        embedding: new Float32Array([1, 0]),
      },
    ],
    notPerson: [],
    covers: [],
    markers: [
      { key: "k1", swept: false },
      { key: "k2", swept: false },
    ],
  };

  it("accepts a face copy that holds it all", () => {
    expect(() => verifyFaceCopy(writeFaceCopy(faceCopy), { faces: 1, photos: 2 })).not.toThrow();
  });

  it("rejects a face copy that came out short", () => {
    const plain = writeFaceCopy(faceCopy);
    expect(() => verifyFaceCopy(plain, { faces: 2, photos: 2 })).toThrow(invalid);
    expect(() => verifyFaceCopy(plain, { faces: 1, photos: 3 })).toThrow(invalid);
  });

  const searchCopy = writeSearchCopy({
    deviceId: "d1",
    deviceLabel: "Phone",
    createdAt: 1,
    modelId: "space-a",
    dim: 1,
    entries: [
      ["k0", new Uint16Array([0x3c00])],
      ["k1", null],
    ],
  });

  it("accepts a search copy that holds it all, a photo that could not be read not counted", () => {
    expect(() => verifySearchCopy(searchCopy, { vectors: 1 })).not.toThrow();
  });

  it("rejects a search copy that came out short", () => {
    expect(() => verifySearchCopy(searchCopy, { vectors: 2 })).toThrow(invalid);
  });

  it("rejects a copy that does not read back at all", () => {
    expect(() => verifyFaceCopy(writeFaceCopy(faceCopy).subarray(0, 20), { faces: 1, photos: 2 })).toThrow(invalid);
    expect(() => verifySearchCopy(searchCopy.subarray(0, 20), { vectors: 1 })).toThrow(invalid);
  });
});
