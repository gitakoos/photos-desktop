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

// Grouping faces into people, by the Android app's rules and with its numbers, so a library
// grouped here and on the phone comes out alike. The embeddings are unit length, so the cosine
// of two is their dot product.
//
// A group is held by up to FACE_CLUSTER_EXEMPLARS anchor faces, its clearest, and a face joins
// by its best match to any of them. A weak face (low score, blurred, turned) must clear a
// stricter bar, so it can join an obvious match but never bridge two people. A merge pass then
// folds together groups whose mean directions are the same person split in two.

/** Two confident faces at least this close are the same person. */
export const FACE_CLUSTER_THRESHOLD = 0.58;
/** What a weak face must clear on top of that. */
export const FACE_CLUSTER_STRICT_DELTA = 0.08;
/** Two groups whose mean directions are this close are one person. */
export const FACE_CLUSTER_MERGE_THRESHOLD = 0.58;
/** How close an unnamed group must be to a named person to be offered as that person. */
export const FACE_SUGGEST_THRESHOLD = 0.45;
/** Components of an embedding. */
export const FACE_EMBEDDING_DIM = 512;
/** Anchor faces kept per group. */
export const FACE_CLUSTER_EXEMPLARS = 5;
/** Past this many groups a face that matches none is left over rather than opening another. */
export const MAX_CLUSTERS = 2000;
/** Above this many groups the merge pass, cubic in their number, is skipped. */
export const MERGE_MAX_CLUSTERS = 400;
/** Photos a group must appear in before it is shown as someone to name. */
export const MIN_FACES_TO_SHOW_PERSON = 2;

export type FaceSample = {
  embedding: Float32Array;
  score: number;
  /** Clear enough to anchor a group (see `isConfidentFace`). */
  confident: boolean;
  /** Confirmed by hand as a named person. */
  confirmed: boolean;
};

export function dot(a: Float32Array, b: Float32Array): number {
  // Four sums side by side: the grouping spends nearly all its time here.
  const n = a.length;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let i = 0;
  for (; i + 3 < n; i += 4) {
    s0 += a[i] * b[i];
    s1 += a[i + 1] * b[i + 1];
    s2 += a[i + 2] * b[i + 2];
    s3 += a[i + 3] * b[i + 3];
  }
  for (; i < n; i++) s0 += a[i] * b[i];
  return s0 + s1 + s2 + s3;
}

/** The unit-length mean of `vectors`, a group's direction; all zeros when there is none. */
export function meanDirection(vectors: Float32Array[], dim = FACE_EMBEDDING_DIM): Float32Array {
  const sum = new Float32Array(vectors[0]?.length ?? dim);
  for (const v of vectors) for (let i = 0; i < sum.length; i++) sum[i] += v[i];
  let normSq = 0;
  for (let i = 0; i < sum.length; i++) normSq += sum[i] * sum[i];
  const inv = normSq > 0 ? 1 / Math.sqrt(normSq) : 0;
  for (let i = 0; i < sum.length; i++) sum[i] *= inv;
  return sum;
}

class ExemplarCluster {
  anchors: Float32Array[];
  private scores: number[];

  constructor(first: Float32Array, score: number) {
    this.anchors = [first];
    this.scores = [score];
  }

  similarityTo(embedding: Float32Array): number {
    let best = -Infinity;
    for (const anchor of this.anchors) {
      const s = dot(embedding, anchor);
      if (s > best) best = s;
    }
    return best;
  }

  add(embedding: Float32Array, score: number): void {
    if (this.anchors.length < FACE_CLUSTER_EXEMPLARS) {
      this.anchors.push(embedding);
      this.scores.push(score);
      return;
    }
    let weakest = 0;
    for (let i = 1; i < this.scores.length; i++) if (this.scores[i] < this.scores[weakest]) weakest = i;
    if (score > this.scores[weakest]) {
      this.anchors[weakest] = embedding;
      this.scores[weakest] = score;
    }
  }
}

/**
 * The group of each sample, or -1 for one left over, in input order. Faces are taken clearest
 * first; one that matches nothing opens a group only when it is confident or confirmed, so
 * stray detections do not seed one. `checkActive` is awaited every 64 faces and on every merge
 * round: it gives the rest of the process its turn on a large library, and may throw to stop.
 */
export async function clusterFaces(
  samples: FaceSample[],
  threshold = FACE_CLUSTER_THRESHOLD,
  mergeThreshold = FACE_CLUSTER_MERGE_THRESHOLD,
  checkActive: () => void | Promise<void> = () => {},
): Promise<Int32Array> {
  const order = samples.map((_, i) => i).sort((a, b) => samples[b].score - samples[a].score || a - b);
  const clusters: ExemplarCluster[] = [];
  const assignment = new Int32Array(samples.length).fill(-1);
  let processed = 0;
  for (const index of order) {
    if ((processed++ & 0x3f) === 0) await checkActive();
    const sample = samples[index];
    const need = sample.confident ? threshold : threshold + FACE_CLUSTER_STRICT_DELTA;
    let bestCluster = -1;
    let bestSimilarity = -Infinity;
    for (let c = 0; c < clusters.length; c++) {
      const similarity = clusters[c].similarityTo(sample.embedding);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestCluster = c;
      }
    }
    if (bestCluster >= 0 && bestSimilarity >= need) {
      clusters[bestCluster].add(sample.embedding, sample.score);
      assignment[index] = bestCluster;
    } else if ((sample.confident || sample.confirmed) && clusters.length < MAX_CLUSTERS) {
      assignment[index] = clusters.length;
      clusters.push(new ExemplarCluster(sample.embedding, sample.score));
    }
  }
  return mergeSimilarClusters(assignment, samples, mergeThreshold, checkActive);
}

/**
 * Repeatedly merges the closest pair of group directions while they are at least
 * `mergeThreshold` alike, recomputing after each, so a chain of near matches cannot fuse unlike
 * people. The leftover (-1) is never merged. Returns the groups renumbered from 0.
 */
async function mergeSimilarClusters(
  assignment: Int32Array,
  samples: FaceSample[],
  mergeThreshold: number,
  checkActive: () => void | Promise<void>,
): Promise<Int32Array> {
  const result = Int32Array.from(assignment);
  if (new Set(Array.from(result).filter((v) => v >= 0)).size > MERGE_MAX_CLUSTERS) return result;
  for (;;) {
    await checkActive();
    const members = new Map<number, number[]>();
    for (let i = 0; i < result.length; i++) {
      if (result[i] < 0) continue;
      let list = members.get(result[i]);
      if (!list) members.set(result[i], (list = []));
      list.push(i);
    }
    const ids = [...members.keys()];
    if (ids.length < 2) break;
    const centroids = new Map<number, Float32Array>();
    for (const id of ids) centroids.set(id, meanDirection(members.get(id)!.map((m) => samples[m].embedding)));
    let into = -1;
    let from = -1;
    let best = mergeThreshold;
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const s = dot(centroids.get(ids[a])!, centroids.get(ids[b])!);
        if (s >= best) {
          best = s;
          into = ids[a];
          from = ids[b];
        }
      }
    }
    if (from < 0) break;
    for (let i = 0; i < result.length; i++) if (result[i] === from) result[i] = into;
  }
  const remap = new Map<number, number>();
  for (const v of result) if (v >= 0 && !remap.has(v)) remap.set(v, remap.size);
  return Int32Array.from(result, (v) => (v < 0 ? -1 : remap.get(v)!));
}

/**
 * New faces placed against the people already grouped: each takes its single closest
 * direction when the match clears the bar (stricter for a weak face). The index of that
 * direction per face, or -1.
 */
export function assignIncremental(
  faces: FaceSample[],
  centroids: Float32Array[],
  threshold = FACE_CLUSTER_THRESHOLD,
  strictDelta = FACE_CLUSTER_STRICT_DELTA,
): Int32Array {
  const result = new Int32Array(faces.length).fill(-1);
  if (centroids.length === 0) return result;
  for (let f = 0; f < faces.length; f++) {
    let bestIndex = -1;
    let best = -Infinity;
    for (let c = 0; c < centroids.length; c++) {
      const s = dot(faces[f].embedding, centroids[c]);
      if (s > best) {
        best = s;
        bestIndex = c;
      }
    }
    const need = faces[f].confident ? threshold : threshold + strictDelta;
    if (bestIndex >= 0 && best >= need) result[f] = bestIndex;
  }
  return result;
}

/**
 * Which group each name lands on after a regroup: the one holding most of that person's faces,
 * counting the faces they carried before and those the user confirmed. The person with most
 * faces is placed first and a group is claimed once. Group index to name.
 */
export function resolveClusterNames(
  oldPersonPerFace: (string | null)[],
  confirmedPerFace: (string | null)[],
  clusterPerFace: Int32Array,
  names: Map<string, string>,
): Map<number, string> {
  type Evidence = { total: number; confirmed: number };
  const byName = new Map<string, Map<number, Evidence>>();
  for (let i = 0; i < clusterPerFace.length; i++) {
    if (clusterPerFace[i] < 0) continue;
    const confirmed = confirmedPerFace[i];
    const old = oldPersonPerFace[i];
    const name = confirmed ?? (old !== null ? names.get(old) : undefined);
    if (!name) continue;
    let perCluster = byName.get(name);
    if (!perCluster) byName.set(name, (perCluster = new Map()));
    let ev = perCluster.get(clusterPerFace[i]);
    if (!ev) perCluster.set(clusterPerFace[i], (ev = { total: 0, confirmed: 0 }));
    ev.total++;
    if (confirmed !== null) ev.confirmed++;
  }
  const total = (m: Map<number, Evidence>) => [...m.values()].reduce((s, e) => s + e.total, 0);
  const ordered = [...byName.entries()].sort((a, b) => total(b[1]) - total(a[1]) || cmp(a[0], b[0]));
  const out = new Map<number, string>();
  const claimed = new Set<number>();
  for (const [name, perCluster] of ordered) {
    const best = [...perCluster.entries()]
      .filter(([c]) => !claimed.has(c))
      .sort((a, b) => b[1].total - a[1].total || b[1].confirmed - a[1].confirmed || a[0] - b[0])[0];
    if (!best) continue;
    out.set(best[0], name);
    claimed.add(best[0]);
  }
  return out;
}

/**
 * A confirmed name that won no group gets one of its own, made of the faces confirmed for it,
 * so a face moved to a new person keeps that name. The new groups are numbered past every id
 * in use, one per name in name order.
 */
export function splitOutUnclaimedNames(
  confirmedPerFace: (string | null)[],
  clusterPerFace: Int32Array,
  nameForCluster: Map<number, string>,
): { assignment: Int32Array; names: Map<number, string> } {
  const assignment = Int32Array.from(clusterPerFace);
  const claimed = new Set(nameForCluster.values());
  const unclaimed = [...new Set(confirmedPerFace.filter((n): n is string => n !== null && !claimed.has(n)))].sort(cmp);
  const names = new Map(nameForCluster);
  if (unclaimed.length === 0) return { assignment, names };
  let next = 0;
  for (const v of clusterPerFace) if (v >= next) next = v + 1;
  for (const v of nameForCluster.keys()) if (v >= next) next = v + 1;
  const clusterByName = new Map<string, number>();
  for (const name of unclaimed) {
    clusterByName.set(name, next);
    names.set(next, name);
    next++;
  }
  for (let i = 0; i < assignment.length; i++) {
    const n = confirmedPerFace[i];
    const target = n !== null ? clusterByName.get(n) : undefined;
    if (target !== undefined) assignment[i] = target;
  }
  return { assignment, names };
}

/**
 * Learns from what the user confirmed: every confirmed face moves to its person's group, then a
 * face still in an unnamed group is pulled into the named group whose clearest faces it best
 * matches, when that clears `threshold`, and never into a person it was said not to be.
 */
export function attractToNamedClusters(
  embeddings: Float32Array[],
  scores: number[],
  assignment: Int32Array,
  clusterName: Map<number, string>,
  confirmedPerFace: (string | null)[],
  threshold: number,
  blockedNames: (Set<string> | undefined)[] = [],
): Int32Array {
  const nameToCluster = new Map<string, number>();
  for (const [cid, name] of clusterName) nameToCluster.set(name, cid);
  const result = Int32Array.from(assignment);
  if (nameToCluster.size === 0) return result;
  for (let i = 0; i < result.length; i++) {
    const n = confirmedPerFace[i];
    const target = n !== null ? nameToCluster.get(n) : undefined;
    if (target !== undefined) result[i] = target;
  }
  const exemplars = new Map<number, Float32Array[]>();
  for (const cid of nameToCluster.values()) {
    const members: number[] = [];
    for (let i = 0; i < result.length; i++) if (result[i] === cid) members.push(i);
    members.sort((a, b) => scores[b] - scores[a] || a - b);
    exemplars.set(
      cid,
      members.slice(0, FACE_CLUSTER_EXEMPLARS).map((m) => embeddings[m]),
    );
  }
  const cids = [...exemplars.keys()].sort((a, b) => a - b);
  for (let i = 0; i < result.length; i++) {
    if (confirmedPerFace[i] !== null) continue;
    if (clusterName.has(result[i])) continue;
    const blocked = blockedNames[i];
    let bestCid = -1;
    let best = -Infinity;
    for (const cid of cids) {
      if (blocked?.has(clusterName.get(cid)!)) continue;
      for (const anchor of exemplars.get(cid)!) {
        const s = dot(embeddings[i], anchor);
        if (s > best) {
          best = s;
          bestCid = cid;
        }
      }
    }
    if (bestCid >= 0 && best >= threshold) result[i] = bestCid;
  }
  return result;
}

/**
 * "Is this <name>?": each unnamed group offered to the named person its direction is closest
 * to, when that clears `threshold`, best first.
 */
export function suggestPersonMatches(
  named: [string, Float32Array][],
  unnamed: [string, Float32Array][],
  threshold = FACE_SUGGEST_THRESHOLD,
): { named: string; unnamed: string; similarity: number }[] {
  if (named.length === 0 || unnamed.length === 0) return [];
  const byId = [...named].sort((a, b) => cmp(a[0], b[0]));
  const out: { named: string; unnamed: string; similarity: number }[] = [];
  for (const [unnamedId, uc] of unnamed) {
    let bestId: string | null = null;
    let best = -Infinity;
    for (const [namedId, nc] of byId) {
      const s = dot(uc, nc);
      if (s > best) {
        best = s;
        bestId = namedId;
      }
    }
    if (bestId !== null && best >= threshold) out.push({ named: bestId, unnamed: unnamedId, similarity: best });
  }
  return out.sort((a, b) => b.similarity - a.similarity || cmp(a.unnamed, b.unnamed));
}

/** An unnamed group shown as someone to name: not the leftovers, and in enough photos. */
export function isNameableCluster(name: string | null, isOther: boolean, faceCount: number): boolean {
  return (name === null || name.trim() === "") && !isOther && faceCount >= MIN_FACES_TO_SHOW_PERSON;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
