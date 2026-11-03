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

// The desktop's own face and search index: one replica merged from every device's copy in
// Drive, the photos this PC scanned itself, and the edits made here. Pure, so the merge rules
// are tested without Drive or a model.
//
// The merge is state-based, in the manner of a CRDT, so every replica that has seen the same
// copies and edits arrives at the same answer whatever order they came in:
//
// - Coverage is a union. A photo any device scanned counts as scanned, and its faces come
//   from the best scan of it: a high-resolution sweep first, then the newest. The search
//   index takes each photo's newest vector.
// - Curation is a set of last-writer-wins registers. Each face has one "who is this" value
//   (confirmed as a name, removed from People, or explicitly left unnamed); each person has a
//   cover; "not this person" marks and photos added by hand are elements that are on or off.
//   A value from a copy carries the copy's save time, an edit made here its own time on a
//   hybrid clock that never falls behind a copy already seen, so a slow PC clock cannot let
//   an older phone save undo a newer edit. Ties go to the edit made here.
// - What the clustering guessed is never curation: it only seeds the names when nothing
//   explicit says otherwise, as on the phone.
// - A rename is an alias from the old name to the new one, applied to every copy, so a
//   phone that has not heard of the rename yet still lands on the renamed person. Renaming
//   onto a name already in use is how two people are merged.
//
// The result is then written back to Drive as this device's own copy: every photo any device
// scanned and every edit any device made, so whichever device restores it gets the most
// complete index there is.

import {
  CLUSTER_PARAMS_VERSION,
  EMBEDDING_DIM,
  FACE_MODEL_VERSION,
  MIN_FACES_TO_SHOW,
  attractToNamed,
  centroid,
  basePass,
  baseStillHolds,
  mergePass,
  type BasePass,
  dot,
  isConfident,
  resolveClusterNames,
  sideways,
  splitOutUnclaimedNames,
  SUGGEST_THRESHOLD,
  suggestMatches,
  type FaceSample,
} from "./faceCluster.ts";
import type { FacesSnap, SearchSnap, SnapFace } from "./mlSnapshot.ts";

/** The recognition model this build embeds with; a copy under another cannot share faces. */
export const FACE_EMBED_SHA256 = "ffd8203a0c9e93d90a4957e24d173a883a5a04d64d23c771742c66273518a0db";
/** How long the pages may read a merge a scan has moved past. */
const STALE_MS = 30_000;
/** Two boxes overlapping this much on the same photo are the same face. */
const SAME_FACE_IOU = 0.5;

/** A face an edit names: its id, and its box so the edit still lands after a rescan. */
export type FaceRef = { id: string; box: [number, number, number, number] };

/** One edit made on this device, timestamped on the replica's hybrid clock. */
export type Op =
  | { t: number; kind: "confirm"; faces: FaceRef[]; name: string }
  | { t: number; kind: "unassign"; faces: FaceRef[] }
  | { t: number; kind: "reject"; faces: FaceRef[] }
  | { t: number; kind: "notPerson"; faces: FaceRef[]; name: string; on: boolean }
  | { t: number; kind: "manual"; keys: string[]; name: string; on: boolean }
  | { t: number; kind: "cover"; name: string; key: string | null }
  | { t: number; kind: "alias"; from: string; to: string };

export type Face = SnapFace & { id: string };

/** One person as the People pages show them. */
export type Person = {
  /** `n:<name>` for a named person, `g:<face id>` for an unnamed group. */
  id: string;
  name: string | null;
  /** Their faces, clearest first. */
  faces: string[];
  /** The photos they are on, face or hand-added. */
  keys: string[];
  cover: { key: string; box: [number, number, number, number] | null } | null;
  /** Where each of `faces` sits in its photo, in the same order, so a page can show the face
   *  itself rather than a whole photo that may hold several. Filled by `view`. */
  boxes?: Box[];
};

/** One face on a photo, for the viewer: its id, box, and who it is if anyone. */
export type PhotoFace = { face: string; box: Box; person: string | null; name: string | null };

export type Suggestion = { name: string; group: string; score: number; faces: string[]; boxes?: Box[] };

export type ReplicaView = {
  people: Person[];
  /** Unnamed groups that look like a named person, best first. */
  suggestions: Suggestion[];
  /** Photos whose faces were looked for, by any device. */
  scanned: number;
  /** Photos the search index covers, by any device. */
  searchable: number;
};

/** A copy the merge reads. `fallback` is this device's own last copy: its faces and vectors
 *  count like any other's, but what it says was decided only fills in where no other device's
 *  copy and no edit here says anything, so it never brings back an old decision over a new one. */
type Source = { device: string; t: number; snap: FacesSnap; full: boolean; fallback?: boolean };

/** Older than any date a device or an edit gives: a value only a fallback copy holds. */
const FALLBACK_TIME = Number.MIN_SAFE_INTEGER + 1;

/** Two boxes on one photo that are one face, when two devices found it: they mostly agree, or
 *  one sits inside the other. */
function sameFace(a: number[], b: number[]): boolean {
  if (iou(a, b) >= 0.3) return true;
  const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const smaller = Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]));
  return smaller > 0 && (iw * ih) / smaller >= 0.6;
}

/**
 * One photo's faces from every copy that looked at it: the best scan's (a thorough one first,
 * then the newest) as they are, then each face another copy found that the best one does not
 * hold, numbered after them. No device's face is lost because another looked at the photo too.
 */
function unionOfPhoto(key: string, perSource: { faces: SnapFace[]; hiRes: boolean; t: number }[]): SnapFace[] {
  if (perSource.length === 0) return [];
  const ranked = perSource
    .map((s, i) => ({ ...s, i }))
    .sort((a, b) => (a.hiRes !== b.hiRes ? (a.hiRes ? -1 : 1) : b.t - a.t || a.i - b.i));
  const out = ranked[0].faces.filter((f) => f.embedding.length === EMBEDDING_DIM);
  let next = 0;
  for (const f of out) if (f.index >= next) next = f.index + 1;
  for (const s of ranked.slice(1)) {
    for (const f of s.faces) {
      if (f.embedding.length !== EMBEDDING_DIM || out.some((k) => sameFace(k.box, f.box))) continue;
      out.push({ ...f, key, index: next++ });
    }
  }
  return out;
}

const faceId = (key: string, index: number) => `${key}#${index}`;

function iou(a: number[], b: number[]): number {
  const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - iw * ih;
  return union > 0 ? (iw * ih) / union : 0;
}

/** A last-writer-wins register: the newest write, edits made here winning a tie. */
class Lww<T> {
  private at = -Infinity;
  private local = false;
  value: T | undefined;
  write(value: T, t: number, local: boolean): void {
    if (t > this.at || (t === this.at && local && !this.local)) {
      this.at = t;
      this.local = local;
      this.value = value;
    }
  }
}

/** Whether a face copy's embeddings compare with this build's. */
export function fullyCompatible(snap: FacesSnap): boolean {
  return (
    snap.modelVersion === FACE_MODEL_VERSION &&
    snap.dim === EMBEDDING_DIM &&
    (!snap.modelSha256 || snap.modelSha256.toLowerCase() === FACE_EMBED_SHA256)
  );
}

/**
 * The replica. Fed the copies read from Drive, this device's own scans and its edits, it
 * answers the People pages and writes the copy this device saves.
 */
export class Replica {
  /** The face copies read from Drive, newest saved per device. */
  private copies: FacesSnap[] = [];
  private searchCopies: SearchSnap[] = [];
  /** This device's own scans: faces and markers, no curation. */
  local: FacesSnap;
  localSearch: SearchSnap;
  ops: Op[] = [];
  private cache: Merged | null = null;
  /** Bumped whenever the faces themselves change (a copy read, a photo scanned), as opposed to
   *  what is decided about them. */
  private facesVersion = 0;
  /** The last grouping, kept for the next merge to reuse when the faces did not change. */
  clusterCache: { version: number; ids: string[]; samples: FaceSample[]; pass: BasePass; merged: Int32Array } | null = null;
  get faceVersion(): number {
    return this.facesVersion;
  }

  constructor(
    readonly deviceId: string,
    readonly deviceLabel: string,
    readonly searchModelId: string,
  ) {
    this.local = emptyFaces(deviceId, deviceLabel);
    this.localSearch = emptySearch(deviceId, deviceLabel, searchModelId);
  }

  /** What each device last published for each curation record, and since when. Kept on disk
   *  beside the replica, so a device saving the same value again does not date it as new. */
  seen: Seen = {};
  private facts: Fact[] = [];

  /** Replaces what Drive holds. This device's own copy is left out: what it says is already
   *  here, first-hand, and taking it back would date old values as new. */
  setCopies(faces: FacesSnap[], search: SearchSnap[]): void {
    // In one fixed order, whatever order Drive lists them in: the grouping takes the faces in
    // the order the copies give them, so the same copies always group the same way.
    const byDevice = (a: { deviceId: string }, b: { deviceId: string }) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0);
    const own = faces.filter((s) => s.deviceId !== this.deviceId).sort(byDevice);
    const ownSearch = search.filter((s) => s.deviceId !== this.deviceId && s.modelId === this.searchModelId).sort(byDevice);
    // This device's own copy in Drive, kept apart as the fallback: the newest of it and the one
    // kept on disk.
    const newest = <T extends { createdAt: number }>(list: T[]) => list.sort((a, b) => b.createdAt - a.createdAt)[0];
    const mine = newest(faces.filter((s) => s.deviceId === this.deviceId));
    const mineSearch = newest(search.filter((s) => s.deviceId === this.deviceId && s.modelId === this.searchModelId));
    const ownChanged = this.setOwn(mine, mineSearch, false);
    // A periodic look at Drive mostly finds the very copies already read: keeping them as they
    // are keeps the grouping too, rather than redoing it for nothing.
    const sig = (list: { deviceId: string; createdAt: number }[]) => list.map((s) => `${s.deviceId}@${s.createdAt}`).sort().join(",");
    if (!ownChanged && sig(own) === sig(this.copies) && sig(ownSearch) === sig(this.searchCopies) && this.facesVersion > 0) return;
    this.copies = own;
    this.searchCopies = ownSearch;
    this.otherModelSearch = search
      .filter((s) => s.deviceId !== this.deviceId && s.modelId !== this.searchModelId)
      .map((s) => ({ device: s.deviceLabel, vectors: s.vectors.size }));
    this.facts = this.copies.flatMap((s) => ingest(s, this.seen));
    this.facesVersion++;
    this.cache = null;
  }

  get copyFacts(): Fact[] {
    return this.ownFacts.length ? [...this.facts, ...this.ownFacts] : this.facts;
  }

  /** This device's own last copy, from disk or Drive: what it knew when it last saved. */
  ownFaces: FacesSnap | null = null;
  ownSearch: SearchSnap | null = null;
  private ownFacts: Fact[] = [];

  /**
   * Takes this device's own last copy in, when newer than the one held. Returns whether it
   * changed. `regroup` false leaves the caller to redo the grouping.
   */
  setOwn(faces: FacesSnap | undefined | null, search: SearchSnap | undefined | null, regroup = true): boolean {
    let changed = false;
    if (faces && faces.deviceId === this.deviceId && fullyCompatible(faces) && faces.createdAt > (this.ownFaces?.createdAt ?? -Infinity)) {
      this.ownFaces = faces;
      this.ownFacts = ingestFallback(faces);
      changed = true;
    }
    if (search && search.deviceId === this.deviceId && search.modelId === this.searchModelId && search.createdAt > (this.ownSearch?.createdAt ?? -Infinity)) {
      this.ownSearch = search;
      changed = true;
    }
    if (changed && regroup) {
      this.facesVersion++;
      this.cache = null;
    }
    return changed;
  }

  /** The time for a new edit: now, or just past the newest time any copy or edit carries. */
  clock(now = Date.now()): number {
    let max = now;
    for (const s of this.copies) max = Math.max(max, s.createdAt + 1);
    for (const op of this.ops) max = Math.max(max, op.t + 1);
    return max;
  }

  /**
   * The photos the library holds now, by link id, or null while it is not known. A device's
   * copy keeps the faces of photos since trashed or deleted, and of photos this account no
   * longer sees; grouped, they made people and suggestions with nothing to show. They stay in
   * the copy this device saves, so nothing another device knows is thrown away, but only the
   * photos in the library are grouped and shown.
   */
  private library: Set<string> | null = null;
  setLibrary(keys: Iterable<string> | null): void {
    const next = keys ? new Set(keys) : null;
    const same = next && this.library ? next.size === this.library.size && [...next].every((k) => this.library!.has(k)) : next === this.library;
    if (same) return;
    this.library = next;
    this.facesVersion++;
    this.cache = null;
  }
  inLibrary(key: string): boolean {
    return !this.library || this.library.has(key);
  }
  /** Whether the library's photos are known yet. */
  get libraryKnown(): boolean {
    return this.library !== null;
  }

  apply(op: Op): void {
    this.ops.push(op);
    this.cache = null;
  }

  /** Records a photo scanned here: its faces (any it had before are replaced) and its marker. */
  /**
   * Records a photo scanned here: its faces (any it had before are replaced) and its marker,
   * `hiRes` when it was the thorough look. `vector` is the search vector, null for a photo that
   * cannot be read, or undefined to leave the one there is.
   */
  addScan(
    key: string,
    faces: (Omit<SnapFace, "key" | "index" | "person" | "confirmed" | "rejected"> & { index?: number })[],
    vector: Uint16Array | null | undefined,
    now = Date.now(),
    hiRes = false,
  ): void {
    this.local.faces = this.local.faces.filter((f) => f.key !== key);
    // A face already known keeps its number, so whatever was decided about it by that number
    // still finds it; a new one is numbered after them.
    let next = 0;
    for (const f of faces) if (f.index !== undefined && f.index >= next) next = f.index + 1;
    for (const f of faces) {
      const { index, ...rest } = f;
      this.local.faces.push({ ...rest, key, index: index ?? next++, person: null, confirmed: null, rejected: false });
    }
    this.local.markers = this.local.markers.filter((m) => m.key !== key);
    this.local.markers.push({ key, hiRes });
    const idx = this.indexes.get(this.local);
    if (idx) {
      idx.faces.set(key, this.local.faces.filter((f) => f.key === key));
      idx.markers.set(key, hiRes);
    }
    this.local.createdAt = now;
    if (vector !== undefined) {
      this.localSearch.vectors.set(key, vector);
      this.localSearch.createdAt = now;
    }
    this.facesVersion++;
    // A scan records a photo every fraction of a second; merging the whole library again for
    // each would hold everything else up. What the pages read may lag a scan by a little
    // (`STALE_MS`); an edit, and anything saved, always reads the replica as it is.
    this.stale = true;
  }

  /** Records a photo's search vector alone, leaving the faces any device found on it as they are. */
  setVector(key: string, vector: Uint16Array | null, now = Date.now()): void {
    this.localSearch.vectors.set(key, vector);
    this.localSearch.createdAt = now;
    this.stale = true;
  }

  /** Search copies made with another model, which this build cannot rank with. */
  otherModelSearch: { device: string; vectors: number }[] = [];

  /**
   * What went into the index and what comes out of it, in counts only: each copy read, what
   * this device added, and the merged whole. What a save is checked against, and what the log
   * shows when a copy seems smaller than it should be.
   */
  report() {
    this.fresh();
    const m = this.merged();
    const photos = new Set<string>();
    for (const f of m.faces.values()) photos.add(f.key);
    let confirmed = 0;
    let rejected = 0;
    for (const v of m.identity.values()) {
      if (v.kind === "confirmed") confirmed++;
      else if (v.kind === "rejected") rejected++;
    }
    let notPerson = 0;
    for (const names of m.blocked.values()) notPerson += names.size;
    const usable = (s: FacesSnap) => s.faces.filter((f) => f.embedding.length === EMBEDDING_DIM).length;
    return {
      copies: this.copies.map((s) => ({
        device: s.deviceLabel,
        savedAt: s.createdAt,
        compatible: fullyCompatible(s),
        faces: s.faces.length,
        usableFaces: usable(s),
        markers: s.markers.length,
        confirmed: s.faces.filter((f) => f.confirmed).length,
        manual: s.manual.length,
        notPerson: s.notPerson.length,
      })),
      searchCopies: [
        ...this.searchCopies.map((s) => ({ device: s.deviceLabel, vectors: s.vectors.size, sameModel: true })),
        ...this.otherModelSearch.map((s) => ({ ...s, sameModel: false })),
      ],
      own: this.ownFaces ? { savedAt: this.ownFaces.createdAt, faces: this.ownFaces.faces.length, markers: this.ownFaces.markers.length, vectors: this.ownSearch?.vectors.size ?? 0 } : null,
      local: { faces: this.local.faces.length, markers: this.local.markers.length, vectors: this.localSearch.vectors.size, edits: this.ops.length },
      merged: {
        faces: m.faces.size,
        photosWithFaces: photos.size,
        scanned: m.markers.size,
        people: m.people.filter((p) => p.name).length,
        confirmed,
        rejected,
        notPerson,
        manual: m.manual.size,
        covers: m.covers.size,
        vectors: m.searchKeys,
      },
    };
  }

  /** What the last grouping named each face: the next one leans on it, as the phone leans on
   *  each face's person, so a scan or an edit does not redraw who is who. Kept on disk. */
  lastNames = new Map<string, string>();

  /** The photos any device scanned for faces (true where the look was the thorough one), and
   *  the photos with a search vector. */
  covered(): { faces: Map<string, boolean>; search: Set<string> } {
    this.fresh();
    const m = this.merged();
    // Only a real vector counts. A photo marked unreadable is looked at again: an older build
    // marked every photo with no HD preview, or slow to arrive, that way for good.
    const search = new Set<string>();
    for (const [key, v] of m.search) if (v) search.add(key);
    return { faces: new Map(m.markers), search };
  }

  /**
   * The faces any device found on one photo, removed ones included: what a second look keeps.
   * Read straight off the copies, by the merge's own rule for which scan of a photo counts (a
   * thorough one first, then the newest), and never through a merge: a scan asks for this once
   * a photo and records a scan right after, so going through the merge would regroup the whole
   * library for every photo.
   */
  knownFaces(key: string): Face[] {
    const perSource: { faces: SnapFace[]; hiRes: boolean; t: number }[] = [];
    for (const s of this.faceSources()) {
      const idx = this.indexOf(s);
      const hiRes = idx.markers.get(key);
      const faces = idx.faces.get(key);
      if (hiRes === undefined && !faces) continue;
      perSource.push({ faces: faces ?? [], hiRes: hiRes ?? false, t: s.createdAt });
    }
    return unionOfPhoto(key, perSource).map((f) => ({ ...f, id: faceId(f.key, f.index) }));
  }

  /** Every copy whose faces compare with this build's, in the merge's order: the other
   *  devices', this device's own last copy, then what it scanned since. */
  faceSources(): FacesSnap[] {
    return [...this.copies.filter(fullyCompatible), ...(this.ownFaces ? [this.ownFaces] : []), this.local];
  }

  /** Each copy's faces and markers by photo, built once per copy. This device's own is kept up
   *  to date by `addScan`. */
  private indexes = new WeakMap<FacesSnap, { faces: Map<string, SnapFace[]>; markers: Map<string, boolean> }>();
  private indexOf(s: FacesSnap) {
    let idx = this.indexes.get(s);
    if (!idx) {
      idx = { faces: new Map(), markers: new Map() };
      for (const f of s.faces) (idx.faces.get(f.key) ?? idx.faces.set(f.key, []).get(f.key)!).push(f);
      for (const m of s.markers) idx.markers.set(m.key, m.hiRes);
      this.indexes.set(s, idx);
    }
    return idx;
  }

  private stale = false;
  private mergedAt = 0;

  /** Makes the next read merge again, whatever a scan left pending. */
  fresh(): void {
    if (this.stale) this.cache = null;
  }

  private merged(): Merged {
    if (this.cache && this.stale && Date.now() - this.mergedAt > STALE_MS) this.cache = null;
    if (!this.cache) {
      this.stale = false;
      this.cache = merge(this);
      this.mergedAt = Date.now();
    }
    return this.cache;
  }

  /** The people, the groups to name and the suggestions, as the pages show them. */
  view(): ReplicaView {
    const m = this.merged();
    return {
      people: m.people.map((p) => ({ ...p, boxes: this.boxesOf(p.faces) })),
      suggestions: m.suggestions.map((s) => ({ ...s, boxes: this.boxesOf(s.faces) })),
      scanned: m.markers.size,
      searchable: m.searchKeys,
    };
  }

  /** The boxes of some faces, to four places: enough to cut a face out of its photo. */
  private boxesOf(ids: string[]): Box[] {
    const faces = this.merged().faces;
    const r = (v: number) => Math.round(v * 1e4) / 1e4;
    return ids.map((id) => {
      const b = faces.get(id)?.box ?? [0, 0, 1, 1];
      return [r(b[0]), r(b[1]), r(b[2]), r(b[3])];
    });
  }

  /** The faces behind some face ids, for an edit to name. */
  refs(ids: string[]): FaceRef[] {
    const m = this.merged();
    return ids.map((id) => m.faces.get(id)).filter((f): f is Face => !!f).map((f) => ({ id: f.id, box: f.box }));
  }

  person(id: string): Person | null {
    return this.merged().people.find((p) => p.id === id) ?? null;
  }

  /** A person's faces that sit on the given photos. */
  facesOn(personId: string, keys: string[]): FaceRef[] {
    const p = this.person(personId);
    if (!p) return [];
    const want = new Set(keys);
    return this.refs(p.faces.filter((id) => want.has(id.slice(0, id.lastIndexOf("#")))));
  }

  /** The groups closest to a named person, for "Is this <name>?", best first. */
  suggestionsFor(name: string, limit = 3): Suggestion[] {
    const m = this.merged();
    const own = m.people.find((p) => p.name === name);
    if (!own) return [];
    const mine = centroid(own.faces.map((id) => m.faces.get(id)!.embedding));
    const out: Suggestion[] = [];
    for (const g of m.groups) {
      if (g.name) continue;
      if (g.faces.some((id) => m.blocked.get(id)?.has(name))) continue;
      const faces = g.faces;
      if (faces.length === 0) continue;
      const score = dot(mine, centroid(faces.map((id) => m.faces.get(id)!.embedding)));
      if (score >= SUGGEST_THRESHOLD) out.push({ name, group: g.id, score, faces });
    }
    return out
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({ ...s, boxes: this.boxesOf(s.faces) }));
  }

  /**
   * One pass of the automatic merge, as on Android: every unnamed group whose centre clears the
   * suggestion floor against a named person's, the same match "Is this <name>?" offers, goes
   * to that person. A group close to two people goes to the nearer, a group holding a face
   * marked as not that person is never taken by them, and named people are never combined.
   * Returns the faces to confirm, per name.
   */
  autoMergePairs(): { name: string; faces: FaceRef[] }[] {
    const m = this.merged();
    const named = m.people.filter((p) => p.name && p.faces.length > 0);
    if (named.length === 0) return [];
    const centres = named.map((p) => ({ name: p.name!, centre: centroid(p.faces.map((id) => m.faces.get(id)!.embedding)) }));
    const claim = new Map<string, { name: string; score: number; faces: string[] }>();
    for (const g of m.groups) {
      if (g.name) continue;
      const centre = centroid(g.faces.map((id) => m.faces.get(id)!.embedding));
      for (const n of centres) {
        if (g.faces.some((id) => m.blocked.get(id)?.has(n.name))) continue;
        const score = dot(n.centre, centre);
        if (score <= SUGGEST_THRESHOLD) continue;
        const prior = claim.get(g.id);
        if (!prior || score > prior.score) claim.set(g.id, { name: n.name, score, faces: g.faces });
      }
    }
    // Only unnamed groups fold, into names that were there before the pass: nothing chains.
    return [...claim]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([, c]) => ({ name: c.name, faces: this.refs(c.faces) }));
  }

  /** Whether `name` was renamed away and now stands for another name. */
  isAliased(name: string): boolean {
    return aliasResolver(this.ops)(name, Infinity) !== name;
  }

  /**
   * The faces found on one photo, as the viewer tags them: each with its box and the person
   * it belongs to, a named one, a group shown on the People page, or none for a face left
   * on its own. Faces removed from People are left out.
   */
  photoFaces(key: string): PhotoFace[] {
    const m = this.merged();
    // Indexed once per merge, not per photo: the viewer asks for every photo it settles on.
    if (!m.photoIndex) {
      const shown = new Set(m.people.map((p) => p.id));
      const groupOf = new Map<string, { id: string; name: string | null; shown: boolean }>();
      for (const g of m.groups) for (const id of g.faces) groupOf.set(id, { ...g, shown: shown.has(g.id) });
      m.photoIndex = { groupOf };
    }
    const { groupOf } = m.photoIndex;
    return (m.byKey.get(key) ?? [])
      .filter((f) => m.identity.get(f.id)?.kind !== "rejected")
      .sort((a, b) => a.box[0] - b.box[0])
      .map((f) => {
        const g = groupOf.get(f.id);
        return {
          face: f.id,
          box: f.box,
          person: g?.shown ? g.id : null,
          name: g?.name ?? null,
        };
      });
  }

  /** Every name in use, for the pickers. */
  names(): string[] {
    return this.merged().people.filter((p) => p.name).map((p) => p.name!).sort((a, b) => a.localeCompare(b));
  }

  /** The face copy this device saves: everything merged. */
  exportFaces(now = Date.now()): FacesSnap {
    this.fresh();
    const m = this.merged();
    const nameOf = new Map<string, string>();
    for (const p of m.people) if (p.name) for (const id of p.faces) nameOf.set(id, p.name);
    return {
      deviceId: this.deviceId,
      deviceLabel: this.deviceLabel,
      createdAt: now,
      modelVersion: FACE_MODEL_VERSION,
      modelSha256: FACE_EMBED_SHA256,
      clusterParams: CLUSTER_PARAMS_VERSION,
      dim: EMBEDDING_DIM,
      faces: [...m.faces.values()].map((f) => {
        const identity = m.identity.get(f.id);
        return {
          ...f,
          rejected: identity?.kind === "rejected",
          confirmed: identity?.kind === "confirmed" ? identity.name : null,
          person: nameOf.get(f.id) ?? null,
        };
      }),
      manual: [...m.manual].map(([k]) => splitPair(k)).map(([name, key]) => ({ name, key })),
      notPerson: [...m.blocked].flatMap(([id, names]) => {
        const at = id.lastIndexOf("#");
        return [...names].map((name) => ({ name, key: id.slice(0, at), index: Number(id.slice(at + 1)) }));
      }),
      covers: [...m.covers].map(([name, key]) => ({ name, key })),
      markers: [...m.markers].map(([key, hiRes]) => ({ key, hiRes })),
    };
  }

  /** The search copy this device saves: every photo's newest vector. */
  exportSearch(now = Date.now()): SearchSnap {
    this.fresh();
    return { ...emptySearch(this.deviceId, this.deviceLabel, this.searchModelId), createdAt: now, vectors: this.merged().search };
  }

  /** The search vectors from every device, for ranking a query. */
  searchVectors(): Map<string, Uint16Array | null> {
    return this.merged().search;
  }

  get faceCopies(): FacesSnap[] {
    return this.copies;
  }

  get searchCopyList(): SearchSnap[] {
    return this.searchCopies;
  }
}

export function emptyFaces(deviceId: string, deviceLabel: string): FacesSnap {
  return {
    deviceId, deviceLabel, createdAt: 0,
    modelVersion: FACE_MODEL_VERSION, modelSha256: FACE_EMBED_SHA256, clusterParams: CLUSTER_PARAMS_VERSION, dim: EMBEDDING_DIM,
    faces: [], manual: [], notPerson: [], covers: [], markers: [],
  };
}

export function emptySearch(deviceId: string, deviceLabel: string, modelId: string): SearchSnap {
  return { deviceId, deviceLabel, createdAt: 0, modelId, dim: EMBEDDING_DIM, vectors: new Map() };
}

// ---- The merge ----

type Identity = { kind: "confirmed"; name: string } | { kind: "rejected" } | { kind: "none" };

type Merged = {
  faces: Map<string, Face>;
  markers: Map<string, boolean>;
  identity: Map<string, Identity>;
  blocked: Map<string, Set<string>>;
  manual: Map<string, true>;
  covers: Map<string, string>;
  search: Map<string, Uint16Array | null>;
  searchKeys: number;
  groups: { id: string; name: string | null; faces: string[] }[];
  /** The kept faces of each photo. */
  byKey: Map<string, Face[]>;
  /** Built the first time a photo's faces are asked for. */
  photoIndex?: { groupOf: Map<string, { id: string; name: string | null; shown: boolean }> };
  people: Person[];
  suggestions: Suggestion[];
};

const pair = (a: string, b: string) => `${a}\u0000${b}`;
const splitPair = (k: string) => k.split("\u0000") as [string, string];

/**
 * Resolves a name written at some time through the renames, `(name, t) => name`. A name's
 * history is cut into epochs where it was taken back for someone new (an alias of the name
 * onto itself); within an epoch the latest rename wins and reaches back over the whole epoch,
 * so a copy saved before the rename, or by a device that has not heard of it, still lands on
 * the renamed person, while a name given out again afterwards is that new person's alone.
 */
export function aliasResolver(ops: Op[]): (name: string, t: number) => string {
  const byName = new Map<string, { resets: number[]; renames: { t: number; to: string }[] }>();
  for (const op of [...ops].sort((a, b) => a.t - b.t)) {
    if (op.kind !== "alias") continue;
    const h = byName.get(op.from) ?? byName.set(op.from, { resets: [], renames: [] }).get(op.from)!;
    if (op.from === op.to) h.resets.push(op.t);
    else h.renames.push({ t: op.t, to: op.to });
  }
  const once = (name: string, t: number): string | null => {
    const h = byName.get(name);
    if (!h) return null;
    // The epoch a time falls in: from the last reset at or before it to the next one.
    let lo = -Infinity;
    let hi = Infinity;
    for (const r of h.resets) {
      if (r <= t) lo = r;
      else {
        hi = r;
        break;
      }
    }
    let to: string | null = null;
    for (const r of h.renames) if (r.t >= lo && r.t < hi) to = r.to;
    return to;
  };
  return (name, t) => {
    let n = name;
    const seen = new Set<string>([n]);
    for (;;) {
      const next = once(n, t);
      if (next === null || seen.has(next)) return n;
      seen.add(next);
      n = next;
    }
  };
}

// ---- Dating what a copy says ----

type Box = [number, number, number, number];

/**
 * One curation value a device published, dated by when that device first published it, not
 * by when it last saved: a copy carries no time per record, and dating every value by the
 * save would let a device that merely saved again, unaware of a newer edit made elsewhere,
 * undo it. `value` for a face is "" (left unnamed), "R" (removed from People) or "C:<name>".
 */
export type Fact =
  | { kind: "identity"; key: string; index: number; box: Box; value: string; t: number }
  | { kind: "notPerson"; key: string; index: number; box: Box; name: string; on: boolean; t: number }
  | { kind: "manual"; key: string; name: string; on: boolean; t: number }
  | { kind: "cover"; name: string; key: string | null; t: number };

/** Per device and record, the value last seen in its copy and since when: `v` "" is "none". */
export type Seen = Record<string, { v: string; t: number; b?: Box }>;

/** A value present since before anything was known of the device: no statement at all. */
const NO_TIME = Number.MIN_SAFE_INTEGER;
const SEP = "\u0001";

/**
 * The facts in one device's copy, each dated by `seen`, which this updates: a value the device
 * published before keeps its first date, a changed one takes this copy's, and a record gone
 * from the copy since the last one is a removal dated by this copy. A copy older than one
 * already read changes nothing that was learned from the newer.
 */
/**
 * This device's own last copy read back, every decision in it dated older than anything: it
 * fills in what no other copy and no edit here holds (a device's copy since deleted from Drive,
 * say), and gives way to all of them. Nothing in it is dated as new, so `seen` is not touched.
 */
export function ingestFallback(snap: FacesSnap): Fact[] {
  const facts: Fact[] = [];
  const boxes = new Map(snap.faces.map((f) => [faceId(f.key, f.index), f.box]));
  for (const f of snap.faces) {
    const value = f.rejected ? "R" : f.confirmed ? `C:${f.confirmed}` : "";
    if (value) facts.push({ kind: "identity", key: f.key, index: f.index, box: f.box, value, t: FALLBACK_TIME });
  }
  for (const n of snap.notPerson) {
    const box = boxes.get(faceId(n.key, n.index));
    if (box) facts.push({ kind: "notPerson", key: n.key, index: n.index, box, name: n.name, on: true, t: FALLBACK_TIME });
  }
  for (const m of snap.manual) facts.push({ kind: "manual", key: m.key, name: m.name, on: true, t: FALLBACK_TIME });
  for (const c of snap.covers) facts.push({ kind: "cover", name: c.name, key: c.key, t: FALLBACK_TIME });
  return facts;
}

export function ingest(snap: FacesSnap, seen: Seen): Fact[] {
  const dev = snap.deviceId + SEP;
  const lastKey = dev + "@";
  const fresh = snap.createdAt >= (seen[lastKey]?.t ?? NO_TIME);
  const facts: Fact[] = [];
  const present = new Set<string>();
  const date = (k: string, v: string, b?: Box): number => {
    present.add(k);
    const prev = seen[k];
    const t = prev ? (prev.v === v ? prev.t : snap.createdAt) : v === "" ? NO_TIME : snap.createdAt;
    if (fresh) seen[k] = b ? { v, t, b } : { v, t };
    return t;
  };
  for (const f of snap.faces) {
    const value = f.rejected ? "R" : f.confirmed ? `C:${f.confirmed}` : "";
    const t = date(`${dev}i${SEP}${f.key}#${f.index}`, value, f.box);
    if (t !== NO_TIME) facts.push({ kind: "identity", key: f.key, index: f.index, box: f.box, value, t });
  }
  const boxes = new Map(snap.faces.map((f) => [faceId(f.key, f.index), f.box]));
  const boxOf = (key: string, index: number) => boxes.get(faceId(key, index));
  for (const n of snap.notPerson) {
    const box = boxOf(n.key, n.index) ?? seen[`${dev}n${SEP}${n.name}${SEP}${n.key}#${n.index}`]?.b;
    const t = date(`${dev}n${SEP}${n.name}${SEP}${n.key}#${n.index}`, "1", box);
    if (box) facts.push({ kind: "notPerson", key: n.key, index: n.index, box, name: n.name, on: true, t });
  }
  for (const m of snap.manual) {
    facts.push({ kind: "manual", key: m.key, name: m.name, on: true, t: date(`${dev}m${SEP}${m.name}${SEP}${m.key}`, "1") });
  }
  for (const c of snap.covers) {
    facts.push({ kind: "cover", name: c.name, key: c.key, t: date(`${dev}c${SEP}${c.name}`, c.key) });
  }
  // What the device held before and no longer does: a removal. A face that is gone was
  // looked at again rather than decided about, so only marks, photos and covers count.
  for (const [k, prev] of Object.entries(seen)) {
    if (!k.startsWith(dev) || present.has(k) || k === lastKey) continue;
    const [kind, ...rest] = k.slice(dev.length).split(SEP);
    if (kind === "i") continue;
    let t = prev.t;
    if (prev.v !== "") {
      t = snap.createdAt;
      if (fresh) seen[k] = prev.b ? { v: "", t, b: prev.b } : { v: "", t };
    }
    if (kind === "n" && prev.b) {
      const at = rest[1].lastIndexOf("#");
      facts.push({ kind: "notPerson", key: rest[1].slice(0, at), index: Number(rest[1].slice(at + 1)), box: prev.b, name: rest[0], on: false, t });
    } else if (kind === "m") {
      facts.push({ kind: "manual", key: rest[1], name: rest[0], on: false, t });
    } else if (kind === "c") {
      facts.push({ kind: "cover", name: rest[0], key: null, t });
    }
  }
  if (fresh) seen[lastKey] = { v: "", t: snap.createdAt };
  return facts;
}

function merge(r: Replica): Merged {
  const ops = [...r.ops].sort((a, b) => a.t - b.t);

  const resolve = aliasResolver(ops);

  const sources: Source[] = [
    ...r.faceCopies.map((snap) => ({ device: snap.deviceId, t: snap.createdAt, snap, full: fullyCompatible(snap) })),
    ...(r.ownFaces ? [{ device: r.deviceId, t: r.ownFaces.createdAt, snap: r.ownFaces, full: true, fallback: true }] : []),
    { device: r.deviceId, t: r.local.createdAt, snap: r.local, full: true },
  ];

  // Coverage: every marker, thorough where any device's look was.
  const markers = new Map<string, boolean>();
  for (const s of sources) {
    const scanned = new Map<string, boolean>();
    for (const m of s.snap.markers) scanned.set(m.key, m.hiRes);
    // A face is a scan of its photo even where a copy carries no marker for it.
    for (const f of s.snap.faces) if (!scanned.has(f.key)) scanned.set(f.key, false);
    for (const [key, hiRes] of scanned) {
      markers.set(key, (markers.get(key) ?? false) || hiRes);
    }
  }
  // Each photo's faces: its best scan's, joined by any face another copy found that it lacks.
  const perPhoto = new Map<string, { faces: SnapFace[]; hiRes: boolean; t: number }[]>();
  for (const s of sources) {
    if (!s.full) continue;
    const byPhoto = new Map<string, SnapFace[]>();
    for (const f of s.snap.faces) (byPhoto.get(f.key) ?? byPhoto.set(f.key, []).get(f.key)!).push(f);
    const hiResOf = new Map<string, boolean>();
    for (const m of s.snap.markers) hiResOf.set(m.key, m.hiRes);
    for (const key of new Set([...byPhoto.keys(), ...hiResOf.keys()])) {
      (perPhoto.get(key) ?? perPhoto.set(key, []).get(key)!).push({ faces: byPhoto.get(key) ?? [], hiRes: hiResOf.get(key) ?? false, t: s.t });
    }
  }
  const faces = new Map<string, Face>();
  const byKey = new Map<string, Face[]>();
  for (const [key, list] of perPhoto) {
    for (const f of unionOfPhoto(key, list)) {
      const face: Face = { ...f, id: faceId(f.key, f.index) };
      faces.set(face.id, face);
      (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(face);
    }
  }
  /** The kept face a face of some copy, or an edit, stands for: the same id where its box still
   *  agrees, else the kept face on the same photo it overlaps most. */
  const canonical = (key: string, id: string, box: number[]): string | null => {
    const same = faces.get(id);
    if (same && iou(same.box, box) >= SAME_FACE_IOU) return id;
    let found: string | null = null;
    let bestOverlap = SAME_FACE_IOU;
    for (const f of byKey.get(key) ?? []) {
      const o = iou(f.box, box);
      if (o >= bestOverlap) {
        bestOverlap = o;
        found = f.id;
      }
    }
    return found;
  };

  // Curation registers, fed by every copy at its save time and every edit at its own.
  const identity = new Map<string, Lww<Identity>>();
  const carried = new Map<string, Lww<string>>();
  const blocked = new Map<string, Lww<boolean>>();
  const manual = new Map<string, Lww<boolean>>();
  const covers = new Map<string, Lww<string | null>>();
  const reg = <T>(m: Map<string, Lww<T>>, k: string) => m.get(k) ?? m.set(k, new Lww<T>()).get(k)!;

  // What the clustering of each device guessed: a hint, dated by the copy, never curation.
  for (const s of sources) {
    for (const f of s.snap.faces) {
      if (!f.person) continue;
      const id = canonical(f.key, faceId(f.key, f.index), f.box);
      const t = s.fallback ? FALLBACK_TIME : s.t;
      if (id) reg(carried, id).write(resolve(f.person, t), t, false);
    }
  }
  // What each device decided, each value dated by when that device first published it.
  for (const fact of r.copyFacts) {
    switch (fact.kind) {
      case "identity": {
        const id = canonical(fact.key, faceId(fact.key, fact.index), fact.box);
        if (!id) break;
        const v = fact.value;
        reg(identity, id).write(
          v === "R" ? { kind: "rejected" } : v.startsWith("C:") ? { kind: "confirmed", name: resolve(v.slice(2), fact.t) } : { kind: "none" },
          fact.t,
          false,
        );
        break;
      }
      case "notPerson": {
        const id = canonical(fact.key, faceId(fact.key, fact.index), fact.box);
        if (id) reg(blocked, pair(id, resolve(fact.name, fact.t))).write(fact.on, fact.t, false);
        break;
      }
      case "manual":
        reg(manual, pair(resolve(fact.name, fact.t), fact.key)).write(fact.on, fact.t, false);
        break;
      case "cover":
        reg(covers, resolve(fact.name, fact.t)).write(fact.key, fact.t, false);
        break;
    }
  }
  const refId = (f: FaceRef) => canonical(f.id.slice(0, f.id.lastIndexOf("#")), f.id, f.box);
  for (const op of ops) {
    switch (op.kind) {
      case "confirm":
        for (const f of op.faces) {
          const id = refId(f);
          if (id) reg(identity, id).write({ kind: "confirmed", name: resolve(op.name, op.t) }, op.t, true);
        }
        break;
      case "unassign":
      case "reject":
        for (const f of op.faces) {
          const id = refId(f);
          if (id) reg(identity, id).write(op.kind === "reject" ? { kind: "rejected" } : { kind: "none" }, op.t, true);
          // An edit says who the face is not, so the guess it carried goes with it.
          if (id) reg(carried, id).write("", op.t, true);
        }
        break;
      case "notPerson":
        for (const f of op.faces) {
          const id = refId(f);
          if (id) reg(blocked, pair(id, resolve(op.name, op.t))).write(op.on, op.t, true);
        }
        break;
      case "manual":
        for (const key of op.keys) reg(manual, pair(resolve(op.name, op.t), key)).write(op.on, op.t, true);
        break;
      case "cover":
        reg(covers, resolve(op.name, op.t)).write(op.key, op.t, true);
        break;
    }
  }

  const identityOut = new Map<string, Identity>();
  for (const [id, v] of identity) if (v.value && v.value.kind !== "none") identityOut.set(id, v.value);
  const blockedOut = new Map<string, Set<string>>();
  for (const [k, v] of blocked) {
    if (!v.value) continue;
    const [id, name] = splitPair(k);
    if (faces.has(id)) (blockedOut.get(id) ?? blockedOut.set(id, new Set()).get(id)!).add(name);
  }
  const manualOut = new Map<string, true>();
  for (const [k, v] of manual) if (v.value) manualOut.set(k, true);
  const coversOut = new Map<string, string>();
  for (const [name, v] of covers) if (v.value) coversOut.set(name, v.value);

  // Search: each photo's newest vector, from any device with this build's model. A photo one
  // device could not read keeps the vector another device made of it.
  const search = new Map<string, Uint16Array | null>();
  const searchAt = new Map<string, number>();
  for (const s of [...r.searchCopyList, ...(r.ownSearch ? [r.ownSearch] : []), r.localSearch]) {
    for (const [key, v] of s.vectors) {
      const had = search.get(key);
      const newer = (searchAt.get(key) ?? -Infinity) <= s.createdAt;
      if (had === undefined || (v && !had) || (newer && (v || !had))) {
        search.set(key, v);
        searchAt.set(key, s.createdAt);
      }
    }
  }
  let searchKeys = 0;
  for (const v of search.values()) if (v) searchKeys++;

  // Grouping, over every face not removed from People.
  // In face id order, as the phone takes them, so a tie in score always falls the same way.
  const kept = [...faces.values()]
    .filter((f) => identityOut.get(f.id)?.kind !== "rejected" && r.inLibrary(f.key))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const confirmedOf = kept.map((f) => {
    const v = identityOut.get(f.id);
    return v?.kind === "confirmed" ? v.name : null;
  });
  // A face's name from another device, else the name the last grouping here gave it. A face
  // whose name a device took away (an edit's empty value) carries none.
  const carriedOf = kept.map((f) => {
    const reg = carried.get(f.id);
    if (reg && reg.value !== undefined) return reg.value || null;
    const last = r.lastNames.get(f.id);
    return last ? resolve(last, Infinity) : null;
  });
  const blockedOf = kept.map((f) => blockedOut.get(f.id) ?? new Set<string>());
  const samples: FaceSample[] = kept.map((f, i) => ({
    embedding: f.embedding,
    score: f.score,
    confident: isConfident(f.score, f.blur, sideways(f.points)),
    confirmed: confirmedOf[i] !== null,
  }));
  // The grouping of the faces themselves is the costly part of a merge. An edit that only
  // confirms faces already grouped (a "yes" to a suggestion, a name, a rename) leaves it as it
  // was, provably (baseStillHolds), so it is reused rather than redone.
  const ids = kept.map((f) => f.id);
  const cached = r.clusterCache;
  let assignment: Int32Array;
  if (
    cached &&
    cached.version === r.faceVersion &&
    cached.ids.length === ids.length &&
    cached.ids.every((id, i) => id === ids[i]) &&
    baseStillHolds(cached.samples, cached.pass, samples)
  ) {
    assignment = cached.merged;
  } else {
    const pass = basePass(samples);
    assignment = mergePass(pass, samples);
    r.clusterCache = { version: r.faceVersion, ids, samples, pass, merged: assignment };
  }
  const voted = resolveClusterNames(carriedOf, confirmedOf, assignment);
  const split = splitOutUnclaimedNames(confirmedOf, assignment, voted);
  assignment = attractToNamed(
    kept.map((f) => f.embedding), kept.map((f) => f.score), split.assignment, split.names, confirmedOf, blockedOf,
  );
  // A face marked as not a person never stays under that person's name.
  for (let i = 0; i < kept.length; i++) {
    const name = split.names.get(assignment[i]);
    if (name && !confirmedOf[i] && blockedOf[i].has(name)) assignment[i] = -1;
  }

  const groupsById = new Map<number, Face[]>();
  kept.forEach((f, i) => {
    if (assignment[i] >= 0) (groupsById.get(assignment[i]) ?? groupsById.set(assignment[i], []).get(assignment[i])!).push(f);
  });
  const groups = [...groupsById].map(([c, members]) => {
    members.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    const name = split.names.get(c) ?? null;
    const id = name ? `n:${name}` : `g:${[...members].map((f) => f.id).sort()[0]}`;
    return { id, name, faces: members.map((f) => f.id) };
  });

  // People: named groups and the names that only hold hand-added photos, then the unnamed
  // groups that span enough photos to be worth naming.
  const manualByName = new Map<string, string[]>();
  for (const k of manualOut.keys()) {
    const [name, key] = splitPair(k);
    if (r.inLibrary(key)) (manualByName.get(name) ?? manualByName.set(name, []).get(name)!).push(key);
  }
  const keyOf = (id: string) => id.slice(0, id.lastIndexOf("#"));
  const people: Person[] = [];
  const named = new Set<string>();
  for (const g of groups) {
    const photoKeys = new Set(g.faces.map(keyOf));
    if (g.name) {
      named.add(g.name);
      for (const k of manualByName.get(g.name) ?? []) photoKeys.add(k);
    } else if (photoKeys.size < MIN_FACES_TO_SHOW) {
      continue;
    }
    people.push({ id: g.id, name: g.name, faces: g.faces, keys: [...photoKeys], cover: coverFor(g.name, g.faces, faces, coversOut, photoKeys) });
  }
  for (const [name, keys] of manualByName) {
    if (named.has(name)) continue;
    const chosen = coversOut.get(name);
    people.push({ id: `n:${name}`, name, faces: [], keys, cover: { key: chosen && keys.includes(chosen) ? chosen : keys[0], box: null } });
  }
  people.sort((a, b) => (a.name && b.name ? b.keys.length - a.keys.length || a.name.localeCompare(b.name) : a.name ? -1 : b.name ? 1 : b.keys.length - a.keys.length));

  const unnamedShown = people.filter((p) => !p.name);
  const centroids = (ids: string[]) => centroid(ids.map((id) => faces.get(id)!.embedding));
  const suggestions = suggestMatches(
    people.filter((p) => p.name && p.faces.length).map((p) => ({ name: p.name!, centroid: centroids(p.faces) })),
    unnamedShown.map((p) => ({ id: p.id, centroid: centroids(p.faces) })),
  )
    .map((s) => ({ name: s.name, group: s.id, score: s.score, faces: unnamedShown.find((p) => p.id === s.id)!.faces }))
    // A group holding a face marked as not that person is not offered again, as on the phone.
    .filter((s) => s.faces.length > 0 && !s.faces.some((id) => blockedOut.get(id)?.has(s.name)));

  r.lastNames = new Map();
  for (const g of groups) if (g.name) for (const id of g.faces) r.lastNames.set(id, g.name);

  return {
    faces, markers, identity: identityOut, blocked: blockedOut, manual: manualOut, covers: coversOut,
    search, searchKeys, groups, people, suggestions, byKey,
  };
}

function coverFor(
  name: string | null,
  ids: string[],
  faces: Map<string, Face>,
  covers: Map<string, string>,
  keys: Set<string>,
): Person["cover"] {
  const chosen = name ? covers.get(name) : undefined;
  if (chosen && keys.has(chosen)) {
    const face = ids.map((id) => faces.get(id)!).find((f) => f.key === chosen);
    return { key: chosen, box: face?.box ?? null };
  }
  const top = ids[0] ? faces.get(ids[0]) : undefined;
  return top ? { key: top.key, box: top.box } : null;
}
