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

// The faces found on this computer and the people made of them, kept sealed with the store's
// key like everything else the app keeps. The faces are split over SHARDS files by photo, so a
// scan that adds a few photos rewrites a small part of a large library rather than all of it;
// the people, the names and every choice the user made sit in one small file of their own.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { adoptDeviceId } from "./deviceId.ts";
import { FACE_EMBEDDING_DIM } from "./faceCluster.ts";
import { curationKey, foldPersonName, legacyFoldPersonName } from "./personName.ts";
import { FACES_DIR, PEOPLE_FILE, readSealedOrDiscard, storeDir, writeSealedAtomic } from "./store.ts";

const SHARDS = 64;
const MAGIC = 0x50465046; // "PFPF"
/**
 * Generation 2 holds the landmarks in the pixels of the picture read, a flags byte and a two-byte
 * face count per photo; generation 1, read still, held the landmarks as shares of the picture and
 * the count in seven bits.
 */
const FORMAT = 2;
const FORMAT_SHARES = 1;

/**
 * Which detector, recognition model and quality gate made the stored faces; a change clears them and
 * holds the names over for the faces the new scan finds.
 */
export const FACE_MODEL_VERSION = 7;

export type FaceRecord = {
  /** `<photo uid>#<index>`. */
  id: string;
  uid: string;
  /** Left, top, right, bottom, each 0 to 1 of the photo. */
  box: [number, number, number, number];
  /** The five landmarks, x then y, in the pixels of the picture read, as the phone keeps them; none when not known. */
  points: number[];
  score: number;
  blur: number;
  sideways: number;
  embedding: Float32Array;
};

export type Person = {
  id: string;
  name: string | null;
  /** The leftovers no group took: never shown as someone to name. */
  isOther: boolean;
};

/** A piece of a person's curation and when it was last set or taken away by hand. */
export type Curation = { kind: 1 | 2 | 3; name: string; ref: string; removed: boolean; at: number };

/**
 * A name, a "not this person" mark or a removal held over a change of the face models, by the photo
 * and where on it the face sat, until the photo is looked at again with the new models.
 */
export type HeldOver = {
  uid: string;
  box: [number, number, number, number];
  kind: "name" | "not" | "rejected";
  /** The person's name; empty for a removal. */
  name: string;
};

/** Everything the user decided, and the grouping it applies to. */
export type PeopleState = {
  version: number;
  people: Person[];
  /** Face id to person id. */
  assign: Record<string, string>;
  /** Face id to the name the user confirmed it as. */
  confirmed: Record<string, string>;
  /** Face id to the names it was marked as not being. */
  blocked: Record<string, string[]>;
  /** Faces marked as not a person at all. */
  rejected: string[];
  /** Person name to the photo picked as its cover. */
  covers: Record<string, string>;
  /** Person name to the photos (link ids) attached to the person by hand on another device. */
  manual: Record<string, string[]>;
  /** When the person of each name got it, epoch ms, by the name as `foldPersonName` folds it. */
  namedAt: Record<string, number>;
  /** The renames and merges made by hand, and taken in from other devices, oldest first. */
  nameChanges: { from: string; to: string; at: number }[];
  /**
   * When each piece of curation was set or taken away by hand, here or on another device, by
   * `curationKey`: a "not this person" mark (kind 2, the face as `link#index`), a cover (kind 3),
   * or a photo attached to a person on the phone (kind 1, its link id).
   */
  curation: Record<string, Curation>;
  /** Whether the first whole-library grouping has run. */
  grouped: boolean;
  nextId: number;
  /** This install's id among the devices that save to Drive, made the first time it saves. */
  deviceId: string | null;
  /** Each other device's face copy taken in, by device id, at the time that copy was made. */
  applied: Record<string, number>;
  /** The layout generation of this file; older ones are brought up to date on load. */
  format: number;
  /** What a change of the face models left waiting for its photos to be looked at again. */
  heldOver: HeldOver[];
  /** The generation of the keys `namedAt` and `curation` are kept under; see [NAME_KEYS]. */
  nameKeys: number;
  /**
   * Faces confirmed as one person here and as another on a device whose copy was taken in, by
   * face id: the name there, the device, and when its copy was made. Neither side's confirmation
   * outranks the other's, so the face keeps its name here until someone decides; a split of the
   * person here offers these first. Gone once both sides agree, or a hand decides it here.
   */
  conflicts: Record<string, Conflict>;
  /**
   * Faces whose confirmation here was taken in from another device's copy, by face id: that
   * device. Such a confirmation follows that device when it changes there, as one made by hand
   * here does not. Gone once the face is decided by hand here.
   */
  confirmedFrom: Record<string, string>;
};

/** A face confirmed differently on another device: see `PeopleState.conflicts`. */
export type Conflict = { there: string; device: string; at: number };

/** Generation 2: names are keyed by `foldPersonName` with their accents kept, as the phone keys them;
 *  generation 1 dropped the accents, and its keys are brought up to date on load by [rekeyNames]. */
const NAME_KEYS = 2;

/**
 * Puts the keys an older build stored names under (accents dropped) onto today's fold: each piece of
 * curation under the key its own name gives, the later one kept where two now meet, and each naming time
 * under every name that the old key stood for.
 */
export function rekeyNames(p: PeopleState): void {
  const curation: Record<string, Curation> = {};
  for (const c of Object.values(p.curation)) {
    const key = curationKey(c.kind, c.name, c.ref);
    const held = curation[key];
    if (!held || held.at < c.at) curation[key] = c;
  }
  p.curation = curation;
  const names = new Set<string>();
  for (const x of p.people) if (x.name) names.add(x.name);
  for (const c of p.nameChanges) {
    names.add(c.from);
    if (c.to) names.add(c.to);
  }
  for (const c of Object.values(p.curation)) names.add(c.name);
  for (const name of Object.values(p.confirmed)) names.add(name);
  for (const name of Object.keys(p.covers)) names.add(name);
  for (const name of Object.keys(p.manual)) names.add(name);
  for (const h of p.heldOver) if (h.name) names.add(h.name);
  const namedAt: Record<string, number> = {};
  for (const name of names) {
    const at = p.namedAt[legacyFoldPersonName(name)];
    if (at === undefined) continue;
    const key = foldPersonName(name);
    namedAt[key] = Math.max(namedAt[key] ?? 0, at);
  }
  p.namedAt = namedAt;
}

/** Generation 2: faces taken from another device are written whole; the copies taken in before
 *  that are taken in again, since what they brought may have been lost. */
const PEOPLE_FORMAT = 2;

export function emptyPeople(): PeopleState {
  return {
    version: FACE_MODEL_VERSION,
    people: [],
    assign: {},
    confirmed: {},
    blocked: {},
    rejected: [],
    covers: {},
    manual: {},
    namedAt: {},
    nameChanges: [],
    curation: {},
    grouped: false,
    nextId: 1,
    deviceId: null,
    applied: {},
    format: PEOPLE_FORMAT,
    heldOver: [],
    nameKeys: NAME_KEYS,
    conflicts: {},
    confirmedFrom: {},
  };
}

/** How much two boxes overlap: their intersection over their union. */
export function boxOverlap(a: readonly number[], b: readonly number[]): number {
  const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = iw * ih;
  const area = (r: readonly number[]) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
  const union = area(a) + area(b) - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Two boxes overlapping at least this much are the same face. */
export const SAME_FACE_IOU = 0.5;

/**
 * Pairs the boxes of `from` with those of `to` overlapping at least SAME_FACE_IOU, the strongest
 * overlap first and each box once: index in `from` to index in `to`.
 */
export function pairBoxes(from: readonly (readonly number[])[], to: readonly (readonly number[])[]): Map<number, number> {
  const options: { a: number; b: number; overlap: number }[] = [];
  from.forEach((a, i) =>
    to.forEach((b, j) => {
      const overlap = boxOverlap(a, b);
      if (overlap >= SAME_FACE_IOU) options.push({ a: i, b: j, overlap });
    }),
  );
  options.sort((x, y) => y.overlap - x.overlap || x.a - y.a || x.b - y.b);
  const pairs = new Map<number, number>();
  const taken = new Set<number>();
  for (const o of options) {
    if (pairs.has(o.a) || taken.has(o.b)) continue;
    pairs.set(o.a, o.b);
    taken.add(o.b);
  }
  return pairs;
}

/** The highest face index a shard keeps. */
export const MAX_FACE_INDEX = 255;

/** Photos a listing may lose at once before how much it lost is weighed against the library. */
const UNTRUSTED_DROP_FLOOR = 20;

const indexIn = (faceId: string) => Number(faceId.slice(faceId.lastIndexOf("#") + 1));

function shardOf(uid: string): number {
  return createHash("sha256").update(uid).digest()[0] % SHARDS;
}

function dir(): string {
  return join(storeDir(), FACES_DIR);
}

function shardPath(n: number): string {
  return join(dir(), `s${String(n).padStart(2, "0")}.enc`);
}


/** The photos of one shard: each scanned photo with its faces (none for a photo without any). */
export type Shard = Map<string, FaceRecord[]>;

const FLOATS_PER_FACE = 4 + 10 + 3 + FACE_EMBEDDING_DIM;

/** The flags byte's bit for a photo looked at again by "Find more photos". */
const SWEPT = 0x01;
/** In generation 1, the face count byte's top bit said the same. */
const SWEPT_SHARES = 0x80;

export function encodeShard(shard: Shard, swept: Set<string> = new Set()): Buffer {
  let size = 12;
  const names: Buffer[] = [];
  for (const [uid, faces] of shard) {
    const name = Buffer.from(uid, "utf8");
    names.push(name);
    size += 2 + name.length + 1 + 2 + Math.min(faces.length, 0xffff) * (1 + FLOATS_PER_FACE * 4);
  }
  const out = Buffer.alloc(size);
  out.writeUInt32LE(MAGIC, 0);
  out.writeUInt32LE(FORMAT, 4);
  out.writeUInt32LE(shard.size, 8);
  let o = 12;
  let n = 0;
  for (const [uid, all] of shard) {
    const faces = all.slice(0, 0xffff);
    const name = names[n++];
    out.writeUInt16LE(name.length, o);
    o += 2;
    name.copy(out, o);
    o += name.length;
    out.writeUInt8(swept.has(uid) ? SWEPT : 0, o++);
    out.writeUInt16LE(faces.length, o);
    o += 2;
    for (const f of faces) {
      out.writeUInt8(indexIn(f.id) & 0xff, o++);
      // Always ten landmark values: a face taken from another device may carry none, and a
      // shorter record would throw every record after it off.
      const points = Array.from({ length: 10 }, (_, i) => f.points[i] ?? 0);
      for (const v of [...f.box, ...points, f.score, f.blur, f.sideways]) {
        out.writeFloatLE(v, o);
        o += 4;
      }
      for (let i = 0; i < FACE_EMBEDDING_DIM; i++) {
        out.writeFloatLE(f.embedding[i] ?? 0, o);
        o += 4;
      }
    }
  }
  return out;
}

export function decodeShard(buf: Buffer): Shard {
  return readShard(buf).shard;
}

/** A shard's photos and which of them "Find more photos" has looked at already. */
export function readShard(buf: Buffer): { shard: Shard; swept: Set<string> } {
  const shard: Shard = new Map();
  const swept = new Set<string>();
  const format = buf.length >= 12 && buf.readUInt32LE(0) === MAGIC ? buf.readUInt32LE(4) : -1;
  if (format !== FORMAT && format !== FORMAT_SHARES) throw new Error("not a face shard");
  const count = buf.readUInt32LE(8);
  let o = 12;
  for (let p = 0; p < count; p++) {
    const len = buf.readUInt16LE(o);
    o += 2;
    const uid = buf.toString("utf8", o, o + len);
    o += len;
    let faceCount: number;
    if (format === FORMAT) {
      if (buf.readUInt8(o++) & SWEPT) swept.add(uid);
      faceCount = buf.readUInt16LE(o);
      o += 2;
    } else {
      const flags = buf.readUInt8(o++);
      faceCount = flags & ~SWEPT_SHARES;
      if (flags & SWEPT_SHARES) swept.add(uid);
    }
    const faces: FaceRecord[] = [];
    for (let k = 0; k < faceCount; k++) {
      const index = buf.readUInt8(o++);
      const floats: number[] = [];
      for (let i = 0; i < 17; i++) {
        floats.push(buf.readFloatLE(o));
        o += 4;
      }
      const embedding = new Float32Array(FACE_EMBEDDING_DIM);
      for (let i = 0; i < FACE_EMBEDDING_DIM; i++) {
        embedding[i] = buf.readFloatLE(o);
        o += 4;
      }
      faces.push({
        id: `${uid}#${index}`,
        uid,
        box: [floats[0], floats[1], floats[2], floats[3]],
        // Shares of a picture whose size was not kept cannot be turned into its pixels: none.
        points: format === FORMAT ? floats.slice(4, 14) : [],
        score: floats[14],
        blur: floats[15],
        sideways: floats[16],
        embedding,
      });
    }
    shard.set(uid, faces);
  }
  return { shard, swept };
}

/**
 * The faces of every scanned photo, held in memory and written back shard by shard: `put`
 * marks a shard changed and `flush` writes the changed ones.
 */
export class FaceStore {
  private shards: Shard[] = [];
  private swept: Set<string>[] = [];
  private dirty = new Set<number>();
  private peopleDirty = false;
  people: PeopleState = emptyPeople();
  /** Counts the user's changes, so a regroup that ran across one knows to throw its result away. */
  edits = 0;
  private loaded = false;

  /** Reads what is on disk, once. Faces from another pipeline generation are dropped. */
  load(): void {
    if (this.loaded) return;
    this.shards = Array.from({ length: SHARDS }, () => new Map());
    this.swept = Array.from({ length: SHARDS }, () => new Set());
    mkdirSync(dir(), { recursive: true });
    const people = readSealedOrDiscard(join(dir(), PEOPLE_FILE));
    let parsed: PeopleState | null = null;
    if (people) {
      try {
        const raw = JSON.parse(people.toString("utf8")) as Partial<PeopleState>;
        // A file from before the format was recorded is the first generation.
        parsed = { ...emptyPeople(), ...raw, format: raw.format ?? 1, nameKeys: raw.nameKeys ?? 1 };
      } catch {
        parsed = null;
      }
    }
    if (parsed && parsed.version === FACE_MODEL_VERSION) {
      this.people = parsed;
      let lost = false;
      for (let n = 0; n < SHARDS; n++) {
        const blob = readSealedOrDiscard(shardPath(n));
        if (!blob) continue;
        try {
          const read = readShard(blob);
          this.shards[n] = read.shard;
          this.swept[n] = read.swept;
        } catch {
          this.shards[n] = new Map();
          lost = true;
        }
      }
      // Its photos are looked at again; what the other devices' copies brought to them is taken
      // in again too, which fills only what is missing.
      if (lost || this.people.format < PEOPLE_FORMAT) {
        this.people.applied = {};
        this.people.format = PEOPLE_FORMAT;
        this.peopleDirty = true;
      }
    } else {
      // Nothing yet, or another generation's faces, whose ids every choice pointed at: the faces start
      // over, and the names, marks and removals wait by where each face sat for the new scan to find it.
      this.people = parsed ? this.heldOverFrom(parsed) : emptyPeople();
      this.clearFiles();
      this.peopleDirty = true;
    }
    if (this.people.nameKeys < NAME_KEYS) {
      rekeyNames(this.people);
      this.people.nameKeys = NAME_KEYS;
      this.peopleDirty = true;
    }
    // A face copy saved before the install had one id for all its copies keeps its id.
    if (this.people.deviceId) adoptDeviceId(this.people.deviceId);
    this.loaded = true;
  }

  /**
   * What a change of the face models keeps of `old`: every name, "not this person" mark and removal
   * on a face, held by its photo and box, besides what was held over already; the renames, the naming
   * times, the covers, the curation times and this install's id. The other devices' copies are taken
   * in again.
   */
  private heldOverFrom(old: PeopleState): PeopleState {
    const next = emptyPeople();
    const nameOf = new Map<string, string>();
    for (const person of old.people ?? []) if (person.name) nameOf.set(person.id, person.name);
    const held: HeldOver[] = [...(old.heldOver ?? [])];
    const rejected = new Set(old.rejected ?? []);
    for (let n = 0; n < SHARDS; n++) {
      const blob = readSealedOrDiscard(shardPath(n));
      if (!blob) continue;
      let shard: Shard;
      try {
        shard = readShard(blob).shard;
      } catch {
        continue;
      }
      for (const faces of shard.values()) {
        for (const f of faces) {
          if (rejected.has(f.id)) {
            held.push({ uid: f.uid, box: f.box, kind: "rejected", name: "" });
            continue;
          }
          const owner = old.assign?.[f.id];
          const name = old.confirmed?.[f.id] ?? (owner ? nameOf.get(owner) : undefined);
          if (name) held.push({ uid: f.uid, box: f.box, kind: "name", name });
          for (const not of old.blocked?.[f.id] ?? []) held.push({ uid: f.uid, box: f.box, kind: "not", name: not });
        }
      }
    }
    next.heldOver = held;
    next.covers = { ...(old.covers ?? {}) };
    next.manual = { ...(old.manual ?? {}) };
    next.namedAt = { ...(old.namedAt ?? {}) };
    next.nameChanges = [...(old.nameChanges ?? [])];
    next.curation = { ...(old.curation ?? {}) };
    next.nameKeys = old.nameKeys ?? 1;
    next.deviceId = old.deviceId ?? null;
    next.nextId = Math.max(1, old.nextId ?? 1);
    return next;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  has(uid: string): boolean {
    return this.loaded && this.shards[shardOf(uid)].has(uid);
  }

  facesOf(uid: string): FaceRecord[] {
    return this.loaded ? (this.shards[shardOf(uid)].get(uid) ?? []) : [];
  }

  /** Whether "Find more photos" has looked at this photo already. */
  isSwept(uid: string): boolean {
    return this.loaded && this.swept[shardOf(uid)].has(uid);
  }

  markSwept(uid: string): void {
    if (!this.loaded) return;
    const n = shardOf(uid);
    this.swept[n].add(uid);
    this.dirty.add(n);
  }

  /** A no-op once unloaded: a run still finishing after a lock writes nothing. */
  put(uid: string, faces: FaceRecord[]): void {
    if (!this.loaded) return;
    const n = shardOf(uid);
    this.shards[n].set(uid, faces);
    this.dirty.add(n);
  }

  /**
   * Moves a photo's faces to the uid of the copy that replaced it, with its "looked at" mark. When the
   * new uid was not scanned, each face keeps its index. When it was, the two sets are put together: a
   * face sitting where one of the new photo's faces sits is that face (`merged`), and the others move
   * over under their own index when it is free there, else the lowest free one. Answers each old face
   * id with the new one it went to; null when the photo was never scanned here.
   */
  movePhoto(oldUid: string, newUid: string): { ids: Map<string, string>; merged: Set<string> } | null {
    if (!this.loaded || oldUid === newUid) return null;
    const from = shardOf(oldUid);
    const faces = this.shards[from].get(oldUid);
    if (!faces) return null;
    const to = shardOf(newUid);
    const ids = new Map<string, string>();
    const merged = new Set<string>();
    const present = this.shards[to].get(newUid);
    let next: FaceRecord[];
    if (!present) {
      next = faces.map((f) => {
        const id = `${newUid}#${indexIn(f.id)}`;
        ids.set(f.id, id);
        return { ...f, id, uid: newUid };
      });
    } else {
      const pairs = pairBoxes(
        faces.map((f) => f.box),
        present.map((f) => f.box),
      );
      next = [...present];
      const taken = new Set(present.map((f) => indexIn(f.id)));
      const unpaired: FaceRecord[] = [];
      faces.forEach((f, i) => {
        const j = pairs.get(i);
        if (j === undefined) {
          unpaired.push(f);
          return;
        }
        ids.set(f.id, present[j].id);
        merged.add(f.id);
      });
      unpaired.sort((a, b) => indexIn(a.id) - indexIn(b.id));
      const place = (f: FaceRecord, index: number) => {
        taken.add(index);
        const id = `${newUid}#${index}`;
        ids.set(f.id, id);
        next.push({ ...f, id, uid: newUid });
      };
      const rest: FaceRecord[] = [];
      for (const f of unpaired) {
        if (taken.has(indexIn(f.id))) rest.push(f);
        else place(f, indexIn(f.id));
      }
      let free = 0;
      for (const f of rest) {
        while (taken.has(free)) free++;
        if (free > MAX_FACE_INDEX) break;
        place(f, free);
      }
    }
    this.shards[from].delete(oldUid);
    this.shards[to].set(newUid, next);
    if (this.swept[from].delete(oldUid)) this.swept[to].add(newUid);
    this.dirty.add(from);
    this.dirty.add(to);
    return { ids, merged };
  }

  /**
   * Drops photos no longer in the library (`uids`), with every choice that pointed at their faces,
   * keeping those in the Drive trash (`trashed`, by link id), which can still come back. A listing
   * that would drop more than half of the photos scanned, past a handful, is not trusted, nor an
   * empty one: nothing is dropped. Answers how many photos were dropped.
   */
  keepOnly(uids: Set<string>, trashed: Set<string> = new Set()): number {
    if (!this.loaded || uids.size === 0) return 0;
    const gone: [number, string][] = [];
    let scanned = 0;
    for (let n = 0; n < this.shards.length; n++) {
      for (const uid of this.shards[n].keys()) {
        scanned++;
        if (!uids.has(uid) && !trashed.has(uid.slice(uid.indexOf("~") + 1))) gone.push([n, uid]);
      }
    }
    if (gone.length > UNTRUSTED_DROP_FLOOR && gone.length * 2 > scanned) return 0;
    const ids = new Set<string>();
    for (const [n, uid] of gone) {
      for (const f of this.shards[n].get(uid) ?? []) ids.add(f.id);
      this.shards[n].delete(uid);
      this.swept[n].delete(uid);
      this.dirty.add(n);
    }
    if (ids.size > 0) this.forgetFaces(ids);
    return gone.length;
  }

  private forgetFaces(ids: Set<string>): void {
    const p = this.people;
    for (const id of ids) {
      delete p.assign[id];
      delete p.confirmed[id];
      delete p.blocked[id];
    }
    p.rejected = p.rejected.filter((id) => !ids.has(id));
    this.markPeople();
  }

  /** Every scanned photo's uid. */
  scanned(): string[] {
    const out: string[] = [];
    for (const shard of this.shards) for (const uid of shard.keys()) out.push(uid);
    return out;
  }

  /** Every face kept, in a stable order. */
  allFaces(): FaceRecord[] {
    const out: FaceRecord[] = [];
    for (const shard of this.shards) for (const faces of shard.values()) out.push(...faces);
    return out;
  }

  markPeople(): void {
    this.peopleDirty = true;
  }

  /** Writes what changed. Throws what the write threw; what was not written stays marked. */
  flush(): void {
    if (!this.loaded) return;
    mkdirSync(dir(), { recursive: true });
    for (const n of [...this.dirty]) {
      writeSealedAtomic(shardPath(n), encodeShard(this.shards[n], this.swept[n]));
      this.dirty.delete(n);
    }
    if (this.peopleDirty) {
      writeSealedAtomic(join(dir(), PEOPLE_FILE), Buffer.from(JSON.stringify(this.people)));
      this.peopleDirty = false;
    }
  }

  /** Forgets every face and person, here and on disk. */
  clear(): void {
    this.shards = Array.from({ length: SHARDS }, () => new Map());
    this.swept = Array.from({ length: SHARDS }, () => new Set());
    this.dirty.clear();
    this.people = emptyPeople();
    this.clearFiles();
    this.peopleDirty = true;
    this.loaded = true;
  }

  /** Forgets what is held without touching the disk, for a sign-out or a lock. */
  unload(): void {
    this.shards = [];
    this.swept = [];
    this.dirty.clear();
    this.peopleDirty = false;
    this.people = emptyPeople();
    this.loaded = false;
  }

  private clearFiles(): void {
    if (!existsSync(dir())) return;
    for (let n = 0; n < SHARDS; n++) rmSync(shardPath(n), { force: true });
  }
}
