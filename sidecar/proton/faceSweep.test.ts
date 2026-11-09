import { describe, expect, it, vi } from "vitest";
import { mergeSweptFaces, sweepLibrary, type SweepIo } from "./faceSweep.ts";
import type { FaceRecord } from "./faceStore.ts";

type Box = FaceRecord["box"];

const face = (id: string, box: Box): FaceRecord => ({
  id,
  uid: id.split("#")[0],
  box,
  points: [],
  score: 0.9,
  blur: 100,
  sideways: 0,
  embedding: new Float32Array(2),
});

describe("mergeSweptFaces", () => {
  it("keeps the known face as it is and adds the new one after it", () => {
    const known = [face("u#0", [0, 0, 0.2, 0.2])];
    const merged = mergeSweptFaces("u", known, [face("u#0", [0.5, 0.5, 0.7, 0.7])]);
    expect(merged.map((f) => f.id)).toEqual(["u#0", "u#1"]);
    expect(merged[0]).toBe(known[0]);
    expect(merged[1].box).toEqual([0.5, 0.5, 0.7, 0.7]);
  });

  it("leaves out a face sitting on a known one", () => {
    const known = [face("u#0", [0.1, 0.1, 0.3, 0.3])];
    expect(mergeSweptFaces("u", known, [face("u#0", [0.1, 0.1, 0.3, 0.3])])).toEqual(known);
  });

  it("leaves out half a face inside a known one, whose overlap alone is too small", () => {
    const known = [face("u#0", [0, 0, 0.4, 0.4])];
    expect(mergeSweptFaces("u", known, [face("u#0", [0, 0, 0.15, 0.4])])).toEqual(known);
  });

  it("adds a face only a little inside a known one", () => {
    const known = [face("u#0", [0, 0, 0.4, 0.4])];
    const merged = mergeSweptFaces("u", known, [face("u#0", [0.3, 0, 0.6, 0.4])]);
    expect(merged.map((f) => f.id)).toEqual(["u#0", "u#1"]);
  });

  it("adds one face when the tiles found it twice", () => {
    const box: Box = [0.5, 0.5, 0.7, 0.7];
    const merged = mergeSweptFaces("u", [], [face("u#0", box), face("u#1", box)]);
    expect(merged.map((f) => f.id)).toEqual(["u#0"]);
  });

  it("follows the highest index, not the number of faces", () => {
    const known = [face("u#7", [0, 0, 0.2, 0.2])];
    const merged = mergeSweptFaces("u", known, [face("u#0", [0.5, 0.5, 0.7, 0.7])]);
    expect(merged.map((f) => f.id)).toEqual(["u#7", "u#8"]);
  });

  it("adds nothing past the highest index a photo keeps", () => {
    const known = [face("u#255", [0, 0, 0.2, 0.2])];
    expect(mergeSweptFaces("u", known, [face("u#0", [0.5, 0.5, 0.7, 0.7])])).toEqual(known);
  });
});

describe("sweepLibrary", () => {
  const bytes = Buffer.from("picture");
  const newFace = (uid: string) => [face(`${uid}#0`, [0.5, 0.5, 0.7, 0.7])];

  /** A library read in order, every photo answered and one new face on each. */
  function harness(todo: string[], over: Partial<SweepIo> = {}) {
    const put = vi.fn<SweepIo["put"]>();
    const marked: string[] = [];
    const onProgress = vi.fn<SweepIo["onProgress"]>();
    const onBatchEnd = vi.fn<SweepIo["onBatchEnd"]>(async () => {});
    const io: SweepIo = {
      todo,
      batch: 2,
      read: async function* (uids) {
        for (const uid of uids) yield { uid, bytes };
      },
      look: async (_bytes, uid) => newFace(uid),
      known: () => [],
      put,
      markSwept: (uid) => marked.push(uid),
      live: () => true,
      onProgress,
      onBatchEnd,
      ...over,
    };
    return { io, put, marked, onProgress, onBatchEnd };
  }

  it("does not mark a photo with nothing to read", async () => {
    const { io, put, marked } = harness(["a"], {
      read: async function* (uids) {
        for (const uid of uids) yield { uid, bytes: null };
      },
    });
    await expect(sweepLibrary(io)).resolves.toBe("done");
    expect(put).not.toHaveBeenCalled();
    expect(marked).toEqual([]);
  });

  it("does not mark a photo missing from the answer", async () => {
    const { io, marked } = harness(["a", "b"], {
      read: async function* () {
        yield { uid: "a", bytes };
      },
    });
    await expect(sweepLibrary(io)).resolves.toBe("done");
    expect(marked).toEqual(["a"]);
  });

  it("marks a photo the models failed on and carries on", async () => {
    const { io, put, marked } = harness(["a", "b", "c"], {
      look: async (_bytes, uid) => {
        if (uid === "b") throw new Error("bad picture");
        return newFace(uid);
      },
    });
    await expect(sweepLibrary(io)).resolves.toBe("done");
    expect(marked).toEqual(["a", "b", "c"]);
    expect(put.mock.calls.map(([uid]) => uid)).toEqual(["a", "c"]);
  });

  it("stops where it was told to, leaving the rest for the next run", async () => {
    const marked: string[] = [];
    const { io } = harness(["a", "b", "c"], {
      markSwept: (uid) => marked.push(uid),
      live: () => marked.length === 0,
    });
    await expect(sweepLibrary(io)).resolves.toBe("stopped");
    expect(marked).toEqual(["a"]);
  });

  it("does not mark a photo whose look ended with the sweep", async () => {
    let live = true;
    const { io, put, marked } = harness(["a"], {
      look: async () => {
        live = false;
        throw new Error("models gone");
      },
      live: () => live,
    });
    await expect(sweepLibrary(io)).resolves.toBe("stopped");
    expect(put).not.toHaveBeenCalled();
    expect(marked).toEqual([]);
  });

  it("counts as stopped when told to while the last batch was put away", async () => {
    let live = true;
    const { io, marked } = harness(["a"], {
      live: () => live,
      onBatchEnd: async () => {
        live = false;
      },
    });
    await expect(sweepLibrary(io)).resolves.toBe("stopped");
    expect(marked).toEqual(["a"]);
  });

  it("reads the faces known after the look, and writes only when one was added", async () => {
    const stored = new Map<string, FaceRecord[]>([
      ["a", newFace("a")],
      ["b", [face("b#3", [0, 0, 0.2, 0.2])]],
    ]);
    const { io, put, marked } = harness(["a", "b"], { known: (uid) => stored.get(uid) ?? [] });
    await expect(sweepLibrary(io)).resolves.toBe("done");
    expect(marked).toEqual(["a", "b"]);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0]).toBe("b");
    expect(put.mock.calls[0][1].map((f) => f.id)).toEqual(["b#3", "b#4"]);
  });

  it("reports the total and the faces added", async () => {
    const { io, onProgress } = harness(["a", "b", "c"]);
    await sweepLibrary(io);
    expect(onProgress.mock.calls).toEqual([
      [0, 3, 0],
      [1, 3, 1],
      [2, 3, 2],
      [3, 3, 3],
    ]);
  });

  it("ends each batch once", async () => {
    const asked: string[][] = [];
    const { io, onBatchEnd } = harness(["a", "b", "c"], {
      read: async function* (uids) {
        asked.push(uids);
        for (const uid of uids) yield { uid, bytes };
      },
    });
    await sweepLibrary(io);
    expect(asked).toEqual([["a", "b"], ["c"]]);
    expect(onBatchEnd).toHaveBeenCalledTimes(2);
  });
});
