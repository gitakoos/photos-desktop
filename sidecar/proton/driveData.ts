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

// What the Android app keeps in Proton Drive beside the photos: the people its face index
// named and the labels put on photos, under `My files/Photos for Proton/`. Read here, to
// show them; nothing is written back.
//
// Each file is the Android app's encrypted, signed envelope ("PPMLSEAL") around either a
// face snapshot ("PPMLSNAP", binary) or a label snapshot (JSON). The layouts follow the
// Android app's MlSnapshotEnvelope and MlSnapshotFormat to the byte. Photos are named by
// their Proton link id, which every device of the account shares.

import { createHash } from "node:crypto";

import { CryptoProxy } from "./crypto.ts";
import { activeRevisionOf, nodeName } from "./nodes.ts";

export const APP_FOLDER = "Photos for Proton";
export const ML_FOLDER = "ML data";
export const LABELS_FOLDER = "Labels";
export const HIDDEN_FOLDER = "Hidden";

const DEVICE_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const FACES_NAME = new RegExp(`^faces-(${DEVICE_ID})\\.pfpml$`);
const SEARCH_NAME = new RegExp(`^search-(${DEVICE_ID})\\.pfpml$`);
const LABELS_NAME = new RegExp(`^labels-(${DEVICE_ID})\\.pfplb$`);
const HIDDEN_NAME = new RegExp(`^hidden-(${DEVICE_ID})\\.pfphd$`);

/** The install that wrote a face snapshot file, or null for any other name. */
export function facesFileDevice(name: string): string | null {
  return FACES_NAME.exec(name)?.[1] ?? null;
}

/** The install that wrote a label snapshot file, or null for any other name. */
/** The installation a search copy's file name names, or null for any other file. */
export function searchFileDevice(name: string): string | null {
  return SEARCH_NAME.exec(name)?.[1] ?? null;
}

export function labelsFileDevice(name: string): string | null {
  return LABELS_NAME.exec(name)?.[1] ?? null;
}

/** The install that wrote a hidden-list file, or null for any other name. */
export function hiddenFileDevice(name: string): string | null {
  return HIDDEN_NAME.exec(name)?.[1] ?? null;
}

// ---- The envelope ----

const ENVELOPE_MAGIC = Buffer.from("PPMLSEAL", "ascii");
const ENVELOPE_VERSION = 1;
const MAX_CHUNK_SIZE = 16 * 1024 * 1024;
const MAX_KEY_PACKET_BYTES = 64 * 1024;
const MAX_SIGNATURE_BYTES = 64 * 1024;
const CIPHER_SLACK_BYTES = 64 * 1024;
const TAG_CHUNK = 1;
const TAG_TRAILER = 2;
const HASH_BYTES = 32;
const SIGNATURE_CONTEXT = Buffer.from("eu.akoos.photos.mlsync.envelope", "ascii");
/** What `verifyMessage` reports for a signature made by one of the given keys. */
const SIGNED_AND_VALID = 1;

export type EnvelopeOpened =
  | { ok: true; plain: Buffer }
  | { ok: false; reason: "not-envelope" | "too-new" | "wrong-key" | "damaged" };

/** A bounds-checked big-endian reader over a whole file, as the envelope is written. */
class BigEndian {
  private at = 0;
  constructor(private readonly buf: Buffer) {}
  get done(): boolean {
    return this.at >= this.buf.length;
  }
  int(): number {
    if (this.at + 4 > this.buf.length) throw new RangeError("short");
    const v = this.buf.readInt32BE(this.at);
    this.at += 4;
    return v;
  }
  byte(): number {
    if (this.at + 1 > this.buf.length) throw new RangeError("short");
    return this.buf[this.at++];
  }
  bytes(n: number): Buffer {
    if (n < 0 || this.at + n > this.buf.length) throw new RangeError("short");
    const out = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
}

function envelopeHeader(chunkSize: number, wrappedKey: Buffer): Buffer {
  const ints = Buffer.alloc(12);
  ints.writeInt32BE(ENVELOPE_VERSION, 0);
  ints.writeInt32BE(chunkSize, 4);
  ints.writeInt32BE(wrappedKey.length, 8);
  return Buffer.concat([ENVELOPE_MAGIC, ints, wrappedKey]);
}

function signedManifest(header: Buffer, hashes: Buffer[]): Buffer {
  const count = Buffer.alloc(4);
  count.writeInt32BE(hashes.length, 0);
  return Buffer.concat([SIGNATURE_CONTEXT, header, count, ...hashes]);
}

async function unwrap(wrappedKey: Buffer, key: any): Promise<any | null> {
  try {
    const sessionKey = await CryptoProxy.decryptSessionKey({ binaryMessage: wrappedKey, decryptionKeys: [key] } as any);
    return sessionKey?.data?.length ? sessionKey : null;
  } catch {
    return null;
  }
}

async function decryptChunk(cipher: Buffer, sessionKey: any): Promise<Buffer | null> {
  try {
    const { data } = await CryptoProxy.decryptMessage({
      binaryMessage: cipher,
      sessionKeys: sessionKey,
      format: "binary",
    } as any);
    return Buffer.from(data as unknown as Uint8Array);
  } catch {
    return null;
  }
}

/** The plaintext an envelope's chunks carry, as the Android app cuts it. */
export const ENVELOPE_CHUNK_SIZE = 4 * 1024 * 1024;

/**
 * Seals `plain` into an envelope the Android app opens: a fresh session key wrapped to
 * `encryptionKey`, the plaintext encrypted chunk by chunk under it, and the trailer signed with
 * `signingKey` over the context, the header and every chunk's hash in order.
 */
export async function sealEnvelope(
  plain: Buffer,
  encryptionKey: any,
  signingKey: any,
  chunkSize = ENVELOPE_CHUNK_SIZE,
): Promise<Buffer> {
  const sessionKey = await CryptoProxy.generateSessionKey({ recipientKeys: [encryptionKey] } as any);
  const wrapped = Buffer.from(
    (await CryptoProxy.encryptSessionKey({
      ...(sessionKey as any),
      encryptionKeys: [encryptionKey],
      format: "binary",
    } as any)) as unknown as Uint8Array,
  );
  const header = envelopeHeader(chunkSize, wrapped);
  const parts: Buffer[] = [header];
  const hashes: Buffer[] = [];
  for (let at = 0; at < plain.length; at += chunkSize) {
    const { message } = (await CryptoProxy.encryptMessage({
      binaryData: plain.subarray(at, at + chunkSize),
      sessionKey,
      format: "binary",
    } as any)) as any;
    const cipher = Buffer.from(message as Uint8Array);
    const head = Buffer.alloc(5);
    head.writeUInt8(TAG_CHUNK, 0);
    head.writeInt32BE(cipher.length, 1);
    parts.push(head, cipher);
    hashes.push(createHash("sha256").update(cipher).digest());
  }
  const signature = Buffer.from(
    (await CryptoProxy.signMessage({
      binaryData: signedManifest(header, hashes),
      signingKeys: [signingKey],
      detached: true,
    } as any)) as string,
    "utf8",
  );
  const trailer = Buffer.alloc(5);
  trailer.writeUInt8(TAG_TRAILER, 0);
  trailer.writeInt32BE(hashes.length, 1);
  const signatureLength = Buffer.alloc(4);
  signatureLength.writeInt32BE(signature.length, 0);
  parts.push(trailer, ...hashes, signatureLength, signature);
  return Buffer.concat(parts);
}

/**
 * Opens one envelope. The key packet is tried against each of `decryptionKeys` in turn, and
 * until a chunk has opened, a key that unwraps to a wrong session key gives way to the next,
 * as the Android app does. Only `ok: true` means every chunk, the ordered hashes and the
 * trailer signature checked out against `verificationKeys`.
 */
export async function openEnvelope(file: Buffer, decryptionKeys: any[], verificationKeys: any[]): Promise<EnvelopeOpened> {
  if (file.length < ENVELOPE_MAGIC.length || !file.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)) {
    return { ok: false, reason: "not-envelope" };
  }
  const r = new BigEndian(file.subarray(ENVELOPE_MAGIC.length));
  try {
    const version = r.int();
    if (version !== ENVELOPE_VERSION) return { ok: false, reason: "too-new" };
    const chunkSize = r.int();
    const wrappedLength = r.int();
    if (chunkSize < 1 || chunkSize > MAX_CHUNK_SIZE || wrappedLength < 1 || wrappedLength > MAX_KEY_PACKET_BYTES) {
      return { ok: false, reason: "damaged" };
    }
    const wrappedKey = r.bytes(wrappedLength);
    const maxCipher = chunkSize + Math.floor(chunkSize / 4) + CIPHER_SLACK_BYTES;

    const candidates = decryptionKeys[Symbol.iterator]();
    const nextSessionKey = async (): Promise<any | null> => {
      for (let next = candidates.next(); !next.done; next = candidates.next()) {
        const opened = await unwrap(wrappedKey, next.value);
        if (opened) return opened;
      }
      return null;
    };
    let sessionKey = await nextSessionKey();
    if (!sessionKey) return { ok: false, reason: "wrong-key" };

    const hashes: Buffer[] = [];
    const plain: Buffer[] = [];
    let lastChunkShort = false;
    let tag = r.byte();
    while (tag === TAG_CHUNK) {
      const length = r.int();
      if (lastChunkShort || length < 1 || length > maxCipher) return { ok: false, reason: "damaged" };
      const cipher = r.bytes(length);
      let chunk = await decryptChunk(cipher, sessionKey);
      while (!chunk && hashes.length === 0) {
        const next = await nextSessionKey();
        if (!next) break;
        sessionKey = next;
        chunk = await decryptChunk(cipher, sessionKey);
      }
      if (!chunk || chunk.length === 0 || chunk.length > chunkSize) return { ok: false, reason: "damaged" };
      hashes.push(createHash("sha256").update(cipher).digest());
      plain.push(chunk);
      lastChunkShort = chunk.length < chunkSize;
      tag = r.byte();
    }
    if (tag !== TAG_TRAILER || r.int() !== hashes.length) return { ok: false, reason: "damaged" };
    for (const hash of hashes) {
      if (!r.bytes(HASH_BYTES).equals(hash)) return { ok: false, reason: "damaged" };
    }
    const signatureLength = r.int();
    if (signatureLength < 1 || signatureLength > MAX_SIGNATURE_BYTES) return { ok: false, reason: "damaged" };
    const signature = r.bytes(signatureLength).toString("utf8");
    if (!r.done) return { ok: false, reason: "damaged" };

    const manifest = signedManifest(envelopeHeader(chunkSize, wrappedKey), hashes);
    let verified = false;
    try {
      const result: any = await CryptoProxy.verifyMessage({
        binaryData: manifest,
        armoredSignature: signature,
        verificationKeys,
      } as any);
      verified = result?.verificationStatus === SIGNED_AND_VALID;
    } catch {
      verified = false;
    }
    if (!verified) return { ok: false, reason: "damaged" };
    return { ok: true, plain: Buffer.concat(plain) };
  } catch (e) {
    if (e instanceof RangeError) return { ok: false, reason: "damaged" };
    throw e;
  }
}

// ---- The face snapshot ----

const SNAPSHOT_MAGIC = Buffer.from("PPMLSNAP", "ascii");
/** The version a face copy is written as, and the newest read; a search copy keeps 4, whose layout 5 and 6 left as it was. */
const FACES_VERSION = 6;
const SEARCH_VERSION = 4;
const OLDEST_READ_VERSION = 4;
const KIND_FACES = 1;
const KIND_SEARCH = 2;
const SEARCH_TOMBSTONE = 0x01;
const NO_REFERENCE = 0xffffffff;
const FACE_REJECTED = 0x01;
const MAX_EMBEDDING_DIM = 4096;
const TAG = {
  KEY: 0x01,
  PERSON: 0x02,
  FACE: 0x03,
  MANUAL: 0x04,
  NOT_PERSON: 0x05,
  COVER: 0x06,
  MARKER: 0x07,
  SEARCH: 0x08,
  NAME_CHANGE: 0x09,
  REMOVAL: 0x0a,
  END: 0xff,
};

/** A face's box within its photo, each edge from 0 to 1: left, top, right, bottom. */
export type FaceBox = [number, number, number, number];

/**
 * One person as a face snapshot names them: the photos they are on, and the cover: the photo
 * picked on the phone, else the one with their clearest face, with that face's box when the
 * cover has one.
 */
export type SnapshotPerson = { name: string; keys: Set<string>; cover: string | null; box: FaceBox | null };

export type FacesSnapshot = { deviceLabel: string; createdAt: number; people: SnapshotPerson[] };

/** One face a phone saved, whole: where it is, its numbers, and who it was said to be. */
export type SnapshotFace = {
  /** The photo's Drive link id. */
  key: string;
  index: number;
  box: FaceBox;
  /** The landmarks, x then y, in the pixels of the picture the phone read. */
  points: number[];
  score: number;
  /** Sharpness of the aligned crop; null when the phone did not measure it. */
  blur: number | null;
  embedding: Float32Array;
  rejected: boolean;
  /** The person the grouping put it with, and the name a user confirmed it as. */
  person: string | null;
  confirmed: string | null;
};

/** Everything a phone's face copy says, face by face, for putting its work beside this computer's. */
export type FaceCopy = {
  deviceId: string;
  deviceLabel: string;
  createdAt: number;
  /** The face pipeline, recognition model and grouping rules the faces were made under. */
  faceModelVersion: number;
  faceModelSha256: string;
  clusterParamsVersion: number;
  embeddingDim: number;
  /**
   * When the account's face data was last deleted everywhere, as far as that device knew, epoch
   * ms; 0 for never, and for a copy of version 4 or 5, which carries no such time.
   */
  facesWipedAt: number;
  faces: SnapshotFace[];
  /** Name and face (`key#index`) pairs marked as not that person, with when each was set (0 when unknown). */
  notPerson: { name: string; key: string; index: number; at: number }[];
  covers: Map<string, string>;
  /** When each cover was picked, by the person's name, 0 when unknown. */
  coverSetAt: Map<string, number>;
  /** The photos attached to a person by hand there, with when (0 when unknown). */
  manual: { name: string; key: string; at: number }[];
  /** The pieces of curation taken away by hand there, oldest first. */
  removals: CurationRemoval[];
  /** When each person got their name there, epoch ms, 0 when unknown, by the name as spelled. */
  namedAt: Map<string, number>;
  /** The renames and merges made by hand there, oldest first: the person called `from` is `to` since `at`. */
  nameChanges: NameChange[];
  /**
   * The photos that device's face scan finished, with or without a face (its scan markers), by
   * link id: what another device can take as done instead of scanning again.
   */
  scanned: string[];
};

/** A rename or merge of a person made by hand at `at` (epoch ms); an empty `to` is the name taken off. */
export type NameChange = { from: string; to: string; at: number };

/** The kinds of curation a removal takes away. */
export const CURATION_MANUAL_PHOTO = 1;
export const CURATION_NOT_PERSON = 2;
export const CURATION_COVER = 3;

/**
 * A piece of a person's curation taken away by hand at `at`: a photo attached to them (`key`), a
 * "not this person" mark (the face `key#index`) or the cover (`key` empty). `index` is 0 unless
 * the kind is a mark.
 */
export type CurationRemoval = { kind: 1 | 2 | 3; name: string; key: string; index: number; at: number };

/** A bounds-checked little-endian reader, as the snapshot is written. */
class LittleEndian {
  private at = 0;
  constructor(private readonly buf: Buffer) {}
  get done(): boolean {
    return this.at >= this.buf.length;
  }
  u8(): number {
    if (this.at + 1 > this.buf.length) throw new RangeError("short");
    return this.buf[this.at++];
  }
  u32(): number {
    if (this.at + 4 > this.buf.length) throw new RangeError("short");
    const v = this.buf.readUInt32LE(this.at);
    this.at += 4;
    return v;
  }
  i64(): number {
    if (this.at + 8 > this.buf.length) throw new RangeError("short");
    const v = Number(this.buf.readBigInt64LE(this.at));
    this.at += 8;
    return v;
  }
  f32(): number {
    if (this.at + 4 > this.buf.length) throw new RangeError("short");
    const v = this.buf.readFloatLE(this.at);
    this.at += 4;
    return v;
  }
  bytes(n: number): Buffer {
    if (n < 0 || this.at + n > this.buf.length) throw new RangeError("short");
    const out = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  skip(n: number): void {
    if (n < 0 || this.at + n > this.buf.length) throw new RangeError("short");
    this.at += n;
  }
  str(): string {
    if (this.at + 2 > this.buf.length) throw new RangeError("short");
    const length = this.buf.readUInt16LE(this.at);
    this.at += 2;
    if (this.at + length > this.buf.length) throw new RangeError("short");
    const out = this.buf.toString("utf8", this.at, this.at + length);
    this.at += length;
    return out;
  }
}

/**
 * The people a face snapshot names. A person's photos are the faces grouped under them
 * (by the clustering, or confirmed by hand), less the faces removed from People and those
 * marked as not them, plus the photos attached to them by hand. Throws on anything that is
 * not a well-formed face snapshot of version 4 to 6.
 */
export function readFacesSnapshot(plain: Buffer): FacesSnapshot {
  return readFaceCopy(plain).snapshot;
}

/** A face copy read whole: the people as the People page shows them, and every face with it. */
export function readFaceCopy(plain: Buffer): { snapshot: FacesSnapshot; copy: FaceCopy } {
  if (plain.length < SNAPSHOT_MAGIC.length || !plain.subarray(0, SNAPSHOT_MAGIC.length).equals(SNAPSHOT_MAGIC)) {
    throw new Error("not a face snapshot");
  }
  const r = new LittleEndian(plain.subarray(SNAPSHOT_MAGIC.length));
  const version = r.u32();
  if (version < OLDEST_READ_VERSION || version > FACES_VERSION) throw new Error(`face snapshot version ${version}`);
  if (r.u8() !== KIND_FACES) throw new Error("not a face snapshot");
  const deviceId = r.str();
  const deviceLabel = r.str();
  const createdAt = r.i64();
  const faceModelVersion = r.u32();
  const faceModelSha256 = r.str();
  const clusterParamsVersion = r.u32();
  const embeddingDim = r.u32();
  if (embeddingDim > MAX_EMBEDDING_DIM) throw new Error("embedding too wide");
  const facesWipedAt = version >= 6 ? r.i64() : 0;
  if (facesWipedAt < 0) throw new Error("a negative delete time");
  const keyCount = r.u32();
  const personCount = r.u32();
  const changeCount = version >= 5 ? r.u32() : 0;
  const removalCount = version >= 5 ? r.u32() : 0;
  const [faceCount, manualCount, notPersonCount, coverCount, markerCount] = [r.u32(), r.u32(), r.u32(), r.u32(), r.u32()];

  const expect = (tag: number) => {
    const got = r.u8();
    if (got !== tag) throw new Error(`record ${got} where ${tag} belongs`);
  };
  const keys: string[] = [];
  for (let i = 0; i < keyCount; i++) {
    expect(TAG.KEY);
    keys.push(r.str());
  }
  const names: string[] = [];
  const namedAt = new Map<string, number>();
  for (let i = 0; i < personCount; i++) {
    expect(TAG.PERSON);
    const name = r.str();
    const at = version >= 5 ? r.i64() : 0;
    if (at < 0) throw new Error("a negative naming time");
    names.push(name);
    namedAt.set(name, Math.max(at, namedAt.get(name) ?? 0));
  }
  const nameChanges: NameChange[] = [];
  for (let i = 0; i < changeCount; i++) {
    expect(TAG.NAME_CHANGE);
    const from = r.str();
    const to = r.str();
    const at = r.i64();
    if (at < 0) throw new Error("a negative change time");
    nameChanges.push({ from, to, at });
  }
  const removals: CurationRemoval[] = [];
  for (let i = 0; i < removalCount; i++) {
    expect(TAG.REMOVAL);
    const kind = r.u8();
    if (kind !== CURATION_MANUAL_PHOTO && kind !== CURATION_NOT_PERSON && kind !== CURATION_COVER) {
      throw new Error(`a removal of kind ${kind}`);
    }
    const name = r.str();
    const key = r.str();
    const index = r.u32();
    const at = r.i64();
    if (at < 0) throw new Error("a negative removal time");
    removals.push({ kind, name, key, index, at });
  }
  const timeOf = () => {
    if (version < 5) return 0;
    const at = r.i64();
    if (at < 0) throw new Error("a negative curation time");
    return at;
  };
  const keyAt = (i: number) => {
    if (i >= keys.length) throw new Error("unlisted photo");
    return keys[i];
  };
  const nameAt = (i: number) => {
    if (i >= names.length) throw new Error("unlisted person");
    return names[i];
  };

  const faces: { key: string; index: number; name: string; box: FaceBox; score: number }[] = [];
  const whole: SnapshotFace[] = [];
  for (let i = 0; i < faceCount; i++) {
    expect(TAG.FACE);
    const key = keyAt(r.u32());
    const index = r.u32();
    const box: FaceBox = [r.f32(), r.f32(), r.f32(), r.f32()];
    const score = r.f32();
    const blur = r.f32();
    const flags = r.u8();
    const person = r.u32();
    const confirmed = r.u32();
    const pointCount = r.u8();
    const points: number[] = [];
    for (let k = 0; k < pointCount * 2; k++) points.push(r.f32());
    const embedding = new Float32Array(embeddingDim);
    for (let k = 0; k < embeddingDim; k++) embedding[k] = r.f32();
    const ref = person !== NO_REFERENCE ? person : confirmed;
    if (ref !== NO_REFERENCE && !(flags & FACE_REJECTED)) faces.push({ key, index, name: nameAt(ref), box, score });
    whole.push({
      key,
      index,
      box,
      points,
      score,
      blur: flags & FACE_BLUR_KNOWN ? blur : null,
      embedding,
      rejected: (flags & FACE_REJECTED) !== 0,
      person: person !== NO_REFERENCE ? nameAt(person) : null,
      confirmed: confirmed !== NO_REFERENCE ? nameAt(confirmed) : null,
    });
  }
  const manual: { name: string; key: string; at: number }[] = [];
  for (let i = 0; i < manualCount; i++) {
    expect(TAG.MANUAL);
    const name = nameAt(r.u32());
    const key = keyAt(r.u32());
    manual.push({ name, key, at: timeOf() });
  }
  const notPerson = new Set<string>();
  const notPersonList: FaceCopy["notPerson"] = [];
  for (let i = 0; i < notPersonCount; i++) {
    expect(TAG.NOT_PERSON);
    const name = nameAt(r.u32());
    const key = keyAt(r.u32());
    const index = r.u32();
    notPerson.add(`${name}\u0000${key}#${index}`);
    notPersonList.push({ name, key, index, at: timeOf() });
  }
  const covers = new Map<string, string>();
  const coverSetAt = new Map<string, number>();
  for (let i = 0; i < coverCount; i++) {
    expect(TAG.COVER);
    const name = nameAt(r.u32());
    covers.set(name, keyAt(r.u32()));
    coverSetAt.set(name, timeOf());
  }
  const scanned: string[] = [];
  for (let i = 0; i < markerCount; i++) {
    expect(TAG.MARKER);
    scanned.push(keyAt(r.u32()));
    r.u8();
  }
  expect(TAG.END);
  if (!r.done) throw new Error("data after the end marker");

  const byName = new Map<string, SnapshotPerson & { best: number }>();
  const personOf = (name: string) => {
    let p = byName.get(name);
    if (!p) byName.set(name, (p = { name, keys: new Set(), cover: covers.get(name) ?? null, box: null, best: -1 }));
    return p;
  };
  for (const f of faces) {
    if (notPerson.has(`${f.name}\u0000${f.key}#${f.index}`)) continue;
    const p = personOf(f.name);
    p.keys.add(f.key);
    const picked = covers.get(f.name);
    // The picked cover's face wins outright; without one, the clearest face does.
    if (picked ? f.key === picked && !p.box : f.score > p.best) {
      if (!picked) p.cover = f.key;
      p.box = f.box;
      p.best = f.score;
    }
  }
  for (const m of manual) personOf(m.name).keys.add(m.key);
  return {
    snapshot: {
      deviceLabel,
      createdAt,
      people: [...byName.values()]
        .filter((p) => p.keys.size > 0)
        .map(({ name, keys, cover, box }) => ({ name, keys, cover, box })),
    },
    copy: {
      deviceId,
      deviceLabel,
      createdAt,
      faceModelVersion,
      faceModelSha256,
      clusterParamsVersion,
      embeddingDim,
      facesWipedAt,
      faces: whole,
      notPerson: notPersonList,
      covers,
      coverSetAt,
      manual,
      removals,
      namedAt,
      nameChanges,
      scanned,
    },
  };
}

/** A face as this computer writes it into its copy. */
export type WrittenFace = {
  key: string;
  index: number;
  box: FaceBox;
  score: number;
  blur: number | null;
  rejected: boolean;
  person: string | null;
  confirmed: string | null;
  /** Landmark x and y pairs. */
  points: number[];
  embedding: Float32Array;
};

export type FaceCopyToWrite = {
  deviceId: string;
  deviceLabel: string;
  createdAt: number;
  faceModelVersion: number;
  faceModelSha256: string;
  clusterParamsVersion: number;
  embeddingDim: number;
  /** The newest delete of the face data everywhere this computer knows of, epoch ms, 0 for none. */
  facesWipedAt?: number;
  faces: WrittenFace[];
  /** The "not this person" marks, each with when it was set by hand (0 when unknown). */
  notPerson: { name: string; key: string; index: number; at?: number }[];
  /** The covers, each with when it was picked (0 when unknown). */
  covers: { name: string; key: string; at?: number }[];
  /** Photos attached to a person by hand, with when. */
  manual?: { name: string; key: string; at?: number }[];
  /** The pieces of curation taken away by hand, oldest first. */
  removals?: CurationRemoval[];
  /** When the person of each name got it, epoch ms, 0 when unknown. */
  namedAt?: (name: string) => number;
  /** The renames and merges made by hand, oldest first. */
  nameChanges?: NameChange[];
  /** Every photo looked at, and whether "Find more photos" has read it too. */
  markers: { key: string; swept: boolean }[];
};

/** The blur field holds a measured value. */
const FACE_BLUR_KNOWN = 0x02;
const MARKER_SWEPT = 0x01;

/** A growing little-endian buffer, as the snapshot is written. */
class LittleEndianWriter {
  private parts: Buffer[] = [];
  u8(v: number) {
    const b = Buffer.alloc(1);
    b.writeUInt8(v, 0);
    this.parts.push(b);
  }
  u32(v: number) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0, 0);
    this.parts.push(b);
  }
  i64(v: number | bigint) {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(typeof v === "bigint" ? v : BigInt(Math.trunc(v)), 0);
    this.parts.push(b);
  }
  f32(v: number) {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v, 0);
    this.parts.push(b);
  }
  floats(v: Float32Array) {
    const b = Buffer.alloc(v.length * 4);
    for (let i = 0; i < v.length; i++) b.writeFloatLE(v[i], i * 4);
    this.parts.push(b);
  }
  halves(v: Uint16Array) {
    const b = Buffer.alloc(v.length * 2);
    for (let i = 0; i < v.length; i++) b.writeUInt16LE(v[i], i * 2);
    this.parts.push(b);
  }
  str(v: string) {
    const bytes = Buffer.from(v, "utf8");
    if (bytes.length > 0xffff) throw new Error("text too long for the snapshot");
    const len = Buffer.alloc(2);
    len.writeUInt16LE(bytes.length, 0);
    this.parts.push(len, bytes);
  }
  done(): Buffer {
    return Buffer.concat(this.parts);
  }
}

/** A version-6 face snapshot, in the layout the Android app reads and `readFaceCopy` reads back. */
export function writeFaceCopy(copy: FaceCopyToWrite): Buffer {
  const keys: string[] = [];
  const keyAt = new Map<string, number>();
  const key = (k: string) => {
    let i = keyAt.get(k);
    if (i === undefined) {
      i = keys.length;
      keys.push(k);
      keyAt.set(k, i);
    }
    return i;
  };
  const names: string[] = [];
  const nameAt = new Map<string, number>();
  const name = (n: string) => {
    let i = nameAt.get(n);
    if (i === undefined) {
      i = names.length;
      names.push(n);
      nameAt.set(n, i);
    }
    return i;
  };
  // Every reference is listed before the records that use it, so the tables are filled first.
  for (const f of copy.faces) {
    key(f.key);
    if (f.person) name(f.person);
    if (f.confirmed) name(f.confirmed);
  }
  const manual = copy.manual ?? [];
  const changes = copy.nameChanges ?? [];
  for (const m of manual) {
    key(m.key);
    name(m.name);
  }
  for (const n of copy.notPerson) {
    key(n.key);
    name(n.name);
  }
  for (const c of copy.covers) {
    key(c.key);
    name(c.name);
  }
  for (const m of copy.markers) key(m.key);

  const w = new LittleEndianWriter();
  w.u32(FACES_VERSION);
  w.u8(KIND_FACES);
  w.str(copy.deviceId);
  w.str(copy.deviceLabel);
  w.i64(copy.createdAt);
  w.u32(copy.faceModelVersion);
  w.str(copy.faceModelSha256);
  w.u32(copy.clusterParamsVersion);
  w.u32(copy.embeddingDim);
  w.i64(Math.max(0, copy.facesWipedAt ?? 0));
  const removals = copy.removals ?? [];
  const counts = [keys.length, names.length, changes.length, removals.length, copy.faces.length, manual.length];
  for (const count of [...counts, copy.notPerson.length, copy.covers.length, copy.markers.length]) w.u32(count);
  for (const k of keys) {
    w.u8(TAG.KEY);
    w.str(k);
  }
  for (const n of names) {
    w.u8(TAG.PERSON);
    w.str(n);
    w.i64(Math.max(0, copy.namedAt?.(n) ?? 0));
  }
  for (const c of changes) {
    w.u8(TAG.NAME_CHANGE);
    w.str(c.from);
    w.str(c.to);
    w.i64(Math.max(0, c.at));
  }
  for (const r of removals) {
    w.u8(TAG.REMOVAL);
    w.u8(r.kind);
    w.str(r.name);
    w.str(r.key);
    w.u32(r.index);
    w.i64(Math.max(0, r.at));
  }
  for (const f of copy.faces) {
    if (f.embedding.length !== copy.embeddingDim) throw new Error("embedding of the wrong width");
    w.u8(TAG.FACE);
    w.u32(keyAt.get(f.key)!);
    w.u32(f.index);
    for (const v of f.box) w.f32(v);
    w.f32(f.score);
    w.f32(f.blur ?? 0);
    w.u8((f.rejected ? FACE_REJECTED : 0) | (f.blur !== null ? FACE_BLUR_KNOWN : 0));
    w.u32(f.person ? nameAt.get(f.person)! : NO_REFERENCE);
    w.u32(f.confirmed ? nameAt.get(f.confirmed)! : NO_REFERENCE);
    const pointCount = Math.floor(f.points.length / 2);
    w.u8(pointCount);
    for (let i = 0; i < pointCount * 2; i++) w.f32(f.points[i]);
    w.floats(f.embedding);
  }
  for (const m of manual) {
    w.u8(TAG.MANUAL);
    w.u32(nameAt.get(m.name)!);
    w.u32(keyAt.get(m.key)!);
    w.i64(Math.max(0, m.at ?? 0));
  }
  for (const n of copy.notPerson) {
    w.u8(TAG.NOT_PERSON);
    w.u32(nameAt.get(n.name)!);
    w.u32(keyAt.get(n.key)!);
    w.u32(n.index);
    w.i64(Math.max(0, n.at ?? 0));
  }
  for (const c of copy.covers) {
    w.u8(TAG.COVER);
    w.u32(nameAt.get(c.name)!);
    w.u32(keyAt.get(c.key)!);
    w.i64(Math.max(0, c.at ?? 0));
  }
  for (const m of copy.markers) {
    w.u8(TAG.MARKER);
    w.u32(keyAt.get(m.key)!);
    w.u8(m.swept ? MARKER_SWEPT : 0);
  }
  w.u8(TAG.END);
  return Buffer.concat([SNAPSHOT_MAGIC, w.done()]);
}

/** The name an install's face copy is stored under. */
export function facesFileName(deviceId: string): string {
  if (!new RegExp(`^${DEVICE_ID}$`).test(deviceId)) throw new Error("not a device id");
  return `faces-${deviceId}.pfpml`;
}

/** The name an install's search index is stored under. */
export function searchFileName(deviceId: string): string {
  if (!new RegExp(`^${DEVICE_ID}$`).test(deviceId)) throw new Error("not a device id");
  return `search-${deviceId}.pfpml`;
}

/** The name an install's labels are stored under. */
export function hiddenFileName(deviceId: string): string {
  if (!new RegExp(`^${DEVICE_ID}$`).test(deviceId)) throw new Error("not a device id");
  return `hidden-${deviceId}.pfphd`;
}

export function labelsFileName(deviceId: string): string {
  if (!new RegExp(`^${DEVICE_ID}$`).test(deviceId)) throw new Error("not a device id");
  return `labels-${deviceId}.pfplb`;
}

/** Puts this install's face copy on Drive; see `saveCopy`. */
export function saveFaceCopy(client: any, deviceId: string, sealed: Buffer, at: Date): Promise<string> {
  return saveCopy(client, ML_FOLDER, facesFileName(deviceId), sealed, at);
}

/**
 * Puts one of this install's copies on Drive, in `My files/Photos for Proton/<folder>`, making the
 * folders when they are not there yet: as a new revision of the file it wrote before, or as a new
 * file the first time. Returns the file's uid. `onProgress` hears the bytes sent so far.
 */
export async function saveCopy(
  client: any,
  folder: string,
  name: string,
  sealed: Buffer,
  at: Date,
  onProgress?: (sent: number) => void,
): Promise<string> {
  const root = await client.getMyFilesRootFolder();
  const app = (await childNamed(client, root.uid, APP_FOLDER)) ?? (await client.createFolder(root.uid, APP_FOLDER));
  const ml = (await childNamed(client, app.uid, folder)) ?? (await client.createFolder(app.uid, folder));
  let existing: any = null;
  for await (const node of client.iterateFolderChildren(ml.uid)) {
    if (node?.type === "file" && !node.trashTime && nodeName(node) === name) existing = node;
  }
  const metadata = {
    mediaType: "application/octet-stream",
    expectedSize: sealed.length,
    expectedSha1: createHash("sha1").update(sealed).digest("hex"),
    modificationTime: at,
    // The name is this install's own, so a draft left under it is one of its own saves, cut
    // short (the app closed mid-upload): it is replaced rather than left blocking every save.
    overrideExistingDraftByOtherClient: true,
  };
  const send = async (uploader: any) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(sealed));
        controller.close();
      },
    });
    const controller = await uploader.uploadFromStream(stream, [], onProgress);
    const { nodeUid } = await controller.completion();
    return nodeUid as string;
  };
  if (existing) return send(await client.getFileRevisionUploader(existing.uid, metadata));
  try {
    return await send(await client.getFileUploader(ml.uid, name, metadata));
  } catch (e) {
    // A finished file of that name the listing did not show: saved as its next revision. One that
    // another device moved to the trash comes back out first, so the new copy is not saved into it.
    const conflict = e as { name?: string; existingNodeUid?: string; isUnfinishedUpload?: boolean };
    if (conflict?.name !== "NodeWithSameNameExistsValidationError" || !conflict.existingNodeUid || conflict.isUnfinishedUpload) throw e;
    const node = await Promise.resolve()
      .then(() => client.getNode(conflict.existingNodeUid))
      .catch(() => null);
    if (node?.trashTime) {
      for await (const result of client.restoreNodes([conflict.existingNodeUid])) {
        if (!(result as { ok?: boolean })?.ok) throw new Error("the copy in the trash could not be restored");
      }
    }
    return send(await client.getFileRevisionUploader(conflict.existingNodeUid, metadata));
  }
}

/** Whether one of this install's copies is still on Drive, out of the trash. Makes no folders. */
export async function copyPresent(client: any, folder: string, name: string): Promise<boolean> {
  const root = await client.getMyFilesRootFolder();
  const app = await childNamed(client, root.uid, APP_FOLDER);
  const parent = app && (await childNamed(client, app.uid, folder));
  if (!parent) return false;
  for await (const node of client.iterateFolderChildren(parent.uid)) {
    if (node?.type === "file" && !node.trashTime && nodeName(node) === name) return true;
  }
  return false;
}

/** A copy that does not read back as what it was made from; `failReason` knows it by its name. */
function copyInvalid(): Error {
  const e = new Error("the copy does not hold what it was made from");
  e.name = "CopyInvalid";
  return e;
}

function readBack<T>(read: (plain: Buffer) => T, plain: Buffer): T {
  try {
    return read(plain);
  } catch {
    throw copyInvalid();
  }
}

/** Throws unless a face copy about to be sealed reads back with all its faces and photos. */
export function verifyFaceCopy(plain: Buffer, expected: { faces: number; photos: number }): void {
  const { copy } = readBack(readFaceCopy, plain);
  if (copy.faces.length !== expected.faces || copy.scanned.length !== expected.photos) throw copyInvalid();
}

/** Throws unless a search copy about to be sealed reads back with all its vectors. */
export function verifySearchCopy(plain: Buffer, expected: { vectors: number }): void {
  if (readBack(readSearchSnapshot, plain).keys.length !== expected.vectors) throw copyInvalid();
}

// ---- The search snapshot ----

export type SearchSnapshot = {
  deviceId: string;
  deviceLabel: string;
  createdAt: number;
  /** The embedding space; vectors compare only under an equal id. */
  modelId: string;
  dim: number;
  /** One Drive link id per vector, in order; a photo the phone could not read is left out. */
  keys: string[];
  /** The vectors one after another, `dim` half-precision values each. */
  vectors: Uint16Array;
};

/**
 * A device's search index: per photo, the image embedding at half precision. Keys that name a
 * photo on one phone only are left out. Throws on anything that is not a well-formed version 4 to 6
 * search snapshot.
 */
export function readSearchSnapshot(plain: Buffer): SearchSnapshot {
  if (plain.length < SNAPSHOT_MAGIC.length || !plain.subarray(0, SNAPSHOT_MAGIC.length).equals(SNAPSHOT_MAGIC)) {
    throw new Error("not a search snapshot");
  }
  const r = new LittleEndian(plain.subarray(SNAPSHOT_MAGIC.length));
  const version = r.u32();
  // Either kind is read at any version this build knows: a search copy's layout stayed as 4 had it.
  if (version < OLDEST_READ_VERSION || version > FACES_VERSION) throw new Error(`search snapshot version ${version}`);
  if (r.u8() !== KIND_SEARCH) throw new Error("not a search snapshot");
  const deviceId = r.str();
  const deviceLabel = r.str();
  const createdAt = r.i64();
  const modelId = r.str();
  const dim = r.u32();
  if (dim === 0 || dim > MAX_EMBEDDING_DIM) throw new Error("embedding of a bad width");
  const keyCount = r.u32();
  const embeddingCount = r.u32();
  // Every vector takes its record's bytes, so a count the file cannot hold is refused before
  // anything is allocated for it.
  if (embeddingCount * (dim * 2 + 6) > plain.length) throw new Error("more vectors than the file holds");
  const expect = (tag: number) => {
    const got = r.u8();
    if (got !== tag) throw new Error(`record ${got} where ${tag} belongs`);
  };
  const allKeys: string[] = [];
  for (let i = 0; i < keyCount; i++) {
    expect(TAG.KEY);
    allKeys.push(r.str());
  }
  const keys: string[] = [];
  const out = new Uint16Array(embeddingCount * dim);
  let filled = 0;
  for (let i = 0; i < embeddingCount; i++) {
    expect(TAG.SEARCH);
    const at = r.u32();
    if (at >= allKeys.length) throw new Error("unlisted photo");
    const flags = r.u8();
    if (flags & ~SEARCH_TOMBSTONE) throw new Error("unknown flag");
    if (flags & SEARCH_TOMBSTONE) continue;
    const bytes = r.bytes(dim * 2);
    const key = allKeys[at];
    if (key.includes("://")) continue;
    for (let d = 0; d < dim; d++) out[filled * dim + d] = bytes.readUInt16LE(d * 2);
    keys.push(key);
    filled++;
  }
  expect(TAG.END);
  if (!r.done) throw new Error("data after the end marker");
  return { deviceId, deviceLabel, createdAt, modelId, dim, keys, vectors: out.slice(0, filled * dim) };
}

/** What this install puts in its search copy: each photo's vector by its Drive link id, null
 *  for a photo that could not be read. */
export type SearchCopyToWrite = {
  deviceId: string;
  deviceLabel: string;
  createdAt: number;
  modelId: string;
  dim: number;
  entries: [string, Uint16Array | null][];
};

/**
 * A version-4 search snapshot in the layout the Android app writes: the key table, then one record
 * per photo, a photo that could not be read as a tombstone with no components.
 */
export function writeSearchCopy(copy: SearchCopyToWrite): Buffer {
  const entries = copy.entries.filter(([key]) => key && !key.includes("://"));
  const w = new LittleEndianWriter();
  w.u32(SEARCH_VERSION);
  w.u8(KIND_SEARCH);
  w.str(copy.deviceId);
  w.str(copy.deviceLabel);
  w.i64(copy.createdAt);
  w.str(copy.modelId);
  w.u32(copy.dim);
  w.u32(entries.length);
  w.u32(entries.length);
  for (const [key] of entries) {
    w.u8(TAG.KEY);
    w.str(key);
  }
  entries.forEach(([, vector], i) => {
    w.u8(TAG.SEARCH);
    w.u32(i);
    if (!vector) {
      w.u8(SEARCH_TOMBSTONE);
      return;
    }
    if (vector.length !== copy.dim) throw new Error("a vector of another width");
    w.u8(0);
    w.halves(vector);
  });
  w.u8(TAG.END);
  return Buffer.concat([SNAPSHOT_MAGIC, w.done()]);
}

// ---- The label snapshot ----

export type LabelsSnapshot = { deviceLabel: string; createdAt: number; labels: Map<string, Set<string>> };

const LABEL_SNAPSHOT_VERSION = 1;

/**
 * A device's labels as saved, with when each part last changed there, so two devices' edits can
 * be put together: the later change to a photo's labels wins, and a label deleted on one device
 * leaves the photos the other labelled before that. A part saved without a change time (by an app
 * that did not write them) reads as changed at 0, older than any edit, so it only fills a gap.
 */
export type LabelCopy = {
  deviceId: string;
  deviceLabel: string;
  createdAt: number;
  /** Each photo's labels by its Drive link id; an empty list is a photo whose labels were taken off. */
  photos: { key: string; labels: string[]; changedAt: number }[];
  /** Labels made with no photo yet. */
  names: { name: string; changedAt: number }[];
  /** Labels deleted, and when. */
  deleted: { name: string; at: number }[];
};

const finite = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** A label snapshot read whole. Throws on anything that is not one. */
export function readLabelCopy(plain: Buffer): LabelCopy {
  const json = JSON.parse(plain.toString("utf8"));
  if (json?.v !== LABEL_SNAPSHOT_VERSION || !Array.isArray(json.p)) throw new Error("not a label snapshot");
  const createdAt = finite(json.c, 0);
  const photos: LabelCopy["photos"] = [];
  for (const photo of json.p) {
    const key = typeof photo?.k === "string" ? photo.k : "";
    // A device key (`content://...`) names a photo on that one phone only.
    if (!key || key.includes("://") || !Array.isArray(photo.l)) continue;
    const labels = photo.l.filter((l: unknown): l is string => typeof l === "string" && !!l.trim()).map((l: string) => l.trim());
    photos.push({ key, labels, changedAt: finite(photo.t, 0) });
  }
  const times = json.mt && typeof json.mt === "object" ? json.mt : {};
  const names = (Array.isArray(json.m) ? json.m : [])
    .filter((n: unknown): n is string => typeof n === "string" && !!n.trim())
    .map((n: string) => ({ name: n.trim(), changedAt: finite(times[n], 0) }));
  const deleted = (Array.isArray(json.x) ? json.x : [])
    .filter((x: any) => typeof x?.n === "string" && x.n.trim())
    .map((x: any) => ({ name: x.n.trim(), at: finite(x.t, createdAt) }));
  return { deviceId: String(json.d ?? ""), deviceLabel: String(json.n ?? ""), createdAt, photos, names, deleted };
}

/**
 * This install's labels in the snapshot the Android app reads: the fields it knows (`v`, `d`, `n`,
 * `c`, `p` with `k` and `l`, `m`) as it writes them, and the change times beside them (`t` on a
 * photo, `mt` for the labels with no photo, `x` for the deleted ones), which an app that does not
 * know them passes over.
 */
export function writeLabelCopy(copy: LabelCopy): Buffer {
  const mt: Record<string, number> = {};
  for (const n of copy.names) mt[n.name] = n.changedAt;
  const json = {
    v: LABEL_SNAPSHOT_VERSION,
    d: copy.deviceId,
    n: copy.deviceLabel,
    c: copy.createdAt,
    p: copy.photos.map((p) => ({ k: p.key, l: p.labels, t: p.changedAt })),
    m: copy.names.map((n) => n.name),
    mt,
    x: copy.deleted.map((d) => ({ n: d.name, t: d.at })),
  };
  return Buffer.from(JSON.stringify(json), "utf8");
}

export const HIDDEN_SNAPSHOT_VERSION = 1;

/**
 * One device's hidden photos and albums, as JSON v1 sealed like the labels:
 * `{ v, d, n, c, p: [{ k, h, t }], a: [{ k, h, t }] }`, each entry a Drive link id (`k`),
 * whether it is hidden (`h`; false is one shown again, kept so the change carries), and when
 * that last changed (`t`, ms). Put together, the later change to an entry wins; an entry with
 * no time reads as 0, older than any change.
 */
export type HiddenEntry = { key: string; hidden: boolean; changedAt: number };
export type HiddenCopy = {
  deviceId: string;
  deviceLabel: string;
  createdAt: number;
  photos: HiddenEntry[];
  albums: HiddenEntry[];
};

/** A hidden-list snapshot read whole. Throws on anything that is not one. */
export function readHiddenCopy(plain: Buffer): HiddenCopy {
  const json = JSON.parse(plain.toString("utf8"));
  if (json?.v !== HIDDEN_SNAPSHOT_VERSION || !Array.isArray(json.p) || !Array.isArray(json.a)) {
    throw new Error("not a hidden-list snapshot");
  }
  const entries = (list: unknown[]): HiddenEntry[] =>
    list
      .filter((e: any) => typeof e?.k === "string" && e.k && !e.k.includes("://") && typeof e.h === "boolean")
      .map((e: any) => ({ key: e.k, hidden: e.h, changedAt: finite(e.t, 0) }));
  return {
    deviceId: String(json.d ?? ""),
    deviceLabel: String(json.n ?? ""),
    createdAt: finite(json.c, 0),
    photos: entries(json.p),
    albums: entries(json.a),
  };
}

export function writeHiddenCopy(copy: HiddenCopy): Buffer {
  const entries = (list: HiddenEntry[]) => list.map((e) => ({ k: e.key, h: e.hidden, t: e.changedAt }));
  const json = {
    v: HIDDEN_SNAPSHOT_VERSION,
    d: copy.deviceId,
    n: copy.deviceLabel,
    c: copy.createdAt,
    p: entries(copy.photos),
    a: entries(copy.albums),
  };
  return Buffer.from(JSON.stringify(json), "utf8");
}

/** The labels of a label snapshot, each with the photos that carry it. Throws on anything else. */
export function readLabelsSnapshot(plain: Buffer): LabelsSnapshot {
  const copy = readLabelCopy(plain);
  const labels = new Map<string, Set<string>>();
  for (const photo of copy.photos) {
    for (const name of photo.labels) {
      let set = labels.get(name);
      if (!set) labels.set(name, (set = new Set()));
      set.add(photo.key);
    }
  }
  return { deviceLabel: copy.deviceLabel, createdAt: copy.createdAt, labels };
}

// ---- Several devices into one ----

/** A name as compared across devices: case and accents aside. */
export function foldName(name: string): string {
  return name.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().trim();
}

export type Collection = { name: string; keys: string[]; cover: string | null; box: FaceBox | null };

/**
 * One list from every device's copy: a person or label named alike on two phones is one
 * entry, with the photos of both. The spelling and the cover come from the newest copy that
 * has them. Most photos first.
 */
export function mergeCollections(
  copies: {
    createdAt: number;
    entries: { name: string; keys: Iterable<string>; cover?: string | null; box?: FaceBox | null }[];
  }[],
): Collection[] {
  const merged = new Map<string, { name: string; keys: Set<string>; cover: string | null; box: FaceBox | null }>();
  for (const copy of [...copies].sort((a, b) => b.createdAt - a.createdAt)) {
    for (const entry of copy.entries) {
      const fold = foldName(entry.name);
      if (!fold) continue;
      let m = merged.get(fold);
      if (!m) merged.set(fold, (m = { name: entry.name, keys: new Set(), cover: null, box: null }));
      for (const k of entry.keys) m.keys.add(k);
      if (!m.cover && entry.cover) {
        m.cover = entry.cover;
        m.box = entry.box ?? null;
      }
    }
  }
  return [...merged.values()]
    .map((m) => ({ name: m.name, keys: [...m.keys], cover: m.cover, box: m.box }))
    .sort((a, b) => b.keys.length - a.keys.length || a.name.localeCompare(b.name));
}

// ---- Reading them from Drive ----

export type DriveCollections = {
  /** Whether the app's folder exists in My files at all. */
  found: boolean;
  people: Collection[];
  labels: Collection[];
  /** The copies read, one per device and kind, for "saved on Pixel 8, 3 days ago". */
  sources: { kind: "faces" | "labels" | "search"; device: string; savedAt: number }[];
  /** Copies that were there but could not be read: another account's, damaged, or newer. */
  unreadable: number;
};

/** What a read takes from Drive: each kind can be left out by the reader's settings. */
export type DriveKinds = {
  faces: boolean;
  labels: boolean;
  search: boolean;
  /** Read the face copies for this computer's own face recognition, without showing their people. */
  faceData?: boolean;
  /** Read the other devices' hidden lists. */
  hidden?: boolean;
  /** This computer's own install, whose face copy is never read back as another device's. */
  ownDeviceId?: string;
  /**
   * Read this install's own files like another device's, after a fresh install or a sign-out:
   * they hold what an earlier install on this PC saved. `ownRead` answers whether all of them were.
   */
  readBack?: boolean;
  /** Files moved to the trash from here, which a listing may still show for a while. */
  trashed?: ReadonlySet<string>;
};

/** The downloaded copies kept on this computer, each under the revision it was read at, so a
 *  copy that has not changed on Drive is not downloaded again. */
export interface CopyCache {
  get(uid: string, revision: string): Buffer | null;
  put(uid: string, revision: string, bytes: Buffer): void;
  /** Forgets every copy but these, the ones still on Drive. */
  keepOnly(uids: Set<string>): void;
}

async function childNamed(client: any, parentUid: string, name: string): Promise<any | null> {
  for await (const node of client.iterateFolderChildren(parentUid)) {
    if (node?.type === "folder" && !node.trashTime && nodeName(node) === name) return node;
  }
  return null;
}

type DriveFile = { uid: string; name: string; revision: string; modifiedAt: number };

/** A file's revision as far as a cache cares: its active revision, and when it last changed. */
function revisionOf(node: any): string {
  const active = activeRevisionOf(node)?.uid ?? "";
  const changed = node?.modificationTime ? new Date(node.modificationTime).getTime() : 0;
  return `${active ?? ""}:${changed}`;
}

/** The files in a folder, less those in the trash, also the ones moved there from here (`trashed`). */
async function filesIn(client: any, folderUid: string, trashed?: ReadonlySet<string>): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  for await (const node of client.iterateFolderChildren(folderUid)) {
    if (node?.type !== "file" || node.trashTime || trashed?.has(node.uid)) continue;
    const modifiedAt = node.modificationTime ? new Date(node.modificationTime).getTime() : 0;
    out.push({ uid: node.uid, name: nodeName(node), revision: revisionOf(node), modifiedAt: Number.isFinite(modifiedAt) ? modifiedAt : 0 });
  }
  return out;
}

/** Every key of every address, primary ones first, so a copy sealed before a key rotation or a
 *  change of primary address still opens. */
async function addressKeys(account: any): Promise<any[]> {
  const keys: any[] = [];
  for (const address of await account.getOwnAddresses()) {
    const own = [...(address.keys ?? [])];
    const primary = own.splice(address.primaryKeyIndex ?? 0, 1);
    keys.push(...primary.map((k: any) => k.key), ...own.map((k: any) => k.key));
  }
  return keys;
}

/** Downloads and opens a copy, from the cache when its revision is the one kept; null when it will not open. */
async function openCopy(client: any, keys: any[], cache: CopyCache | null, file: DriveFile): Promise<Buffer | null> {
  try {
    let bytes = cache?.get(file.uid, file.revision) ?? null;
    if (!bytes) {
      bytes = await download(client, file.uid);
      cache?.put(file.uid, file.revision, bytes);
    }
    const opened = await openEnvelope(bytes, keys, keys);
    if (opened.ok) return opened.plain;
  } catch (e) {
    process.stderr.write(`[drive-data] a copy could not be read: ${(e as Error).name}\n`);
  }
  return null;
}

/** Far above any real copy (a search index is about 1 KB a photo), so only a broken or
 *  hostile file reaches it, and it is stopped before it can take the memory. */
const COPY_MAX_BYTES = 512 * 1024 * 1024;

async function download(client: any, uid: string): Promise<Buffer> {
  const downloader = await client.getFileDownloader(uid);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const sink = new WritableStream<Uint8Array>({
    write(chunk) {
      size += chunk.length;
      if (size > COPY_MAX_BYTES) throw new Error("the saved copy is too large to read");
      chunks.push(chunk);
    },
  });
  await downloader.downloadToStream(sink).completion();
  return Buffer.concat(chunks);
}

/** What a read brings: the people and labels, and the search copies that share the text
 *  encoder's space (any other is counted, not kept). */
export type DriveData = DriveCollections & {
  search: SearchSnapshot[];
  searchOtherModel: number;
  /** Every face copy read whole, when asked for. */
  faceCopies: FaceCopy[];
  /** Every other device's label copy read whole, when the labels are asked for. */
  labelCopies: LabelCopy[];
  /** Every other device's hidden list, when asked for. */
  hiddenCopies: HiddenCopy[];
  /** With `readBack`, whether every file of this install's was read; true without it. */
  ownRead: boolean;
  /** The name each device's copies read here carry, by device id. */
  deviceNames: [string, string][];
};

/**
 * Reads the kinds asked for from every device's copy in `My files/Photos for Proton/` and folds
 * them together. `client` is a Drive client for My files and `account` the signed-in account,
 * whose address keys open the copies. A copy whose revision is the one cached is not downloaded
 * again. A copy that will not open is counted and passed over; the others still come through.
 */
export async function loadDriveData(
  client: any,
  account: any,
  kinds: DriveKinds,
  cache: CopyCache | null,
  searchModelId: string,
): Promise<DriveData> {
  const result: DriveData = {
    found: false,
    people: [],
    labels: [],
    sources: [],
    unreadable: 0,
    search: [],
    searchOtherModel: 0,
    faceCopies: [],
    labelCopies: [],
    hiddenCopies: [],
    ownRead: true,
    deviceNames: [],
  };
  const root = await client.getMyFilesRootFolder();
  const app = await childNamed(client, root.uid, APP_FOLDER);
  if (!app) {
    cache?.keepOnly(new Set());
    return result;
  }
  result.found = true;
  const keys = await addressKeys(account);

  const seen = new Set<string>();
  const names = new Map<string, string>();
  const own = kinds.ownDeviceId;
  // Whether a file is another device's, or one of this install's that is read back.
  const readable = (device: string | null): device is string => !!device && (device !== own || !!kinds.readBack);
  // A file of this install's that is not read, or will not open, keeps the next round reading back.
  const ownMissed = (device: string | null) => {
    if (kinds.readBack && device && device === own) result.ownRead = false;
  };
  const unreadable = (device: string) => {
    result.unreadable++;
    ownMissed(device);
  };
  const open = async (file: DriveFile, device: string): Promise<Buffer | null> => {
    seen.add(file.uid);
    const plain = await openCopy(client, keys, cache, file);
    if (!plain) unreadable(device);
    return plain;
  };

  const people: Parameters<typeof mergeCollections>[0] = [];
  const wantFaces = kinds.faces || !!kinds.faceData;
  const ml = wantFaces || kinds.search || kinds.readBack ? await childNamed(client, app.uid, ML_FOLDER) : null;
  for (const file of ml ? await filesIn(client, ml.uid, kinds.trashed) : []) {
    const faceDevice = facesFileDevice(file.name);
    const searchDevice = searchFileDevice(file.name);
    if (faceDevice && !kinds.faceData) ownMissed(faceDevice);
    if (searchDevice && !kinds.search) ownMissed(searchDevice);
    if (wantFaces && readable(faceDevice)) {
      const plain = await open(file, faceDevice);
      if (!plain) continue;
      try {
        const { snapshot: snap, copy } = readFaceCopy(plain);
        if (kinds.faces) people.push({ createdAt: snap.createdAt, entries: snap.people });
        if (kinds.faceData) result.faceCopies.push(copy);
        result.sources.push({ kind: "faces", device: snap.deviceLabel, savedAt: snap.createdAt });
        names.set(faceDevice, snap.deviceLabel);
      } catch {
        unreadable(faceDevice);
      }
    } else if (kinds.search && readable(searchDevice)) {
      const plain = await open(file, searchDevice);
      if (!plain) continue;
      try {
        const snap = readSearchSnapshot(plain);
        names.set(searchDevice, snap.deviceLabel);
        if (snap.modelId !== searchModelId) {
          result.searchOtherModel++;
          continue;
        }
        result.search.push(snap);
        result.sources.push({ kind: "search", device: snap.deviceLabel, savedAt: snap.createdAt });
      } catch {
        unreadable(searchDevice);
      }
    }
  }

  const labels: { createdAt: number; entries: { name: string; keys: Iterable<string> }[] }[] = [];
  const labelFolder = kinds.labels || kinds.readBack ? await childNamed(client, app.uid, LABELS_FOLDER) : null;
  for (const file of labelFolder ? await filesIn(client, labelFolder.uid, kinds.trashed) : []) {
    const device = labelsFileDevice(file.name);
    if (!kinds.labels) ownMissed(device);
    if (!kinds.labels || !readable(device)) continue;
    const plain = await open(file, device);
    if (!plain) continue;
    try {
      const copy = readLabelCopy(plain);
      result.labelCopies.push(copy);
      const snap = readLabelsSnapshot(plain);
      labels.push({
        createdAt: snap.createdAt,
        entries: [...snap.labels].map(([name, keys]) => ({ name, keys })),
      });
      result.sources.push({ kind: "labels", device: snap.deviceLabel, savedAt: snap.createdAt });
      names.set(device, snap.deviceLabel);
    } catch {
      unreadable(device);
    }
  }

  const hiddenFolder = kinds.hidden || kinds.readBack ? await childNamed(client, app.uid, HIDDEN_FOLDER) : null;
  for (const file of hiddenFolder ? await filesIn(client, hiddenFolder.uid, kinds.trashed) : []) {
    const device = hiddenFileDevice(file.name);
    if (!kinds.hidden) ownMissed(device);
    if (!kinds.hidden || !readable(device)) continue;
    const plain = await open(file, device);
    if (!plain) continue;
    try {
      const copy = readHiddenCopy(plain);
      result.hiddenCopies.push(copy);
      if (copy.deviceLabel) names.set(device, copy.deviceLabel);
    } catch {
      unreadable(device);
    }
  }
  result.deviceNames = [...names];

  // Only copies still on Drive, of the kinds still read, stay cached.
  cache?.keepOnly(seen);
  result.people = mergeCollections(people);
  result.labels = mergeCollections(labels);
  return result;
}

// ---- The backups on Drive, device by device ----

/** One device's files in the app's Drive data folders. */
export type DriveBackup = {
  device: string;
  /** This install's own files. */
  own: boolean;
  /** The name its copies carry, null when none of them was read for it. */
  name: string | null;
  /** When the newest of its files was saved, epoch ms. */
  savedAt: number;
  /** Its files, faces, search index, labels and hidden list. */
  files: string[];
};

/** The device a Drive data file belongs to, and whether its copy is a small one that carries the name. */
function deviceOfFile(name: string): { device: string; small: boolean } | null {
  const small = labelsFileDevice(name) ?? hiddenFileDevice(name);
  if (small) return { device: small, small: true };
  const big = facesFileDevice(name) ?? searchFileDevice(name);
  return big ? { device: big, small: false } : null;
}

/**
 * Every device with files in the app's three Drive data folders, newest first. A device whose name
 * is not in `names` gets it from its labels or hidden copy, the small ones that carry it; the names
 * read come back for the caller to keep.
 */
export async function listDriveBackups(
  client: any,
  account: any,
  cache: CopyCache | null,
  ownDeviceId: string,
  names: Readonly<Record<string, string>>,
  trashed?: ReadonlySet<string>,
): Promise<{ backups: DriveBackup[]; names: [string, string][] }> {
  const root = await client.getMyFilesRootFolder();
  const app = await childNamed(client, root.uid, APP_FOLDER);
  if (!app) return { backups: [], names: [] };
  const byDevice = new Map<string, { backup: DriveBackup; small: DriveFile[] }>();
  for (const folder of [ML_FOLDER, LABELS_FOLDER, HIDDEN_FOLDER]) {
    const node = await childNamed(client, app.uid, folder);
    for (const file of node ? await filesIn(client, node.uid, trashed) : []) {
      const of = deviceOfFile(file.name);
      if (!of) continue;
      let entry = byDevice.get(of.device);
      if (!entry) {
        entry = {
          backup: { device: of.device, own: of.device === ownDeviceId, name: names[of.device] ?? null, savedAt: 0, files: [] },
          small: [],
        };
        byDevice.set(of.device, entry);
      }
      entry.backup.files.push(file.uid);
      entry.backup.savedAt = Math.max(entry.backup.savedAt, file.modifiedAt);
      if (of.small) entry.small.push(file);
    }
  }
  const read: [string, string][] = [];
  let keys: any[] | null = null;
  for (const { backup, small } of byDevice.values()) {
    if (backup.name || backup.own) continue;
    for (const file of small) {
      keys ??= await addressKeys(account);
      const plain = await openCopy(client, keys, cache, file);
      if (!plain) continue;
      try {
        const label = (labelsFileDevice(file.name) ? readLabelCopy(plain) : readHiddenCopy(plain)).deviceLabel.trim();
        if (!label) continue;
        backup.name = label;
        read.push([backup.device, label]);
        break;
      } catch {
        /* the next file may carry it */
      }
    }
  }
  const backups = [...byDevice.values()].map((e) => e.backup).sort((a, b) => b.savedAt - a.savedAt);
  return { backups, names: read };
}

/** Moves `uids` to the Drive trash, where they can be restored from; answers the ones that went. */
export async function trashDriveFiles(client: any, uids: string[]): Promise<string[]> {
  const moved: string[] = [];
  for await (const result of client.trashNodes(uids)) {
    const r = result as { uid?: string; ok?: boolean };
    if (r?.ok && r.uid) moved.push(r.uid);
  }
  return moved;
}

/** The other devices' face copies on Drive, for a delete made everywhere. */
export async function otherFaceCopies(client: any, ownDeviceId: string, trashed?: ReadonlySet<string>): Promise<string[]> {
  const root = await client.getMyFilesRootFolder();
  const app = await childNamed(client, root.uid, APP_FOLDER);
  const ml = app ? await childNamed(client, app.uid, ML_FOLDER) : null;
  if (!ml) return [];
  return (await filesIn(client, ml.uid, trashed))
    .filter((f) => {
      const device = facesFileDevice(f.name);
      return !!device && device !== ownDeviceId;
    })
    .map((f) => f.uid);
}
