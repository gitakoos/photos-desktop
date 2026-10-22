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
  facesFileDevice,
  labelsFileDevice,
  loadDriveData,
  mergeCollections,
  openEnvelope,
  readFacesSnapshot,
  readLabelsSnapshot,
  readSearchSnapshot,
  searchFileDevice,
  type CopyCache,
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
    const other = Buffer.from(whole);
    other.writeUInt32LE(5, 8);
    expect(() => readFacesSnapshot(other)).toThrow();
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

  it("refuses a face snapshot and a file cut short", () => {
    expect(() => readSearchSnapshot(facesSnapshot())).toThrow();
    const whole = searchSnapshot();
    expect(() => readSearchSnapshot(whole.subarray(0, whole.length - 3))).toThrow();
  });
});

/** A stand-in for the My files client: the app folder with its ML data and Labels folders. */
function fakeDrive(files: { uid: string; name: string; revision: string; bytes: Buffer }[]) {
  const node = (uid: string, name: string, type: string, revision = "") => ({
    uid,
    type,
    name: { ok: true, value: name },
    activeRevision: { ok: true, value: { uid: revision } },
    modificationTime: new Date(0),
  });
  const downloads: string[] = [];
  const children: Record<string, any[]> = {
    root: [node("app", "Photos for Proton", "folder")],
    app: [node("ml", "ML data", "folder"), node("labels", "Labels", "folder")],
    ml: files.filter((f) => !f.name.startsWith("labels")).map((f) => node(f.uid, f.name, "file", f.revision)),
    labels: files.filter((f) => f.name.startsWith("labels")).map((f) => node(f.uid, f.name, "file", f.revision)),
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

  it("drops the cached copies of files no longer on Drive", async () => {
    const cache = memoryCache();
    cache.put("gone", "r", Buffer.from("x"));
    await loadDriveData(fakeDrive([]).client, account(), { faces: true, labels: true, search: true }, cache, "space-a");
    expect(cache.entries.size).toBe(0);
  });
});
