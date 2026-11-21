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

// The faces a phone saved to Drive set beside the faces found on this computer: the same face
// on the same photo is found by where it sits, and its numbers are compared.

import { installDeviceId } from "./deviceId.ts";
import {
  CURATION_COVER,
  CURATION_MANUAL_PHOTO,
  CURATION_NOT_PERSON,
  type CurationRemoval,
  type FaceCopy,
  type FaceCopyToWrite,
  type SnapshotFace,
  type WrittenFace,
} from "./driveData.ts";
import { sidewaysMeasure } from "./faceAlign.ts";
import { FACE_EMBEDDING_DIM, dot, runPausable, runPausableSliced, type Pausable } from "./faceCluster.ts";
import {
  curationKey,
  dropHidden,
  foldPersonName,
  keepNameChange,
  mergeInPlace,
  moveCuration,
  moveHidden,
  otherPerson,
  takeTokenOff,
  portableFaceId,
  pruneCuration,
  renameInPlace,
} from "./facePeople.ts";
import {
  FACE_MODEL_VERSION,
  MAX_FACE_INDEX,
  SAME_FACE_IOU,
  boxOverlap as iou,
  type Curation,
  type FaceRecord,
  type FaceStore,
  type Person,
} from "./faceStore.ts";
import { isHiddenToken } from "./personName.ts";

export { SAME_FACE_IOU };

/** A phone's face and the face found here that is the same one. */
export type FacePair = { phone: SnapshotFace; local: FaceRecord; overlap: number };

/** Below this box overlap two faces are the same only when their numbers say so as well. */
export const SAME_FACE_LOOSE_IOU = 0.3;
/** How alike the numbers of two loosely overlapping faces must be to be taken as the same face. */
export const SAME_FACE_MIN_COSINE = 0.7;
/** How far apart two box edges may be and still be the same box after a copy's 32-bit floats. */
const SAME_BOX_TOLERANCE = 1e-4;

type Placed = { box: readonly number[]; embedding: Float32Array };

function alike(a: Placed, b: Placed): number {
  return a.embedding.length === FACE_EMBEDDING_DIM && b.embedding.length === FACE_EMBEDDING_DIM ? dot(a.embedding, b.embedding) : NaN;
}

/** Whether two faces on one photo are the same face: boxes overlapping by half, or loosely
 *  overlapping boxes whose numbers agree. The phone decides by the same rule. */
export function sameFace(a: Placed, b: Placed): boolean {
  const overlap = iou(a.box, b.box);
  return overlap >= SAME_FACE_IOU || (overlap >= SAME_FACE_LOOSE_IOU && alike(a, b) >= SAME_FACE_MIN_COSINE);
}

/**
 * The phone faces of one photo paired with the faces found on it here, each face once: first the
 * boxes that overlap by half, the closest overlap first, then, when the numbers compare (`loose`),
 * the loosely overlapping ones whose numbers agree, the most alike first. Ties go to the lower
 * index. The phone pairs by the very same steps (`pairSameFaces`), so both pick the same twins.
 */
function pairOnPhoto(phoneFaces: SnapshotFace[], local: FaceRecord[], loose = true): FacePair[] {
  const takenPhone = new Set<SnapshotFace>();
  const takenLocal = new Set<string>();
  const pairs: FacePair[] = [];
  const take = (options: { pair: FacePair; rank: number }[]) => {
    options.sort(
      (a, b) =>
        b.rank - a.rank || a.pair.phone.index - b.pair.phone.index || indexOf(a.pair.local.id) - indexOf(b.pair.local.id),
    );
    for (const { pair } of options) {
      if (takenPhone.has(pair.phone) || takenLocal.has(pair.local.id)) continue;
      takenPhone.add(pair.phone);
      takenLocal.add(pair.local.id);
      pairs.push(pair);
    }
  };
  const close: { pair: FacePair; rank: number }[] = [];
  for (const phone of phoneFaces) {
    for (const here of local) {
      const overlap = iou(phone.box, here.box);
      if (overlap >= SAME_FACE_IOU) close.push({ pair: { phone, local: here, overlap }, rank: overlap });
    }
  }
  take(close);
  if (!loose) return pairs;
  const near: { pair: FacePair; rank: number }[] = [];
  for (const phone of phoneFaces) {
    if (takenPhone.has(phone)) continue;
    for (const here of local) {
      if (takenLocal.has(here.id)) continue;
      const overlap = iou(phone.box, here.box);
      if (overlap < SAME_FACE_LOOSE_IOU) continue;
      const similarity = alike(phone, here);
      if (similarity >= SAME_FACE_MIN_COSINE) near.push({ pair: { phone, local: here, overlap }, rank: similarity });
    }
  }
  take(near);
  return pairs;
}

/**
 * Each phone face on a photo also looked at here, with the face here that is the same face
 * (`pairOnPhoto`); one local face is taken by one phone face at most.
 */
export function pairFaces(store: FaceStore, copies: FaceCopy[]): FacePair[] {
  return runPausable(pairFacesSteps(store, copies));
}

function* pairFacesSteps(store: FaceStore, copies: FaceCopy[]): Pausable<FacePair[]> {
  const uidByLink = new Map<string, string>();
  for (const uid of store.scanned()) uidByLink.set(uid.slice(uid.indexOf("~") + 1), uid);
  const pairs: FacePair[] = [];
  for (const copy of copies) {
    const byKey = new Map<string, SnapshotFace[]>();
    for (const face of copy.faces) {
      if (face.rejected || !uidByLink.has(face.key)) continue;
      let list = byKey.get(face.key);
      if (!list) byKey.set(face.key, (list = []));
      list.push(face);
    }
    for (const [key, phoneFaces] of byKey) {
      yield;
      pairs.push(...pairOnPhoto(phoneFaces, store.facesOf(uidByLink.get(key)!)));
    }
  }
  return pairs;
}

/**
 * Whether the other device's copy holds the set of faces this computer takes in place of its own
 * where both looked at a photo: the device whose id sorts first keeps its set. Never for an unknown
 * id or this computer's own copy. The phone decides by the same rule, so the two agree.
 */
export function incomingSetWins(copyDeviceId: string, ownDeviceId: string | null): boolean {
  return !!copyDeviceId && !!ownDeviceId && copyDeviceId < ownDeviceId;
}

/** Whether every face of the copy for a photo is held here as it is, under its index and in its
 *  box: the two sets were brought together before. Faces of its own beside them are allowed. */
export function holdsIncomingSet(faces: SnapshotFace[], here: FaceRecord[]): boolean {
  const byIndex = new Map(here.map((f) => [indexOf(f.id), f]));
  return faces.every((face) => {
    const held = byIndex.get(face.index);
    return !!held && held.box.every((v, i) => Math.abs(v - face.box[i]) <= SAME_BOX_TOLERANCE);
  });
}

/**
 * Free indexes for faces moving onto a photo, none of them in `used`: every face's own index when
 * that is free, then the lowest free ones, in index order. The phone assigns by the same rule
 * (`freeFaceIds`). Returns own index to new index.
 */
function freeIndexes(used: Set<number>, own: number[]): Map<number, number> {
  const taken = new Set(used);
  const out = new Map<number, number>();
  const ordered = [...new Set(own)].sort((a, b) => a - b);
  for (const index of ordered) {
    if (taken.has(index)) continue;
    taken.add(index);
    out.set(index, index);
  }
  let next = 0;
  for (const index of ordered) {
    if (out.has(index)) continue;
    while (taken.has(next)) next++;
    taken.add(next);
    out.set(index, next);
  }
  return out;
}

function recordOf(uid: string, face: SnapshotFace, index: number): FaceRecord {
  return {
    id: `${uid}#${index}`,
    uid,
    box: face.box,
    points: face.points.length >= 10 ? face.points.slice(0, 10) : [],
    score: face.score,
    blur: face.blur ?? 100,
    sideways: sidewaysMeasure(face.points) ?? 0,
    embedding: face.embedding,
  };
}

/** The ids of each photo's faces in the people's records, in the order each record holds them, so a photo's decisions are found without reading every face's. */
type PhotoIndex = {
  confirmed: Map<string, string[]>;
  assign: Map<string, string[]>;
  blocked: Map<string, string[]>;
  rejected: Map<string, string[]>;
  /** The keys of the "not this person" times, by the photo's link id. */
  curation: Map<string, string[]>;
};

const photoOfFace = (faceId: string) => faceId.slice(0, faceId.lastIndexOf("#"));

function indexByPhoto(keys: Iterable<string>, photo: (key: string) => string | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const key of keys) {
    const at = photo(key);
    if (at === null) continue;
    const list = out.get(at);
    if (list) list.push(key);
    else out.set(at, [key]);
  }
  return out;
}

function photoIndex(p: FaceStore["people"], rejected: Set<string>): PhotoIndex {
  return {
    confirmed: indexByPhoto(Object.keys(p.confirmed), photoOfFace),
    assign: indexByPhoto(Object.keys(p.assign), photoOfFace),
    blocked: indexByPhoto(Object.keys(p.blocked), photoOfFace),
    rejected: indexByPhoto(rejected, photoOfFace),
    curation: indexByPhoto(Object.keys(p.curation), (key) => {
      const c = p.curation[key];
      return c.kind === CURATION_NOT_PERSON ? photoOfFace(c.ref) : null;
    }),
  };
}

/**
 * Points what the user decided about a photo's faces at the ids `newIdOf` gives them: the
 * confirmed names, the groupings, the "not this person" marks and their times, and the faces left
 * out. A face with no new id takes its decisions with it. `index` finds the photo's entries; each
 * photo is pointed once per index.
 */
function repointFaces(
  p: FaceStore["people"],
  rejected: Set<string>,
  uid: string,
  newIdOf: Map<string, string>,
  index: PhotoIndex,
): void {
  const move = <T>(record: Record<string, T>, ids: string[] | undefined) => {
    const moved: [string, T][] = [];
    for (const id of ids ?? []) {
      if (!Object.hasOwn(record, id)) continue;
      const value = record[id];
      delete record[id];
      const to = newIdOf.get(id);
      if (to) moved.push([to, value]);
    }
    for (const [to, value] of moved) record[to] = value;
  };
  move(p.confirmed, index.confirmed.get(uid));
  move(p.assign, index.assign.get(uid));
  move(p.blocked, index.blocked.get(uid));
  const left = (index.rejected.get(uid) ?? []).filter((id) => rejected.has(id));
  for (const id of left) rejected.delete(id);
  for (const id of left) {
    const to = newIdOf.get(id);
    if (to) rejected.add(to);
  }
  const link = linkOf(uid);
  const portable = new Map([...newIdOf].map(([from, to]) => [portableFaceId(from), portableFaceId(to)]));
  const times: Curation[] = [];
  for (const key of index.curation.get(link) ?? []) {
    const c = p.curation[key];
    if (!c || c.kind !== CURATION_NOT_PERSON || photoOfFace(c.ref) !== link) continue;
    delete p.curation[key];
    const to = portable.get(c.ref);
    if (to) times.push({ ...c, ref: to });
  }
  for (const c of times) {
    const key = curationKey(c.kind, c.name, c.ref);
    if ((p.curation[key]?.at ?? -1) < c.at) p.curation[key] = c;
  }
}

/**
 * Takes the other device's set of faces for a photo in place of the one found here: each face
 * takes over what the user decided about the face here that is the same one, and every face here
 * with no twin there stays under a free index. A face left out there is left out here too, unless
 * it was confirmed here. The names the copy brings follow as for any pair, since the faces now sit
 * in the very same boxes.
 */
function adoptSet(
  store: FaceStore,
  rejected: Set<string>,
  uid: string,
  faces: SnapshotFace[],
  here: FaceRecord[],
  index: PhotoIndex,
): void {
  const p = store.people;
  const pairs = pairOnPhoto(faces, here);
  const twinOf = new Map(pairs.map((x) => [x.phone, x.local]));
  const newIdOf = new Map<string, string>();
  const records: FaceRecord[] = [];
  const used = new Set(faces.map((f) => f.index));
  for (const face of faces) {
    const record = recordOf(uid, face, face.index);
    records.push(record);
    const twin = twinOf.get(face);
    if (twin) newIdOf.set(twin.id, record.id);
  }
  const paired = new Set(pairs.map((x) => x.local.id));
  const alone = here.filter((face) => !paired.has(face.id));
  const moved = freeIndexes(used, alone.map((face) => indexOf(face.id)));
  for (const face of alone) {
    const record = { ...face, id: `${uid}#${moved.get(indexOf(face.id))!}` };
    records.push(record);
    newIdOf.set(face.id, record.id);
  }
  repointFaces(p, rejected, uid, newIdOf, index);
  for (const face of faces) {
    const id = `${uid}#${face.index}`;
    if (face.rejected && p.confirmed[id] === undefined && !rejected.has(id)) {
      rejected.add(id);
      delete p.assign[id];
    }
  }
  store.put(uid, records);
}

export type Comparison = {
  /** Phone faces on photos looked at here. */
  phoneFaces: number;
  pairs: number;
  /** Cosine of the pairs' numbers: middle, low tenth, high tenth, and the share at 0.8 or more. */
  median: number;
  p10: number;
  p90: number;
  close: number;
  /** Middle overlap of the paired boxes. */
  overlap: number;
};

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export function compareWithPhone(store: FaceStore, copies: FaceCopy[]): Comparison {
  return runPausable(compareSteps(store, copies));
}

/** `compareWithPhone`, giving the rest of the process its turn as it pairs the faces. */
export function compareWithPhoneAsync(store: FaceStore, copies: FaceCopy[]): Promise<Comparison> {
  return runPausableSliced(compareSteps(store, copies));
}

function* compareSteps(store: FaceStore, copies: FaceCopy[]): Pausable<Comparison> {
  const uids = new Set(store.scanned().map((uid) => uid.slice(uid.indexOf("~") + 1)));
  let phoneFaces = 0;
  for (const copy of copies) for (const f of copy.faces) if (!f.rejected && uids.has(f.key)) phoneFaces++;
  const pairs = (yield* pairFacesSteps(store, copies)).filter((p) => p.phone.embedding.length === p.local.embedding.length);
  const cos = pairs.map((p) => dot(p.phone.embedding, p.local.embedding)).sort((a, b) => a - b);
  const overlaps = pairs.map((p) => p.overlap).sort((a, b) => a - b);
  return {
    phoneFaces,
    pairs: pairs.length,
    median: quantile(cos, 0.5),
    p10: quantile(cos, 0.1),
    p90: quantile(cos, 0.9),
    close: cos.length ? cos.filter((c) => c >= 0.8).length / cos.length : 0,
    overlap: quantile(overlaps, 0.5),
  };
}

export function describeComparison(c: Comparison): string {
  const f = (v: number) => v.toFixed(3);
  return (
    `${c.pairs} of ${c.phoneFaces} faces paired, cosine median ${f(c.median)} ` +
    `(p10 ${f(c.p10)}, p90 ${f(c.p90)}), ${Math.round(c.close * 100)}% at 0.8 or more, ` +
    `box overlap median ${f(c.overlap)}`
  );
}

/** The recognition model's digest, as the phone writes it: a copy under it is taken in whole. */
export const FACE_MODEL_SHA256 = "ffd8203a0c9e93d90a4957e24d173a883a5a04d64d23c771742c66273518a0db";
/** The generation of the grouping rules, as the phone counts them. */
export const FACE_CLUSTER_PARAMS_VERSION = 1;

/**
 * Whether a copy's faces were made the way this computer makes them: the same face pipeline, numbers
 * of the same width from the same recognition model, grouped under the same rules. A digest left
 * blank cannot prove the models differ. Only such a copy's faces and numbers are taken in; from any
 * other, only the names and the rest of the curation, laid on the faces found here by where they sit.
 */
export function copyFits(copy: FaceCopy): boolean {
  const sha = copy.faceModelSha256.trim().toLowerCase();
  return (
    copy.faceModelVersion === FACE_MODEL_VERSION &&
    copy.embeddingDim === FACE_EMBEDDING_DIM &&
    copy.clusterParamsVersion === FACE_CLUSTER_PARAMS_VERSION &&
    (sha === "" || sha === FACE_MODEL_SHA256)
  );
}

/** Whether `name` was taken off its person here, or on a device whose copy came in, after `at`. */
function nameTakenOffSince(p: FaceStore["people"], name: string, at: number): boolean {
  const fold = foldPersonName(name);
  return p.nameChanges.some((c) => !c.to && c.at > at && foldPersonName(c.from) === fold);
}

const linkOf = (uid: string) => uid.slice(uid.indexOf("~") + 1);
const indexOf = (faceId: string) => Number(faceId.slice(faceId.lastIndexOf("#") + 1));

/** This install's id among the devices, made once and kept with the people. */
export function deviceIdOf(store: FaceStore): string {
  const p = store.people;
  if (!p.deviceId) {
    p.deviceId = installDeviceId();
    store.markPeople();
  }
  return p.deviceId;
}

/**
 * What this computer puts on Drive: every face found here with who it is, the "not this person"
 * marks, the picked covers, and every photo looked at, in the copy format the phone reads.
 */
export function copyForDrive(
  store: FaceStore,
  deviceLabel: string,
  at: number,
  facesWipedAt = 0,
  hidden: (uid: string) => boolean = () => false,
): FaceCopyToWrite {
  const p = store.people;
  // A hidden photo is never carried: not its faces, its marks, its cover, nor that it was looked at.
  const uidByLink = new Map(store.scanned().map((uid) => [linkOf(uid), uid]));
  const hiddenLink = (link: string) => {
    const uid = uidByLink.get(link);
    return uid !== undefined && hidden(uid);
  };
  const rejected = new Set(p.rejected);
  const nameOf = new Map<string, string>();
  for (const person of p.people) if (person.name) nameOf.set(person.id, person.name);
  const faces: WrittenFace[] = [];
  const notPerson: FaceCopyToWrite["notPerson"] = [];
  // In a fixed order, so the same faces make the same copy, and an unchanged one is not saved again.
  const ordered = store
    .allFaces()
    .filter((f) => !hidden(f.uid))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const face of ordered) {
    const key = linkOf(face.uid);
    const index = indexOf(face.id);
    const owner = p.assign[face.id];
    faces.push({
      key,
      index,
      box: face.box,
      score: face.score,
      blur: face.blur,
      rejected: rejected.has(face.id),
      person: owner ? (nameOf.get(owner) ?? null) : null,
      confirmed: p.confirmed[face.id] ?? null,
      // A face taken from the phone came with no landmarks; the zeros it is kept with here are none.
      points: face.points.every((v) => v === 0) ? [] : face.points,
      embedding: face.embedding,
    });
    for (const name of p.blocked[face.id] ?? []) {
      notPerson.push({ name, key, index, at: setTime(p, CURATION_NOT_PERSON, name, portableFaceId(face.id)) });
    }
  }
  const covers: FaceCopyToWrite["covers"] = [];
  for (const [name, uid] of Object.entries(p.covers)) {
    if (store.has(uid) && !hidden(uid)) covers.push({ name, key: linkOf(uid), at: setTime(p, CURATION_COVER, name, "") });
  }
  const manual: NonNullable<FaceCopyToWrite["manual"]> = [];
  for (const [name, links] of Object.entries(p.manual)) {
    for (const key of [...links].sort()) {
      if (!hiddenLink(key)) manual.push({ name, key, at: setTime(p, CURATION_MANUAL_PHOTO, name, key) });
    }
  }
  // Every removal kept, about a photo every device knows (a link id) or a cover.
  const removals: CurationRemoval[] = Object.values(p.curation)
    .filter((c) => c.removed && (c.kind === CURATION_COVER || (c.ref && !c.ref.includes(":"))))
    .filter((c) => c.kind === CURATION_COVER || !hiddenLink(c.ref.split("#")[0]))
    .sort((a, b) => a.at - b.at)
    .map((c) => {
      const hash = c.kind === CURATION_NOT_PERSON ? c.ref.lastIndexOf("#") : -1;
      return {
        kind: c.kind,
        name: c.name,
        key: hash >= 0 ? c.ref.slice(0, hash) : c.ref,
        index: hash >= 0 ? Number(c.ref.slice(hash + 1)) || 0 : 0,
        at: c.at,
      };
    });
  return {
    deviceId: deviceIdOf(store),
    deviceLabel,
    createdAt: at,
    faceModelVersion: FACE_MODEL_VERSION,
    faceModelSha256: FACE_MODEL_SHA256,
    clusterParamsVersion: FACE_CLUSTER_PARAMS_VERSION,
    embeddingDim: FACE_EMBEDDING_DIM,
    facesWipedAt,
    faces,
    notPerson,
    covers,
    manual,
    removals,
    namedAt: (name) => p.namedAt[foldPersonName(name)] ?? 0,
    nameChanges: p.nameChanges,
    // Every row, a person shown again too, so the show crosses devices; in a fixed order.
    hiddenPeople: Object.keys(p.hidden)
      .sort()
      .map((k) => ({ name: p.hidden[k].name, hidden: p.hidden[k].hidden, at: p.hidden[k].at })),
    // Never marked as read at full resolution: this computer reads the large preview, tiles and
    // all, and the phone's own full-resolution "Find more photos" should still read these.
    markers: store
      .scanned()
      .filter((uid) => !hidden(uid))
      .map((uid) => ({ key: linkOf(uid), swept: false })),
  };
}

/** When a piece of curation was set by hand, 0 when no time is kept or it was taken away since. */
function setTime(p: FaceStore["people"], kind: number, name: string, ref: string): number {
  const held = p.curation[curationKey(kind, name, ref)];
  return held && !held.removed ? held.at : 0;
}

/**
 * Carries out the renames and merges another device made after the name held here, before its faces
 * are taken in, so they meet the people under their new names: the later rename or merge wins on
 * every device. One this computer holds a later name for is passed over. Every change and the later
 * of the two naming times are kept either way, so the next copy written here hands them on. Answers
 * how many were carried out; taking the same copy in again changes nothing. This computer's own
 * copy is passed over unless `ownToo`: what an earlier install on this PC saved, read back.
 */
export function takeInNameChanges(store: FaceStore, copy: FaceCopy, ownToo = false): number {
  const p = store.people;
  if (copy.deviceId === p.deviceId && !ownToo) return 0;
  let changed = false;
  let carried = 0;
  const timeOf = (name: string) => p.namedAt[foldPersonName(name)] ?? 0;
  const holder = (name: string) => p.people.find((x) => x.name && foldPersonName(x.name) === foldPersonName(name));
  // Two devices that each renamed one person away from the same name leave it held by no one here; the person
  // goes by the name the rename made here before `before` gave it, followed as far as it goes.
  const heldNow = (name: string, before: number): string | null => {
    let current = name;
    for (let hops = 0; hops < 20; hops++) {
      if (holder(current)) return current;
      const fold = foldPersonName(current);
      const next = p.nameChanges.filter((c) => c.to && c.at < before && foldPersonName(c.from) === fold).pop();
      if (!next) return null;
      current = next.to;
    }
    return null;
  };
  for (const [name, at] of copy.namedAt) {
    const fold = foldPersonName(name);
    if (!fold || at <= timeOf(name)) continue;
    p.namedAt[fold] = at;
    changed = true;
  }
  for (const change of copy.nameChanges) {
    const from = change.from.trim();
    const to = change.to.trim();
    if (!from || from === to) continue;
    const fromHere = heldNow(from, change.at);
    const person = fromHere ? holder(fromHere) : undefined;
    if (!to) {
      // The name taken off there, after it was given here: the person stays, unnamed.
      if (person && fromHere && timeOf(fromHere) < change.at) {
        // A hidden group shown again keeps its row: the show is the later row of that name.
        if (!isHiddenToken(fromHere)) dropHidden(p, fromHere);
        renameInPlace(p, person, null);
        carried++;
        changed = true;
      }
      if (keepNameChange(p, { from, to: "", at: change.at })) changed = true;
      if (timeOf(from) <= change.at && !holder(from) && p.namedAt[foldPersonName(from)] !== undefined) {
        delete p.namedAt[foldPersonName(from)];
        changed = true;
      }
      continue;
    }
    if (person && fromHere && foldPersonName(fromHere) !== foldPersonName(to) && timeOf(fromHere) < change.at) {
      const into = holder(to);
      if (into && into.id !== person.id) {
        const cover = p.covers[person.name!];
        mergeInPlace(p, person, into);
        if (cover && !p.covers[into.name!]) p.covers[into.name!] = cover;
      } else {
        renameInPlace(p, person, to);
      }
      // "Not this person" marks follow the name too, with the times of what was set by hand.
      const target = holder(to)!.name!;
      moveCuration(p, fromHere, target);
      moveHidden(p, fromHere, target);
      for (const [faceId, names] of Object.entries(p.blocked)) {
        if (!names.some((n) => foldPersonName(n) === foldPersonName(fromHere))) continue;
        const next = names.map((n) => (foldPersonName(n) === foldPersonName(fromHere) ? target : n));
        p.blocked[faceId] = [...new Set(next)];
      }
      carried++;
      changed = true;
    }
    if (keepNameChange(p, { from, to, at: change.at })) changed = true;
    if (timeOf(from) <= change.at && !holder(from) && p.namedAt[foldPersonName(from)] !== undefined) {
      delete p.namedAt[foldPersonName(from)];
      changed = true;
    }
    if (change.at > timeOf(to)) {
      p.namedAt[foldPersonName(to)] = change.at;
      changed = true;
    }
  }
  if (changed) {
    store.markPeople();
    store.edits++;
  }
  return carried;
}

/** What taking in another device's copy changed here. */
export type Applied = {
  /** Renames and merges made there after the name held here, carried out here. */
  renamed: number;
  named: number;
  added: number;
  rejected: number;
  marked: number;
  /** Photos attached to a person by hand there, newly attached here. */
  attached: number;
  /** Faces both sides name, differently: left as they are here. */
  conflicts: number;
  /** Photos whose faces here gave way to the set the other device found. */
  adopted: number;
  /** People hidden or shown again there after the setting held here. */
  hiddenChanged: number;
};

/**
 * Finds people by name, the first holder of a name in the people's order as a search through them
 * would, and makes one when nobody holds it. Read once from the people: only good while no one is
 * renamed meanwhile, and while people are added only through `named`.
 */
function peopleByName(p: FaceStore["people"]) {
  const byFold = new Map<string, Person>();
  for (const person of p.people) {
    if (!person.name) continue;
    const fold = foldPersonName(person.name);
    if (!byFold.has(fold)) byFold.set(fold, person);
  }
  return {
    holder: (name: string): Person | undefined => byFold.get(foldPersonName(name)),
    named: (name: string): Person => {
      const fold = foldPersonName(name);
      let person = byFold.get(fold);
      if (!person) {
        person = { id: `p${p.nextId++}`, name, isOther: false };
        p.people.push(person);
        byFold.set(fold, person);
      }
      return person;
    },
  };
}

/** `nameTakenOffSince` at `at`, worked out once per name: the renames do not change while a copy is taken in. */
function takenOffSince(p: FaceStore["people"], at: number): (name: string) => boolean {
  const known = new Map<string, boolean>();
  return (name) => {
    let off = known.get(name);
    if (off === undefined) known.set(name, (off = nameTakenOffSince(p, name, at)));
    return off;
  };
}

/**
 * Takes in what another device's copy knows and this computer does not, and nothing else: a name
 * for a face that has none here, a face the other device found and this one missed, a face left
 * out there that nobody decided on here, a "not this person" mark, a cover. A face both sides
 * name differently keeps its name here. Each copy is taken in once, when it is newer than the
 * last one taken in from that device. This computer's own copy only with `ownToo`, as for
 * `takeInNameChanges`.
 */
export function applyCopy(store: FaceStore, copy: FaceCopy, ownToo = false): Applied | null {
  return runPausable(applyCopySteps(store, copy, ownToo));
}

/**
 * `applyCopy`, giving the rest of the process its turn as it goes. Between turns it holds nothing
 * back: what it changed is in the people, and it reads them again after each turn, so a change made
 * meanwhile is built on, not written over. A store emptied or let go meanwhile ends it with null,
 * the copy not noted as taken in.
 */
export function applyCopyAsync(
  store: FaceStore,
  copy: FaceCopy,
  ownToo = false,
  slice?: () => Promise<void> | undefined,
): Promise<Applied | null> {
  return runPausableSliced(applyCopySteps(store, copy, ownToo), slice);
}

function* applyCopySteps(store: FaceStore, copy: FaceCopy, ownToo: boolean): Pausable<Applied | null> {
  const p = store.people;
  if (copy.deviceId === p.deviceId && !ownToo) return null;
  if ((p.applied[copy.deviceId] ?? -1) >= copy.createdAt) return null;
  const result: Applied = {
    renamed: takeInNameChanges(store, copy, ownToo),
    named: 0,
    added: 0,
    rejected: 0,
    marked: 0,
    attached: 0,
    conflicts: 0,
    adopted: 0,
    hiddenChanged: 0,
  };
  let rejected = new Set(p.rejected);
  const namesOf = () => {
    const out = new Map<string, string>();
    for (const person of p.people) if (person.name) out.set(person.id, person.name);
    return out;
  };
  let nameOf = namesOf();
  let people = peopleByName(p);
  let takenOff = takenOffSince(p, copy.createdAt);
  let index: PhotoIndex | null = null;
  const whole = copyFits(copy);
  const uidByLink = new Map<string, string>();
  for (const uid of store.scanned()) uidByLink.set(linkOf(uid), uid);
  // A face paired earlier that a change made meanwhile replaced or dropped is passed over.
  const current = (face: FaceRecord) => store.facesOf(face.uid).includes(face);

  // A turn for the rest of the process: what is held goes into the people first, and is read back after.
  let marks = 0;
  let assignHeld = p.assign;
  let peopleHeld = p.people;
  const handBack = () => {
    p.rejected = [...rejected];
    store.markPeople();
    store.edits++;
    marks = store.peopleMarks;
    assignHeld = p.assign;
    peopleHeld = p.people;
  };
  const takeBack = (): boolean => {
    if (store.people !== p || !store.isLoaded()) return false;
    rejected = new Set(p.rejected);
    nameOf = namesOf();
    people = peopleByName(p);
    takenOff = takenOffSince(p, copy.createdAt);
    if (store.peopleMarks !== marks || p.assign !== assignHeld || p.people !== peopleHeld) index = null;
    return true;
  };
  function* turn(): Generator<void, boolean, boolean> {
    handBack();
    yield;
    return takeBack();
  }

  // A photo both devices looked at holds two sets of the same faces. The device whose id sorts
  // first keeps its set; the other takes it in place of its own, once, so both end up with one set
  // under one set of ids and what is set by hand afterwards crosses face by face.
  if (whole && incomingSetWins(copy.deviceId, deviceIdOf(store))) {
    const facesByKey = new Map<string, SnapshotFace[]>();
    for (const face of copy.faces) {
      const list = facesByKey.get(face.key);
      if (list) list.push(face);
      else facesByKey.set(face.key, [face]);
    }
    for (const [key, faces] of facesByKey) {
      if ((yield) && !(yield* turn())) return null;
      const uid = uidByLink.get(key);
      if (!uid) continue;
      const here = store.facesOf(uid);
      if (here.length === 0 || holdsIncomingSet(faces, here)) continue;
      if (faces.some((f) => f.embedding.length !== FACE_EMBEDDING_DIM || f.index > MAX_FACE_INDEX)) continue;
      index ??= photoIndex(p, rejected);
      adoptSet(store, rejected, uid, faces, here, index);
      result.adopted++;
    }
  }

  const copyByKey = new Map<string, SnapshotFace[]>();
  for (const face of copy.faces) {
    if (!uidByLink.has(face.key)) continue;
    const list = copyByKey.get(face.key);
    if (list) list.push(face);
    else copyByKey.set(face.key, [face]);
  }
  const localOf = new Map<SnapshotFace, FaceRecord>();
  for (const [key, faces] of copyByKey) {
    if ((yield) && !(yield* turn())) return null;
    for (const pair of pairOnPhoto(faces, store.facesOf(uidByLink.get(key)!), whole)) localOf.set(pair.phone, pair.local);
  }

  // Faces the other device found and this one did not: every face of the copy left unpaired, kept
  // here as found there, under its own index when it is free here, else the lowest free one, when its
  // numbers are this computer's kind. Pairing takes every same face it can, so an unpaired face is
  // none of the faces here, or a second detection that device holds and this one must hold too for the
  // two sets to be one. One left out there comes left out.
  if (whole) {
    for (const [key, faces] of copyByKey) {
      if ((yield) && !(yield* turn())) return null;
      const uid = uidByLink.get(key)!;
      if (!store.has(uid)) continue;
      const missing = faces.filter((face) => !localOf.has(face) && face.embedding.length === FACE_EMBEDDING_DIM);
      if (missing.length === 0) continue;
      const here = store.facesOf(uid);
      const at = freeIndexes(new Set(here.map((f) => indexOf(f.id))), missing.map((face) => face.index));
      const added: FaceRecord[] = [];
      for (const face of missing) {
        const index = at.get(face.index)!;
        if (index > MAX_FACE_INDEX || added.some((r) => indexOf(r.id) === index)) continue;
        const record = recordOf(uid, face, index);
        added.push(record);
        localOf.set(face, record);
        if (face.rejected) rejected.add(record.id);
        result.added++;
      }
      if (added.length) store.put(uid, [...here, ...added]);
    }
  }

  const byKeyIndex = new Map<string, FaceRecord>();
  for (const [phone, local] of localOf) byKeyIndex.set(`${phone.key}#${phone.index}`, local);
  const paired = (key: string, index: number) => {
    const local = byKeyIndex.get(`${key}#${index}`);
    return local && current(local) ? local : undefined;
  };

  // What that device took away by hand after it was set here goes here too; the removal is kept
  // either way, so a setting from before it is not brought back and the next copy hands it on.
  for (const removal of copy.removals) {
    if ((yield) && !(yield* turn())) return null;
    let ref = removal.key;
    let local: FaceRecord | undefined;
    if (removal.kind === CURATION_NOT_PERSON) {
      const uid = uidByLink.get(removal.key);
      local = paired(removal.key, removal.index) ?? (uid ? store.facesOf(uid).find((f) => f.id === `${uid}#${removal.index}`) : undefined);
      ref = local ? portableFaceId(local.id) : `${removal.key}#${removal.index}`;
    } else if (removal.kind === CURATION_COVER) {
      ref = "";
    }
    const key = curationKey(removal.kind, removal.name, ref);
    const held = p.curation[key];
    if ((held?.at ?? 0) >= removal.at) continue;
    if (!held?.removed) {
      if (removal.kind === CURATION_MANUAL_PHOTO) {
        const name = people.holder(removal.name)?.name ?? removal.name;
        const rest = (p.manual[name] ?? []).filter((link) => link !== removal.key);
        if (rest.length) p.manual[name] = rest;
        else delete p.manual[name];
      }
      if (local && p.blocked[local.id]) {
        const rest = p.blocked[local.id].filter((n) => foldPersonName(n) !== foldPersonName(removal.name));
        if (rest.length) p.blocked[local.id] = rest;
        else delete p.blocked[local.id];
      }
      if (removal.kind === CURATION_COVER) {
        const person = people.holder(removal.name);
        if (person) delete p.covers[person.name!];
      }
    }
    p.curation[key] = { kind: removal.kind, name: removal.name, ref, removed: true, at: removal.at };
  }
  pruneCuration(p);

  for (const [phone, local] of localOf) {
    if ((yield) && !(yield* turn())) return null;
    if (rejected.has(local.id) || !current(local)) continue;
    const decided = p.confirmed[local.id] !== undefined;
    if (phone.rejected) {
      if (!decided) {
        rejected.add(local.id);
        delete p.assign[local.id];
        result.rejected++;
      }
      continue;
    }
    const name = phone.confirmed ?? phone.person;
    if (!name || takenOff(name)) continue;
    const ownerName = p.assign[local.id] ? nameOf.get(p.assign[local.id]) : undefined;
    if (ownerName !== undefined) {
      if (foldPersonName(ownerName) !== foldPersonName(name)) result.conflicts++;
      continue;
    }
    if (decided || p.blocked[local.id]?.some((n) => foldPersonName(n) === foldPersonName(name))) continue;
    const person = people.named(name);
    nameOf.set(person.id, person.name!);
    p.assign[local.id] = person.id;
    // Only a name confirmed there is confirmed here: the other device's grouping is as automatic as this one's.
    if (phone.confirmed) p.confirmed[local.id] = person.name!;
    result.named++;
  }
  p.rejected = [...rejected];

  for (const mark of copy.notPerson) {
    if ((yield) && !(yield* turn())) return null;
    const local = paired(mark.key, mark.index);
    if (!local) continue;
    const key = curationKey(CURATION_NOT_PERSON, mark.name, portableFaceId(local.id));
    const held = p.curation[key];
    const confirmedHere = p.confirmed[local.id] !== undefined && foldPersonName(p.confirmed[local.id]) === foldPersonName(mark.name);
    // A mark set by hand there after what is held here for it outranks the confirmation here: the
    // photo was taken off the person there. An untimed or older one leaves a confirmed face alone.
    const overrides = mark.at > 0 && mark.at > (held?.at ?? 0);
    if (confirmedHere && !overrides) continue;
    // Taken back here after it was set there: not brought back.
    if (held?.removed && held.at >= mark.at) continue;
    if (mark.at > (held?.at ?? 0)) {
      p.curation[key] = { kind: CURATION_NOT_PERSON, name: mark.name, ref: portableFaceId(local.id), removed: false, at: mark.at };
    }
    if (confirmedHere) {
      delete p.confirmed[local.id];
      const owner = p.people.find((x) => x.id === p.assign[local.id]);
      if (owner?.name && foldPersonName(owner.name) === foldPersonName(mark.name)) p.assign[local.id] = otherPerson(p).id;
    }
    const list = p.blocked[local.id] ?? [];
    if (list.includes(mark.name)) continue;
    list.push(mark.name);
    p.blocked[local.id] = list;
    result.marked++;
  }
  for (const m of copy.manual) {
    if ((yield) && !(yield* turn())) return null;
    if (!m.name.trim() || takenOff(m.name)) continue;
    const name = people.holder(m.name)?.name ?? m.name;
    const key = curationKey(CURATION_MANUAL_PHOTO, name, m.key);
    const held = p.curation[key];
    if (held?.removed && held.at >= m.at) continue;
    const list = p.manual[name] ?? [];
    if (!list.includes(m.key)) {
      p.manual[name] = [...list, m.key];
      result.attached++;
    }
    if (m.at > (held?.at ?? 0)) p.curation[key] = { kind: CURATION_MANUAL_PHOTO, name, ref: m.key, removed: false, at: m.at };
  }
  for (const [name, key] of copy.covers) {
    if ((yield) && !(yield* turn())) return null;
    const uid = uidByLink.get(key);
    const person = people.holder(name);
    if (!uid || !person) continue;
    const setAt = copy.coverSetAt.get(name) ?? 0;
    const curation = curationKey(CURATION_COVER, person.name!, "");
    const held = p.curation[curation];
    if (held?.removed && held.at >= setAt) continue;
    // Of two covers the later one; with none here, the other device's. A cover picked here always has
    // its time, so one held without a time came from another device's copy, and that device's current
    // cover takes its place even when it carries no time either.
    const heldAt = held && !held.removed ? held.at : 0;
    if (p.covers[person.name!] && heldAt > 0 && setAt <= heldAt) continue;
    p.covers[person.name!] = uid;
    if (setAt > heldAt) p.curation[curation] = { kind: CURATION_COVER, name: person.name!, ref: "", removed: false, at: setAt };
  }

  // Hiding and showing: the later of the two settings of a name wins, here or there. A name taken off
  // after the setting has nothing left to hide. A group shown again there loses its reserved label here.
  // Showing a hidden group renames it, so the people are searched as they are now.
  const holderNow = (name: string) => p.people.find((x) => x.name && foldPersonName(x.name) === foldPersonName(name));
  for (const h of copy.hiddenPeople) {
    const name = h.name.trim();
    if (!name) continue;
    const token = isHiddenToken(name);
    if (!token && nameTakenOffSince(p, name, h.at)) continue;
    const key = foldPersonName(name);
    if ((p.hidden[key]?.at ?? -1) >= h.at) continue;
    const person = holderNow(name);
    p.hidden[key] = { name: person?.name ?? name, hidden: h.hidden, at: h.at };
    if (!h.hidden && person) takeTokenOff(p, person, h.at);
    result.hiddenChanged++;
  }

  p.applied[copy.deviceId] = copy.createdAt;
  store.markPeople();
  store.edits++;
  return result;
}

/**
 * Takes the photos another device's face scan already finished as done here, with the faces it
 * found on them, so this computer does not scan them again: the two share the work. Only photos
 * of this library (`uidByLink`, link id to uid) that were not scanned here are taken. A face
 * comes with the name it has there; a face left out there, or one of another model's size, is
 * not taken, and the photo still counts as done. Answers how many photos were taken. This
 * computer's own copy only with `ownToo`, as for `takeInNameChanges`.
 */
export function adoptScanned(store: FaceStore, copy: FaceCopy, uidByLink: Map<string, string>, ownToo = false): number {
  return runPausable(adoptScannedSteps(store, copy, uidByLink, ownToo));
}

/**
 * `adoptScanned`, giving the rest of the process its turn between photos; it reads the people again
 * after each turn. A store emptied or let go meanwhile ends it with what was taken until then.
 */
export function adoptScannedAsync(
  store: FaceStore,
  copy: FaceCopy,
  uidByLink: Map<string, string>,
  ownToo = false,
  slice?: () => Promise<void> | undefined,
): Promise<number> {
  return runPausableSliced(adoptScannedSteps(store, copy, uidByLink, ownToo), slice);
}

function* adoptScannedSteps(store: FaceStore, copy: FaceCopy, uidByLink: Map<string, string>, ownToo: boolean): Pausable<number> {
  const p = store.people;
  if (copy.deviceId === p.deviceId && !ownToo) return 0;
  // Faces of another kind compare with nothing found here: their photos are scanned here instead.
  if (!copyFits(copy)) return 0;
  // The names the faces come with are the ones after that device's renames and merges.
  takeInNameChanges(store, copy, ownToo);
  const facesOf = new Map<string, SnapshotFace[]>();
  for (const face of copy.faces) {
    const list = facesOf.get(face.key);
    if (list) list.push(face);
    else facesOf.set(face.key, [face]);
  }
  const blocks = new Map<string, string[]>();
  for (const mark of copy.notPerson) {
    const id = `${mark.key}#${mark.index}`;
    blocks.set(id, [...(blocks.get(id) ?? []), mark.name]);
  }
  let people = peopleByName(p);
  let takenOff = takenOffSince(p, copy.createdAt);
  let adopted = 0;
  function* turn(): Generator<void, boolean, boolean> {
    if (adopted > 0) {
      store.markPeople();
      store.edits++;
    }
    yield;
    if (store.people !== p || !store.isLoaded()) return false;
    people = peopleByName(p);
    takenOff = takenOffSince(p, copy.createdAt);
    return true;
  }
  for (const key of copy.scanned) {
    if ((yield) && !(yield* turn())) return adopted;
    const uid = uidByLink.get(key);
    if (!uid || store.has(uid)) continue;
    const records: FaceRecord[] = [];
    for (const face of facesOf.get(key) ?? []) {
      if (face.rejected || face.embedding.length !== FACE_EMBEDDING_DIM || face.index > MAX_FACE_INDEX) continue;
      const record: FaceRecord = {
        id: `${uid}#${face.index}`,
        uid,
        box: face.box,
        points: face.points.length >= 10 ? face.points.slice(0, 10) : [],
        score: face.score,
        blur: face.blur ?? 100,
        sideways: sidewaysMeasure(face.points) ?? 0,
        embedding: face.embedding,
      };
      records.push(record);
      const blocked = blocks.get(`${key}#${face.index}`);
      if (blocked) p.blocked[record.id] = blocked;
      const name = face.confirmed ?? face.person;
      if (!name || blocked?.some((n) => foldPersonName(n) === foldPersonName(name))) continue;
      if (takenOff(name)) continue;
      const person = people.named(name);
      p.assign[record.id] = person.id;
      if (face.confirmed) p.confirmed[record.id] = person.name!;
    }
    store.put(uid, records);
    adopted++;
  }
  if (adopted > 0) {
    store.markPeople();
    store.edits++;
  }
  return adopted;
}

function overlap(a: readonly number[], b: readonly number[]): number {
  return iou(a, b);
}
