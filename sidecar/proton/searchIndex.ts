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

// The search by what a photo shows, indexed on this computer: the phone's CLIP image encoder
// run over each photo's large preview, the vectors kept at half precision, sealed, beside the
// faces, in the same space the phone's index and the text encoder share.

import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { coverSquare, type Decoded } from "./phoneDecode.ts";
import { pinnedModel } from "./pinnedModel.ts";
import { EMBEDDING_DIM, SEARCH_MODEL_ID, halfToFloatTable, type SearchCopy } from "./semantic.ts";
import { SEARCH_DIR, readSealedOrDiscard, storeDir, writeSealedAtomic } from "./store.ts";

/** The phone's CLIP image encoder, pinned to the release's bytes. */
export const IMAGE_MODEL = {
  url: "https://github.com/gitakoos/clip-models/releases/download/v1/clip_image.onnx",
  file: "clip_image.onnx",
  size: 172_680_414,
  sha256: "57bd1d3bc57e74d99a14a1ef0d1de717049dc2a14cb867a5927907a88c4eecaf",
};

export const imageModel = pinnedModel(IMAGE_MODEL, "semantic");

/** The square the encoder reads. */
export const CLIP_SIDE = 224;
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711];

/**
 * A decoded photo as the encoder reads it, as the phone lays it out: scaled to cover the square,
 * centre-cropped, then each channel scaled to 0..1 and normalised by the CLIP mean and spread,
 * red, green and blue planes one after another.
 */
export function clipInputFrom(img: Decoded): Float32Array {
  return clipPlanes(coverSquare(img, CLIP_SIDE));
}

/** RGB bytes of the square as the encoder's normalised planes. */
export function clipPlanes(rgb: Uint8Array): Float32Array {
  const plane = CLIP_SIDE * CLIP_SIDE;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) out[c * plane + i] = (rgb[i * 3 + c] / 255 - CLIP_MEAN[c]) / CLIP_STD[c];
  }
  return out;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** A 32-bit float as the nearest IEEE half, as the phone stores its vectors. */
export function floatToHalf(value: number): number {
  f32[0] = value;
  const x = u32[0];
  let bits = (x >>> 16) & 0x8000;
  // The mantissa with one more bit, for rounding.
  let m = (x >>> 12) & 0x07ff;
  const e = (x >>> 23) & 0xff;
  if (e < 103) return bits;
  if (e > 142) {
    bits |= 0x7c00;
    if (e === 255 && x & 0x007fffff) bits |= 0x200;
    return bits;
  }
  if (e < 113) {
    m |= 0x0800;
    return bits | ((m >>> (114 - e)) + ((m >>> (113 - e)) & 1));
  }
  bits |= ((e - 112) << 10) | (m >>> 1);
  return bits + (m & 1);
}

/** A unit vector at half precision. */
export function toHalves(vector: Float32Array): Uint16Array {
  let n = 0;
  for (const v of vector) n += v * v;
  const inv = n > 0 ? 1 / Math.sqrt(n) : 0;
  return Uint16Array.from(vector, (v) => floatToHalf(v * inv));
}

const SHARDS = 64;
const MAGIC = 0x53504650; // "PFPS"
const FORMAT = 1;
const TOMBSTONE = 0x01;
const MODEL_FILE = "model.enc";
/** What the vectors here were made with: the model, and the full-resolution original it read.
 *  An index made any other way is dropped and made again. */
const INDEX_KIND = `${SEARCH_MODEL_ID}|original`;

function shardOf(uid: string): number {
  return createHash("sha256").update(uid).digest()[0] % SHARDS;
}

/** A photo's vector at half precision, or null for one that could not be read: never read again. */
type Shard = Map<string, Uint16Array | null>;

export function encodeShard(shard: Shard): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.writeUInt32LE(MAGIC, 0);
  head.writeUInt32LE(FORMAT, 4);
  head.writeUInt32LE(shard.size, 8);
  parts.push(head);
  for (const [uid, vector] of shard) {
    const name = Buffer.from(uid, "utf8");
    const len = Buffer.alloc(3);
    len.writeUInt16LE(name.length, 0);
    len.writeUInt8(vector ? 0 : TOMBSTONE, 2);
    parts.push(len.subarray(0, 2), name, len.subarray(2));
    if (vector) parts.push(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength));
  }
  return Buffer.concat(parts);
}

export function decodeShard(buf: Buffer): Shard {
  if (buf.length < 12 || buf.readUInt32LE(0) !== MAGIC || buf.readUInt32LE(4) !== FORMAT) {
    throw new Error("not a search shard");
  }
  const shard: Shard = new Map();
  const count = buf.readUInt32LE(8);
  let o = 12;
  for (let i = 0; i < count; i++) {
    const len = buf.readUInt16LE(o);
    o += 2;
    const uid = buf.toString("utf8", o, o + len);
    o += len;
    const flags = buf.readUInt8(o++);
    if (flags & TOMBSTONE) {
      shard.set(uid, null);
      continue;
    }
    const vector = new Uint16Array(EMBEDDING_DIM);
    for (let k = 0; k < EMBEDDING_DIM; k++) vector[k] = buf.readUInt16LE(o + k * 2);
    o += EMBEDDING_DIM * 2;
    shard.set(uid, vector);
  }
  return shard;
}

/**
 * The vectors of every photo indexed here, held in memory and written back shard by shard,
 * sealed like the rest of the store. Vectors of another model are dropped on load.
 */
export class SearchStore {
  private shards: Shard[] = [];
  private dirty = new Set<number>();
  private loaded = false;
  /** Bumped by every change, so the copy the search reads is made again only when needed. */
  version = 0;
  private copyCache: { version: number; copy: SearchCopy } | null = null;

  private dir(): string {
    return join(storeDir(), SEARCH_DIR);
  }

  private shardPath(n: number): string {
    return join(this.dir(), `s${String(n).padStart(2, "0")}.enc`);
  }

  load(): void {
    if (this.loaded) return;
    this.shards = Array.from({ length: SHARDS }, () => new Map());
    mkdirSync(this.dir(), { recursive: true });
    const model = readSealedOrDiscard(join(this.dir(), MODEL_FILE))?.toString("utf8");
    if (model === INDEX_KIND) {
      for (let n = 0; n < SHARDS; n++) {
        const blob = readSealedOrDiscard(this.shardPath(n));
        if (!blob) continue;
        try {
          this.shards[n] = decodeShard(blob);
        } catch {
          this.shards[n] = new Map();
        }
      }
    } else {
      for (let n = 0; n < SHARDS; n++) rmSync(this.shardPath(n), { force: true });
      writeSealedAtomic(join(this.dir(), MODEL_FILE), Buffer.from(INDEX_KIND, "utf8"));
    }
    this.loaded = true;
    this.version++;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  has(uid: string): boolean {
    return this.loaded && this.shards[shardOf(uid)].has(uid);
  }

  /** A photo's vector; null for one that could not be read, undefined for one not indexed. */
  get(uid: string): Uint16Array | null | undefined {
    return this.loaded ? this.shards[shardOf(uid)].get(uid) : undefined;
  }

  put(uid: string, vector: Uint16Array | null): void {
    if (!this.loaded) return;
    const n = shardOf(uid);
    this.shards[n].set(uid, vector);
    this.dirty.add(n);
    this.version++;
  }

  /** Moves a photo's vector to the uid of the copy that replaced it. False when there was none to move. */
  move(oldUid: string, newUid: string): boolean {
    if (!this.loaded || oldUid === newUid || this.has(newUid)) return false;
    const from = shardOf(oldUid);
    if (!this.shards[from].has(oldUid)) return false;
    const vector = this.shards[from].get(oldUid) ?? null;
    this.shards[from].delete(oldUid);
    this.dirty.add(from);
    this.put(newUid, vector);
    return true;
  }

  keepOnly(uids: Set<string>): void {
    for (let n = 0; n < this.shards.length; n++) {
      for (const uid of [...this.shards[n].keys()]) {
        if (uids.has(uid)) continue;
        this.shards[n].delete(uid);
        this.dirty.add(n);
        this.version++;
      }
    }
  }

  /** How many photos have a vector, as against the ones that could not be read. */
  counts(): { indexed: number; unreadable: number } {
    let indexed = 0;
    let unreadable = 0;
    for (const shard of this.shards) for (const v of shard.values()) v ? indexed++ : unreadable++;
    return { indexed, unreadable };
  }

  /** Every vector, keyed by the photo's Drive link id, as the search ranks the phone's. */
  copy(): SearchCopy {
    if (this.copyCache?.version === this.version) return this.copyCache.copy;
    const keys: string[] = [];
    const vectors: Uint16Array[] = [];
    for (const shard of this.shards) {
      for (const [uid, v] of shard) {
        if (!v) continue;
        keys.push(uid.slice(uid.indexOf("~") + 1));
        vectors.push(v);
      }
    }
    const flat = new Uint16Array(keys.length * EMBEDDING_DIM);
    vectors.forEach((v, i) => flat.set(v, i * EMBEDDING_DIM));
    const copy = { keys, vectors: flat };
    this.copyCache = { version: this.version, copy };
    return copy;
  }

  /** Each photo's vector, by uid, for setting beside another device's. */
  entries(): [string, Uint16Array | null][] {
    const out: [string, Uint16Array | null][] = [];
    for (const shard of this.shards) out.push(...shard);
    return out;
  }

  flush(): void {
    if (!this.loaded) return;
    mkdirSync(this.dir(), { recursive: true });
    for (const n of [...this.dirty]) {
      writeSealedAtomic(this.shardPath(n), encodeShard(this.shards[n]));
      this.dirty.delete(n);
    }
  }

  clear(): void {
    this.shards = Array.from({ length: SHARDS }, () => new Map());
    this.dirty.clear();
    for (let n = 0; n < SHARDS; n++) rmSync(this.shardPath(n), { force: true });
    this.loaded = true;
    this.version++;
  }

  unload(): void {
    this.shards = [];
    this.dirty.clear();
    this.loaded = false;
    this.copyCache = null;
  }
}

/**
 * Fills the photos of `uidByLink` that have no vector here from other devices' copies, each copy's
 * keys being Drive link ids. A vector made here, or one taken in before, is never replaced, and a
 * photo another device could not read is left for this one to read. Answers how many were filled.
 */
export function fillFromCopies(
  store: Pick<SearchStore, "get" | "put">,
  copies: SearchCopy[],
  uidByLink: Map<string, string>,
): number {
  let filled = 0;
  for (const copy of copies) {
    if (copy.vectors.length !== copy.keys.length * EMBEDDING_DIM) continue;
    copy.keys.forEach((key, i) => {
      const uid = uidByLink.get(key);
      if (!uid || store.get(uid)) return;
      const vector = copy.vectors.slice(i * EMBEDDING_DIM, (i + 1) * EMBEDDING_DIM);
      if (vector.every((v) => v === 0)) return;
      store.put(uid, vector);
      filled++;
    });
  }
  return filled;
}

/**
 * How alike this computer's vectors and the phone's came out, photo by photo: the cosine of each
 * photo both indexed, as the middle, the low and high tenth, and the share at 0.95 or more.
 */
export function compareSearch(local: SearchCopy, phone: SearchCopy[]): {
  pairs: number;
  median: number;
  p10: number;
  p90: number;
  close: number;
} {
  const table = halfToFloatTable();
  const at = new Map<string, number>();
  local.keys.forEach((k, i) => at.set(k, i));
  const cos: number[] = [];
  for (const copy of phone) {
    copy.keys.forEach((key, j) => {
      const i = at.get(key);
      if (i === undefined) return;
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let d = 0; d < EMBEDDING_DIM; d++) {
        const a = table[local.vectors[i * EMBEDDING_DIM + d]];
        const b = table[copy.vectors[j * EMBEDDING_DIM + d]];
        dot += a * b;
        na += a * a;
        nb += b * b;
      }
      // A phone tombstone is all zeros: not a photo both could read.
      if (na > 0 && nb > 0) cos.push(dot / Math.sqrt(na * nb));
    });
  }
  cos.sort((a, b) => a - b);
  const q = (p: number) => (cos.length ? cos[Math.min(cos.length - 1, Math.floor(p * cos.length))] : 0);
  return {
    pairs: cos.length,
    median: q(0.5),
    p10: q(0.1),
    p90: q(0.9),
    close: cos.length ? cos.filter((c) => c >= 0.95).length / cos.length : 0,
  };
}
