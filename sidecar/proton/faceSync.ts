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
import { FACE_EMBEDDING_DIM, dot } from "./faceCluster.ts";
import {
  curationKey,
  foldPersonName,
  keepNameChange,
  mergeInPlace,
  moveCuration,
  otherPerson,
  portableFaceId,
  pruneCuration,
  renameInPlace,
} from "./facePeople.ts";
import {
  FACE_MODEL_VERSION,
  MAX_FACE_INDEX,
  SAME_FACE_IOU,
  boxOverlap as iou,
  type FaceRecord,
  type FaceStore,
  type Person,
} from "./faceStore.ts";

export { SAME_FACE_IOU };

/** A phone's face and the face found here that is the same one. */
export type FacePair = { phone: SnapshotFace; local: FaceRecord; overlap: number };

/**
 * Each phone face on a photo also looked at here, with the face here that sits in the same
 * place; one local face is taken by one phone face at most, the closest overlap first.
 */
export function pairFaces(store: FaceStore, copies: FaceCopy[]): FacePair[] {
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
      const local = store.facesOf(uidByLink.get(key)!);
      const options: FacePair[] = [];
      for (const phone of phoneFaces) {
        for (const here of local) {
          const overlap = iou(phone.box, here.box);
          if (overlap >= SAME_FACE_IOU) options.push({ phone, local: here, overlap });
        }
      }
      options.sort((a, b) => b.overlap - a.overlap);
      const takenPhone = new Set<SnapshotFace>();
      const takenLocal = new Set<string>();
      for (const option of options) {
        if (takenPhone.has(option.phone) || takenLocal.has(option.local.id)) continue;
        takenPhone.add(option.phone);
        takenLocal.add(option.local.id);
        pairs.push(option);
      }
    }
  }
  return pairs;
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
  const uids = new Set(store.scanned().map((uid) => uid.slice(uid.indexOf("~") + 1)));
  let phoneFaces = 0;
  for (const copy of copies) for (const f of copy.faces) if (!f.rejected && uids.has(f.key)) phoneFaces++;
  const pairs = pairFaces(store, copies).filter((p) => p.phone.embedding.length === p.local.embedding.length);
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
};

/** A face here overlapping a phone face this much is taken for it, and no second one is added. */
const OVERLAPPING = 0.3;

function personNamed(p: FaceStore["people"], name: string): Person {
  const fold = foldPersonName(name);
  let person = p.people.find((x) => x.name && foldPersonName(x.name) === fold);
  if (!person) {
    person = { id: `p${p.nextId++}`, name, isOther: false };
    p.people.push(person);
  }
  return person;
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
  };
  const rejected = new Set(p.rejected);
  const nameOf = new Map<string, string>();
  for (const person of p.people) if (person.name) nameOf.set(person.id, person.name);

  const pairs = pairFaces(store, [copy]);
  const localOf = new Map<SnapshotFace, FaceRecord>();
  for (const pair of pairs) localOf.set(pair.phone, pair.local);
  const whole = copyFits(copy);

  // Faces the other device found and this one did not: kept here as found there, when its numbers
  // are this computer's kind.
  const uidByLink = new Map<string, string>();
  for (const uid of store.scanned()) uidByLink.set(linkOf(uid), uid);
  for (const face of copy.faces) {
    if (!whole || localOf.has(face) || face.rejected || face.embedding.length !== FACE_EMBEDDING_DIM) continue;
    const uid = uidByLink.get(face.key);
    if (!uid) continue;
    const here = store.facesOf(uid);
    if (here.some((f) => overlap(f.box, face.box) >= OVERLAPPING)) continue;
    const index = here.reduce((m, f) => Math.max(m, indexOf(f.id)), -1) + 1;
    if (index > MAX_FACE_INDEX) continue;
    const record: FaceRecord = {
      id: `${uid}#${index}`,
      uid,
      box: face.box,
      points: face.points.length >= 10 ? face.points.slice(0, 10) : [],
      score: face.score,
      blur: face.blur ?? 100,
      sideways: sidewaysMeasure(face.points) ?? 0,
      embedding: face.embedding,
    };
    store.put(uid, [...here, record]);
    localOf.set(face, record);
    result.added++;
  }

  const byKeyIndex = new Map<string, FaceRecord>();
  for (const [phone, local] of localOf) byKeyIndex.set(`${phone.key}#${phone.index}`, local);
  const holder = (name: string) => p.people.find((x) => x.name && foldPersonName(x.name) === foldPersonName(name));

  // What that device took away by hand after it was set here goes here too; the removal is kept
  // either way, so a setting from before it is not brought back and the next copy hands it on.
  for (const removal of copy.removals) {
    let ref = removal.key;
    let local: FaceRecord | undefined;
    if (removal.kind === CURATION_NOT_PERSON) {
      const uid = uidByLink.get(removal.key);
      local = byKeyIndex.get(`${removal.key}#${removal.index}`) ?? (uid ? store.facesOf(uid).find((f) => f.id === `${uid}#${removal.index}`) : undefined);
      ref = local ? portableFaceId(local.id) : `${removal.key}#${removal.index}`;
    } else if (removal.kind === CURATION_COVER) {
      ref = "";
    }
    const key = curationKey(removal.kind, removal.name, ref);
    const held = p.curation[key];
    if ((held?.at ?? 0) >= removal.at) continue;
    if (!held?.removed) {
      if (removal.kind === CURATION_MANUAL_PHOTO) {
        const name = holder(removal.name)?.name ?? removal.name;
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
        const person = holder(removal.name);
        if (person) delete p.covers[person.name!];
      }
    }
    p.curation[key] = { kind: removal.kind, name: removal.name, ref, removed: true, at: removal.at };
  }
  pruneCuration(p);

  // The marks first: one set by hand there after the confirmation here takes the face off that
  // person, so the name loop below can then give it the name it has there.
  for (const mark of copy.notPerson) {
    const local = byKeyIndex.get(`${mark.key}#${mark.index}`);
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
      delete p.confirmedFrom[local.id];
      const owner = p.people.find((x) => x.id === p.assign[local.id]);
      if (owner?.name && foldPersonName(owner.name) === foldPersonName(mark.name)) p.assign[local.id] = otherPerson(p).id;
    }
    const list = p.blocked[local.id] ?? [];
    if (list.includes(mark.name)) continue;
    list.push(mark.name);
    p.blocked[local.id] = list;
    result.marked++;
  }
  for (const [phone, local] of localOf) {
    if (rejected.has(local.id)) continue;
    const decided = p.confirmed[local.id] !== undefined;
    if (phone.rejected) {
      if (!decided) {
        rejected.add(local.id);
        delete p.assign[local.id];
        result.rejected++;
      }
      continue;
    }
    const conflict = p.conflicts[local.id];
    const name = phone.confirmed ?? phone.person;
    if (!name) {
      // That device no longer names it: a conflict it raised is over.
      if (conflict?.device === copy.deviceId) delete p.conflicts[local.id];
      continue;
    }
    if (nameTakenOffSince(p, name, copy.createdAt)) continue;
    if (p.blocked[local.id]?.some((n) => foldPersonName(n) === foldPersonName(name))) continue;
    const ownerName = p.assign[local.id] ? nameOf.get(p.assign[local.id]) : undefined;
    if (ownerName !== undefined && foldPersonName(ownerName) === foldPersonName(name)) {
      // Agreed now, by that device, or by a confirmation from any.
      if (conflict && (conflict.device === copy.deviceId || phone.confirmed)) delete p.conflicts[local.id];
      continue;
    }
    if (ownerName !== undefined || decided) {
      // Named differently on the two sides. A confirmation here that was itself taken in from
      // this device follows it: that device changed its mind. Otherwise the name here stays:
      // naming a group confirms every face in it, on both devices, so a confirmation there may
      // well be no hand decision, and taking it would undo this computer's own grouping or a
      // split made here. A hand decision there that should move it comes with a timed "not
      // this person" mark, taken in above. A confirmation there is kept as a conflict, for the
      // split of the person here to offer and for someone to decide.
      if (phone.confirmed && decided && p.confirmedFrom[local.id] === copy.deviceId) {
        const person = personNamed(p, phone.confirmed);
        nameOf.set(person.id, person.name!);
        p.assign[local.id] = person.id;
        p.confirmed[local.id] = person.name!;
        delete p.conflicts[local.id];
        result.named++;
      } else {
        if (phone.confirmed) p.conflicts[local.id] = { there: phone.confirmed, device: copy.deviceId, at: copy.createdAt };
        result.conflicts++;
      }
      continue;
    }
    const person = personNamed(p, name);
    nameOf.set(person.id, person.name!);
    p.assign[local.id] = person.id;
    // Only a name confirmed there is confirmed here: the other device's grouping is as automatic as this one's.
    if (phone.confirmed) {
      p.confirmed[local.id] = person.name!;
      p.confirmedFrom[local.id] = copy.deviceId;
    }
    delete p.conflicts[local.id];
    result.named++;
  }
  p.rejected = [...rejected];

  for (const m of copy.manual) {
    if (!m.name.trim() || nameTakenOffSince(p, m.name, copy.createdAt)) continue;
    const name = holder(m.name)?.name ?? m.name;
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
    const uid = uidByLink.get(key);
    const person = holder(name);
    if (!uid || !person) continue;
    const setAt = copy.coverSetAt.get(name) ?? 0;
    const curation = curationKey(CURATION_COVER, person.name!, "");
    const held = p.curation[curation];
    if (held?.removed && held.at >= setAt) continue;
    // Of two covers the later one; with none here, the other device's.
    const heldAt = held && !held.removed ? held.at : 0;
    if (p.covers[person.name!] && setAt <= heldAt) continue;
    p.covers[person.name!] = uid;
    if (setAt > heldAt) p.curation[curation] = { kind: CURATION_COVER, name: person.name!, ref: "", removed: false, at: setAt };
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
  let adopted = 0;
  for (const key of copy.scanned) {
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
      if (nameTakenOffSince(p, name, copy.createdAt)) continue;
      const person = personNamed(p, name);
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
