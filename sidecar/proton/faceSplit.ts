/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

/**
 * Splitting a person in two: two people who look alike (siblings, a parent and a grown child)
 * that the grouping put together.
 *
 * The grouping asks of every pair of faces one absolute question, "alike enough?", with one bar
 * for everyone (FACE_CLUSTER_THRESHOLD), and two lookalikes clear it. A split asks a relative
 * one instead: is this face closer to the faces the user said are A, or to those they said are
 * B? Two people can both clear the bar and still be consistently closer to themselves than to
 * each other, which is what this tells apart, with the same face numbers the scan made.
 *
 *   - The examples: the faces the user picks for each side, a person B already named (their
 *     confirmed faces), and what another device said about faces of this person (`conflicts`).
 *   - Each side's direction is the mean of its examples, refined over a few rounds with the
 *     faces that clearly lean that way; a face's margin is how much closer it is to A than B.
 *   - A face goes to a side when its margin is clear (a stricter bar for a weak face, as the
 *     grouping has) and its nearest examples agree. Otherwise it is unsure, and is not guessed:
 *     it stays with A as it was, for the user to answer.
 *   - Two faces in one photo are two people: if both lean the same way, the clearer one keeps
 *     that side and the other takes the other, or both are unsure when neither is clear.
 *   - How far to trust it: each example is left out in turn and sorted like the rest. If the
 *     examples do not land where the user put them, or few faces lean clearly, the result
 *     says the two look too alike to split reliably.
 *
 * Age. Two siblings differ less from each other than each does from themselves as a baby: over
 * all the years, the biggest difference among their faces is age, not who. So with the photos'
 * dates, the faces to pick from are taken year by year, newest first (the two ends of one year
 * are the two children, not a baby and a child), and a face is compared with each side as it
 * looked around that year: each side's faces of that year and of one either side, as far as
 * both sides have faces there. Never the whole side: the older one at eight looks like the
 * younger one at eight, years later, more than like themselves at ten. So the split starts in
 * the years of the examples and works outward a year a round, each year sorted against the one
 * next to it, where the two have aged alike; a year with no sorted neighbour is left unsure.
 *
 * Applied, the result is kept in the one form both this computer's regroup and the phone's
 * keep: the faces of each side confirmed as that side, and B's also marked as not A, with the
 * time, so the other device moves them too (see faceSync). The unsure ones are left exactly
 * as they were.
 */

import { randomBytes } from "node:crypto";
import { dot } from "./faceCluster.ts";
import { isConfidentFace } from "./faceAlign.ts";
import { curationKey, foldPersonName, mint, noteCuration, personOf, portableFaceId } from "./facePeople.ts";
import type { Conflict, Curation, FaceRecord, FaceStore, Person } from "./faceStore.ts";

/** A face as the window shows one: its photo, where it sits, and the year it was taken when known. */
export type SplitFace = { faceId: string; uid: string; box: [number, number, number, number]; year?: number };

/** Each photo's capture time, in ms, by uid; a photo missing or at 0 has no date. */
export type PhotoTimes = ReadonlyMap<string, number>;
const NO_TIMES: PhotoTimes = new Map();

export type SplitStart = {
  personId: string;
  name: string | null;
  /** Faces in the person. */
  faces: number;
  /** Photos with exactly two of the person's faces: one answer labels both. */
  pairs: { left: SplitFace; right: SplitFace }[];
  /** The clearest faces from the two ends of the person, alternating, to pick examples from. */
  contrast: SplitFace[];
  /** Faces of this person another device confirmed as someone else, by that name. */
  elsewhere: { name: string; faceIds: string[]; sample: SplitFace[] }[];
};

export type SplitSide = "a" | "b" | "unsure";

export type SplitPlan = {
  counts: Record<SplitSide, number>;
  /** Examples left out one at a time that still landed on their side, of those tried. */
  checked: { right: number; tried: number };
  /** Of the faces not given as examples, the share that leans clearly one way. */
  clearShare: number;
  verdict: "reliable" | "weak" | "unreliable" | "few";
  /** The least certain faces of each side, for a look before applying. */
  leastSureA: SplitFace[];
  leastSureB: SplitFace[];
  /**
   * The unsure faces, newest first and hardest first within a year, with which way each leans;
   * "none" for one no year near it could be compared for.
   */
  unsure: (SplitFace & { lean: "a" | "b" | "even" | "none" })[];
  /** How the person's faces were sorted, by the year taken, newest first; undated last. */
  byYear: { year: number | null; a: number; b: number; unsure: number }[];
  /** Years too far from the examples to be sorted from them, newest first: they wait for examples there. */
  waiting: number[];
};

export type SplitApplied = { stayed: number; moved: number; unsure: number; undo: string };

/** Margins below these are not clear: confident faces, and weak ones (as the grouping's strict delta). */
const MARGIN = 0.05;
const MARGIN_WEAK = 0.1;
/** Rounds of refining each side's direction with the faces that clearly lean that way; with dates, at most this many (one year further each). */
const ROUNDS = 3;
const ROUNDS_DATED = 16;
/** An example counts this many times over a face that only leans that way. */
const EXAMPLE_WEIGHT = 5;
/** Nearest examples asked to agree, and how many examples per side are asked at most. */
const NEIGHBOURS = 7;
const NEIGHBOUR_POOL = 150;
/** Examples per side tried left out, at most. */
const CHECK_POOL = 200;
/** Unsure faces listed for review, at most. */
const UNSURE_LISTED = 400;
/** A split's undo kept, at most this many, until the app closes. */
const UNDO_KEPT = 5;
/** Comparing a face with each side around its year: the weight of that year, and of one either side. */
const NEAR_YEARS = [1, 0.5];
/** With no example near a dated face's year to ask, its margin must clear this much more. */
const UNCHECKED = 1.5;
/**
 * Faces' worth (an example counts EXAMPLE_WEIGHT, a leaning face 1) a side needs in a year for
 * that year to count at all, and at which it counts in full. Below it, one face that only leaned
 * that way would be the side's whole direction for the year, and could pull the next year over.
 */
const YEAR_MIN = 3;
const YEAR_FULL = 5;
/** A year sorted as a whole: the share of its faces whose own lean must agree with their group. */
const YEAR_AGREE = 0.8;
/**
 * A year with no examples near it: how closely its two sides must be apart the way the
 * examples are (cosine of the two differences). Apart by who they are, they line up; apart by
 * glasses or the light, they hardly do.
 */
const YEAR_ALIGNED = 0.35;
/** The share of examples whose nearest other example is the same person, for the split to work outward from them. */
const EXAMPLES_NEAREST = 0.9;
/** Below this share, the face numbers do not tell the two apart face by face: the split is not to be trusted. */
const EXAMPLES_NEAREST_LOW = 0.75;
/**
 * Years beyond the nearest examples a split works out to; further ones wait for examples there.
 * Each year further takes the last one's sorting on trust, and a wrong turn is carried on.
 */
const REACH = 2;
/** Photos with both of them, sorted on their own, needed before they count toward the verdict. */
const PAIRS_ASKED = 5;
/** The share of those with both faces sent one way above which the split is at best "probably", and not to be trusted. */
const PAIRS_WRONG_OK = 0.05;
const PAIRS_WRONG_BAD = 0.15;
/** A face is left out of its own year's side when judged while that side has fewer faces there than this; past it, one face hardly moves the side. */
const SELF_WEIGHS_BELOW = 40;
/** Faces to pick from: in all, and per end of the newest year and of each older one. */
const CONTRAST_MAX = 32;
const CONTRAST_NEWEST = 4;
const CONTRAST_OLDER = 2;
/** Clear faces a run of years gathers before its two ends are looked for. */
const ERA_MIN = 12;

const yieldNow = () => new Promise<void>((resolve) => setImmediate(resolve));

function yearOf(times: PhotoTimes, uid: string): number | null {
  const t = times.get(uid);
  return t && t > 0 ? new Date(t).getFullYear() : null;
}

function view(f: FaceRecord, times: PhotoTimes = NO_TIMES): SplitFace {
  const year = yearOf(times, f.uid);
  return year === null ? { faceId: f.id, uid: f.uid, box: f.box } : { faceId: f.id, uid: f.uid, box: f.box, year };
}

/** The unit-length direction of a weighted sum. */
function direction(sum: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < sum.length; i++) n += sum[i] * sum[i];
  const inv = n > 0 ? 1 / Math.sqrt(n) : 0;
  const out = new Float32Array(sum.length);
  for (let i = 0; i < sum.length; i++) out[i] = sum[i] * inv;
  return out;
}

function addInto(sum: Float32Array, v: Float32Array, weight: number): void {
  for (let i = 0; i < sum.length; i++) sum[i] += v[i] * weight;
}

const confident = (f: FaceRecord) => isConfidentFace(f.score, f.blur, f.sideways);

/** The faces of one side, in all and by the year taken. */
class SideFaces {
  readonly all: Float32Array;
  readonly years = new Map<number, { sum: Float32Array; n: number }>();
  constructor(readonly dim: number) {
    this.all = new Float32Array(dim);
  }
  add(v: Float32Array, year: number | null, weight: number): void {
    addInto(this.all, v, weight);
    if (year === null) return;
    let y = this.years.get(year);
    if (!y) this.years.set(year, (y = { sum: new Float32Array(this.dim), n: 0 }));
    addInto(y.sum, v, weight);
    y.n += weight;
  }
  copy(): SideFaces {
    const out = new SideFaces(this.dim);
    out.all.set(this.all);
    for (const [year, y] of this.years) out.years.set(year, { sum: Float32Array.from(y.sum), n: y.n });
    return out;
  }
}

/**
 * The directions of the two sides to compare a face of `year` with: each side's faces of that
 * year and of one either side, each year as far as both sides have faces there. Undated, the
 * whole sides; null for a dated face with no year near it that both sides have.
 */
function towardAt(
  a: SideFaces,
  b: SideFaces,
  year: number | null,
  less?: { side: "a" | "b"; v: Float32Array },
): [Float32Array, Float32Array] | null {
  if (year === null) return [direction(a.all), direction(b.all)];
  const ta = new Float32Array(a.dim);
  const tb = new Float32Array(b.dim);
  let local = false;
  for (let d = -1; d <= 1; d++) {
    let ya = a.years.get(year + d);
    let yb = b.years.get(year + d);
    if (!ya || !yb) continue;
    // The face being judged is not its own evidence: its year without it.
    if (less && d === 0) {
      const own = less.side === "a" ? ya : yb;
      const sum = Float32Array.from(own.sum);
      addInto(sum, less.v, -1);
      const without = { sum, n: own.n - 1 };
      if (less.side === "a") ya = without;
      else yb = without;
    }
    if (ya.n < YEAR_MIN || yb.n < YEAR_MIN) continue;
    const w = NEAR_YEARS[Math.abs(d)] * Math.min(1, ya.n / YEAR_FULL, yb.n / YEAR_FULL);
    addInto(ta, direction(ya.sum), w);
    addInto(tb, direction(yb.sum), w);
    local = true;
  }
  return local ? [direction(ta), direction(tb)] : null;
}

/** `towardAt`, each year worked out once. */
function towardMemo(a: SideFaces, b: SideFaces): (year: number | null) => [Float32Array, Float32Array] | null {
  const memo = new Map<number | null, [Float32Array, Float32Array] | null>();
  return (year) => {
    if (!memo.has(year)) memo.set(year, towardAt(a, b, year));
    return memo.get(year)!;
  };
}

/** The two ends of a set of faces (a few rounds of two-means), the `perEnd` nearest each, clearest first. */
function twoEnds(clear: FaceRecord[], perEnd: number): [FaceRecord[], FaceRecord[]] {
  if (clear.length < 2) return [clear.slice(0, perEnd), []];
  const mean = new Float32Array(clear[0].embedding.length);
  for (const f of clear) addInto(mean, f.embedding, 1);
  const centre = direction(mean);
  let first = clear[0];
  for (const f of clear) if (dot(f.embedding, centre) < dot(first.embedding, centre)) first = f;
  let second = clear[0];
  for (const f of clear) if (dot(f.embedding, first.embedding) < dot(second.embedding, first.embedding)) second = f;
  let ca = first.embedding;
  let cb = second.embedding;
  let side = new Uint8Array(clear.length);
  for (let round = 0; round < 6; round++) {
    const sa = new Float32Array(ca.length);
    const sb = new Float32Array(cb.length);
    side = new Uint8Array(clear.length);
    clear.forEach((f, i) => {
      const toB = dot(f.embedding, cb) > dot(f.embedding, ca);
      side[i] = toB ? 1 : 0;
      addInto(toB ? sb : sa, f.embedding, 1);
    });
    ca = direction(sa);
    cb = direction(sb);
  }
  const end = (s: number) =>
    clear
      .filter((_, i) => side[i] === s)
      .sort((x, y) => dot(y.embedding, s ? cb : ca) - dot(x.embedding, s ? cb : ca))
      .slice(0, perEnd);
  return [end(0), end(1)];
}

/**
 * A year's faces sorted as a whole, for a year neither side has sorted faces in yet. Compared
 * one at a time with the year next to it, a face leans only a little: there, one of the two is
 * a year older than here and the other a year younger, so age says nothing and only who it is
 * does. Together the year's faces may fall into two groups (two-means from its two most
 * different faces, not from the leans, so that agreeing with them means something), and the
 * year next to it says which group is which. Taken only when the groups agree with the leans:
 * most faces of each lean its way, and each group leans its own way on average. Then a face
 * goes with its group when it is clearly nearer it than the other, without itself. Otherwise
 * null, and the year's faces are sorted one at a time. Whether the groups are the two people
 * at all, and not glasses against none, is asked of the examples after (see `yearHolds`).
 */
export function sortYear(faces: FaceRecord[], leans: (number | null)[]): Map<string, "a" | "b"> | null {
  if (faces.length < 2 * YEAR_MIN || leans.some((m) => m === null)) return null;
  const m = leans as number[];
  const dim = faces[0].embedding.length;
  const mean = new Float32Array(dim);
  for (const f of faces) addInto(mean, f.embedding, 1);
  const centre = direction(mean);
  let first = faces[0];
  for (const f of faces) if (dot(f.embedding, centre) < dot(first.embedding, centre)) first = f;
  let second = faces[0];
  for (const f of faces) if (dot(f.embedding, first.embedding) < dot(second.embedding, first.embedding)) second = f;
  let cx = first.embedding;
  let cy = second.embedding;
  let inX = faces.map((f) => dot(f.embedding, cx) >= dot(f.embedding, cy));
  for (let round = 0; round < 8; round++) {
    const sx = new Float32Array(dim);
    const sy = new Float32Array(dim);
    faces.forEach((f, i) => addInto(inX[i] ? sx : sy, f.embedding, 1));
    cx = direction(sx);
    cy = direction(sy);
    const next = faces.map((f) => dot(f.embedding, cx) >= dot(f.embedding, cy));
    if (next.every((v, i) => v === inX[i])) break;
    inX = next;
  }
  const nx = inX.filter(Boolean).length;
  const ny = faces.length - nx;
  if (nx < YEAR_MIN || ny < YEAR_MIN) return null;
  let leanX = 0;
  let leanY = 0;
  faces.forEach((_, i) => {
    if (inX[i]) leanX += m[i];
    else leanY += m[i];
  });
  // The group leaning further toward A is A's.
  const xIsA = leanX / nx >= leanY / ny;
  const toA = inX.map((x) => x === xIsA);
  const leanA = (xIsA ? leanX / nx : leanY / ny);
  const leanB = (xIsA ? leanY / ny : leanX / nx);
  if (leanA < MARGIN / 2 || leanB > -MARGIN / 2) return null;
  let agree = 0;
  faces.forEach((_, i) => {
    if (toA[i] === m[i] > 0) agree++;
  });
  if (agree < YEAR_AGREE * faces.length) return null;
  // Each face against its group without itself, and the other group.
  const sa = new Float32Array(dim);
  const sb = new Float32Array(dim);
  faces.forEach((f, i) => addInto(toA[i] ? sa : sb, f.embedding, 1));
  const out = new Map<string, "a" | "b">();
  faces.forEach((f, i) => {
    const own = Float32Array.from(toA[i] ? sa : sb);
    addInto(own, f.embedding, -1);
    const other = toA[i] ? sb : sa;
    if (dot(f.embedding, direction(own)) - dot(f.embedding, direction(other)) >= MARGIN) out.set(f.id, toA[i] ? "a" : "b");
  });
  return out;
}

/**
 * Whether the faces sorted in a year with no examples near it hold as the two people: both
 * sides there, no photo with two of its faces on one side (two faces in one photo are two
 * people), and the two sides apart the way they are in the years next to it (`nextApart`, the
 * direction from B's faces to A's there), where the two are nearly the same ages. Faces split
 * by something else (glasses or none, lying down, the light) are apart along that instead, and
 * the year is left unsure, as are the years beyond it, which it would otherwise lead astray in
 * turn. Not the examples' own difference: that is the two at the examples' ages, and the
 * difference in age between two children changes what they look like from year to year.
 */
export function yearHolds(sorted: { f: FaceRecord; side: "a" | "b" }[], nextApart: Float32Array | null): boolean {
  if (!nextApart) return false;
  const a = sorted.filter((x) => x.side === "a");
  const b = sorted.filter((x) => x.side === "b");
  if (a.length < YEAR_MIN || b.length < YEAR_MIN) return false;
  // One such photo is let pass (a mirror, a collage, a photo of a photo); two are not.
  const sideOfPhoto = new Map<string, "a" | "b">();
  let together = 0;
  for (const { f, side } of sorted) {
    if (sideOfPhoto.get(f.uid) === side && ++together > 1) return false;
    sideOfPhoto.set(f.uid, side);
  }
  const dim = nextApart.length;
  const sa = new Float32Array(dim);
  const sb = new Float32Array(dim);
  for (const x of a) addInto(sa, x.f.embedding, 1);
  for (const x of b) addInto(sb, x.f.embedding, 1);
  const apart = direction(sa);
  addInto(apart, direction(sb), -1);
  return dot(direction(apart), nextApart) >= YEAR_ALIGNED;
}

/** Two lists taken in turn. */
function alternate<T>(x: T[], y: T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i]) out.push(x[i]);
    if (y[i]) out.push(y[i]);
  }
  return out;
}

/** The faces of a person, as grouped now. */
function facesOfPerson(store: FaceStore, personId: string): FaceRecord[] {
  const p = store.people;
  const rejected = new Set(p.rejected);
  return store.allFaces().filter((f) => p.assign[f.id] === personId && !rejected.has(f.id));
}

/**
 * What the window opens a split with: the examples to pick from, and what other devices said.
 * `times` dates the photos: the faces to pick from are then taken year by year, newest first.
 */
export function splitStart(store: FaceStore, personId: string, times: PhotoTimes = NO_TIMES): SplitStart {
  const p = store.people;
  const person = personOf(p, personId);
  if (person.isOther) throw new Error("The leftovers cannot be split");
  const faces = facesOfPerson(store, personId);
  const look = (f: FaceRecord) => view(f, times);
  const newestFirst = (x: FaceRecord, y: FaceRecord) => (yearOf(times, y.uid) ?? -Infinity) - (yearOf(times, x.uid) ?? -Infinity);

  // Photos where two of the person's faces appear: two people, so one answer labels both.
  // The newest first, where the two differ most to the eye.
  const byPhoto = new Map<string, FaceRecord[]>();
  for (const f of faces) {
    let list = byPhoto.get(f.uid);
    if (!list) byPhoto.set(f.uid, (list = []));
    list.push(f);
  }
  const pairs = [...byPhoto.values()]
    .filter((list) => list.length === 2 && list.every(confident))
    .sort((x, y) => newestFirst(x[0], y[0]) || Math.min(y[0].score, y[1].score) - Math.min(x[0].score, x[1].score))
    .slice(0, 8)
    .map(([l, r]) => ({ left: look(l), right: look(r) }));

  // The two ends of the person, the faces nearest each, clearest first. Lookalikes merged into
  // one sit at the two ends of a year; over all the years, the ends are apart in age instead.
  const clear = faces.filter(confident).sort((x, y) => y.score - x.score).slice(0, 3000);
  const dated = clear.filter((f) => yearOf(times, f.uid) !== null);
  const contrast: SplitFace[] = [];
  if (dated.length >= ERA_MIN && dated.length * 2 >= clear.length) {
    // Runs of years, newest first, each gathering at least ERA_MIN faces.
    const byYear = new Map<number, FaceRecord[]>();
    for (const f of dated) {
      const year = yearOf(times, f.uid)!;
      let list = byYear.get(year);
      if (!list) byYear.set(year, (list = []));
      list.push(f);
    }
    let era: FaceRecord[] = [];
    let newest = true;
    const take = () => {
      const [x, y] = twoEnds(era, newest ? CONTRAST_NEWEST : CONTRAST_OLDER);
      for (const f of alternate(x, y)) if (contrast.length < CONTRAST_MAX) contrast.push(look(f));
      era = [];
      newest = false;
    };
    for (const year of [...byYear.keys()].sort((x, y) => y - x)) {
      era.push(...byYear.get(year)!);
      if (era.length >= ERA_MIN) take();
      if (contrast.length >= CONTRAST_MAX) break;
    }
    if (era.length >= 2 && contrast.length < CONTRAST_MAX) take();
  } else if (clear.length >= 2) {
    const [x, y] = twoEnds(clear, 8);
    contrast.push(...alternate(x, y).map(look));
  }

  // What another device confirmed some of these faces as, by name.
  const byName = new Map<string, FaceRecord[]>();
  for (const f of faces) {
    const conflict = p.conflicts[f.id];
    if (!conflict) continue;
    const key = foldPersonName(conflict.there);
    let list = byName.get(key);
    if (!list) byName.set(key, (list = []));
    list.push(f);
  }
  const elsewhere = [...byName.values()]
    .map((list) => ({
      name: p.conflicts[list[0].id].there,
      faceIds: list.map((f) => f.id),
      sample: list.slice(0, 6).map(look),
    }))
    .sort((x, y) => y.faceIds.length - x.faceIds.length);

  return { personId, name: person.name, faces: faces.length, pairs, contrast, elsewhere };
}

type Labelled = { sides: Map<string, SplitSide>; margins: Map<string, number>; faces: FaceRecord[]; plan: SplitPlan };

/**
 * Works out the split of `personId` between itself (A) and `otherName` (B) from the examples
 * picked for each, without changing anything.
 */
export async function planSplit(
  store: FaceStore,
  personId: string,
  otherName: string,
  picked: { a: string[]; b: string[] },
  times: PhotoTimes = NO_TIMES,
  stale: () => boolean = newPlanTicket(),
): Promise<SplitPlan> {
  return (await label(store, personId, otherName, picked, times, stale)).plan;
}

/** Previews asked for, so an older one still being worked out gives way to the newest. */
let planTickets = 0;

/**
 * A preview's place in line: true once a newer one has been asked for, when this one stops at
 * its next pause. Taken as the request arrives, before anything it waits on.
 */
export function newPlanTicket(): () => boolean {
  const ticket = ++planTickets;
  return () => planTickets !== ticket;
}

/** A preview given up for a newer one. */
export class SplitSuperseded extends Error {
  constructor() {
    super("superseded by a newer preview");
  }
}

async function label(
  store: FaceStore,
  personId: string,
  otherName: string,
  picked: { a: string[]; b: string[] },
  times: PhotoTimes,
  stale?: () => boolean,
): Promise<Labelled> {
  const p = store.people;
  const person = personOf(p, personId);
  if (person.isOther) throw new Error("The leftovers cannot be split");
  const fold = foldPersonName(otherName);
  if (!fold) throw new Error("A name is needed for the other person");
  if (person.name && foldPersonName(person.name) === fold) throw new Error("Pick someone other than this person");
  const faces = facesOfPerson(store, personId);
  const inPerson = new Set(faces.map((f) => f.id));
  const byId = new Map(store.allFaces().map((f) => [f.id, f]));

  // The examples. Picked for A: faces of this person. For B: picked here, and the faces already
  // confirmed as B by name, wherever they are now, the clearest first.
  const aIds = new Set(picked.a.filter((id) => inPerson.has(id)));
  const bIds = new Set(picked.b.filter((id) => byId.has(id) && !aIds.has(id)));
  const named = Object.entries(p.confirmed)
    .filter(([id, n]) => foldPersonName(n) === fold && byId.has(id) && !aIds.has(id))
    .map(([id]) => byId.get(id)!)
    .sort((x, y) => y.score - x.score)
    .slice(0, 300);
  for (const f of named) bIds.add(f.id);
  if (aIds.size === 0 || bIds.size === 0) throw new Error("Pick at least one face of each person");
  const aSeeds = [...aIds].map((id) => byId.get(id)!);
  const bSeeds = [...bIds].map((id) => byId.get(id)!);

  const dim = faces[0]?.embedding.length ?? aSeeds[0].embedding.length;
  const yearOfFace = new Map<string, number | null>();
  for (const f of [...faces, ...aSeeds, ...bSeeds]) yearOfFace.set(f.id, yearOf(times, f.uid));
  const seedSides = (seeds: FaceRecord[]) => {
    const s = new SideFaces(dim);
    for (const f of seeds) s.add(f.embedding, yearOfFace.get(f.id)!, EXAMPLE_WEIGHT);
    return s;
  };
  const aSeedSide = seedSides(aSeeds);
  const bSeedSide = seedSides(bSeeds);
  let toward = towardMemo(aSeedSide, bSeedSide);
  let sidesNow = { a: aSeedSide, b: bSeedSide };
  /** The side each face leant to in the last round, and so is part of that side's sum. */
  let added = new Map<string, "a" | "b">();
  /** How much closer a face is to A than to B, around its year; null with no sorted year near it. */
  const margin = (f: FaceRecord): number | null => {
    const year = yearOfFace.get(f.id)!;
    const side = added.get(f.id);
    // A dated face that leant one way is judged by its year without itself.
    const got =
      side && year !== null && (sidesNow[side].years.get(year)?.n ?? 0) < SELF_WEIGHS_BELOW
        ? towardAt(sidesNow.a, sidesNow.b, year, { side, v: f.embedding })
        : toward(year);
    return got ? dot(f.embedding, got[0]) - dot(f.embedding, got[1]) : null;
  };
  const rest = faces.filter((f) => !aIds.has(f.id) && !bIds.has(f.id));
  const dated = rest.some((f) => yearOfFace.get(f.id) !== null);
  /** The clear faces to sort, by year. */
  const restByYear = new Map<number | null, FaceRecord[]>();
  for (const f of rest) {
    if (!confident(f)) continue;
    const year = yearOfFace.get(f.id)!;
    let list = restByYear.get(year);
    if (!list) restByYear.set(year, (list = []));
    list.push(f);
  }

  /** How many years a year is from the nearest with examples of both sides; Infinity with none. */
  // A year counts as one with examples when both sides have some in it or a year either side:
  // an era's picks are spread over its years.
  const near3 = (side: SideFaces, y: number) =>
    (side.years.get(y - 1)?.n ?? 0) + (side.years.get(y)?.n ?? 0) + (side.years.get(y + 1)?.n ?? 0);
  const exampleYears = [...new Set([...aSeedSide.years.keys(), ...bSeedSide.years.keys()])].filter(
    (y) => near3(aSeedSide, y) >= YEAR_MIN && near3(bSeedSide, y) >= YEAR_MIN,
  );
  const fromExamples = (year: number) => Math.min(Infinity, ...exampleYears.map((y) => Math.abs(y - year)));
  /** A year with examples of both sides in it or next to it. */
  const nearExamples = (year: number) => fromExamples(year) <= 1;
  /** How the two are apart in the years next to `year`, as sorted so far: from B's faces to A's. */
  const apartNear = (year: number): Float32Array | null => {
    const sum = new Float32Array(dim);
    let any = false;
    for (const d of [-1, 1]) {
      const ya = sidesNow.a.years.get(year + d);
      const yb = sidesNow.b.years.get(year + d);
      if (!ya || !yb || ya.n < YEAR_MIN || yb.n < YEAR_MIN) continue;
      const gap = direction(ya.sum);
      addInto(gap, direction(yb.sum), -1);
      addInto(sum, direction(gap), 1);
      any = true;
    }
    return any ? direction(sum) : null;
  };
  /** The years whose sorted faces were taken in the last round. */
  let keptYears = new Set<number | null>();
  /** Up to CHECK_POOL of a side's examples, the user's picks first. */
  const pool0 = (seeds: FaceRecord[], picks: Set<string>) =>
    [...seeds].sort((x, y) => Number(picks.has(y.id)) - Number(picks.has(x.id)) || y.score - x.score).slice(0, CHECK_POOL);
  // Working outward from the examples takes, year after year, the faces most like those already
  // sorted. That holds only when a face's likeness is mostly who it is: asked of the examples,
  // whose nearest other example (of about the same age) must be one of the same person. Where
  // it is not (the light, glasses or the angle matter more to the model than which child it
  // is), only the years at the examples are sorted.
  const examplesNearest = ((): number | null => {
    // At most a few hundred asked (the user's picks first), and judged by the weaker side, as
    // the leave-one-out check is: a few of one side among many of the other would vanish.
    const all = [
      ...pool0(aSeeds, new Set(picked.a)).map((f) => ({ f, a: true })),
      ...pool0(bSeeds, new Set(picked.b)).map((f) => ({ f, a: false })),
    ];
    const right = { a: 0, b: 0 };
    const asked = { a: 0, b: 0 };
    for (const x of all) {
      const year = yearOfFace.get(x.f.id)!;
      let best = -Infinity;
      let bestA: boolean | null = null;
      for (const y of all) {
        if (y === x) continue;
        const other = yearOfFace.get(y.f.id)!;
        if (year !== null && (other === null || Math.abs(other - year) > 1)) continue;
        const s = dot(x.f.embedding, y.f.embedding);
        if (s > best) {
          best = s;
          bestA = y.a;
        }
      }
      if (bestA === null) continue;
      const side = x.a ? "a" : "b";
      asked[side]++;
      if (bestA === x.a) right[side]++;
    }
    if (asked.a < 2 || asked.b < 2) return null;
    return Math.min(right.a / asked.a, right.b / asked.b);
  })();
  const examplesHold = examplesNearest !== null && examplesNearest >= EXAMPLES_NEAREST;

  // The examples the nearest-neighbour check asks: as many from each side, the user's picks
  // first, then the clearest. Uneven sides would make the vote the count of examples rather
  // than who the face is near: with three of A and sixty of B, no face could get four A votes.
  // A dated face asks the examples of its year and one either side only: across the years,
  // its nearest are those of its age, whoever they are.
  const pickedA = new Set(picked.a);
  const pickedB = new Set(picked.b);
  const votersFor = (aPool: FaceRecord[], bPool: FaceRecord[]) => {
    const even = Math.min(NEIGHBOUR_POOL, aPool.length, bPool.length);
    const pool = (seeds: FaceRecord[], picks: Set<string>) =>
      [...seeds].sort((x, y) => Number(picks.has(y.id)) - Number(picks.has(x.id)) || y.score - x.score).slice(0, even);
    return {
      voters: [...pool(aPool, pickedA).map((f) => ({ f, a: true })), ...pool(bPool, pickedB).map((f) => ({ f, a: false }))],
      // An odd number of neighbours, fewer than each side has: with two of each, the nearest three.
      k: Math.min(NEIGHBOURS, 2 * even - 1),
    };
  };
  const votersMemo = new Map<number | null, ReturnType<typeof votersFor>>();
  const votersAt = (year: number | null) => {
    let got = votersMemo.get(year);
    if (!got) {
      const near = (f: FaceRecord) => {
        const y = yearOfFace.get(f.id)!;
        return year === null || (y !== null && Math.abs(y - year) <= 1);
      };
      votersMemo.set(year, (got = votersFor(aSeeds.filter(near), bSeeds.filter(near))));
    }
    return got;
  };
  /** Whether the nearest examples agree, or null when there are none of each to ask. */
  // A face's nearest examples are the same in every round: asked once.
  const votes = new Map<string, { forA: number; of: number } | null>();
  const nearestAgree = (f: FaceRecord, towardA: boolean): boolean | null => {
    let vote = votes.get(f.id);
    if (vote === undefined) votes.set(f.id, (vote = nearestVote(f)));
    if (!vote) return null;
    return towardA ? vote.forA * 2 > vote.of : vote.forA * 2 < vote.of;
  };
  const nearestVote = (f: FaceRecord): { forA: number; of: number } | null => {
    const { voters, k } = votersAt(yearOfFace.get(f.id)!);
    if (k < 1) return null;
    const best: { s: number; a: boolean }[] = [];
    for (const v of voters) {
      const s = dot(f.embedding, v.f.embedding);
      if (best.length < k) {
        best.push({ s, a: v.a });
        best.sort((x, y) => x.s - y.s);
      } else if (s > best[0].s) {
        best[0] = { s, a: v.a };
        best.sort((x, y) => x.s - y.s);
      }
    }
    return { forA: best.filter((b) => b.a).length, of: best.length };
  };

  // Each side refined with the faces that lean clearly its way, in their own year. With dates,
  // until no more are sorted: each round reaches a year further from the examples.
  for (let round = 0; round < (dated ? ROUNDS_DATED : ROUNDS); round++) {
    const sa = aSeedSide.copy();
    const sb = bSeedSide.copy();
    const now = new Map<string, "a" | "b">();
    let changed = 0;
    keptYears = new Set();
    let worked = 0;
    for (const [year, list] of restByYear) {
      // The sidecar answers the window between years: pictures and clicks are not held up.
      worked += list.length;
      if (worked > 256) {
        worked = 0;
        await yieldNow();
        if (stale?.()) throw new SplitSuperseded();
      }
      // A year neither side has sorted faces in yet is sorted as a whole from the year next to
      // it (see `sortYear`); one that has, a face at a time.
      const own =
        year !== null &&
        (sidesNow.a.years.get(year)?.n ?? 0) >= YEAR_MIN &&
        (sidesNow.b.years.get(year)?.n ?? 0) >= YEAR_MIN;
      const whole = year !== null && !own ? sortYear(list, list.map(margin)) : null;
      const sorted: { f: FaceRecord; side: "a" | "b" }[] = [];
      for (const f of list) {
        let side: "a" | "b" | undefined;
        if (whole) side = whole.get(f.id);
        else {
          const m = margin(f);
          if (m !== null && m >= MARGIN) side = "a";
          else if (m !== null && m <= -MARGIN) side = "b";
          // Next to the examples, a face is added to a side only when its nearest examples
          // agree: else the faces that only lean one way outnumber the examples, and could
          // draw the side toward what they share besides who they are (glasses, the light).
          if (side && year !== null && nearestAgree(f, side === "a") === false) side = undefined;
        }
        if (side) sorted.push({ f, side });
      }
      // Far from the examples, a year is taken only as the two people (see `yearHolds`).
      if (
        year !== null &&
        !nearExamples(year) &&
        (fromExamples(year) > REACH || !examplesHold || !yearHolds(sorted, apartNear(year)))
      )
        continue;
      keptYears.add(year);
      for (const { f, side } of sorted) {
        now.set(f.id, side);
        (side === "a" ? sa : sb).add(f.embedding, year, 1);
        if (added.get(f.id) !== side) changed++;
      }
    }
    const settled = changed === 0 && now.size === added.size;
    added = now;
    sidesNow = { a: sa, b: sb };
    toward = towardMemo(sa, sb);
    await yieldNow();
    if (stale?.()) throw new SplitSuperseded();
    if (dated && round >= ROUNDS - 1 && settled) break;
  }

  const sides = new Map<string, SplitSide>();
  const margins = new Map<string, number>();
  const uncompared = new Set<string>();
  /** Faces sorted in years with no examples near them: reached by working outward. */
  let reached = 0;
  for (const f of aSeeds) if (inPerson.has(f.id)) sides.set(f.id, "a");
  for (const f of bSeeds) if (inPerson.has(f.id)) sides.set(f.id, "b");
  let done = 0;
  for (const f of rest) {
    const m = margin(f);
    margins.set(f.id, m ?? 0);
    if (m === null) uncompared.add(f.id);
    let bar = confident(f) ? MARGIN : MARGIN_WEAK;
    const agree = m === null ? false : nearestAgree(f, m > 0);
    // No example near its year to ask: its own year and the next, sorted before it, decide,
    // by a wider margin.
    if (agree === null) bar *= UNCHECKED;
    // Far from the examples, only in a year that held as the two people (see `yearHolds`).
    const year = yearOfFace.get(f.id)!;
    const far = year !== null && !nearExamples(year);
    if (far && !keptYears.has(year)) sides.set(f.id, "unsure");
    else if (m === null || Math.abs(m) < bar || agree === false) sides.set(f.id, "unsure");
    else {
      sides.set(f.id, m > 0 ? "a" : "b");
      if (far) reached++;
    }
    if ((++done & 0xff) === 0) {
      await yieldNow();
      if (stale?.()) throw new SplitSuperseded();
    }
  }
  for (const f of [...aSeeds, ...bSeeds]) margins.set(f.id, margin(f) ?? 0);

  // Two of the person's faces in one photo are two people.
  const byPhoto = new Map<string, FaceRecord[]>();
  for (const f of faces) {
    let list = byPhoto.get(f.uid);
    if (!list) byPhoto.set(f.uid, (list = []));
    list.push(f);
  }
  // Those photos are also the one check the user's examples do not give: of their two faces
  // sorted on their own, how often both went the same way, which a split by who they are never
  // does. Asked before the rule below puts them apart, which would hide it.
  // Asked of every such photo whose two faces were compared, sorted or only leaning, by which
  // way each leans; one is let pass (a mirror, a collage).
  let pairsAsked = 0;
  let pairsTogether = 0;
  let pairPhotos = 0;
  for (const list of byPhoto.values()) {
    if (list.length !== 2) continue;
    pairPhotos++;
    if (list.some((f) => aIds.has(f.id) || bIds.has(f.id) || uncompared.has(f.id))) continue;
    const [mx, my] = list.map((f) => margins.get(f.id)!);
    if (mx === 0 || my === 0) continue;
    pairsAsked++;
    if (mx > 0 === my > 0) pairsTogether++;
  }
  const pairsWrong = pairsAsked >= PAIRS_ASKED ? Math.max(0, pairsTogether - 1) / pairsAsked : null;
  /** Photos with both there are, but too few to tell by: no word on the split either way. */
  const pairsTooFew = pairPhotos > 0 && pairsWrong === null;
  for (const list of byPhoto.values()) {
    if (list.length !== 2) continue;
    const [x, y] = list;
    const sx = sides.get(x.id)!;
    const sy = sides.get(y.id)!;
    if (sx !== sy || (sx !== "a" && sx !== "b")) continue;
    const seedX = aIds.has(x.id) || bIds.has(x.id);
    const seedY = aIds.has(y.id) || bIds.has(y.id);
    if (seedX && seedY) continue;
    if (seedX || seedY) {
      // The example is who the user said; the other face in the photo is the other person.
      sides.set((seedX ? y : x).id, sx === "a" ? "b" : "a");
      continue;
    }
    // Neither is an example: the one leaning harder that way keeps the side, the other is unsure
    // rather than forced to the other side against its own margin.
    const mx = margins.get(x.id)!;
    const my = margins.get(y.id)!;
    const keep = sx === "a" ? (mx >= my ? x : y) : mx <= my ? x : y;
    sides.set((keep === x ? y : x).id, "unsure");
  }

  // How far to trust it: each example left out and sorted by the other examples alone, on
  // each side; and the share of the other faces that went to a side at all.
  const check = (seeds: FaceRecord[], side: "a" | "b") => {
    const own = side === "a" ? aSeedSide : bSeedSide;
    const other = side === "a" ? bSeedSide : aSeedSide;
    const ownSorted = side === "a" ? sidesNow.a : sidesNow.b;
    const otherSorted = side === "a" ? sidesNow.b : sidesNow.a;
    let right = 0;
    let tried = 0;
    // An example alone on its side has nothing left to be sorted against.
    if (seeds.length < 2) return { right, tried };
    for (const f of seeds.slice(0, CHECK_POOL)) {
      const year = yearOfFace.get(f.id)!;
      const without = own.copy();
      without.add(f.embedding, year, -EXAMPLE_WEIGHT);
      // Against the other examples near its year; with none of its side left there, against the
      // faces sorted there without it; with neither, not tried: the whole sides would ask its
      // age rather than who it is.
      let toward = towardAt(without, other, year);
      if (!toward && year !== null) {
        const sortedWithout = ownSorted.copy();
        sortedWithout.add(f.embedding, year, -EXAMPLE_WEIGHT);
        toward = towardAt(sortedWithout, otherSorted, year);
      }
      if (!toward) continue;
      tried++;
      if (dot(f.embedding, toward[0]) > dot(f.embedding, toward[1])) right++;
    }
    return { right, tried };
  };
  const checkA = check(aSeeds, "a");
  const checkB = check(bSeeds, "b");
  const right = checkA.right + checkB.right;
  const tried = checkA.tried + checkB.tried;

  const counts: Record<SplitSide, number> = { a: 0, b: 0, unsure: 0 };
  for (const s of sides.values()) counts[s]++;
  const sorted = rest.filter((f) => sides.get(f.id) !== "unsure").length;
  // Of the faces in reach: those in years too far from the examples wait for examples there,
  // and say nothing of how well the two can be told apart.
  const inReach = rest.filter((f) => {
    const year = yearOfFace.get(f.id)!;
    return year === null || fromExamples(year) <= REACH;
  });
  const clearShare = inReach.length
    ? inReach.filter((f) => sides.get(f.id) !== "unsure").length / inReach.length
    : rest.length
      ? 0
      : 1;
  const waiting = [...new Set(rest.map((f) => yearOfFace.get(f.id)!).filter((y): y is number => y !== null && fromExamples(y) > REACH))].sort(
    (x, y) => y - x,
  );
  // Judged by the weaker side: a side whose examples do not hold together is not a person.
  const accuracy = Math.min(checkA.right / Math.max(1, checkA.tried), checkB.right / Math.max(1, checkB.tried));
  // Most faces sorted far from any example: the examples' check does not reach them, so at
  // best "probably", and a look at the years far from the examples is asked for.
  const mostlyReached = sorted > 0 && reached * 2 > sorted;
  const verdict: SplitPlan["verdict"] =
    checkA.tried < 2 || checkB.tried < 2
      ? "few"
      : accuracy >= 0.95 &&
          clearShare >= 0.75 &&
          !mostlyReached &&
          (examplesNearest === null || examplesHold) &&
          (pairsWrong === null ? !pairsTooFew : pairsWrong <= PAIRS_WRONG_OK)
        ? "reliable"
        : accuracy < 0.85 ||
            clearShare < 0.5 ||
            (examplesNearest !== null && examplesNearest < EXAMPLES_NEAREST_LOW) ||
            (pairsWrong !== null && pairsWrong > PAIRS_WRONG_BAD)
          ? "unreliable"
          : "weak";

  const ofSide = (side: SplitSide) =>
    rest
      .filter((f) => sides.get(f.id) === side)
      .sort((x, y) => Math.abs(margins.get(x.id)!) - Math.abs(margins.get(y.id)!));
  // The unsure ones the newest first: the years the two differ most to the eye, whose answers
  // then carry to the years either side.
  // In reach first, then the years waiting for examples (an answer there is one), newest first.
  const far = (f: FaceRecord) => {
    const year = yearOfFace.get(f.id)!;
    return year !== null && fromExamples(year) > REACH;
  };
  const unsure = ofSide("unsure")
    .sort(
      (x, y) =>
        Number(far(x)) - Number(far(y)) ||
        (yearOfFace.get(y.id) ?? -Infinity) - (yearOfFace.get(x.id) ?? -Infinity) ||
        Number(uncompared.has(x.id)) - Number(uncompared.has(y.id)),
    )
    .slice(0, UNSURE_LISTED)
    .map((f) => {
      const m = margins.get(f.id)!;
      const lean = uncompared.has(f.id) ? "none" : Math.abs(m) < MARGIN / 2 ? "even" : m > 0 ? "a" : "b";
      return { ...view(f, times), lean: lean as "a" | "b" | "even" | "none" };
    });
  const years = new Map<number | null, { year: number | null; a: number; b: number; unsure: number }>();
  for (const f of faces) {
    const year = yearOfFace.get(f.id)!;
    let row = years.get(year);
    if (!row) years.set(year, (row = { year, a: 0, b: 0, unsure: 0 }));
    row[sides.get(f.id)!]++;
  }
  const byYear = [...years.values()].sort((x, y) => (y.year ?? -Infinity) - (x.year ?? -Infinity));
  const plan: SplitPlan = {
    counts,
    checked: { right, tried },
    clearShare,
    verdict,
    leastSureA: ofSide("a").slice(0, 12).map((f) => view(f, times)),
    leastSureB: ofSide("b").slice(0, 12).map((f) => view(f, times)),
    unsure,
    byYear,
    waiting,
  };
  return { sides, margins, faces, plan };
}

/** What a split changed, kept so it can be taken back. */
type SplitUndo = {
  personId: string;
  /** The other person, and whether the split made them. */
  otherId: string;
  otherName: string;
  createdId: string | null;
  /** Each face the split changed: as it was, and as the split left it. */
  faces: Record<
    string,
    {
      was: { assign?: string; confirmed?: string; blocked?: string[]; conflict?: Conflict; from?: string };
      left: { assign?: string; confirmed?: string };
    }
  >;
  /** Each "not this person" mark the split set or took away, and what was held for it before. */
  marks: { faceId: string; key: string; name: string; ref: string; before: Curation | undefined }[];
};

const undos = new Map<string, SplitUndo>();

/**
 * Splits the person: its faces sorted as `planSplit` sorts them, B's moved to the person of
 * that name (made if there is none), and the result kept as confirmations and marks.
 */
export async function applySplit(
  store: FaceStore,
  personId: string,
  otherName: string,
  picked: { a: string[]; b: string[] },
  at = Date.now(),
  times: PhotoTimes = NO_TIMES,
): Promise<SplitApplied> {
  const { sides, faces } = await label(store, personId, otherName, picked, times);
  const p = store.people;
  const person = personOf(p, personId);
  const name = otherName.trim().slice(0, 100);
  const fold = foldPersonName(name);
  let other: Person | undefined = p.people.find((x) => x.id !== personId && x.name && foldPersonName(x.name) === fold);
  let createdId: string | null = null;
  if (!other) {
    other = { id: mint(p), name, isOther: false };
    p.people.push(other);
    p.namedAt[fold] = at;
    createdId = other.id;
  }
  const undo: SplitUndo = { personId, otherId: other.id, otherName: other.name!, createdId, faces: {}, marks: [] };
  const remember = (faceId: string) => {
    if (undo.faces[faceId]) return;
    undo.faces[faceId] = {
      was: {
        assign: p.assign[faceId],
        confirmed: p.confirmed[faceId],
        blocked: p.blocked[faceId] ? [...p.blocked[faceId]] : undefined,
        conflict: p.conflicts[faceId],
        from: p.confirmedFrom[faceId],
      },
      left: {},
    };
  };
  const mark = (faceId: string, markName: string, removed: boolean) => {
    const ref = portableFaceId(faceId);
    const key = curationKey(2, markName, ref);
    undo.marks.push({ faceId, key, name: markName, ref, before: p.curation[key] ? { ...p.curation[key] } : undefined });
    noteCuration(p, 2, markName, [ref], removed, at);
  };
  const block = (faceId: string, blockName: string) => {
    const list = p.blocked[faceId] ?? [];
    if (!list.some((n) => foldPersonName(n) === foldPersonName(blockName))) p.blocked[faceId] = [...list, blockName];
    mark(faceId, blockName, false);
  };
  const unblock = (faceId: string, blockName: string) => {
    const list = p.blocked[faceId];
    if (!list?.some((n) => foldPersonName(n) === foldPersonName(blockName))) return;
    const rest = list.filter((n) => foldPersonName(n) !== foldPersonName(blockName));
    if (rest.length) p.blocked[faceId] = rest;
    else delete p.blocked[faceId];
    mark(faceId, blockName, true);
  };
  let stayed = 0;
  let moved = 0;
  let unsure = 0;
  for (const f of faces) {
    const side = sides.get(f.id);
    // Sorting yields to the rest of the sidecar, and a scan or a hand may have moved a face
    // meanwhile: only the faces still in the person are split.
    if (!side || p.assign[f.id] !== person.id) continue;
    if (side === "unsure") {
      // Not guessed, and left exactly as it was: with its confirmation, if it had one.
      unsure++;
      continue;
    }
    remember(f.id);
    if (side === "a") {
      p.assign[f.id] = person.id;
      if (person.name) p.confirmed[f.id] = person.name;
      stayed++;
    } else {
      p.assign[f.id] = other.id;
      p.confirmed[f.id] = other.name!;
      unblock(f.id, other.name!);
      if (person.name) block(f.id, person.name);
      moved++;
    }
    delete p.conflicts[f.id];
    delete p.confirmedFrom[f.id];
    undo.faces[f.id].left = { assign: p.assign[f.id], confirmed: p.confirmed[f.id] };
  }
  store.markPeople();
  store.edits++;
  const token = randomBytes(9).toString("base64url");
  undos.set(token, undo);
  while (undos.size > UNDO_KEPT) undos.delete(undos.keys().next().value!);
  return { stayed, moved, unsure, undo: token };
}

export type SplitUndone = { ok: boolean; restored: number; skipped: number };

/**
 * Takes a split back, as long as the app has not been closed since. A face changed after the
 * split (moved by hand, or by a regroup to a person that is no longer there) is left as it is
 * now. A face moved to the other person is marked as not them, with this time, so a device
 * that took the split in moves it back too.
 */
export function undoSplit(store: FaceStore, token: string, at = Date.now()): SplitUndone {
  const undo = undos.get(token);
  if (!undo) return { ok: false, restored: 0, skipped: 0 };
  undos.delete(token);
  const p = store.people;
  const ids = new Set(p.people.map((x) => x.id));
  const restored = new Set<string>();
  let skipped = 0;
  for (const [faceId, { was, left }] of Object.entries(undo.faces)) {
    const now = { assign: p.assign[faceId], confirmed: p.confirmed[faceId] };
    if (now.assign !== left.assign || now.confirmed !== left.confirmed || !was.assign || !ids.has(was.assign)) {
      skipped++;
      continue;
    }
    p.assign[faceId] = was.assign;
    if (was.confirmed !== undefined) p.confirmed[faceId] = was.confirmed;
    else delete p.confirmed[faceId];
    if (was.blocked) p.blocked[faceId] = [...was.blocked];
    else delete p.blocked[faceId];
    if (was.conflict) p.conflicts[faceId] = was.conflict;
    if (was.from) p.confirmedFrom[faceId] = was.from;
    restored.add(faceId);
  }
  // A mark held before the split goes back to what it was, with this time so it outranks the
  // split's on a device that took the split in. One the split set is taken back, likewise.
  for (const m of [...undo.marks].reverse()) {
    if (!restored.has(m.faceId)) continue;
    if (m.before) p.curation[m.key] = { ...m.before, at };
    else noteCuration(p, 2, m.name, [m.ref], true, at);
  }
  // Moved back off the other person: said so, with this time, for the other devices.
  for (const faceId of restored) {
    if (undo.faces[faceId].left.assign !== undo.otherId) continue;
    const list = p.blocked[faceId] ?? [];
    if (!list.some((n) => foldPersonName(n) === foldPersonName(undo.otherName))) p.blocked[faceId] = [...list, undo.otherName];
    noteCuration(p, 2, undo.otherName, [portableFaceId(faceId)], false, at);
  }
  if (undo.createdId && !Object.values(p.assign).includes(undo.createdId)) {
    p.people = p.people.filter((x) => x.id !== undo.createdId);
    delete p.namedAt[foldPersonName(undo.otherName)];
  }
  store.markPeople();
  store.edits++;
  return { ok: true, restored: restored.size, skipped };
}
