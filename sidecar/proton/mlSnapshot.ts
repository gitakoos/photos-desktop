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

// The face and search snapshots in full, both ways: every record the Android app's
// MlSnapshotWriter writes, read back with its embeddings, landmarks and curation, and written
// again in the same layout to the byte. `driveData.ts` keeps its lighter readers for the
// people view; this is what the desktop's own index merges from and saves as.
//
// Layout (little-endian, a string is a u16 length and UTF-8):
//   "PPMLSNAP" | u32 version 4 | u8 kind | str deviceId | str deviceLabel | i64 createdAt
//   faces:  u32 model version | str model digest | u32 clustering version
//   search: str model id
//   u32 embedding width | u32 count per section | records, section by section | 0xFF

/** Format version, the only one the Android app writes and reads. */
export const SNAPSHOT_VERSION = 4;
const MAGIC = Buffer.from("PPMLSNAP", "ascii");
const KIND_FACES = 1;
const KIND_SEARCH = 2;
const MAX_EMBEDDING_DIM = 4096;
const MAX_STRING_BYTES = 0xffff;
const MAX_LANDMARK_POINTS = 0xff;
const NO_REFERENCE = 0xffffffff;
const FACE_REJECTED = 0x01;
const FACE_BLUR_KNOWN = 0x02;
const SCAN_HI_RES = 0x01;
const SEARCH_TOMBSTONE = 0x01;
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

/** One detected face, as the snapshot carries it. The box is in fractions of the photo. */
export type SnapFace = {
  key: string;
  index: number;
  box: [number, number, number, number];
  score: number;
  /** Laplacian sharpness of the aligned crop, when the writer measured it. */
  blur: number | null;
  rejected: boolean;
  /** The named person the clustering grouped it under. */
  person: string | null;
  /** The name confirmed for it by hand. */
  confirmed: string | null;
  /** The landmark points, x and y interleaved. */
  points: Float32Array;
  /** The unit-length recognition embedding. */
  embedding: Float32Array;
};

export type FacesHeader = {
  deviceId: string;
  deviceLabel: string;
  createdAt: number;
  modelVersion: number;
  modelSha256: string;
  clusterParams: number;
  dim: number;
};

export type FacesSnap = FacesHeader & {
  faces: SnapFace[];
  manual: { name: string; key: string }[];
  notPerson: { name: string; key: string; index: number }[];
  covers: { name: string; key: string }[];
  markers: { key: string; hiRes: boolean }[];
};

export type SearchSnap = {
  deviceId: string;
  deviceLabel: string;
  createdAt: number;
  modelId: string;
  dim: number;
  /** Per photo its vector at half precision, or null for a photo marked as unreadable. */
  vectors: Map<string, Uint16Array | null>;
};

/** Whether a key names a cloud photo every device shares, not a path on one phone. */
export function isPortableKey(key: string): boolean {
  return key.length > 0 && !key.includes("://") && Buffer.byteLength(key, "utf8") <= MAX_STRING_BYTES;
}

// ---- Reading ----

class Reader {
  private at = 0;
  constructor(private readonly buf: Buffer) {}
  get done(): boolean {
    return this.at >= this.buf.length;
  }
  private need(n: number): void {
    if (n < 0 || this.at + n > this.buf.length) throw new RangeError("the snapshot ends early");
  }
  u8(): number {
    this.need(1);
    return this.buf[this.at++];
  }
  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.at);
    this.at += 4;
    return v;
  }
  i64(): number {
    this.need(8);
    const v = Number(this.buf.readBigInt64LE(this.at));
    this.at += 8;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.buf.readFloatLE(this.at);
    this.at += 4;
    return v;
  }
  str(): string {
    this.need(2);
    const length = this.buf.readUInt16LE(this.at);
    this.at += 2;
    this.need(length);
    const out = this.buf.toString("utf8", this.at, this.at + length);
    this.at += length;
    return out;
  }
  floats(n: number): Float32Array {
    this.need(n * 4);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.buf.readFloatLE(this.at + i * 4);
    this.at += n * 4;
    return out;
  }
  halves(n: number): Uint16Array {
    this.need(n * 2);
    const out = new Uint16Array(n);
    for (let i = 0; i < n; i++) out[i] = this.buf.readUInt16LE(this.at + i * 2);
    this.at += n * 2;
    return out;
  }
  expect(tag: number): void {
    const got = this.u8();
    if (got !== tag) throw new Error(`record ${got} where ${tag} belongs`);
  }
}

function open(plain: Buffer, kind: number): { r: Reader; deviceId: string; deviceLabel: string; createdAt: number } {
  if (plain.length < MAGIC.length || !plain.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not a snapshot");
  const r = new Reader(plain.subarray(MAGIC.length));
  const version = r.u32();
  if (version !== SNAPSHOT_VERSION) throw new Error(`snapshot version ${version}`);
  if (r.u8() !== kind) throw new Error("another kind of snapshot");
  return { r, deviceId: r.str(), deviceLabel: r.str(), createdAt: r.i64() };
}

function tables(r: Reader, keyCount: number, personCount: number) {
  const keys: string[] = [];
  for (let i = 0; i < keyCount; i++) {
    r.expect(TAG.KEY);
    keys.push(r.str());
  }
  const names: string[] = [];
  for (let i = 0; i < personCount; i++) {
    r.expect(TAG.PERSON);
    names.push(r.str());
  }
  const key = (i: number) => {
    if (i >= keys.length) throw new Error("unlisted photo");
    return keys[i];
  };
  const name = (i: number) => {
    if (i >= names.length) throw new Error("unlisted person");
    return names[i];
  };
  return { keys, key, name };
}

/** A face snapshot in full. Throws on anything that is not a well-formed version-4 one. */
export function parseFacesSnapshot(plain: Buffer): FacesSnap {
  const { r, deviceId, deviceLabel, createdAt } = open(plain, KIND_FACES);
  const modelVersion = r.u32();
  const modelSha256 = r.str();
  const clusterParams = r.u32();
  const dim = r.u32();
  if (dim === 0 || dim > MAX_EMBEDDING_DIM) throw new Error("embedding of a bad width");
  const [keyCount, personCount, faceCount, manualCount, notPersonCount, coverCount, markerCount] = [
    r.u32(), r.u32(), r.u32(), r.u32(), r.u32(), r.u32(), r.u32(),
  ];
  // Every face takes at least its embedding's bytes, so a count the file cannot hold is
  // refused before anything is allocated for it.
  if (faceCount * dim * 4 > plain.length) throw new Error("more faces than the file holds");
  const t = tables(r, keyCount, personCount);

  const faces: SnapFace[] = [];
  for (let i = 0; i < faceCount; i++) {
    r.expect(TAG.FACE);
    const key = t.key(r.u32());
    const index = r.u32();
    const box: SnapFace["box"] = [r.f32(), r.f32(), r.f32(), r.f32()];
    const score = r.f32();
    const blur = r.f32();
    const flags = r.u8();
    const person = r.u32();
    const confirmed = r.u32();
    const points = r.floats(r.u8() * 2);
    const embedding = r.floats(dim);
    faces.push({
      key,
      index,
      box,
      score,
      blur: flags & FACE_BLUR_KNOWN ? blur : null,
      rejected: !!(flags & FACE_REJECTED),
      person: person === NO_REFERENCE ? null : t.name(person),
      confirmed: confirmed === NO_REFERENCE ? null : t.name(confirmed),
      points,
      embedding,
    });
  }
  const manual: FacesSnap["manual"] = [];
  for (let i = 0; i < manualCount; i++) {
    r.expect(TAG.MANUAL);
    manual.push({ name: t.name(r.u32()), key: t.key(r.u32()) });
  }
  const notPerson: FacesSnap["notPerson"] = [];
  for (let i = 0; i < notPersonCount; i++) {
    r.expect(TAG.NOT_PERSON);
    notPerson.push({ name: t.name(r.u32()), key: t.key(r.u32()), index: r.u32() });
  }
  const covers: FacesSnap["covers"] = [];
  for (let i = 0; i < coverCount; i++) {
    r.expect(TAG.COVER);
    covers.push({ name: t.name(r.u32()), key: t.key(r.u32()) });
  }
  const markers: FacesSnap["markers"] = [];
  for (let i = 0; i < markerCount; i++) {
    r.expect(TAG.MARKER);
    markers.push({ key: t.key(r.u32()), hiRes: !!(r.u8() & SCAN_HI_RES) });
  }
  r.expect(TAG.END);
  if (!r.done) throw new Error("data after the end marker");
  return {
    deviceId, deviceLabel, createdAt, modelVersion, modelSha256, clusterParams, dim,
    faces, manual, notPerson, covers, markers,
  };
}

/** A search snapshot in full, tombstones included. Throws on anything malformed. */
export function parseSearchSnapshot(plain: Buffer): SearchSnap {
  const { r, deviceId, deviceLabel, createdAt } = open(plain, KIND_SEARCH);
  const modelId = r.str();
  const dim = r.u32();
  if (dim === 0 || dim > MAX_EMBEDDING_DIM) throw new Error("embedding of a bad width");
  const keyCount = r.u32();
  const count = r.u32();
  if (count * 6 > plain.length) throw new Error("more vectors than the file holds");
  const t = tables(r, keyCount, 0);
  const vectors = new Map<string, Uint16Array | null>();
  for (let i = 0; i < count; i++) {
    r.expect(TAG.SEARCH);
    const key = t.key(r.u32());
    const flags = r.u8();
    if (flags & ~SEARCH_TOMBSTONE) throw new Error("unknown flag");
    vectors.set(key, flags & SEARCH_TOMBSTONE ? null : r.halves(dim));
  }
  r.expect(TAG.END);
  if (!r.done) throw new Error("data after the end marker");
  return { deviceId, deviceLabel, createdAt, modelId, dim, vectors };
}

// ---- Writing ----

class Writer {
  private parts: Buffer[] = [];
  private cur = Buffer.alloc(64 * 1024);
  private at = 0;
  private room(n: number): void {
    if (this.at + n <= this.cur.length) return;
    this.parts.push(this.cur.subarray(0, this.at));
    this.cur = Buffer.alloc(Math.max(64 * 1024, n));
    this.at = 0;
  }
  u8(v: number): void {
    this.room(1);
    this.cur[this.at++] = v & 0xff;
  }
  u16(v: number): void {
    this.room(2);
    this.cur.writeUInt16LE(v, this.at);
    this.at += 2;
  }
  u32(v: number): void {
    this.room(4);
    this.cur.writeUInt32LE(v >>> 0, this.at);
    this.at += 4;
  }
  i64(v: number): void {
    this.room(8);
    this.cur.writeBigInt64LE(BigInt(Math.trunc(v)), this.at);
    this.at += 8;
  }
  f32(v: number): void {
    this.room(4);
    this.cur.writeFloatLE(v, this.at);
    this.at += 4;
  }
  bytes(b: Buffer): void {
    this.room(b.length);
    b.copy(this.cur, this.at);
    this.at += b.length;
  }
  str(s: string): void {
    const b = Buffer.from(s, "utf8");
    if (b.length > MAX_STRING_BYTES) throw new Error("a string field is too long");
    this.u16(b.length);
    this.bytes(b);
  }
  done(): Buffer {
    return Buffer.concat([...this.parts, this.cur.subarray(0, this.at)]);
  }
}

function head(w: Writer, kind: number, h: { deviceId: string; deviceLabel: string; createdAt: number }): void {
  w.bytes(MAGIC);
  w.u32(SNAPSHOT_VERSION);
  w.u8(kind);
  w.str(h.deviceId);
  w.str(h.deviceLabel);
  w.i64(h.createdAt);
}

/** Numbers each distinct value in first-seen order, the way the writer's tables do. */
function table(values: Iterable<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const v of values) if (!out.has(v)) out.set(v, out.size);
  return out;
}

/**
 * A face snapshot as the Android app writes one. Keys that are not portable and faces whose
 * embedding is not `dim` wide are left out, with the records that name them.
 */
export function writeFacesSnapshot(snap: FacesSnap): Buffer {
  const faces = snap.faces.filter((f) => isPortableKey(f.key) && f.embedding.length === snap.dim);
  const manual = snap.manual.filter((m) => isPortableKey(m.key) && m.name.trim());
  const notPerson = snap.notPerson.filter((m) => isPortableKey(m.key) && m.name.trim());
  const covers = snap.covers.filter((m) => isPortableKey(m.key) && m.name.trim());
  const markers = snap.markers.filter((m) => isPortableKey(m.key));
  const keys = table([
    ...faces.map((f) => f.key),
    ...manual.map((m) => m.key),
    ...notPerson.map((m) => m.key),
    ...covers.map((m) => m.key),
    ...markers.map((m) => m.key),
  ]);
  const names = table([
    ...faces.flatMap((f) => [f.person, f.confirmed].filter((n): n is string => !!n)),
    ...manual.map((m) => m.name),
    ...notPerson.map((m) => m.name),
    ...covers.map((m) => m.name),
  ]);
  const w = new Writer();
  head(w, KIND_FACES, snap);
  w.u32(snap.modelVersion);
  w.str(snap.modelSha256);
  w.u32(snap.clusterParams);
  w.u32(snap.dim);
  for (const n of [keys.size, names.size, faces.length, manual.length, notPerson.length, covers.length, markers.length]) {
    w.u32(n);
  }
  for (const k of keys.keys()) {
    w.u8(TAG.KEY);
    w.str(k);
  }
  for (const n of names.keys()) {
    w.u8(TAG.PERSON);
    w.str(n);
  }
  for (const f of faces) {
    if (f.points.length % 2 || f.points.length / 2 > MAX_LANDMARK_POINTS) throw new Error("bad landmarks");
    w.u8(TAG.FACE);
    w.u32(keys.get(f.key)!);
    w.u32(f.index);
    for (const v of f.box) w.f32(v);
    w.f32(f.score);
    w.f32(f.blur ?? 0);
    w.u8((f.rejected ? FACE_REJECTED : 0) | (f.blur !== null ? FACE_BLUR_KNOWN : 0));
    w.u32(f.person ? names.get(f.person)! : NO_REFERENCE);
    w.u32(f.confirmed ? names.get(f.confirmed)! : NO_REFERENCE);
    w.u8(f.points.length / 2);
    for (const v of f.points) w.f32(v);
    for (const v of f.embedding) w.f32(v);
  }
  for (const m of manual) {
    w.u8(TAG.MANUAL);
    w.u32(names.get(m.name)!);
    w.u32(keys.get(m.key)!);
  }
  for (const m of notPerson) {
    w.u8(TAG.NOT_PERSON);
    w.u32(names.get(m.name)!);
    w.u32(keys.get(m.key)!);
    w.u32(m.index);
  }
  for (const m of covers) {
    w.u8(TAG.COVER);
    w.u32(names.get(m.name)!);
    w.u32(keys.get(m.key)!);
  }
  for (const m of markers) {
    w.u8(TAG.MARKER);
    w.u32(keys.get(m.key)!);
    w.u8(m.hiRes ? SCAN_HI_RES : 0);
  }
  w.u8(TAG.END);
  return w.done();
}

/** A search snapshot as the Android app writes one, tombstones as a bare flag. */
export function writeSearchSnapshot(snap: SearchSnap): Buffer {
  const entries = [...snap.vectors].filter(([key, v]) => isPortableKey(key) && (v === null || v.length === snap.dim));
  const w = new Writer();
  head(w, KIND_SEARCH, snap);
  w.str(snap.modelId);
  w.u32(snap.dim);
  w.u32(entries.length);
  w.u32(entries.length);
  for (const [key] of entries) {
    w.u8(TAG.KEY);
    w.str(key);
  }
  entries.forEach(([, vector], i) => {
    w.u8(TAG.SEARCH);
    w.u32(i);
    if (vector === null) {
      w.u8(SEARCH_TOMBSTONE);
      return;
    }
    w.u8(0);
    const b = Buffer.alloc(vector.length * 2);
    for (let d = 0; d < vector.length; d++) b.writeUInt16LE(vector[d], d * 2);
    w.bytes(b);
  });
  w.u8(TAG.END);
  return w.done();
}

// ---- Half precision ----

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** `value` rounded to the nearest half, ties to even, as the half's bits: the phone's rule. */
export function floatToHalf(value: number): number {
  f32[0] = value;
  const bits = u32[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x7fffff;
  if (exponent === 0xff) return mantissa === 0 ? sign | 0x7c00 : sign | 0x7e00 | (mantissa >>> 13);
  const e = exponent - 112;
  const round = (v: number, shift: number) => {
    const kept = v >>> shift;
    const dropped = v & ((1 << shift) - 1);
    const half = 1 << (shift - 1);
    return dropped > half || (dropped === half && (kept & 1) === 1) ? kept + 1 : kept;
  };
  if (e >= 0x1f) return sign | 0x7c00;
  if (e > 0) return sign | ((e << 10) + round(mantissa, 13));
  if (e >= -10) return sign | round(mantissa | 0x800000, 14 - e);
  return sign;
}

/** A unit vector at half precision, as the search snapshot stores one. */
export function toHalves(vector: Float32Array): Uint16Array {
  const out = new Uint16Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = floatToHalf(vector[i]);
  return out;
}

/**
 * `plain` (a snapshot) with its save time zeroed: what two saves of the same index share,
 * byte for byte, whenever they were made. The time sits after the magic, the version, the
 * kind and the two length-prefixed device strings.
 */
export function withoutSaveTime(plain: Buffer): Buffer {
  let at = MAGIC.length + 4 + 1;
  for (let i = 0; i < 2; i++) {
    if (at + 2 > plain.length) return plain;
    at += 2 + plain.readUInt16LE(at);
  }
  if (at + 8 > plain.length) return plain;
  const out = Buffer.from(plain);
  out.fill(0, at, at + 8);
  return out;
}
