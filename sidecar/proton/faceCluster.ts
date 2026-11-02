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

class ExemplarCluster {
  anchors: Float32Array[] = [];
  scores: number[] = [];
  constructor(first: Float32Array, score: number) {
    this.anchors.push(first);
    this.scores.push(score);
  }
  similarityTo(e: Float32Array): number {
    let best = -Infinity;
    for (const a of this.anchors) best = Math.max(best, dot(e, a));
    return best;
  }
  add(e: Float32Array, score: number): void {
    if (this.anchors.length < EXEMPLARS) {
      this.anchors.push(e);
      this.scores.push(score);
      return;
    }
    let weakest = 0;
    for (let i = 1; i < this.scores.length; i++) if (this.scores[i] < this.scores[weakest]) weakest = i;
    if (score > this.scores[weakest]) {
      this.anchors[weakest] = e;
      this.scores[weakest] = score;
    }
  }
}

/**
 * Groups faces into identities, clearest first: a confident face joins at the threshold, a
 * weak one at the threshold plus the strict delta, and only a confident or confirmed face may
 * open a group. Groups whose mean directions meet the merge floor are then folded together.
 * Returns the group per face in input order, -1 for a face left unassigned.
 */
export function clusterFaces(samples: FaceSample[], threshold = CLUSTER_THRESHOLD, mergeThreshold = MERGE_THRESHOLD): Int32Array {
  const order = samples.map((_, i) => i).sort((a, b) => samples[b].score - samples[a].score);
  const clusters: ExemplarCluster[] = [];
  const assignment = new Int32Array(samples.length).fill(-1);
  for (const index of order) {
    const s = samples[index];
    const need = s.confident ? threshold : threshold + STRICT_DELTA;
    let best = -1;
    let bestSim = -Infinity;
    for (let c = 0; c < clusters.length; c++) {
      const sim = clusters[c].similarityTo(s.embedding);
      if (sim > bestSim) {
        bestSim = sim;
        best = c;
      }
    }
    if (best >= 0 && bestSim >= need) {
      clusters[best].add(s.embedding, s.score);
      assignment[index] = best;
    } else if ((s.confident || s.confirmed) && clusters.length < MAX_CLUSTERS) {
      assignment[index] = clusters.length;
      clusters.push(new ExemplarCluster(s.embedding, s.score));
    }
  }
  return mergeSimilar(assignment, samples, mergeThreshold);
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
  let next = Math.max(-1, ...result, ...names.keys()) + 1;
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
  const anchors = new Map<number, Float32Array[]>();
  for (const c of byName.values()) {
    const members = [...result.keys()].filter((i) => result[i] === c);
    anchors.set(c, members.sort((a, b) => scores[b] - scores[a]).slice(0, EXEMPLARS).map((i) => embeddings[i]));
  }
  const ids = [...anchors.keys()].sort((a, b) => a - b);
  for (let i = 0; i < result.length; i++) {
    if (confirmed[i] || names.has(result[i])) continue;
    let best = -1;
    let bestSim = -Infinity;
    for (const c of ids) {
      if (blocked[i]?.has(names.get(c)!)) continue;
      for (const a of anchors.get(c)!) {
        const sim = dot(embeddings[i], a);
        if (sim > bestSim) {
          bestSim = sim;
          best = c;
        }
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
