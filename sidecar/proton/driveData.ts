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
import { nodeName } from "./nodes.ts";

export const APP_FOLDER = "Photos for Proton";
export const ML_FOLDER = "ML data";
export const LABELS_FOLDER = "Labels";

const DEVICE_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const FACES_NAME = new RegExp(`^faces-(${DEVICE_ID})\\.pfpml$`);
const SEARCH_NAME = new RegExp(`^search-(${DEVICE_ID})\\.pfpml$`);
const LABELS_NAME = new RegExp(`^labels-(${DEVICE_ID})\\.pfplb$`);

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
const SNAPSHOT_VERSION = 4;
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
 * not a well-formed version-4 face snapshot.
 */
export function readFacesSnapshot(plain: Buffer): FacesSnapshot {
  if (plain.length < SNAPSHOT_MAGIC.length || !plain.subarray(0, SNAPSHOT_MAGIC.length).equals(SNAPSHOT_MAGIC)) {
    throw new Error("not a face snapshot");
  }
  const r = new LittleEndian(plain.subarray(SNAPSHOT_MAGIC.length));
  const version = r.u32();
  if (version !== SNAPSHOT_VERSION) throw new Error(`face snapshot version ${version}`);
  if (r.u8() !== KIND_FACES) throw new Error("not a face snapshot");
  r.str(); // device id
  const deviceLabel = r.str();
  const createdAt = r.i64();
  r.u32(); // face model version
  r.str(); // face model digest
  r.u32(); // clustering parameters version
  const embeddingDim = r.u32();
  if (embeddingDim > MAX_EMBEDDING_DIM) throw new Error("embedding too wide");
  const [keyCount, personCount, faceCount, manualCount, notPersonCount, coverCount, markerCount] = [
    r.u32(), r.u32(), r.u32(), r.u32(), r.u32(), r.u32(), r.u32(),
  ];

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
  for (let i = 0; i < personCount; i++) {
    expect(TAG.PERSON);
    names.push(r.str());
  }
  const keyAt = (i: number) => {
    if (i >= keys.length) throw new Error("unlisted photo");
    return keys[i];
  };
  const nameAt = (i: number) => {
    if (i >= names.length) throw new Error("unlisted person");
    return names[i];
  };

  const faces: { key: string; index: number; name: string; box: FaceBox; score: number }[] = [];
  for (let i = 0; i < faceCount; i++) {
    expect(TAG.FACE);
    const key = keyAt(r.u32());
    const index = r.u32();
    const box: FaceBox = [r.f32(), r.f32(), r.f32(), r.f32()];
    const score = r.f32();
    r.skip(4); // blur
    const flags = r.u8();
    const person = r.u32();
    const confirmed = r.u32();
    const points = r.u8();
    r.skip(points * 8 + embeddingDim * 4);
    const ref = person !== NO_REFERENCE ? person : confirmed;
    if (ref !== NO_REFERENCE && !(flags & FACE_REJECTED)) faces.push({ key, index, name: nameAt(ref), box, score });
  }
  const manual: { name: string; key: string }[] = [];
  for (let i = 0; i < manualCount; i++) {
    expect(TAG.MANUAL);
    manual.push({ name: nameAt(r.u32()), key: keyAt(r.u32()) });
  }
  const notPerson = new Set<string>();
  for (let i = 0; i < notPersonCount; i++) {
    expect(TAG.NOT_PERSON);
    const name = nameAt(r.u32());
    const key = keyAt(r.u32());
    notPerson.add(`${name}\u0000${key}#${r.u32()}`);
  }
  const covers = new Map<string, string>();
  for (let i = 0; i < coverCount; i++) {
    expect(TAG.COVER);
    const name = nameAt(r.u32());
    covers.set(name, keyAt(r.u32()));
  }
  for (let i = 0; i < markerCount; i++) {
    expect(TAG.MARKER);
    keyAt(r.u32());
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
    deviceLabel,
    createdAt,
    people: [...byName.values()]
      .filter((p) => p.keys.size > 0)
      .map(({ name, keys, cover, box }) => ({ name, keys, cover, box })),
  };
}

// ---- The search snapshot ----

export type SearchSnapshot = {
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
 * photo on one phone only are left out. Throws on anything that is not a well-formed version-4
 * search snapshot.
 */
export function readSearchSnapshot(plain: Buffer): SearchSnapshot {
  if (plain.length < SNAPSHOT_MAGIC.length || !plain.subarray(0, SNAPSHOT_MAGIC.length).equals(SNAPSHOT_MAGIC)) {
    throw new Error("not a search snapshot");
  }
  const r = new LittleEndian(plain.subarray(SNAPSHOT_MAGIC.length));
  const version = r.u32();
  if (version !== SNAPSHOT_VERSION) throw new Error(`search snapshot version ${version}`);
  if (r.u8() !== KIND_SEARCH) throw new Error("not a search snapshot");
  r.str(); // device id
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
  return { deviceLabel, createdAt, modelId, dim, keys, vectors: out.slice(0, filled * dim) };
}

// ---- The label snapshot ----

export type LabelsSnapshot = { deviceLabel: string; createdAt: number; labels: Map<string, Set<string>> };

const LABEL_SNAPSHOT_VERSION = 1;

/** The labels of a label snapshot, each with the photos that carry it. Throws on anything else. */
export function readLabelsSnapshot(plain: Buffer): LabelsSnapshot {
  const json = JSON.parse(plain.toString("utf8"));
  if (json?.v !== LABEL_SNAPSHOT_VERSION || !Array.isArray(json.p)) throw new Error("not a label snapshot");
  const labels = new Map<string, Set<string>>();
  for (const photo of json.p) {
    const key = typeof photo?.k === "string" ? photo.k : "";
    // A device key (`content://...`) names a photo on that one phone only.
    if (!key || key.includes("://") || !Array.isArray(photo.l)) continue;
    for (const label of photo.l) {
      if (typeof label !== "string" || !label.trim()) continue;
      const name = label.trim();
      let set = labels.get(name);
      if (!set) labels.set(name, (set = new Set()));
      set.add(key);
    }
  }
  return { deviceLabel: String(json.n ?? ""), createdAt: Number(json.c ?? 0), labels };
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
export type DriveKinds = { faces: boolean; labels: boolean; search: boolean };

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
    if (node?.type === "folder" && nodeName(node) === name) return node;
  }
  return null;
}

type DriveFile = { uid: string; name: string; revision: string };

/** A file's revision as far as a cache cares: its active revision, and when it last changed. */
function revisionOf(node: any): string {
  const active = node?.activeRevision?.ok ? node.activeRevision.value?.uid : "";
  const changed = node?.modificationTime ? new Date(node.modificationTime).getTime() : 0;
  return `${active ?? ""}:${changed}`;
}

async function filesIn(client: any, folderUid: string): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  for await (const node of client.iterateFolderChildren(folderUid)) {
    if (node?.type === "file") out.push({ uid: node.uid, name: nodeName(node), revision: revisionOf(node) });
  }
  return out;
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
export type DriveData = DriveCollections & { search: SearchSnapshot[]; searchOtherModel: number };

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
  };
  const root = await client.getMyFilesRootFolder();
  const app = await childNamed(client, root.uid, APP_FOLDER);
  if (!app) {
    cache?.keepOnly(new Set());
    return result;
  }
  result.found = true;

  // Every key of every address, primary ones first, so a copy sealed before a key rotation
  // or a change of primary address still opens.
  const keys: any[] = [];
  for (const address of await account.getOwnAddresses()) {
    const own = [...(address.keys ?? [])];
    const primary = own.splice(address.primaryKeyIndex ?? 0, 1);
    keys.push(...primary.map((k: any) => k.key), ...own.map((k: any) => k.key));
  }

  const seen = new Set<string>();
  const open = async (file: DriveFile): Promise<Buffer | null> => {
    seen.add(file.uid);
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
    result.unreadable++;
    return null;
  };

  const people: Parameters<typeof mergeCollections>[0] = [];
  const ml = kinds.faces || kinds.search ? await childNamed(client, app.uid, ML_FOLDER) : null;
  for (const file of ml ? await filesIn(client, ml.uid) : []) {
    if (kinds.faces && facesFileDevice(file.name)) {
      const plain = await open(file);
      if (!plain) continue;
      try {
        const snap = readFacesSnapshot(plain);
        people.push({ createdAt: snap.createdAt, entries: snap.people });
        result.sources.push({ kind: "faces", device: snap.deviceLabel, savedAt: snap.createdAt });
      } catch {
        result.unreadable++;
      }
    } else if (kinds.search && searchFileDevice(file.name)) {
      const plain = await open(file);
      if (!plain) continue;
      try {
        const snap = readSearchSnapshot(plain);
        if (snap.modelId !== searchModelId) {
          result.searchOtherModel++;
          continue;
        }
        result.search.push(snap);
        result.sources.push({ kind: "search", device: snap.deviceLabel, savedAt: snap.createdAt });
      } catch {
        result.unreadable++;
      }
    }
  }

  const labels: { createdAt: number; entries: { name: string; keys: Iterable<string> }[] }[] = [];
  const labelFolder = kinds.labels ? await childNamed(client, app.uid, LABELS_FOLDER) : null;
  for (const file of labelFolder ? await filesIn(client, labelFolder.uid) : []) {
    if (!labelsFileDevice(file.name)) continue;
    const plain = await open(file);
    if (!plain) continue;
    try {
      const snap = readLabelsSnapshot(plain);
      labels.push({
        createdAt: snap.createdAt,
        entries: [...snap.labels].map(([name, keys]) => ({ name, keys })),
      });
      result.sources.push({ kind: "labels", device: snap.deviceLabel, savedAt: snap.createdAt });
    } catch {
      result.unreadable++;
    }
  }

  // Only copies still on Drive, of the kinds still read, stay cached.
  cache?.keepOnly(seen);
  result.people = mergeCollections(people);
  result.labels = mergeCollections(labels);
  return result;
}
