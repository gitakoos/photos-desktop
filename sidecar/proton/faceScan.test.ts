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

import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";

import { FACE_EMBEDDING_DIM } from "./faceCluster.ts";
import { FaceScanner, analyzeImage, modelDownloadProgress, tilesFor, type ScanSource } from "./faceScan.ts";
import type { FaceCopyToWrite } from "./driveData.ts";
import type { FaceRecord } from "./faceStore.ts";
import { ModelWorkerGone } from "./ortSession.ts";
import { PowerWatch } from "./scanPipeline.ts";
import { missFor, type ScanMiss } from "./scanMisses.ts";
import { initStore, setDataKey } from "./store.ts";
import { direction, faceOf, seeded } from "./testFaces.ts";

describe("the models' download progress", () => {
  it("keeps the whole total while each file finishes, the finished ones counted as done", () => {
    const both = (first: "downloading" | "ready", second: "downloading" | "absent") =>
      modelDownloadProgress([
        { size: 32, status: first === "ready" ? { state: "ready" } : { state: "downloading", done: 20, total: 32 } },
        { size: 16, status: second === "downloading" ? { state: "downloading", done: 4, total: 16 } : { state: "absent" } },
      ]);
    expect(both("downloading", "downloading")).toEqual({ done: 24, total: 48 });
    expect(both("ready", "downloading")).toEqual({ done: 36, total: 48 });
  });

  it("says nothing once no file is downloading", () => {
    expect(modelDownloadProgress([{ size: 32, status: { state: "ready" } }])).toBeNull();
  });
});

describe("the sensitive pass's tiles", () => {
  it("leave a small picture whole", () => {
    expect(tilesFor(640, 480)).toEqual([]);
  });

  it("cover a large picture to its edges, overlapping", () => {
    const tiles = tilesFor(1920, 1080);
    expect(tiles.every((t) => t.w === 640 && t.h === 640)).toBe(true);
    expect(Math.max(...tiles.map((t) => t.x + t.w))).toBe(1920);
    expect(Math.max(...tiles.map((t) => t.y + t.h))).toBe(1080);
    const xs = [...new Set(tiles.map((t) => t.x))].sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeLessThan(640);
  });

  it("keep a narrow side whole", () => {
    const tiles = tilesFor(2400, 500);
    expect(tiles.every((t) => t.y === 0 && t.h === 500)).toBe(true);
  });
});

/** A detector that answers these faces, each a centre, a side and a score, with its five landmarks. */
function detectorOf(faces: { cx: number; cy: number; side: number; score: number }[]) {
  const out = new Float32Array(faces.length * 16);
  faces.forEach((f, r) => {
    const { cx, cy, side, score } = f;
    out.set([cx, cy, side, side, score, cx - 20, cy - 15, cx + 20, cy - 15, cx, cy + 5, cx - 15, cy + 25, cx + 15, cy + 25, 1], r * 16);
  });
  return { inputNames: ["in"], outputNames: ["out"], run: async () => ({ out: { data: out } }) };
}

const embedder = {
  inputNames: ["in"],
  outputNames: ["out"],
  run: async () => ({ out: { data: new Float32Array(FACE_EMBEDDING_DIM).fill(1) } }),
};

/** A flat grey picture, with sharp noise around the faces at these centres. */
function picture(side: number, sharpAt: number[][]) {
  const rand = seeded(5);
  const rgb = new Uint8Array(side * side * 3).fill(128);
  for (const [cx, cy] of sharpAt) {
    for (let y = cy - 110; y < cy + 110; y++) {
      for (let x = cx - 100; x < cx + 100; x++) {
        if (x < 0 || y < 0 || x >= side || y >= side) continue;
        for (let c = 0; c < 3; c++) rgb[(y * side + x) * 3 + c] = Math.floor(rand() * 256);
      }
    }
  }
  return { rgb, width: side, height: side };
}

describe("the faces found on a photo", () => {
  it("are numbered as the phone numbers them, counting a face too blurred to keep", async () => {
    // Three faces; the middle one sits on a flat patch, too blurred to keep.
    const detector = detectorOf([
      { cx: 100, cy: 320, side: 80, score: 0.97 },
      { cx: 320, cy: 320, side: 80, score: 0.95 },
      { cx: 540, cy: 320, side: 80, score: 0.93 },
    ]);
    const img = picture(640, [
      [100, 320],
      [540, 320],
    ]);
    const faces = await analyzeImage(img, { detector, embedder, accel: "cpu" } as any, "u");
    expect(faces.map((f) => f.id)).toEqual(["u#0", "u#2"]);
  });

  it("keep their landmarks in the picture's pixels, as the phone does", async () => {
    const detector = detectorOf([{ cx: 540, cy: 320, side: 80, score: 0.97 }]);
    const [face] = await analyzeImage(picture(640, [[540, 320]]), { detector, embedder, accel: "cpu" } as any, "u");
    expect(face.points[0]).toBeCloseTo(520, 3);
    expect(face.points[1]).toBeCloseTo(305, 3);
    expect(face.box[0]).toBeCloseTo(500 / 640, 5);
  });
});

/** A library to scan: the photos listed, the trash, the hidden ones; every photo asked for is noted. */
function library(uids: string[], opts: { trashed?: string[] | null; hidden?: string[] } = {}) {
  const asked: string[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  let listed: () => void = () => {};
  const wasListed = new Promise<void>((r) => (listed = r));
  let hold = false;
  const source: ScanSource = {
    listUids: async () => {
      listed();
      if (hold) await held;
      return uids;
    },
    async *pictures(batch) {
      for (const uid of batch) {
        asked.push(uid);
        yield { uid, bytes: null };
      }
    },
    listTrashed: async () => {
      if (opts.trashed === null) throw new Error("offline");
      return new Set(opts.trashed ?? []);
    },
    hiddenTest: () => (uid) => (opts.hidden ?? []).includes(uid),
  };
  return {
    source,
    asked,
    wasListed,
    holdListing: () => {
      hold = true;
    },
    release: () => release(),
  };
}

function scanner(): FaceScanner {
  const s = new FaceScanner();
  // The models are not needed: no photo here has bytes to read.
  (s as any).ensureModels = async () => true;
  s.setEnabled(true, false, false, false, false);
  return s;
}

/** Waits for the run and the save after it, so nothing is written into the next test's store. */
async function settle(s: FaceScanner): Promise<void> {
  while ((s as any).running || (s as any).saving) await ((s as any).running ?? (s as any).saving);
}

const face = (uid: string): FaceRecord => ({
  id: `${uid}#0`,
  uid,
  box: [0.1, 0.1, 0.3, 0.4],
  points: [],
  score: 0.9,
  blur: 100,
  sideways: 0,
  embedding: new Float32Array(FACE_EMBEDDING_DIM).fill(0.04),
});

describe("the scan of the library", () => {
  beforeEach(() => {
    initStore(mkdtempSync(join(tmpdir(), "pfp-scan-")));
    setDataKey(randomBytes(32));
  });

  it("leaves the hidden photos unread, and keeps the faces of a photo in the trash", async () => {
    const s = scanner();
    s.store.load();
    s.store.put("vol~t", [face("vol~t")]);
    s.store.people.people.push({ id: "p1", name: "Ann", isOther: false });
    s.store.people.assign["vol~t#0"] = "p1";
    s.store.people.confirmed["vol~t#0"] = "Ann";
    const lib = library(["vol~a", "vol~h"], { trashed: ["t"], hidden: ["vol~h"] });
    s.setSource(lib.source);
    await settle(s);
    expect(lib.asked).toEqual(["vol~a"]);
    expect(s.store.has("vol~h")).toBe(false);
    expect(s.store.facesOf("vol~t")).toHaveLength(1);
    expect(s.store.people.confirmed["vol~t#0"]).toBe("Ann");
    s.stop(false);
  });

  it("drops nothing when the trash cannot be read", async () => {
    const s = scanner();
    s.store.load();
    s.store.put("vol~gone", [face("vol~gone")]);
    const lib = library(["vol~a"], { trashed: null });
    s.setSource(lib.source);
    await settle(s);
    expect(s.store.has("vol~gone")).toBe(true);
    s.stop(false);
  });

  it("starts again when the library comes back while the last run is still ending", async () => {
    const s = scanner();
    const first = library([]);
    first.holdListing();
    s.setSource(first.source);
    await first.wasListed;
    // A quick lock and unlock: the run of the first is still waiting on its listing.
    s.setSource(null);
    const second = library(["vol~a"]);
    s.setSource(second.source);
    first.release();
    await second.wasListed;
    await settle(s);
    expect(second.asked).toEqual(["vol~a"]);
    s.stop(false);
  });

  it("indexes right after a run that began before the search was turned on", async () => {
    const s = scanner();
    const lib = library(["vol~a"]);
    lib.holdListing();
    s.setSource(lib.source);
    await lib.wasListed;
    // The search turned on while the faces' run waits on its listing.
    s.setEnabled(true, false, false, false, true);
    lib.release();
    await settle(s);
    expect((s as any).ran).toEqual({ faces: true, index: true });
    expect(s.getStatus().search).not.toBeNull();
    s.stop(false);
  });
});

/**
 * A library of one photo that always gives `miss` instead of a picture, its file's revision
 * `stamp.now`; every ask for the photo and for its revision is noted.
 */
function missingLibrary(uid: string, miss: ScanMiss, stamp = { now: "rev1" }) {
  const asked: string[] = [];
  const stamped: string[][] = [];
  const source: ScanSource = {
    listUids: async () => [uid],
    async *pictures(batch) {
      for (const one of batch) {
        asked.push(one);
        yield { uid: one, bytes: null, miss };
      }
    },
    listTrashed: async () => new Set(),
    stamps: async (uids) => {
      stamped.push(uids);
      return new Map(uids.map((one) => [one, stamp.now]));
    },
    hiddenTest: () => () => false,
  };
  return { source, asked, stamped, stamp };
}

describe("a photo the scan cannot read", () => {
  const timeout = missFor("timeout");

  beforeEach(() => {
    initStore(mkdtempSync(join(tmpdir(), "pfp-miss-")));
    setDataKey(randomBytes(32));
  });

  it("is skipped at once when it will never read, for the faces and the search, with its cause", async () => {
    const s = scanner();
    s.setEnabled(true, false, false, false, true);
    const lib = missingLibrary("vol~a", missFor("undecodable"));
    s.setSource(lib.source);
    await settle(s);
    expect(s.store.has("vol~a")).toBe(true);
    expect(s.search.get("vol~a")).toBeNull();
    expect(s.missSummary()).toEqual({ waiting: 0, skipped: 1, waitingBy: {}, skippedBy: { undecodable: 1 } });
    s.stop(false);
  });

  it("is left unscanned when it failed for now, and out of the next pass until its wait is over", async () => {
    const s = scanner();
    const lib = missingLibrary("vol~a", timeout);
    s.setSource(lib.source);
    await settle(s);
    expect(s.store.has("vol~a")).toBe(false);
    expect(s.misses.attempts("vol~a")).toBe(1);
    s.setSource(lib.source);
    await settle(s);
    expect(lib.asked).toEqual(["vol~a"]);
    expect(s.missSummary()?.waitingBy).toEqual({ timeout: 1 });
    s.stop(false);
  });

  it("is given up on and counted as looked at on its eighth counted failure in a row", async () => {
    const s = scanner();
    s.misses.load();
    // Seven failures long past, the last wait over.
    for (let i = 0; i < 7; i++) s.misses.miss("vol~a", timeout, 0);
    const lib = missingLibrary("vol~a", timeout);
    s.setSource(lib.source);
    await settle(s);
    expect(lib.asked).toEqual(["vol~a"]);
    expect(s.store.has("vol~a")).toBe(true);
    expect(s.getStatus().done).toBe(1);
    expect(s.missSummary()?.skippedBy).toEqual({ "gaveUp:timeout": 1 });
    s.stop(false);
  });

  it("is read again, faces and search, once its file changes", async () => {
    const s = scanner();
    s.setEnabled(true, false, false, false, true);
    const lib = missingLibrary("vol~a", missFor("undecodable"));
    s.setSource(lib.source);
    await settle(s);
    expect(lib.stamped).toEqual([["vol~a"]]);
    lib.stamp.now = "rev2";
    // The comparison with Drive is due again.
    (s as any).stampsCheckedAt = 0;
    s.setSource(lib.source);
    await settle(s);
    expect(lib.asked).toEqual(["vol~a", "vol~a"]);
    s.stop(false);
  });

  it("is read again once its file changes also while face recognition is off", async () => {
    const s = scanner();
    const lib = missingLibrary("vol~a", missFor("undecodable"));
    s.setSource(lib.source);
    await settle(s);
    s.stop(true);
    lib.stamp.now = "rev2";
    s.setEnabled(false, false, false, false, true);
    await settle(s);
    expect(lib.asked).toEqual(["vol~a", "vol~a"]);
    expect(s.store.isLoaded()).toBe(false);
    s.store.load();
    expect(s.store.has("vol~a")).toBe(false);
    s.stop(false);
  });

  it("is not read again while its file stays the same", async () => {
    const s = scanner();
    const lib = missingLibrary("vol~a", missFor("undecodable"));
    s.setSource(lib.source);
    await settle(s);
    (s as any).stampsCheckedAt = 0;
    s.setSource(lib.source);
    await settle(s);
    expect(lib.asked).toEqual(["vol~a"]);
    s.stop(false);
  });

  it("waits for another try, rather than counting as looked at, when the face model throws on it", async () => {
    const s = scanner();
    (s as any).analyze = async () => {
      throw new Error("model run failed");
    };
    const picture = await noisyJpeg(7);
    const source: ScanSource = {
      listUids: async () => ["vol~a"],
      async *pictures(batch) {
        for (const uid of batch) yield { uid, bytes: picture };
      },
      listTrashed: async () => new Set(),
      hiddenTest: () => () => false,
    };
    s.setSource(source);
    await settle(s);
    expect(s.store.has("vol~a")).toBe(false);
    expect(s.missSummary()?.waitingBy).toEqual({ model: 1 });
    s.stop(false);
  });

  it("is given up on after taking the model thread down twice in a row, and kept for one loss", () => {
    const s = scanner();
    s.misses.load();
    (s as any).workerLost("vol~a", true, false);
    expect(s.misses.attempts("vol~a")).toBe(0);
    (s as any).workerLost("vol~a", true, false);
    expect(s.misses.attempts("vol~a")).toBe(1);
    expect(s.missSummary()?.waitingBy).toEqual({ model: 1 });
    s.stop(false);
  });

  it("comes back after five minutes when the library could not be read", async () => {
    const s = scanner();
    const source: ScanSource = {
      listUids: async () => {
        throw new Error("offline");
      },
      async *pictures() {},
      listTrashed: async () => new Set(),
      hiddenTest: () => () => false,
    };
    s.setSource(source);
    await settle(s);
    expect(s.getStatus().state).toBe("failed");
    expect((s as any).recheckDelay()).toBe(5 * 60_000);
    s.stop(false);
  });

  it("is left out of this computer's face copy for the other devices once skipped", async () => {
    const s = scanner();
    let written: FaceCopyToWrite | null = null;
    s.setDriveWriter(async (copy) => {
      written = copy;
      return true;
    });
    const lib = missingLibrary("vol~a", missFor("undecodable"));
    s.setSource(lib.source);
    await settle(s);
    await s.shareOnce(() => s.saveFaces(true));
    expect(s.store.scanned()).toEqual(["vol~a"]);
    expect(written!.markers).toEqual([]);
    s.stop(false);
  });

  it("brings the next run forward to when its wait ends", () => {
    const s = scanner();
    s.misses.load();
    expect((s as any).recheckDelay(1000)).toBe(15 * 60_000);
    s.misses.miss("vol~a", timeout, 1000);
    s.misses.miss("vol~a", timeout, 1000);
    expect((s as any).recheckDelay(1000)).toBe(15 * 60_000);
    s.misses.miss("vol~b", timeout, 1000);
    expect((s as any).recheckDelay(1000)).toBe(5 * 60_000);
    s.stop(false);
  });
});

describe("this computer's face copy after a change of the face models", () => {
  beforeEach(() => {
    initStore(mkdtempSync(join(tmpdir(), "pfp-held-")));
    setDataKey(randomBytes(32));
  });

  it("is not saved while names wait for their photos to be looked at again", () => {
    const s = new FaceScanner();
    s.setDriveWriter(async () => true);
    s.setEnabled(true, false, false, true, false);
    s.store.load();
    s.store.people.heldOver = [{ uid: "vol~a", box: [0.1, 0.1, 0.3, 0.4], kind: "name", name: "Ann" }];
    expect(s.facesDirty(true)).toBe(false);
    s.store.people.heldOver = [];
    expect(s.facesDirty(true)).toBe(true);
    s.stop(false);
  });
});

/** A noisy little JPEG, different for every seed, sharp enough everywhere for a face to be kept. */
async function noisyJpeg(seed: number): Promise<Buffer> {
  const rand = seeded(seed);
  const side = 320;
  const rgb = Buffer.alloc(side * side * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = Math.floor(rand() * 256);
  return sharp(rgb, { raw: { width: side, height: side, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
}

/** A number read off a model's input, so what a fake model answers depends on the picture. */
function digest(data: Float32Array): number {
  let h = 2166136261;
  for (let i = 0; i < data.length; i += 97) h = Math.imul(h ^ Math.round(data[i] * 1000), 16777619) >>> 0;
  return h;
}

/** Waits a random number of turns, so photos worked on side by side finish in a jumbled order. */
const jitter = async () => {
  for (let hops = Math.floor(Math.random() * 8); hops > 0; hops--) await new Promise<void>((r) => setImmediate(r));
};

/**
 * Fake models that answer from the picture: none to three faces where the picture says, each
 * face's numbers near one of six people's, and a search vector of the picture's own.
 */
function pictureModels() {
  const people = Array.from({ length: 6 }, (_, k) => direction(seeded(100 + k)));
  const input = (feeds: any) => Object.values(feeds)[0] as { data: Float32Array };
  const detector = {
    inputNames: ["in"],
    outputNames: ["out"],
    run: async (feeds: any) => {
      await jitter();
      const h = digest(input(feeds).data);
      const count = h % 7 === 0 ? 0 : 1 + (h % 3);
      const out = new Float32Array(count * 16);
      for (let r = 0; r < count; r++) {
        const cx = 140 + r * 150 + ((h >>> 8) % 20);
        const cy = 200 + ((h >>> (12 + r)) % 200);
        out.set([cx, cy, 110, 110, 0.9 - r * 0.01, cx - 25, cy - 18, cx + 25, cy - 18, cx, cy + 6, cx - 18, cy + 30, cx + 18, cy + 30, 1], r * 16);
      }
      return { out: { data: out } };
    },
  };
  const embedder = {
    inputNames: ["in"],
    outputNames: ["out"],
    run: async (feeds: any) => {
      await jitter();
      const h = digest(input(feeds).data);
      return { out: { data: faceOf(people[h % people.length], seeded(h), 0.4) } };
    },
  };
  const clip = {
    inputNames: ["in"],
    outputNames: ["out"],
    run: async (feeds: any) => {
      await jitter();
      return { out: { data: direction(seeded(digest(input(feeds).data))) } };
    },
  };
  return { models: { detector, embedder, accel: "cpu" as const }, clip: { session: clip, accel: "cpu" as const } };
}

/**
 * A library whose photos arrive after random waits, each batch in the order the real one takes:
 * the originals first, then the photos read from their preview (here every fifth), one with no
 * picture at all among them.
 */
function jpegLibrary(pictures: Map<string, Buffer | null>): ScanSource {
  return {
    listUids: async () => [...pictures.keys()],
    async *pictures(batch) {
      const later = batch.filter((_, i) => i % 5 === 4);
      for (const uid of [...batch.filter((_, i) => i % 5 !== 4), ...later]) {
        await jitter();
        yield { uid, bytes: pictures.get(uid) ?? null };
      }
    },
    listTrashed: async () => new Set(),
    hiddenTest: () => () => false,
  };
}

/** Everything the scan wrote, in the order it wrote it, and where the store stands after. */
async function scanWith(width: number, pictures: Map<string, Buffer | null>) {
  initStore(mkdtempSync(join(tmpdir(), "pfp-order-")));
  setDataKey(Buffer.alloc(32, 7));
  const { models, clip } = pictureModels();
  const s = new FaceScanner(new PowerWatch(async () => ({ saving: false, metered: false })));
  (s as any).ensureModels = async () => true;
  (s as any).openModels = async () => models;
  (s as any).openClip = async () => clip;
  (s as any).speed = () => ({
    chosen: null,
    machine: "balanced",
    running: "balanced",
    level: { photos: width, downloads: 4, prefetch: width > 1, pauseMs: 0 },
  });
  s.store.load();
  // A library grouped before: the new faces are placed with the people as the scan goes.
  s.store.people.grouped = true;
  const writes: string[] = [];
  const put = s.store.put.bind(s.store);
  s.store.put = (uid, faces) => {
    writes.push(`faces ${uid} ${faces.map((f) => f.id).join(",")}`);
    put(uid, faces);
  };
  const searchPut = s.search.put.bind(s.search);
  s.search.put = (uid, vector) => {
    writes.push(`search ${uid} ${vector ? digest(Float32Array.from(vector)) : "none"}`);
    searchPut(uid, vector);
  };
  s.setEnabled(true, false, false, false, true);
  s.setSource(jpegLibrary(pictures));
  await settle(s);
  const faces = s.store.allFaces().map((f) => ({ ...f, embedding: Array.from(f.embedding) }));
  const { people, assign } = s.store.people;
  const vectors = [...pictures.keys()].map((uid) => {
    const v = s.search.get(uid);
    return v ? Array.from(v) : v;
  });
  const status = s.getStatus();
  s.stop(true);
  return { writes, faces, people, assign, vectors, done: status.done, faceCount: status.faces };
}

describe("photos read side by side", () => {
  it("come out exactly as read one at a time: the same faces, numbers, people and order", { timeout: 60_000 }, async () => {
    const pictures = new Map<string, Buffer | null>();
    for (let i = 0; i < 144; i++) pictures.set(`vol~p${String(i).padStart(3, "0")}`, i === 37 ? null : await noisyJpeg(i + 1));
    const one = await scanWith(1, pictures);
    // Enough faces that the people are placed in the middle of the scan, not only at its end.
    expect(one.faces.length).toBeGreaterThan(220);
    expect(one.people.length).toBeGreaterThan(1);
    expect(one.done).toBe(144);
    for (const width of [2, 4]) {
      const many = await scanWith(width, pictures);
      expect(many.writes).toEqual(one.writes);
      expect(many.faces).toEqual(one.faces);
      expect(many.people).toEqual(one.people);
      expect(many.assign).toEqual(one.assign);
      expect(many.vectors).toEqual(one.vectors);
      expect(many.faceCount).toBe(one.faceCount);
    }
  });
});

describe("a model thread lost in the middle of a pass", () => {
  it("stops the pass with the photo unrecorded, and the next pass reads it", { timeout: 60_000 }, async () => {
    initStore(mkdtempSync(join(tmpdir(), "pfp-lost-")));
    setDataKey(Buffer.alloc(32, 9));
    const pictures = new Map<string, Buffer>();
    for (let i = 0; i < 12; i++) pictures.set(`vol~q${String(i).padStart(2, "0")}`, await noisyJpeg(i + 500));
    const { models, clip } = pictureModels();
    // The thread is lost at the sixth photo's detection, and again on the run tried once more.
    const yielded: string[] = [];
    let calls = 0;
    let lose = true;
    const detect = models.detector.run;
    models.detector.run = async (feeds: any) => {
      calls++;
      if (lose && calls >= 6) throw new ModelWorkerGone();
      return detect(feeds);
    };
    const s = new FaceScanner(new PowerWatch(async () => ({ saving: false, metered: false })));
    (s as any).ensureModels = async () => true;
    (s as any).openModels = async () => models;
    (s as any).openClip = async () => clip;
    (s as any).speed = () => ({
      chosen: null,
      machine: "balanced",
      running: "balanced",
      level: { photos: 1, downloads: 1, prefetch: false, pauseMs: 0 },
    });
    s.store.load();
    s.setEnabled(true, false, false, false, true);
    s.setSource({
      listUids: async () => [...pictures.keys()],
      async *pictures(batch) {
        for (const uid of batch) {
          yielded.push(uid);
          yield { uid, bytes: pictures.get(uid) ?? null };
        }
      },
      listTrashed: async () => new Set(),
      hiddenTest: () => () => false,
    });
    await settle(s);
    const lost = yielded[5];
    expect(s.getStatus().state).toBe("failed");
    expect(s.store.has(lost)).toBe(false);
    expect(s.search.get(lost)).toBeFalsy();
    for (const uid of yielded.slice(0, 5)) expect(s.store.has(uid)).toBe(true);
    // A pass with the thread back reads it, and the rest.
    lose = false;
    (s as any).kick();
    await settle(s);
    expect(s.getStatus().state).toBe("done");
    for (const uid of pictures.keys()) expect(s.store.has(uid)).toBe(true);
    expect(s.search.get(lost)).toBeTruthy();
    s.stop(true);
  });
});
