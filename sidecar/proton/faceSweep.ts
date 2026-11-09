/**
 * The full scan started from Settings: every photo looked at once more, tile by tile, with the
 * faces already known left as they are. Apart from the models and the library, so it is tested
 * without either.
 */

import { MAX_FACE_INDEX, SAME_FACE_IOU, boxOverlap, type FaceRecord } from "./faceStore.ts";

/** A new face with at least this much of it inside a known one is that face, cut by a tile. */
export const CONTAINED_SAME_FACE = 0.6;

/** How much of `face` lies inside `other`. */
function containedIn(face: readonly number[], other: readonly number[]): number {
  const iw = Math.max(0, Math.min(face[2], other[2]) - Math.max(face[0], other[0]));
  const ih = Math.max(0, Math.min(face[3], other[3]) - Math.max(face[1], other[1]));
  const area = Math.max(0, face[2] - face[0]) * Math.max(0, face[3] - face[1]);
  return area <= 0 ? 0 : (iw * ih) / area;
}

function sameFace(found: readonly number[], known: readonly number[]): boolean {
  return boxOverlap(found, known) >= SAME_FACE_IOU || containedIn(found, known) >= CONTAINED_SAME_FACE;
}

/**
 * The faces of a photo after a closer look: every known one untouched, with its id and so its name,
 * then the ones found that are not one of those, each under the next free index.
 */
export function mergeSweptFaces(uid: string, known: FaceRecord[], found: FaceRecord[]): FaceRecord[] {
  const merged = [...known];
  let index = known.reduce((m, f) => Math.max(m, Number(f.id.slice(f.id.lastIndexOf("#") + 1))), -1);
  for (const face of found) {
    if (index >= MAX_FACE_INDEX) break;
    if (merged.some((f) => sameFace(face.box, f.box))) continue;
    merged.push({ ...face, id: `${uid}#${++index}`, uid });
  }
  return merged;
}

export type SweepIo = {
  /** The photos to look at. */
  todo: string[];
  /** Photos asked for at once. */
  batch: number;
  /** What to read for these photos; null for one with nothing to read, and a photo left out is not read now. */
  read: (uids: string[]) => AsyncIterable<{ uid: string; bytes: Buffer | null }>;
  look: (bytes: Buffer, uid: string) => Promise<FaceRecord[]>;
  known: (uid: string) => FaceRecord[];
  put: (uid: string, faces: FaceRecord[]) => void;
  markSwept: (uid: string) => void;
  live: () => boolean;
  /** Photos looked at, of all to look at, and the faces added so far. */
  onProgress: (done: number, total: number, added: number) => void;
  onBatchEnd: () => Promise<void>;
};

/**
 * Looks at each photo of `todo` and keeps what is new on it. A photo is marked only once it has been
 * read, so one that could not be read now comes back on the next run, as does one under way when the
 * sweep stops. One the models fail on is marked: reading it again would fail again.
 */
export async function sweepLibrary(io: SweepIo): Promise<"done" | "stopped"> {
  const total = io.todo.length;
  let done = 0;
  let added = 0;
  io.onProgress(done, total, added);
  for (let i = 0; i < total; i += io.batch) {
    if (!io.live()) return "stopped";
    for await (const { uid, bytes } of io.read(io.todo.slice(i, i + io.batch))) {
      if (!io.live()) return "stopped";
      if (!bytes) continue;
      let found: FaceRecord[] = [];
      try {
        found = await io.look(bytes, uid);
      } catch {
        /* marked below, with nothing found on it */
      }
      if (!io.live()) return "stopped";
      // Read after the look, which takes a while: a copy from another device may have come in since.
      const known = io.known(uid);
      const merged = mergeSweptFaces(uid, known, found);
      if (merged.length > known.length) {
        io.put(uid, merged);
        added += merged.length - known.length;
      }
      io.markSwept(uid);
      io.onProgress(++done, total, added);
    }
    await io.onBatchEnd();
  }
  // Told to stop while the last batch was put away: the sweep's ending is no longer this run's to do.
  return io.live() ? "done" : "stopped";
}
