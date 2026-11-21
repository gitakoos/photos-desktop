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

// The people made of the stored faces, and every change the user makes to them. A regroup of
// the whole library carries the names over to the groups that hold most of each person's faces;
// new faces between regroups join the closest person or form new groups of their own.

import { diag } from "./diag.ts";
import { isConfidentFace } from "./faceAlign.ts";
import { curationKey, foldPersonName, isHiddenToken, isReservedName, newHiddenToken, shownName } from "./personName.ts";
import {
  FACE_CLUSTER_MERGE_THRESHOLD,
  FACE_CLUSTER_STRICT_DELTA,
  FACE_CLUSTER_THRESHOLD,
  FACE_SUGGEST_THRESHOLD,
  MERGE_MAX_CLUSTERS,
  assignIncrementalAsync,
  attractToNamedClustersAsync,
  clusterFaces,
  MIN_FACES_TO_SHOW_PERSON,
  dot,
  isNameableCluster,
  meanDirection,
  resolveClusterNames,
  runPausable,
  runPausableSliced,
  splitOutUnclaimedNames,
  suggestPersonMatchesSteps,
  timeSlicer,
  type FaceSample,
  type Pausable,
} from "./faceCluster.ts";
import {
  SAME_FACE_IOU,
  boxOverlap,
  pairBoxes,
  type Curation,
  type FaceRecord,
  type FaceStore,
  type HeldOver,
  type PeopleState,
  type Person,
} from "./faceStore.ts";

/** A face "not a person" takes with it every kept face at least this close to the dismissed group. */
export const HIDE_SIMILAR_THRESHOLD = 0.62;

/** Thrown into a regroup that was told to stop. */
export { curationKey, foldPersonName } from "./personName.ts";

export class Stopped extends Error {
  constructor() {
    super("stopped");
    this.name = "Stopped";
  }
}

function sampleOf(face: FaceRecord, people: PeopleState): FaceSample {
  return {
    embedding: face.embedding,
    score: face.score,
    confident: isConfidentFace(face.score, face.blur, face.sideways),
    confirmed: people.confirmed[face.id] !== undefined,
  };
}

function mint(people: PeopleState): string {
  return `p${people.nextId++}`;
}


/**
 * Regroups every kept face from the start, carrying each name to the group that holds most of
 * that person's faces. `isActive` is asked as it goes; a false answer stops it with nothing
 * changed.
 */
export async function regroupAll(store: FaceStore, isActive: () => boolean = () => true): Promise<void> {
  const p = store.people;
  const edits = store.edits;
  const rejected = new Set(p.rejected);
  const faces = store.allFaces().filter((f) => !rejected.has(f.id));
  const samples = faces.map((f) => sampleOf(f, p));
  const oldPerson = faces.map((f) => p.assign[f.id] ?? null);
  const confirmed = faces.map((f) => p.confirmed[f.id] ?? null);
  const blocked = faces.map((f) => (p.blocked[f.id] ? new Set(p.blocked[f.id]) : undefined));
  const names = new Map<string, string>();
  for (const person of p.people) if (person.name) names.set(person.id, person.name);

  const slice = timeSlicer();
  const check = async () => {
    if (!isActive()) throw new Stopped();
    const turn = slice();
    if (turn) await turn;
  };
  const base = await clusterFaces(samples, undefined, undefined, check);
  const voted = resolveClusterNames(oldPerson, confirmed, base, names);
  const split = splitOutUnclaimedNames(confirmed, base, voted);
  const final = await attractToNamedClustersAsync(
    samples.map((s) => s.embedding),
    samples.map((s) => s.score),
    split.assignment,
    split.names,
    confirmed,
    FACE_CLUSTER_THRESHOLD,
    blocked,
  );
  // A face marked as not someone never stays with them.
  for (let i = 0; i < final.length; i++) {
    const name = split.names.get(final[i]);
    if (name !== undefined && blocked[i]?.has(name) && confirmed[i] !== name) final[i] = -1;
  }
  // A change the user made meanwhile is not lost under a grouping that did not see it.
  if (!isActive() || store.edits !== edits) throw new Stopped();

  const groups = new Map<number, number[]>();
  for (let i = 0; i < final.length; i++) {
    let list = groups.get(final[i]);
    if (!list) groups.set(final[i], (list = []));
    list.push(i);
  }
  const oldIdByName = new Map<string, string>();
  for (const person of p.people) if (person.name) oldIdByName.set(person.name, person.id);
  const namedIds = new Set(oldIdByName.values());
  const oldOther = p.people.find((x) => x.isOther)?.id ?? null;
  const used = new Set<string>(oldOther ? [oldOther] : []);
  const people: Person[] = [];
  const assign: Record<string, string> = {};
  for (const [cluster, members] of groups) {
    if (cluster < 0) continue;
    const name = split.names.get(cluster) ?? null;
    let id: string | null = null;
    if (name) {
      id = oldIdByName.get(name) ?? null;
    } else {
      // An unnamed group keeps the id most of its faces had, so a page open on it stays good.
      const votes = new Map<string, number>();
      for (const m of members) {
        const old = oldPerson[m];
        if (old && !namedIds.has(old) && !used.has(old)) votes.set(old, (votes.get(old) ?? 0) + 1);
      }
      for (const [old, count] of votes) if (count * 2 > members.length) id = old;
    }
    if (!id || used.has(id)) id = mint(p);
    used.add(id);
    people.push({ id, name, isOther: false });
    for (const m of members) assign[faces[m].id] = id;
  }
  const leftover = groups.get(-1);
  if (leftover?.length) {
    const id = oldOther ?? mint(p);
    people.push({ id, name: null, isOther: true });
    for (const m of leftover) assign[faces[m].id] = id;
  }
  p.people = people;
  p.assign = assign;
  p.grouped = true;
  store.markPeople();
}

/** Whether a regroup left the folding of its groups to [mergeSplitGroups]: past this many groups its own
 *  merge step is skipped, as on the phone. */
export function groupMergeOwed(store: FaceStore): boolean {
  return store.people.people.filter((x) => !x.isOther).length > MERGE_MAX_CLUSTERS;
}

/**
 * Folds together the groups that are one person, on each group's mean direction, the step the phone
 * runs after a big regroup and at the end of a batched one: the closest pair at or past the merge bar
 * goes first and the merged direction is weighed by face count, two different names never fold, a
 * group goes under a named person only when none of its faces was marked as not being them, and the
 * named or larger group survives. The faces moved are not confirmed. Stops with nothing changed when
 * `isActive` turns false or the user changes something meanwhile. Answers how many groups folded.
 */
export async function mergeSplitGroups(store: FaceStore, isActive: () => boolean = () => true): Promise<number> {
  const p = store.people;
  const edits = store.edits;
  const slice = timeSlicer();
  const byPerson = await runPausableSliced(facesByPersonSteps(store), slice);
  const groups = p.people.filter((x) => !x.isOther && (byPerson.get(x.id)?.length ?? 0) > 0);
  const n = groups.length;
  if (n < 2) return 0;
  const centroids = await runPausableSliced(centroidSteps(groups, byPerson), slice);
  const counts = groups.map((x) => byPerson.get(x.id)!.length);
  const names = groups.map((x) => x.name);
  const blocked = await runPausableSliced(blockedSteps(groups, byPerson, p), slice);
  const alive = new Array<boolean>(n).fill(true);
  const version = new Array<number>(n).fill(0);
  const root = Array.from({ length: n }, (_, i) => i);
  type Pair = { a: number; b: number; s: number; va: number; vb: number };
  const heap: Pair[] = [];
  const push = (x: Pair) => {
    heap.push(x);
    let i = heap.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (heap[up].s >= heap[i].s) break;
      [heap[up], heap[i]] = [heap[i], heap[up]];
      i = up;
    }
  };
  const pop = (): Pair | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].s > heap[m].s) m = l;
        if (r < heap.length && heap[r].s > heap[m].s) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const check = async () => {
    if (!isActive()) throw new Stopped();
    const turn = slice();
    if (turn) await turn;
  };
  for (let a = 0; a < n; a++) {
    await check();
    for (let b = a + 1; b < n; b++) {
      const s = dot(centroids[a], centroids[b]);
      if (s >= FACE_CLUSTER_MERGE_THRESHOLD) push({ a, b, s, va: 0, vb: 0 });
    }
  }
  let folded = 0;
  for (let top = pop(); top; top = pop()) {
    const { a, b } = top;
    if (!alive[a] || !alive[b] || version[a] !== top.va || version[b] !== top.vb) continue;
    const nameA = names[a];
    const nameB = names[b];
    if (nameA && nameB && nameA !== nameB) continue;
    const survivor = nameA && !nameB ? a : nameB && !nameA ? b : counts[a] >= counts[b] ? a : b;
    const dropped = survivor === a ? b : a;
    const survivorName = names[survivor];
    if (survivorName && !names[dropped] && blocked[dropped].has(survivorName)) continue;
    const merged = new Float32Array(centroids[survivor].length);
    for (let k = 0; k < merged.length; k++) {
      merged[k] = centroids[survivor][k] * counts[survivor] + centroids[dropped][k] * counts[dropped];
    }
    centroids[survivor] = meanDirection([merged], merged.length);
    counts[survivor] += counts[dropped];
    for (const name of blocked[dropped]) blocked[survivor].add(name);
    alive[dropped] = false;
    root[dropped] = survivor;
    version[survivor]++;
    folded++;
    await check();
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === survivor) continue;
      const s = dot(centroids[survivor], centroids[k]);
      if (s >= FACE_CLUSTER_MERGE_THRESHOLD) push({ a: survivor, b: k, s, va: version[survivor], vb: version[k] });
    }
  }
  if (folded === 0) return 0;
  if (!isActive() || store.edits !== edits) throw new Stopped();
  const into = new Map<string, string>();
  for (let i = 0; i < n; i++) {
    if (alive[i]) continue;
    let s = root[i];
    while (!alive[s]) s = root[s];
    into.set(groups[i].id, groups[s].id);
  }
  // The faces of the folded groups are found a part at a time; when the people changed meanwhile,
  // every face is looked at again as the groups are folded.
  const marks = store.peopleMarks;
  const moving = await runPausableSliced(movingSteps(p, into), slice);
  if (!isActive() || store.edits !== edits) throw new Stopped();
  for (const faceId of store.peopleMarks === marks ? moving : Object.keys(p.assign)) {
    const target = into.get(p.assign[faceId]);
    if (target) p.assign[faceId] = target;
  }
  p.people = p.people.filter((x) => !into.has(x.id));
  store.markPeople();
  return folded;
}

/**
 * Above this many faces the whole-library regroup is left out: it grows with the faces times the
 * groups, and the people the scan formed as it went stand as they are.
 */
export const FULL_REGROUP_MAX_FACES = 60_000;

/**
 * The grouping at the end of a scan pass, once per set of faces never grouped as a whole: every face
 * regrouped from the start, its groups folded on their directions when there are more than its own
 * merge takes; past FULL_REGROUP_MAX_FACES only the fold, the closing step of the phone's batched
 * grouping. `starting` is called before it begins. Answers what ran, or null when nothing was owed.
 */
export async function groupAfterPass(
  store: FaceStore,
  isActive: () => boolean,
  starting: () => void = () => {},
): Promise<"regrouped" | "folded" | null> {
  if (store.people.grouped) return null;
  const faceCount = store.allFaces().length;
  if (faceCount === 0) return null;
  starting();
  if (faceCount <= FULL_REGROUP_MAX_FACES) {
    await diag.time("faces", "regroup_all", () => regroupAll(store, isActive));
    if (groupMergeOwed(store)) await mergeSplitGroups(store, isActive);
    return "regrouped";
  }
  await mergeSplitGroups(store, isActive);
  store.people.grouped = true;
  store.markPeople();
  return "folded";
}

/**
 * What follows faces taken in from another device: the new ones placed, the likely groups merged
 * when the automatic merge is on, and the leftovers looked at again against everyone named.
 */
export async function settleTakenIn(store: FaceStore, autoMerging: boolean): Promise<void> {
  await placeNew(store);
  if (autoMerging) await autoMergeAsync(store);
  await reconsiderLeftovers(store);
}

/**
 * Looks at the leftover faces again against everyone named: as a person gathers faces, one that
 * matched nobody before may now clear the bar for them. Only the usual bar takes a face in (a
 * stricter one for a weak face), never a person it was marked as not being. Returns how many moved;
 * none when the people changed while it looked, which leaves them for the next call.
 */
export async function reconsiderLeftovers(store: FaceStore): Promise<number> {
  const p = store.people;
  const edits = store.edits;
  const other = p.people.find((x) => x.isOther);
  if (!other) return 0;
  const before = groupingOf(p);
  const byPerson = await runPausableSliced(facesByPersonSteps(store));
  if (changedMeanwhile(store, p, edits, before)) return 0;
  const leftovers = byPerson.get(other.id) ?? [];
  const named = p.people.filter((x) => x.name && (byPerson.get(x.id)?.length ?? 0) > 0);
  if (leftovers.length === 0 || named.length === 0) return 0;
  const centroids = await runPausableSliced(centroidSteps(named, byPerson));
  if (changedMeanwhile(store, p, edits, before)) return 0;
  const matched = await assignIncrementalAsync(
    leftovers.map((f) => sampleOf(f, p)),
    centroids,
  );
  if (changedMeanwhile(store, p, edits, before)) return 0;
  let moved = 0;
  for (let i = 0; i < leftovers.length; i++) {
    if (matched[i] < 0 || p.assign[leftovers[i].id] !== other.id) continue;
    const target = named[matched[i]];
    if (p.blocked[leftovers[i].id]?.includes(target.name!)) continue;
    p.assign[leftovers[i].id] = target.id;
    moved++;
  }
  if (moved > 0) store.markPeople();
  return moved;
}

/** What a grouping step that gave the rest of the process its turn compares against afterwards. */
function groupingOf(p: PeopleState): { people: Person[]; assign: Record<string, string> } {
  return { people: p.people, assign: p.assign };
}

/**
 * Whether the people changed while a step gave the rest of the process its turn: the user changed
 * something, the store was emptied or let go, or a regroup or fold put new people in place. Its
 * result is then thrown away, as it was worked out from what is no longer there.
 */
function changedMeanwhile(
  store: FaceStore,
  p: PeopleState,
  edits: number,
  before: { people: Person[]; assign: Record<string, string> },
): boolean {
  return store.people !== p || store.edits !== edits || p.people !== before.people || p.assign !== before.assign;
}

/** Each person's faces, by person id. */
function facesByPerson(store: FaceStore): Map<string, FaceRecord[]> {
  return runPausable(facesByPersonSteps(store));
}

/** How many faces a long read of every face takes between two asks for a turn. */
const FACES_PER_STEP = 2048;

export function* facesByPersonSteps(store: FaceStore): Pausable<Map<string, FaceRecord[]>> {
  const p = store.people;
  const out = new Map<string, FaceRecord[]>();
  const faces = store.allFaces();
  for (let i = 0; i < faces.length; i++) {
    if (i % FACES_PER_STEP === FACES_PER_STEP - 1) yield;
    const face = faces[i];
    const id = p.assign[face.id];
    if (!id) continue;
    let list = out.get(id);
    if (!list) out.set(id, (list = []));
    list.push(face);
  }
  return out;
}

/** The mean direction of each of `people`'s faces, asking for a turn between people. */
function* centroidSteps(people: Person[], byPerson: Map<string, FaceRecord[]>): Pausable<Float32Array[]> {
  const out: Float32Array[] = [];
  for (const person of people) {
    yield;
    out.push(meanDirection(byPerson.get(person.id)!.map((f) => f.embedding)));
  }
  return out;
}

/** The names each group's faces were said not to be, asking for a turn as it goes. */
function* blockedSteps(groups: Person[], byPerson: Map<string, FaceRecord[]>, p: PeopleState): Pausable<Set<string>[]> {
  const out: Set<string>[] = [];
  let n = 0;
  for (const x of groups) {
    const marks = new Set<string>();
    for (const f of byPerson.get(x.id)!) {
      if (++n % FACES_PER_STEP === 0) yield;
      for (const name of p.blocked[f.id] ?? []) marks.add(name);
    }
    out.push(marks);
  }
  return out;
}

/** The faces placed with a group that `into` folds into another, asking for a turn as it goes. */
function* movingSteps(p: PeopleState, into: Map<string, string>): Pausable<string[]> {
  const ids = Object.keys(p.assign);
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (i % FACES_PER_STEP === FACES_PER_STEP - 1) yield;
    if (into.has(p.assign[ids[i]])) out.push(ids[i]);
  }
  return out;
}

/** The faces no grouping has placed yet, leaving out the rejected ones, asking for a turn as it goes. */
function* freshSteps(store: FaceStore, p: PeopleState): Pausable<FaceRecord[]> {
  const rejected = new Set(p.rejected);
  const faces = store.allFaces();
  const out: FaceRecord[] = [];
  for (let i = 0; i < faces.length; i++) {
    if (i % FACES_PER_STEP === FACES_PER_STEP - 1) yield;
    const f = faces[i];
    if (!rejected.has(f.id) && !p.assign[f.id]) out.push(f);
  }
  return out;
}

/** What the grouping reads of each face, asking for a turn as it goes. */
function* sampleSteps(faces: FaceRecord[], p: PeopleState): Pausable<FaceSample[]> {
  const out: FaceSample[] = [];
  for (let i = 0; i < faces.length; i++) {
    if (i % FACES_PER_STEP === FACES_PER_STEP - 1) yield;
    out.push(sampleOf(faces[i], p));
  }
  return out;
}

/** 1 for each face its photo still holds, asking for a turn as it goes. */
function* onPhotoSteps(store: FaceStore, faces: FaceRecord[]): Pausable<Uint8Array> {
  const out = new Uint8Array(faces.length);
  for (let i = 0; i < faces.length; i++) {
    if (i % FACES_PER_STEP === FACES_PER_STEP - 1) yield;
    if (store.facesOf(faces[i].uid).includes(faces[i])) out[i] = 1;
  }
  return out;
}

/** The leftovers, made the first time a face is put there. */
export function otherPerson(p: PeopleState): Person {
  let other = p.people.find((x) => x.isOther);
  if (!other) {
    other = { id: mint(p), name: null, isOther: true };
    p.people.push(other);
  }
  return other;
}

/**
 * Places the faces no grouping has seen: each joins the closest person when close enough (never
 * one it was said not to be), the clear ones left over group among themselves into new people,
 * and the rest go to the leftovers. Left for the next call when the user changes something, or
 * a regroup puts new people in place, while it runs. One placement at a time per store.
 */
export function placeNew(store: FaceStore): Promise<void> {
  const before = placing.get(store) ?? Promise.resolve();
  const run = before.then(() => placeNewNow(store));
  const settled = run.catch(() => {});
  placing.set(store, settled);
  void settled.then(() => {
    if (placing.get(store) === settled) placing.delete(store);
  });
  return run;
}

/** The placement running or waiting per store: the next one starts once it is through. */
const placing = new WeakMap<FaceStore, Promise<void>>();

async function placeNewNow(store: FaceStore): Promise<void> {
  const p = store.people;
  const edits = store.edits;
  const before = groupingOf(p);
  // One budget for the whole placement, so what runs between its long loops counts against it too.
  const slice = timeSlicer();
  const fresh = await runPausableSliced(freshSteps(store, p), slice);
  if (fresh.length === 0) return;
  const byPerson = await runPausableSliced(facesByPersonSteps(store), slice);
  const targets = p.people.filter((x) => !x.isOther && (byPerson.get(x.id)?.length ?? 0) > 0);
  const centroids = await runPausableSliced(centroidSteps(targets, byPerson), slice);
  if (changedMeanwhile(store, p, edits, before)) return;
  const samples = await runPausableSliced(sampleSteps(fresh, p), slice);
  const matched = await assignIncrementalAsync(samples, centroids, FACE_CLUSTER_THRESHOLD, FACE_CLUSTER_STRICT_DELTA, slice);
  if (changedMeanwhile(store, p, edits, before)) return;
  const clearFirst: number[] = [];
  for (let i = 0; i < fresh.length; i++) if (matched[i] < 0 && samples[i].confident) clearFirst.push(i);
  const grouping = clearFirst.length
    ? await clusterFaces(
        clearFirst.map((i) => samples[i]),
        FACE_CLUSTER_THRESHOLD,
        FACE_CLUSTER_MERGE_THRESHOLD,
        () => {},
        slice,
      )
    : new Int32Array(0);
  // Whether each face is still on its photo, looked up a part at a time; when the faces changed
  // meanwhile, each is looked up again as it is placed.
  const facesAt = store.facesMarks;
  const onPhoto = await runPausableSliced(onPhotoSteps(store, fresh), slice);
  if (changedMeanwhile(store, p, edits, before)) return;
  const stillOnPhoto =
    store.facesMarks === facesAt
      ? (i: number) => onPhoto[i] === 1
      : (i: number) => store.facesOf(fresh[i].uid).includes(fresh[i]);
  // A face placed, or a photo scanned again or dropped, while the rest of the process had its turn is not placed here.
  const held = (i: number) => !p.assign[fresh[i].id] && stillOnPhoto(i);
  const unplaced: number[] = [];
  for (let i = 0; i < fresh.length; i++) {
    if (!held(i)) continue;
    const target = matched[i] >= 0 ? targets[matched[i]] : null;
    if (target && !(target.name && p.blocked[fresh[i].id]?.includes(target.name))) {
      p.assign[fresh[i].id] = target.id;
    } else {
      unplaced.push(i);
    }
  }
  const groupOf = new Map<number, number>();
  clearFirst.forEach((i, k) => groupOf.set(i, grouping[k]));
  const newIds = new Map<number, string>();
  const placed = new Set<number>();
  for (const i of unplaced) {
    const g = groupOf.get(i) ?? -1;
    if (g < 0) continue;
    let id = newIds.get(g);
    if (!id) {
      id = mint(p);
      newIds.set(g, id);
      p.people.push({ id, name: null, isOther: false });
    }
    p.assign[fresh[i].id] = id;
    placed.add(i);
  }
  const rest = unplaced.filter((i) => !placed.has(i));
  if (rest.length) {
    const other = otherPerson(p);
    for (const i of rest) p.assign[fresh[i].id] = other.id;
  }
  store.markPeople();
}

/**
 * Puts what a change of the face models held over back on the faces found since, photo by photo, by
 * where each face sat: a removal on the face that sits where the removed one did, a "not this person"
 * mark likewise, and each name on one face, the closest overlap first, confirmed as that person so the
 * grouping keeps it. What found no face on a photo looked at again is let go; what waits on a photo
 * not looked at yet stays, unless `keep` says the photo will not be. Answers how many were put back.
 */
export function takeHeldOver(store: FaceStore, keep: (uid: string) => boolean = () => true): number {
  const p = store.people;
  if (p.heldOver.length === 0) return 0;
  const byUid = new Map<string, HeldOver[]>();
  for (const h of p.heldOver) {
    const list = byUid.get(h.uid);
    if (list) list.push(h);
    else byUid.set(h.uid, [h]);
  }
  const waiting: HeldOver[] = [];
  const rejected = new Set(p.rejected);
  let placed = 0;
  const closest = (faces: FaceRecord[], box: HeldOver["box"]) => {
    let best: FaceRecord | null = null;
    let bestOverlap = SAME_FACE_IOU;
    for (const f of faces) {
      const o = boxOverlap(f.box, box);
      if (o >= bestOverlap) {
        best = f;
        bestOverlap = o;
      }
    }
    return best;
  };
  for (const [uid, held] of byUid) {
    if (!store.has(uid)) {
      if (keep(uid)) waiting.push(...held);
      continue;
    }
    const faces = store.facesOf(uid);
    for (const h of held) {
      if (h.kind !== "rejected") continue;
      const f = closest(faces, h.box);
      if (!f || p.confirmed[f.id] !== undefined || rejected.has(f.id)) continue;
      rejected.add(f.id);
      delete p.assign[f.id];
      placed++;
    }
    for (const h of held) {
      if (h.kind !== "not") continue;
      const f = closest(faces, h.box);
      if (!f) continue;
      const list = p.blocked[f.id] ?? [];
      if (!list.some((n) => foldPersonName(n) === foldPersonName(h.name))) list.push(h.name);
      p.blocked[f.id] = list;
      placed++;
    }
    const names = held.filter((h) => h.kind === "name");
    const open = faces.filter((f) => !rejected.has(f.id) && p.confirmed[f.id] === undefined);
    for (const [i, j] of pairBoxes(
      names.map((h) => h.box),
      open.map((f) => f.box),
    )) {
      const face = open[j];
      const name = names[i].name;
      if (p.blocked[face.id]?.some((n) => foldPersonName(n) === foldPersonName(name))) continue;
      let person = p.people.find((x) => x.name && foldPersonName(x.name) === foldPersonName(name));
      if (!person) {
        person = { id: mint(p), name, isOther: false };
        p.people.push(person);
      }
      p.assign[face.id] = person.id;
      p.confirmed[face.id] = person.name!;
      placed++;
    }
  }
  if (placed === 0 && waiting.length === p.heldOver.length) return 0;
  p.rejected = [...rejected];
  p.heldOver = waiting;
  store.markPeople();
  store.edits++;
  return placed;
}

export type PersonView = {
  id: string;
  name: string | null;
  isOther: boolean;
  /** The photos the person is in. */
  uids: string[];
  cover: { uid: string; box: [number, number, number, number] } | null;
};

/** "Might be the same person": an unnamed group offered to the named person it is closest to. */
export type Suggestion = { unnamed: string; named: string; similarity: number };

/**
 * The unnamed groups worth naming that sit close to a named person, best match first, leaving
 * out every pair already answered with "Different person".
 */
export function listSuggestions(store: FaceStore): Suggestion[] {
  return runPausable(suggestionSteps(store));
}

function* suggestionSteps(store: FaceStore, faces?: Map<string, FaceRecord[]>): Pausable<Suggestion[]> {
  const p = store.people;
  const byPerson = faces ?? (yield* facesByPersonSteps(store));
  const named: [string, Float32Array][] = [];
  const unnamed: [string, Float32Array][] = [];
  const nameOf = new Map<string, string>();
  for (const person of p.people) {
    if (person.isOther || isHiddenName(p, person.name)) continue;
    const faces = byPerson.get(person.id) ?? [];
    if (faces.length === 0) continue;
    yield;
    const direction = meanDirection(faces.map((f) => f.embedding));
    if (shownName(person.name)) {
      named.push([person.id, direction]);
      nameOf.set(person.id, person.name!);
    } else if (isNameableCluster(null, false, new Set(faces.map((f) => f.uid)).size)) {
      unnamed.push([person.id, direction]);
    }
  }
  const matches = yield* suggestPersonMatchesSteps(named, unnamed);
  return matches.filter((s) => {
    const name = nameOf.get(s.named)!;
    return !(byPerson.get(s.unnamed) ?? []).some((f) => p.blocked[f.id]?.includes(name));
  });
}

/** "Different person": the group's faces are never offered to, or pulled into, that person again. */
export function dismissSuggestion(store: FaceStore, unnamedId: string, namedId: string): void {
  const p = store.people;
  const named = personOf(p, namedId);
  personOf(p, unnamedId);
  if (!named.name) return;
  const marked: string[] = [];
  for (const [faceId, personId] of Object.entries(p.assign)) {
    if (personId !== unnamedId) continue;
    const list = p.blocked[faceId] ?? [];
    if (!list.includes(named.name)) list.push(named.name);
    p.blocked[faceId] = list;
    marked.push(faceId);
  }
  noteCuration(p, 2, named.name, marked.map(portableFaceId), false, Date.now());
  store.markPeople();
  store.edits++;
}

/**
 * Takes the suggestions as if "Merge" were pressed on them, again until none is left, as the phone's
 * automatic merge does: only a match past the bar a face joins a person at (FACE_CLUSTER_THRESHOLD),
 * never two named people, and the faces taken in are not confirmed, so a regroup can still take apart
 * a merge nobody looked at. Returns how many groups went into someone.
 */
export function autoMerge(store: FaceStore): number {
  return runPausable(autoMergeSteps(store));
}

/**
 * `autoMerge`, giving the rest of the process its turn while it works out each round's suggestions.
 * A round that finds the people changed meanwhile is not carried out, and the merging stops there.
 */
export function autoMergeAsync(store: FaceStore): Promise<number> {
  return runPausableSliced(autoMergeSteps(store));
}

function* autoMergeSteps(store: FaceStore): Pausable<number> {
  let merged = 0;
  for (let round = 0; round < 10; round++) {
    const held = store.people;
    const marks = store.peopleMarks;
    const edits = store.edits;
    const suggestions = (yield* suggestionSteps(store)).filter((s) => s.similarity > FACE_CLUSTER_THRESHOLD);
    if (store.people !== held || store.peopleMarks !== marks || store.edits !== edits) break;
    if (suggestions.length === 0) break;
    const taken = new Set<string>();
    const p = store.people;
    const pairs: [Person, Person][] = [];
    for (const s of suggestions) {
      if (taken.has(s.unnamed)) continue;
      taken.add(s.unnamed);
      pairs.push([personOf(p, s.unnamed), personOf(p, s.named)]);
    }
    mergeAllInPlace(p, pairs);
    store.markPeople();
    store.edits += pairs.length;
    merged += pairs.length;
  }
  return merged;
}

/**
 * Puts each unnamed group of `pairs` into its named person, as `mergeInPlace` one after another
 * would, unconfirmed, reading every face's person once for all of them.
 */
function mergeAllInPlace(p: PeopleState, pairs: [Person, Person][]): void {
  const into = new Map(pairs.map(([from, to]) => [from.id, to.id]));
  for (const [faceId, personId] of Object.entries(p.assign)) {
    const to = into.get(personId);
    if (to) p.assign[faceId] = to;
  }
  for (const [from, to] of pairs) {
    if (!from.name) continue;
    delete p.covers[from.name];
    const attached = p.manual[from.name];
    delete p.manual[from.name];
    if (attached?.length && to.name) p.manual[to.name] = [...new Set([...(p.manual[to.name] ?? []), ...attached])];
  }
  p.people = p.people.filter((x) => !into.has(x.id));
}

/** A face in no group worth naming: one of the leftovers, or alone in its group. */
export type LooseFace = { faceId: string; uid: string; box: [number, number, number, number] };

/** At most this many loose faces are listed at once. */
export const MAX_LOOSE = 600;

/**
 * The faces in no group worth naming, clearest first: the leftovers, and the groups seen in
 * one photo only. These are the faces the People page cannot offer as someone to name.
 */
export function listLoose(store: FaceStore, faces?: Map<string, FaceRecord[]>): { faces: LooseFace[]; total: number } {
  const p = store.people;
  const byPerson = faces ?? facesByPerson(store);
  const loose: FaceRecord[] = [];
  for (const person of p.people) {
    if (person.name) continue;
    const faces = byPerson.get(person.id) ?? [];
    if (person.isOther || new Set(faces.map((f) => f.uid)).size < MIN_FACES_TO_SHOW_PERSON) loose.push(...faces);
  }
  loose.sort((a, b) => b.score - a.score);
  return {
    faces: loose.slice(0, MAX_LOOSE).map((f) => ({ faceId: f.id, uid: f.uid, box: f.box })),
    total: loose.length,
  };
}

/**
 * Says who these faces are: they join the person of that name, or a new one is made for it.
 * Confirmed under the name, so a regroup keeps them there. Returns the person's id.
 */
export function nameFaces(store: FaceStore, faceIds: string[], rawName: string, at = Date.now()): string {
  const p = store.people;
  const name = rawName.trim().slice(0, 100);
  if (!name) throw new Error("A name is needed");
  if (isReservedName(name)) throw new Error("This name cannot be used");
  const fold = foldPersonName(name);
  let person = p.people.find((x) => x.name && foldPersonName(x.name) === fold);
  if (!person) {
    person = { id: mint(p), name, isOther: false };
    p.people.push(person);
    p.namedAt[fold] = at;
  }
  addFacesToPerson(store, person.id, faceIds);
  return person.id;
}

/** "Not a person" for these faces alone: put aside for good, nothing else with them. */
export function rejectFaces(store: FaceStore, faceIds: string[]): number {
  const p = store.people;
  const rejected = new Set(p.rejected);
  let count = 0;
  for (const id of faceIds) {
    if (rejected.has(id)) continue;
    rejected.add(id);
    delete p.assign[id];
    delete p.confirmed[id];
    count++;
  }
  p.rejected = [...rejected];
  store.markPeople();
  store.edits++;
  return count;
}

/** A face on one photo, with who it is as far as the grouping goes. */
export type PhotoFace = {
  faceId: string;
  box: [number, number, number, number];
  personId: string | null;
  /** The person's name; null for an unnamed group or none. */
  name: string | null;
};

/** The faces found on a photo, left to right, leaving out those marked as not a person. */
export function facesOnPhoto(store: FaceStore, uid: string): PhotoFace[] {
  const p = store.people;
  const rejected = new Set(p.rejected);
  return store
    .facesOf(uid)
    .filter((f) => !rejected.has(f.id))
    .sort((a, b) => a.box[0] - b.box[0])
    .map((f) => {
      const personId = p.assign[f.id] ?? null;
      const person = personId ? p.people.find((x) => x.id === personId) : undefined;
      // A hidden person is not offered on a photo either: the face reads as one nobody has grouped.
      const hidden = isHiddenName(p, person?.name ?? null);
      return {
        faceId: f.id,
        box: f.box,
        personId: person && !person.isOther && !hidden ? person.id : null,
        name: hidden ? null : shownName(person?.name ?? null),
      };
    });
}

/** The people as the window lists them. */
export type PeopleLists = {
  named: PersonView[];
  unnamed: PersonView[];
  /** The people hidden from the lists above, shown only in the Hidden section. */
  hidden: PersonView[];
  leftover: number;
  suggestions: Suggestion[];
  loose: { faces: LooseFace[]; total: number };
};

/**
 * The people worth showing: everyone named, and the unnamed groups seen in enough photos. A named
 * person's photos are those of their faces and those attached to them by hand on another device, as
 * far as `uidOfLink` (else the photos scanned here) finds them in the library.
 */
export function listPeople(store: FaceStore, uidOfLink?: (link: string) => string | undefined): PeopleLists {
  return runPausable(listPeopleSteps(store, uidOfLink));
}

function* listPeopleSteps(store: FaceStore, uidOfLink?: (link: string) => string | undefined): Pausable<PeopleLists> {
  const p = store.people;
  const byPerson = yield* facesByPersonSteps(store);
  const named: PersonView[] = [];
  const unnamed: PersonView[] = [];
  const hidden: PersonView[] = [];
  let leftover = 0;
  let scannedByLink: Map<string, string> | null = null;
  const resolve = (link: string) => {
    const found = uidOfLink?.(link);
    if (found) return found;
    if (!scannedByLink) scannedByLink = new Map(store.scanned().map((uid) => [portableFaceId(uid), uid]));
    return scannedByLink.get(link);
  };
  for (const person of p.people) {
    yield;
    const faces = byPerson.get(person.id) ?? [];
    const uids = [...new Set(faces.map((f) => f.uid))];
    if (person.name && !person.isOther) {
      const have = new Set(uids);
      for (const link of p.manual[person.name] ?? []) {
        const uid = resolve(link);
        if (uid && !have.has(uid)) {
          have.add(uid);
          uids.push(uid);
        }
      }
    }
    if (person.isOther) {
      leftover = uids.length;
      continue;
    }
    if (uids.length === 0) continue;
    const picked = person.name ? p.covers[person.name] : undefined;
    const coverFace =
      (picked ? faces.find((f) => f.uid === picked) : undefined) ??
      faces.reduce((best, f) => (f.score > best.score ? f : best), faces[0]);
    const label = shownName(person.name);
    const view: PersonView = {
      id: person.id,
      name: label,
      isOther: false,
      uids,
      cover: coverFace ? { uid: coverFace.uid, box: coverFace.box } : null,
    };
    if (isHiddenName(p, person.name)) hidden.push(view);
    else if (label) named.push(view);
    else if (isNameableCluster(null, false, uids.length)) unnamed.push(view);
  }
  named.sort((a, b) => b.uids.length - a.uids.length || a.name!.localeCompare(b.name!));
  const bySize = (a: PersonView, b: PersonView) => b.uids.length - a.uids.length || (a.id < b.id ? -1 : 1);
  unnamed.sort(bySize);
  hidden.sort(bySize);
  const suggestions = yield* suggestionSteps(store, byPerson);
  return { named, unnamed, hidden, leftover, suggestions, loose: listLoose(store, byPerson) };
}

function personOf(p: PeopleState, id: string): Person {
  const person = p.people.find((x) => x.id === id);
  if (!person) throw new Error("This person is no longer here");
  return person;
}

/** The renames and merges kept, and carried in a face copy; older ones have long reached every device. */
export const MAX_NAME_CHANGES = 500;

/** Keeps a rename or merge once, the newest MAX_NAME_CHANGES of them, oldest first. Answers whether it was new. */
export function keepNameChange(p: PeopleState, change: { from: string; to: string; at: number }): boolean {
  if (p.nameChanges.some((c) => c.from === change.from && c.to === change.to && c.at === change.at)) return false;
  p.nameChanges.push({ from: change.from, to: change.to, at: change.at });
  p.nameChanges.sort((a, b) => a.at - b.at);
  if (p.nameChanges.length > MAX_NAME_CHANGES) p.nameChanges.splice(0, p.nameChanges.length - MAX_NAME_CHANGES);
  return true;
}

/** The person called `from` is called `to` from `at` on, renamed or put together with the one already called that. */
function noteRenamed(p: PeopleState, from: string, to: string, at: number): void {
  if (from === to) return;
  keepNameChange(p, { from, to, at });
  delete p.namedAt[foldPersonName(from)];
  p.namedAt[foldPersonName(to)] = at;
  moveCuration(p, from, to);
  moveHidden(p, from, to);
}

/** The removals kept, and carried in a face copy; older ones have long reached every device. */
export const MAX_CURATION_REMOVALS = 2000;

/** Where the time of a piece of curation is kept: its kind, the person's name, and the photo or face. */

/** A face as every device of the account knows it: the photo's link id and the face's index. */
export function portableFaceId(faceId: string): string {
  return faceId.slice(faceId.indexOf("~") + 1);
}

/**
 * Points the people's choices about a photo's faces at the copy that replaced it: the faces moved
 * as `ids` says (see `FaceStore.movePhoto`), a cover picked on the photo, and the curation that
 * names the photo or one of its faces by link. A face put together with one the new photo already
 * had (`merged`) fills only what that face lacks: a face left out there, or confirmed there, stays as
 * it is; otherwise a removal, then a confirmed name, then a named person's grouping is taken, never
 * a name the face there is marked as not being. Its "not this person" marks go with it, except one
 * against the name the face there is confirmed as. Of two curation times for one piece, the later
 * is kept.
 */
export function rekeyPeople(
  p: PeopleState,
  oldUid: string,
  newUid: string,
  ids: Map<string, string>,
  merged: Set<string> = new Set(),
): void {
  const rejected = new Set(p.rejected);
  const named = new Map(p.people.filter((x) => x.name).map((x) => [x.id, x.name!] as const));
  const rejectedToo: string[] = [];
  const blockedFor = (id: string, name: string) => (p.blocked[id] ?? []).some((n) => foldPersonName(n) === foldPersonName(name));
  for (const [from, to] of ids) {
    if (!merged.has(from)) {
      if (from in p.assign) p.assign[to] = p.assign[from];
      if (from in p.confirmed) p.confirmed[to] = p.confirmed[from];
      if (from in p.blocked) p.blocked[to] = p.blocked[from];
    } else {
      if (!rejected.has(to) && p.confirmed[to] === undefined) {
        const confirmed = p.confirmed[from];
        const grouped = p.assign[from] ? named.get(p.assign[from]) : undefined;
        if (rejected.has(from)) {
          rejected.add(to);
          rejectedToo.push(to);
          delete p.assign[to];
        } else if (confirmed !== undefined && !blockedFor(to, confirmed)) {
          const person = p.people.find((x) => x.name && foldPersonName(x.name) === foldPersonName(confirmed));
          if (person) {
            p.assign[to] = person.id;
            p.confirmed[to] = person.name!;
          }
        } else if (grouped && !(p.assign[to] && named.has(p.assign[to])) && !blockedFor(to, grouped)) {
          p.assign[to] = p.assign[from];
        }
      }
      const marks = (p.blocked[from] ?? []).filter(
        (n) => !(p.confirmed[to] !== undefined && foldPersonName(p.confirmed[to]) === foldPersonName(n)) && !blockedFor(to, n),
      );
      if (marks.length) p.blocked[to] = [...(p.blocked[to] ?? []), ...marks];
    }
    delete p.assign[from];
    delete p.confirmed[from];
    delete p.blocked[from];
  }
  p.rejected = [...p.rejected.flatMap((id) => (merged.has(id) ? [] : [ids.get(id) ?? id])), ...rejectedToo];
  for (const name of Object.keys(p.covers)) if (p.covers[name] === oldUid) p.covers[name] = newUid;
  const oldLink = portableFaceId(oldUid);
  const newLink = portableFaceId(newUid);
  for (const list of Object.values(p.manual)) {
    const i = list.indexOf(oldLink);
    if (i < 0) continue;
    if (list.includes(newLink)) list.splice(i, 1);
    else list[i] = newLink;
  }
  for (const [key, c] of Object.entries(p.curation)) {
    let ref: string | null = null;
    if (c.ref === oldLink) ref = newLink;
    else if (c.ref.startsWith(`${oldLink}#`)) {
      const to = ids.get(`${oldUid}${c.ref.slice(oldLink.length)}`);
      ref = to ? portableFaceId(to) : newLink + c.ref.slice(oldLink.length);
    }
    if (ref === null) continue;
    delete p.curation[key];
    const target = curationKey(c.kind, c.name, ref);
    if ((p.curation[target]?.at ?? -1) < c.at) p.curation[target] = { ...c, ref };
  }
}

/** Keeps when these pieces of `name`'s curation were set or taken away, the newest removals only. */
export function noteCuration(p: PeopleState, kind: 1 | 2 | 3, name: string, refs: string[], removed: boolean, at: number): void {
  if (!name.trim() || refs.length === 0) return;
  for (const ref of refs) p.curation[curationKey(kind, name, ref)] = { kind, name, ref, removed, at };
  if (removed) pruneCuration(p);
}

/** Drops all but the newest MAX_CURATION_REMOVALS removals. */
export function pruneCuration(p: PeopleState): void {
  const removals = Object.entries(p.curation).filter(([, c]) => c.removed);
  if (removals.length <= MAX_CURATION_REMOVALS) return;
  removals.sort((a, b) => a[1].at - b[1].at);
  for (const [key] of removals.slice(0, removals.length - MAX_CURATION_REMOVALS)) delete p.curation[key];
}

/** Moves the curation times of `from` to `to`, keeping the later of two for the same piece. */
export function moveCuration(p: PeopleState, from: string, to: string): void {
  if (foldPersonName(from) === foldPersonName(to)) return;
  for (const [key, c] of Object.entries(p.curation)) {
    if (foldPersonName(c.name) !== foldPersonName(from)) continue;
    delete p.curation[key];
    const moved: Curation = { ...c, name: to };
    const target = curationKey(c.kind, to, c.ref);
    if ((p.curation[target]?.at ?? -1) < moved.at) p.curation[target] = moved;
  }
}

/**
 * Names a person, or takes the name away with an empty one. A name another person already has
 * puts the two together under it. Returns the id the person now goes by.
 */
export function renamePerson(store: FaceStore, id: string, rawName: string, at = Date.now()): string {
  const p = store.people;
  const person = personOf(p, id);
  if (person.isOther) throw new Error("The leftovers cannot be named");
  const name = rawName.trim().slice(0, 100) || null;
  if (name && isReservedName(name)) throw new Error("This name cannot be used");
  if (name) {
    const fold = foldPersonName(name);
    const same = p.people.find((x) => x.id !== id && x.name && foldPersonName(x.name) === fold);
    if (same) {
      mergePeople(store, id, same.id, at);
      return same.id;
    }
  }
  if (person.name && name) noteRenamed(p, person.name, name, at);
  else if (name) {
    p.namedAt[foldPersonName(name)] = at;
    confirmGroup(p, id, name);
  } else if (person.name) {
    keepNameChange(p, { from: person.name, to: "", at });
    delete p.namedAt[foldPersonName(person.name)];
    if (!isHiddenToken(person.name)) dropHidden(p, person.name);
  }
  renameInPlace(p, person, name);
  store.markPeople();
  store.edits++;
  return id;
}

/** Naming a group says who its faces are: each is confirmed, so a regroup keeps them together. */
function confirmGroup(p: PeopleState, id: string, name: string): void {
  const rejected = new Set(p.rejected);
  for (const [faceId, owner] of Object.entries(p.assign)) {
    if (owner !== id || rejected.has(faceId) || p.confirmed[faceId] !== undefined) continue;
    if (p.blocked[faceId]?.some((n) => foldPersonName(n) === foldPersonName(name))) continue;
    p.confirmed[faceId] = name;
  }
}

/** Whether the person called `name` is hidden from People. */
export function isHiddenName(p: PeopleState, name: string | null): boolean {
  return !!name && p.hidden[foldPersonName(name)]?.hidden === true;
}

/** Moves the hidden row of `from` to `to`, keeping the later one where `to` has a row already. */
export function moveHidden(p: PeopleState, from: string, to: string): void {
  const fromKey = foldPersonName(from);
  const toKey = foldPersonName(to);
  const row = p.hidden[fromKey];
  if (!row || fromKey === toKey) return;
  delete p.hidden[fromKey];
  if ((p.hidden[toKey]?.at ?? -1) < row.at) p.hidden[toKey] = { ...row, name: to };
}

/** Forgets the hidden row of a name that was taken off or renamed away. */
export function dropHidden(p: PeopleState, name: string): void {
  delete p.hidden[foldPersonName(name)];
}

/** Takes the reserved label off a group, which is an unnamed group again, as a rename to no name does. */
export function takeTokenOff(p: PeopleState, person: Person, at: number): void {
  if (!person.name || !isHiddenToken(person.name)) return;
  keepNameChange(p, { from: person.name, to: "", at });
  delete p.namedAt[foldPersonName(person.name)];
  renameInPlace(p, person, null);
}

/**
 * Hides a person from People and every suggestion, keeping all their faces and photos. An unnamed
 * group is labelled with a reserved name first, so it stays together on every device, and is shown
 * as unnamed all the same.
 */
export function hidePerson(store: FaceStore, id: string, at = Date.now()): void {
  const p = store.people;
  const person = personOf(p, id);
  if (person.isOther) throw new Error("The leftovers cannot be hidden");
  if (!person.name) {
    const token = newHiddenToken();
    p.namedAt[foldPersonName(token)] = at;
    confirmGroup(p, id, token);
    renameInPlace(p, person, token);
  }
  p.hidden[foldPersonName(person.name!)] = { name: person.name!, hidden: true, at };
  store.markPeople();
  store.edits++;
}

/** Shows a hidden person again, in People and in the suggestions; a reserved label comes off the group. */
export function showPerson(store: FaceStore, id: string, at = Date.now()): void {
  const p = store.people;
  const person = personOf(p, id);
  if (!person.name) return;
  const name = person.name;
  takeTokenOff(p, person, at);
  p.hidden[foldPersonName(name)] = { name, hidden: false, at };
  store.markPeople();
  store.edits++;
}

/** Gives `person` the name, with the cover and the faces confirmed under the old one. */
export function renameInPlace(p: PeopleState, person: Person, name: string | null): void {
  const id = person.id;
  if (person.name && p.covers[person.name] && name) {
    p.covers[name] = p.covers[person.name];
  }
  if (person.name) delete p.covers[person.name];
  if (person.name && name !== person.name && p.manual[person.name]) {
    if (name) p.manual[name] = [...new Set([...(p.manual[name] ?? []), ...p.manual[person.name]])];
    delete p.manual[person.name];
  }
  // Faces confirmed under the old name follow the person to the new one.
  for (const [faceId, confirmed] of Object.entries(p.confirmed)) {
    if (confirmed === person.name && p.assign[faceId] === id) {
      if (name) p.confirmed[faceId] = name;
      else delete p.confirmed[faceId];
    }
  }
  person.name = name;
}

/**
 * Puts `fromId`'s faces under `intoId`. Under a name, the faces of both are confirmed as that
 * person, so a regroup keeps together what was put together by hand even where the faces
 * look too different to group on their own.
 */
export function mergePeople(store: FaceStore, fromId: string, intoId: string, at = Date.now()): void {
  const p = store.people;
  if (fromId === intoId) return;
  const from = personOf(p, fromId);
  const into = personOf(p, intoId);
  if (from.isOther || into.isOther) throw new Error("The leftovers cannot be merged");
  if (from.name && into.name) noteRenamed(p, from.name, into.name, at);
  mergeInPlace(p, from, into);
  store.markPeople();
  store.edits++;
}

/**
 * Puts `from`'s faces under `into`, confirmed under its name when it has one unless `confirm` is
 * false, and drops `from`. The photos attached to `from` by hand go to `into`.
 */
export function mergeInPlace(p: PeopleState, from: Person, into: Person, confirm = true): void {
  const fromId = from.id;
  const intoId = into.id;
  for (const [faceId, personId] of Object.entries(p.assign)) {
    if (personId !== fromId && personId !== intoId) continue;
    p.assign[faceId] = intoId;
    if (into.name && confirm) p.confirmed[faceId] = into.name;
  }
  if (from.name) {
    delete p.covers[from.name];
    const attached = p.manual[from.name];
    delete p.manual[from.name];
    if (attached?.length && into.name) p.manual[into.name] = [...new Set([...(p.manual[into.name] ?? []), ...attached])];
  }
  p.people = p.people.filter((x) => x.id !== fromId);
}

/**
 * "Not a person": the group's faces are put aside for good, with every other kept face that is
 * at least HIDE_SIMILAR_THRESHOLD close to them, so a statue seen in many photos goes in one
 * step. Faces of a named person, or confirmed by hand, stay where they are.
 */
export function rejectPerson(store: FaceStore, id: string): number {
  const p = store.people;
  const person = personOf(p, id);
  const byPerson = facesByPerson(store);
  const own = byPerson.get(id) ?? [];
  if (own.length === 0) return 0;
  const centroid = meanDirection(own.map((f) => f.embedding));
  const namedIds = new Set(p.people.filter((x) => x.name).map((x) => x.id));
  const rejected = new Set(p.rejected);
  let count = 0;
  const reject = (face: FaceRecord) => {
    if (rejected.has(face.id)) return;
    rejected.add(face.id);
    delete p.assign[face.id];
    delete p.confirmed[face.id];
    count++;
  };
  for (const face of own) reject(face);
  if (!person.name) {
    for (const face of store.allFaces()) {
      if (rejected.has(face.id) || p.confirmed[face.id] !== undefined) continue;
      const owner = p.assign[face.id];
      if (owner && namedIds.has(owner)) continue;
      if (dot(face.embedding, centroid) >= HIDE_SIMILAR_THRESHOLD) reject(face);
    }
  }
  p.rejected = [...rejected];
  if (person.name) {
    // The name's marks and cover go with it, taken away by hand.
    const marks: string[] = [];
    for (const [faceId, names] of Object.entries(p.blocked)) {
      if (!names.includes(person.name)) continue;
      const rest = names.filter((n) => n !== person.name);
      if (rest.length) p.blocked[faceId] = rest;
      else delete p.blocked[faceId];
      marks.push(portableFaceId(faceId));
    }
    noteCuration(p, 2, person.name, marks, true, Date.now());
    if (p.covers[person.name]) noteCuration(p, 3, person.name, [""], true, Date.now());
    delete p.covers[person.name];
    noteCuration(p, 1, person.name, p.manual[person.name] ?? [], true, Date.now());
    delete p.manual[person.name];
  }
  p.people = p.people.filter((x) => x.id !== id);
  store.markPeople();
  store.edits++;
  return count;
}

/** Takes the person's faces on these photos away from them, into the leftovers. */
export function removePhotosFromPerson(store: FaceStore, id: string, uids: string[], at = Date.now()): number {
  const p = store.people;
  const person = personOf(p, id);
  const wanted = new Set(uids);
  const other = otherPerson(p);
  let count = 0;
  const marked: string[] = [];
  for (const face of store.allFaces()) {
    if (!wanted.has(face.uid) || p.assign[face.id] !== id) continue;
    p.assign[face.id] = other.id;
    delete p.confirmed[face.id];
    if (person.name) {
      const list = p.blocked[face.id] ?? [];
      if (!list.includes(person.name)) list.push(person.name);
      p.blocked[face.id] = list;
      marked.push(portableFaceId(face.id));
    }
    count++;
  }
  if (person.name) noteCuration(p, 2, person.name, marked, false, at);
  if (person.name && wanted.has(p.covers[person.name] ?? "")) delete p.covers[person.name];
  if (person.name) count += detachManual(p, person.name, uids.map(portableFaceId), at);
  store.markPeople();
  store.edits++;
  return count;
}

/** Takes these photos (link ids) off the ones attached to `name` by hand; answers how many were. */
function detachManual(p: PeopleState, name: string, links: string[], at: number): number {
  const attached = p.manual[name];
  if (!attached) return 0;
  const drop = new Set(links);
  const gone = attached.filter((link) => drop.has(link));
  if (gone.length === 0) return 0;
  const rest = attached.filter((link) => !drop.has(link));
  if (rest.length) p.manual[name] = rest;
  else delete p.manual[name];
  noteCuration(p, 1, name, gone, true, at);
  return gone.length;
}

/**
 * "This isn't <name>" for one face, from the viewer: the face leaves its person and goes to the
 * leftovers, marked as not them so it never joins them again, and the photo is no longer attached
 * to them by hand. The photo stays, and the face can still be offered for someone else. Answers
 * whether the face was theirs.
 */
export function notThisPerson(store: FaceStore, faceId: string, at = Date.now()): boolean {
  const p = store.people;
  const id = p.assign[faceId];
  const person = id ? p.people.find((x) => x.id === id) : undefined;
  if (!person || person.isOther) return false;
  const uid = faceId.slice(0, faceId.lastIndexOf("#"));
  if (!store.facesOf(uid).some((f) => f.id === faceId)) return false;
  p.assign[faceId] = otherPerson(p).id;
  delete p.confirmed[faceId];
  if (person.name) {
    const list = p.blocked[faceId] ?? [];
    if (!list.includes(person.name)) list.push(person.name);
    p.blocked[faceId] = list;
    noteCuration(p, 2, person.name, [portableFaceId(faceId)], false, at);
    detachManual(p, person.name, [portableFaceId(uid)], at);
  }
  store.markPeople();
  store.edits++;
  return true;
}

/** A face that might be this person, on a photo not yet theirs. */
export type Candidate = { faceId: string; uid: string; box: [number, number, number, number]; similarity: number };

/** At most this many photos are offered at once. */
const MAX_CANDIDATES = 300;

/**
 * Photos that might also be this named person: the best face on each photo, among the faces no
 * named person holds and nobody confirmed, at least FACE_SUGGEST_THRESHOLD close to the person
 * and never one marked as not them. Closest first.
 */
export function personCandidates(store: FaceStore, id: string): Candidate[] {
  const p = store.people;
  const person = personOf(p, id);
  if (!person.name) return [];
  const own = facesByPerson(store).get(id) ?? [];
  if (own.length === 0) return [];
  const centroid = meanDirection(own.map((f) => f.embedding));
  const ownUids = new Set(own.map((f) => f.uid));
  const namedIds = new Set(p.people.filter((x) => x.name).map((x) => x.id));
  const rejected = new Set(p.rejected);
  const best = new Map<string, Candidate>();
  for (const face of store.allFaces()) {
    if (ownUids.has(face.uid) || rejected.has(face.id) || p.confirmed[face.id] !== undefined) continue;
    const owner = p.assign[face.id];
    if (owner && namedIds.has(owner)) continue;
    if (p.blocked[face.id]?.includes(person.name)) continue;
    const similarity = dot(face.embedding, centroid);
    if (similarity < FACE_SUGGEST_THRESHOLD) continue;
    const seen = best.get(face.uid);
    if (!seen || seen.similarity < similarity) best.set(face.uid, { faceId: face.id, uid: face.uid, box: face.box, similarity });
  }
  return [...best.values()].sort((a, b) => b.similarity - a.similarity).slice(0, MAX_CANDIDATES);
}

/** Puts these faces with the person, confirmed as them, so a regroup keeps them there. */
export function addFacesToPerson(store: FaceStore, id: string, faceIds: string[], at = Date.now()): number {
  const p = store.people;
  const person = personOf(p, id);
  if (person.isOther) throw new Error("The leftovers cannot take faces");
  const known = new Set(store.allFaces().map((f) => f.id));
  let count = 0;
  // Moving a face to a person takes back a mark that it is not them.
  const unmarked: string[] = [];
  for (const faceId of faceIds) {
    if (!known.has(faceId)) continue;
    p.assign[faceId] = id;
    p.rejected = p.rejected.filter((x) => x !== faceId);
    if (person.name) {
      p.confirmed[faceId] = person.name;
      if (p.blocked[faceId]?.includes(person.name)) unmarked.push(portableFaceId(faceId));
      const blocked = p.blocked[faceId]?.filter((n) => n !== person.name);
      if (blocked?.length) p.blocked[faceId] = blocked;
      else delete p.blocked[faceId];
    }
    count++;
  }
  if (person.name) noteCuration(p, 2, person.name, unmarked, true, at);
  store.markPeople();
  store.edits++;
  return count;
}

/** "Not them" on offered photos: those faces are never offered to, or pulled into, this person. */
export function declineCandidates(store: FaceStore, id: string, faceIds: string[], at = Date.now()): void {
  const p = store.people;
  const person = personOf(p, id);
  if (!person.name) return;
  for (const faceId of faceIds) {
    const list = p.blocked[faceId] ?? [];
    if (!list.includes(person.name)) list.push(person.name);
    p.blocked[faceId] = list;
  }
  noteCuration(p, 2, person.name, faceIds.map(portableFaceId), false, at);
  store.markPeople();
  store.edits++;
}

/** Picks the photo a named person's card shows. */
export function setPersonCover(store: FaceStore, id: string, uid: string, at = Date.now()): void {
  const p = store.people;
  const person = personOf(p, id);
  if (!person.name) throw new Error("Name the person first");
  p.covers[person.name] = uid;
  noteCuration(p, 3, person.name, [""], false, at);
  store.markPeople();
  store.edits++;
}
