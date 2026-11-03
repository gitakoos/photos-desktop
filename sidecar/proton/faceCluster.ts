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

// Grouping faces into people, and the quality gate that decides which faces may lead a group:
// the Android app's FaceClustering and FaceQuality, rule for rule and threshold for threshold,
// so a library grouped here reads the same as on the phone. Pure, so every rule is tested
// without a model.

/** Cosine floor for two confident faces to be the same person (GhostFaceNet, ArcFace-trained). */
export const CLUSTER_THRESHOLD = 0.58;
/** Extra cosine a weak face (low score, blurred, turned) must clear to join. */
export const STRICT_DELTA = 0.08;
/** Two groups whose mean directions are this close are one person split in two. */
export const MERGE_THRESHOLD = 0.58;
/** How close an unnamed group must sit to a named person to be offered as "Is this <name>?". */
export const SUGGEST_THRESHOLD = 0.45;
/** The face pipeline generation the phone writes; faces under another do not compare. */
export const FACE_MODEL_VERSION = 7;
/** The clustering parameters' generation, written into every face copy. */
export const CLUSTER_PARAMS_VERSION = 1;
export const EMBEDDING_DIM = 512;
/** The clearest faces a group compares a newcomer against. */
const EXEMPLARS = 5;
const MAX_CLUSTERS = 2000;
const MERGE_MAX_CLUSTERS = 400;
/** Photos an unnamed group must span before it shows as a person to name. */
export const MIN_FACES_TO_SHOW = 2;

// ---- Quality ----

export const MIN_CONFIDENT_SCORE = 0.62;
export const MIN_CONFIDENT_BLUR = 12;
export const MAX_CONFIDENT_SIDEWAYS = 0.18;
/** Below this sharpness a crop is not stored at all. */
export const MIN_SHARPNESS = 2;

/** Variance of the 4-neighbour Laplacian over the inner pixels: low for a blurred crop. */
export function laplacianVariance(gray: ArrayLike<number>, width: number, height: number): number {
  if (width < 3 || height < 3 || gray.length < width * height) return 0;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const lap = gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

/** Sharpness of an RGB crop, through the phone's integer grey (77, 150, 29 over 256). */
export function rgbSharpness(rgb: ArrayLike<number>, width: number, height: number): number {
  const gray = new Int32Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = (rgb[i * 3] * 77 + rgb[i * 3 + 1] * 150 + rgb[i * 3 + 2] * 29) >> 8;
  }
  return laplacianVariance(gray, width, height);
}

/** How far a face is turned, from its five points: 0 frontal, toward 1 in profile. */
export function sideways(points: ArrayLike<number>): number | null {
  if (points.length < 10) return null;
  const p = (i: number) => [points[2 * i], points[2 * i + 1]];
  const [le, re, nose, lm, rm] = [p(0), p(1), p(2), p(3), p(4)];
  const d = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const asym = (a: number[], b: number[]) => {
    const da = d(a, nose);
    const db = d(b, nose);
    return da + db <= 0 ? 0 : Math.abs(da - db) / (da + db);
  };
  return (asym(le, re) + asym(lm, rm)) / 2;
}

/** Whether a face is clear, sharp and frontal enough to lead a group. */
export function isConfident(score: number, blur: number | null, turn: number | null): boolean {
  if (score < MIN_CONFIDENT_SCORE) return false;
  if (blur !== null && blur < MIN_CONFIDENT_BLUR) return false;
  if (turn !== null && turn > MAX_CONFIDENT_SIDEWAYS) return false;
  return true;
}

// ---- Vectors ----

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  const inv = n > 0 ? 1 / Math.sqrt(n) : 0;
  return Float32Array.from(v, (x) => x * inv);
}

/** The unit mean direction of some embeddings. */
export function centroid(vectors: Float32Array[]): Float32Array {
  const sum = new Float32Array(vectors[0]?.length ?? EMBEDDING_DIM);
  for (const v of vectors) for (let i = 0; i < sum.length; i++) sum[i] += v[i];
  return normalize(sum);
}

// ---- Grouping ----

export type FaceSample = { embedding: Float32Array; score: number; confident: boolean; confirmed: boolean };

/** What the base pass did with each face: its group (-1 for none) and whether it opened it. */
export type BasePass = { assignment: Int32Array; opened: Uint8Array };

/**
 * The base pass, clearest face first: a confident face joins the group whose best anchor it
 * matches at the threshold, a weak one at the threshold plus the strict delta, and only a
 * confident or confirmed face may open a group. Each group keeps its five clearest faces as
 * anchors. The anchors sit in one flat array and every comparison is one tight loop, which is
 * what makes a library of thousands of faces group in a fraction of a second.
 */
export function basePass(samples: FaceSample[], threshold = CLUSTER_THRESHOLD): BasePass {
  const dim = samples[0]?.embedding.length ?? EMBEDDING_DIM;
  const order = samples.map((_, i) => i).sort((a, b) => samples[b].score - samples[a].score);
  const assignment = new Int32Array(samples.length).fill(-1);
  const opened = new Uint8Array(samples.length);
  let anchors = new Float32Array(Math.max(1, Math.min(samples.length, MAX_CLUSTERS)) * EXEMPLARS * dim);
  const anchorScores: number[] = [];
  const counts: number[] = [];
  let clusters = 0;
  for (const index of order) {
    const s = samples[index];
    const e = s.embedding;
    const need = s.confident ? threshold : threshold + STRICT_DELTA;
    let best = -1;
    let bestSim = -Infinity;
    for (let c = 0; c < clusters; c++) {
      const base = c * EXEMPLARS * dim;
      for (let a = 0; a < counts[c]; a++) {
        const at = base + a * dim;
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
        let i = 0;
        for (; i + 3 < dim; i += 4) {
          s0 += e[i] * anchors[at + i];
          s1 += e[i + 1] * anchors[at + i + 1];
          s2 += e[i + 2] * anchors[at + i + 2];
          s3 += e[i + 3] * anchors[at + i + 3];
        }
        for (; i < dim; i++) s0 += e[i] * anchors[at + i];
        const sim = s0 + s1 + s2 + s3;
        if (sim > bestSim) {
          bestSim = sim;
          best = c;
        }
      }
    }
    if (best >= 0 && bestSim >= need) {
      assignment[index] = best;
      // A full group swaps its weakest anchor for a clearer newcomer.
      const scores = anchorScores.slice(best * EXEMPLARS, best * EXEMPLARS + counts[best]);
      let slot = counts[best];
      if (slot >= EXEMPLARS) {
        let weakest = 0;
        for (let i = 1; i < EXEMPLARS; i++) if (scores[i] < scores[weakest]) weakest = i;
        slot = s.score > scores[weakest] ? weakest : -1;
      } else {
        counts[best]++;
      }
      if (slot >= 0) {
        anchors.set(e, (best * EXEMPLARS + slot) * dim);
        anchorScores[best * EXEMPLARS + slot] = s.score;
      }
    } else if ((s.confident || s.confirmed) && clusters < MAX_CLUSTERS) {
      if ((clusters + 1) * EXEMPLARS * dim > anchors.length) {
        const grown = new Float32Array(Math.min(MAX_CLUSTERS, clusters * 2 + 1) * EXEMPLARS * dim);
        grown.set(anchors);
        anchors = grown;
      }
      assignment[index] = clusters;
      opened[index] = 1;
      anchors.set(e, clusters * EXEMPLARS * dim);
      anchorScores[clusters * EXEMPLARS] = s.score;
      counts.push(1);
      clusters++;
    }
  }
  return { assignment, opened };
}

/**
 * Whether a base pass made over `before` holds for `after` too, without running it again: the
 * same faces in the same order, and any face whose right to open a group changed (a weak face
 * confirmed by hand, or no longer) neither opened a group nor was left out. Such a face joined
 * a group that existed before it was reached, and every face before it is unchanged, so it
 * joins that group again; what follows it then sees the same groups. This is what lets a "yes"
 * to a suggestion, which confirms faces already grouped, skip the whole pass.
 */
export function baseStillHolds(before: FaceSample[], pass: BasePass, after: FaceSample[]): boolean {
  if (before.length !== after.length) return false;
  for (let i = 0; i < after.length; i++) {
    const a = before[i];
    const b = after[i];
    if (a.embedding !== b.embedding || a.score !== b.score || a.confident !== b.confident) return false;
    const seedBefore = a.confident || a.confirmed;
    const seedAfter = b.confident || b.confirmed;
    if (seedBefore !== seedAfter && (pass.opened[i] || pass.assignment[i] < 0)) return false;
  }
  return true;
}

/**
 * Groups faces into identities: the base pass, then groups whose mean directions meet the
 * merge floor are folded together. Returns the group per face in input order, -1 for a face
 * left unassigned.
 */
export function clusterFaces(samples: FaceSample[], threshold = CLUSTER_THRESHOLD, mergeThreshold = MERGE_THRESHOLD): Int32Array {
  return mergeSimilar(basePass(samples, threshold).assignment, samples, mergeThreshold);
}

/** The merge pass alone, over a base pass already made. */
export function mergePass(pass: BasePass, samples: FaceSample[], mergeThreshold = MERGE_THRESHOLD): Int32Array {
  return mergeSimilar(pass.assignment, samples, mergeThreshold);
}

function mergeSimilar(assignment: Int32Array, samples: FaceSample[], mergeThreshold: number): Int32Array {
  const result = assignment.slice();
  if (new Set([...result].filter((v) => v >= 0)).size <= MERGE_MAX_CLUSTERS) {
    for (;;) {
      const members = new Map<number, number[]>();
      result.forEach((v, i) => {
        if (v >= 0) (members.get(v) ?? members.set(v, []).get(v)!).push(i);
      });
      const ids = [...members.keys()];
      if (ids.length < 2) break;
      const means = new Map(ids.map((id) => [id, centroid(members.get(id)!.map((i) => samples[i].embedding))]));
      let into = -1;
      let from = -1;
      let bestSim = mergeThreshold;
      for (let a = 0; a < ids.length; a++) {
        for (let b = a + 1; b < ids.length; b++) {
          const sim = dot(means.get(ids[a])!, means.get(ids[b])!);
          if (sim >= bestSim) {
            bestSim = sim;
            into = ids[a];
            from = ids[b];
          }
        }
      }
      if (from < 0) break;
      for (let i = 0; i < result.length; i++) if (result[i] === from) result[i] = into;
    }
  }
  const remap = new Map<number, number>();
  return result.map((v) => (v < 0 ? -1 : (remap.get(v) ?? remap.set(v, remap.size).get(v)!)));
}

/**
 * Gives each name the group holding the most of that person's faces, counting both the name a
 * face carried before (`carried`) and the name it was confirmed as, confirmations breaking
 * ties. The largest person picks first and each group is claimed once.
 */
export function resolveClusterNames(
  carried: (string | null)[],
  confirmed: (string | null)[],
  assignment: Int32Array,
): Map<number, string> {
  const evidence = new Map<string, Map<number, { total: number; confirmed: number }>>();
  for (let i = 0; i < assignment.length; i++) {
    if (assignment[i] < 0) continue;
    const name = confirmed[i] ?? carried[i];
    if (!name) continue;
    const byCluster = evidence.get(name) ?? evidence.set(name, new Map()).get(name)!;
    const ev = byCluster.get(assignment[i]) ?? byCluster.set(assignment[i], { total: 0, confirmed: 0 }).get(assignment[i])!;
    ev.total++;
    if (confirmed[i]) ev.confirmed++;
  }
  const total = (m: Map<number, { total: number }>) => [...m.values()].reduce((s, e) => s + e.total, 0);
  const names = [...evidence.entries()].sort((a, b) => total(b[1]) - total(a[1]) || compare(a[0], b[0]));
  const out = new Map<number, string>();
  const claimed = new Set<number>();
  for (const [name, byCluster] of names) {
    const best = [...byCluster.entries()]
      .filter(([c]) => !claimed.has(c))
      .sort((a, b) => b[1].total - a[1].total || b[1].confirmed - a[1].confirmed || a[0] - b[0])[0];
    if (!best) continue;
    out.set(best[0], name);
    claimed.add(best[0]);
  }
  return out;
}

/** A confirmed name that won no group gets one of its own, holding the faces confirmed as it. */
export function splitOutUnclaimedNames(
  confirmed: (string | null)[],
  assignment: Int32Array,
  names: Map<number, string>,
): { assignment: Int32Array; names: Map<number, string> } {
  const result = assignment.slice();
  const claimed = new Set(names.values());
  const unclaimed = [...new Set(confirmed.filter((n): n is string => !!n && !claimed.has(n)))].sort(compare);
  if (unclaimed.length === 0) return { assignment: result, names };
  const out = new Map(names);
  let next = -1;
  for (const v of result) if (v > next) next = v;
  for (const k of names.keys()) if (k > next) next = k;
  next++;
  const byName = new Map<string, number>();
  for (const name of unclaimed) {
    byName.set(name, next);
    out.set(next++, name);
  }
  for (let i = 0; i < result.length; i++) {
    const target = confirmed[i] ? byName.get(confirmed[i]!) : undefined;
    if (target !== undefined) result[i] = target;
  }
  return { assignment: result, names: out };
}

/**
 * Teaches from the confirmations: each confirmed face moves into its named group, then a face
 * in an unnamed group is pulled into the named group whose clearest faces it best matches when
 * that clears `threshold`, never into a name it was marked as not being.
 */
export function attractToNamed(
  embeddings: Float32Array[],
  scores: number[],
  assignment: Int32Array,
  names: Map<number, string>,
  confirmed: (string | null)[],
  blocked: Set<string>[],
  threshold = CLUSTER_THRESHOLD,
): Int32Array {
  const result = assignment.slice();
  const byName = new Map<string, number>();
  for (const [c, n] of names) byName.set(n, c);
  if (byName.size === 0) return result;
  for (let i = 0; i < result.length; i++) {
    const target = confirmed[i] ? byName.get(confirmed[i]!) : undefined;
    if (target !== undefined) result[i] = target;
  }
  // Each named group's clearest faces, gathered in one walk and laid out in one flat array, so
  // every face is compared in one tight loop: the same rule, a fraction of the time.
  const membersOf = new Map<number, number[]>();
  for (const c of byName.values()) membersOf.set(c, []);
  for (let i = 0; i < result.length; i++) membersOf.get(result[i])?.push(i);
  const ids = [...membersOf.keys()].sort((a, b) => a - b);
  const dim = embeddings[0]?.length ?? EMBEDDING_DIM;
  const flat = new Float32Array(Math.max(1, ids.length * EXEMPLARS) * dim);
  const groupOf: number[] = [];
  for (const c of ids) {
    const top = membersOf.get(c)!.sort((a, b) => scores[b] - scores[a]).slice(0, EXEMPLARS);
    for (const i of top) {
      flat.set(embeddings[i], groupOf.length * dim);
      groupOf.push(c);
    }
  }
  const nameOfGroup = new Map(ids.map((c) => [c, names.get(c)!]));
  for (let i = 0; i < result.length; i++) {
    if (confirmed[i] || names.has(result[i])) continue;
    const e = embeddings[i];
    const no = blocked[i];
    let best = -1;
    let bestSim = -Infinity;
    for (let a = 0; a < groupOf.length; a++) {
      const c = groupOf[a];
      if (no?.size && no.has(nameOfGroup.get(c)!)) continue;
      const at = a * dim;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      let k = 0;
      for (; k + 3 < dim; k += 4) {
        s0 += e[k] * flat[at + k];
        s1 += e[k + 1] * flat[at + k + 1];
        s2 += e[k + 2] * flat[at + k + 2];
        s3 += e[k + 3] * flat[at + k + 3];
      }
      for (; k < dim; k++) s0 += e[k] * flat[at + k];
      const sim = s0 + s1 + s2 + s3;
      if (sim > bestSim) {
        bestSim = sim;
        best = c;
      }
    }
    if (best >= 0 && bestSim >= threshold) result[i] = best;
  }
  return result;
}

/** For each unnamed group, the named person its mean direction is closest to, when that clears
 *  `threshold`: best matches first. */
export function suggestMatches(
  named: { name: string; centroid: Float32Array }[],
  unnamed: { id: string; centroid: Float32Array }[],
  threshold = SUGGEST_THRESHOLD,
): { name: string; id: string; score: number }[] {
  const out: { name: string; id: string; score: number }[] = [];
  for (const u of unnamed) {
    let best: string | null = null;
    let bestSim = -Infinity;
    for (const n of named) {
      const sim = dot(u.centroid, n.centroid);
      if (sim > bestSim) {
        bestSim = sim;
        best = n.name;
      }
    }
    if (best !== null && bestSim >= threshold) out.push({ name: best, id: u.id, score: bestSim });
  }
  return out.sort((a, b) => b.score - a.score || compare(a.id, b.id));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
