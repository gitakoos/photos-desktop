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
import { beforeEach, describe, expect, it, vi } from "vitest";

import { backupBaseline } from "./backupBaseline.ts";
import { writeBackupFlags } from "./backupFlags.ts";
import type { FaceCopyToWrite, SearchCopyToWrite } from "./driveData.ts";
import { FACE_EMBEDDING_DIM } from "./faceCluster.ts";
import { FaceScanner, analyzeImage, modelDownloadProgress, tilesFor, type ScanSource } from "./faceScan.ts";
import type { FaceRecord } from "./faceStore.ts";
import { PowerWatch } from "./scanPipeline.ts";
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

async function settle(s: FaceScanner): Promise<void> {
  while ((s as any).running) await (s as any).running;
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

describe("this computer's copies against the last ones written", () => {
  beforeEach(() => {
    initStore(mkdtempSync(join(tmpdir(), "pfp-shrink-")));
    setDataKey(randomBytes(32));
  });

  const links = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
  const dropTo = (n: number) => ({ photosBefore: 100, photosAfter: n, itemsBefore: 100, itemsAfter: n });

  /** The first `n` photos of the library looked at, a face found on each. */
  function holding(s: FaceScanner, n: number): void {
    s.store.clear();
    for (const link of links(n)) s.store.put(`vol~${link}`, [face(`vol~${link}`)]);
  }

  /** The first `n` photos of the library indexed. */
  function indexing(s: FaceScanner, n: number): void {
    s.search.clear();
    for (const link of links(n)) s.search.put(`vol~${link}`, new Uint16Array(1));
  }

  /** Face recognition and the index on and shared, a library of a hundred listed, the faces of them all held. */
  function sharing() {
    const faces: FaceCopyToWrite[] = [];
    const search: SearchCopyToWrite[] = [];
    const s = new FaceScanner();
    s.setDriveWriter(
      async (copy) => {
        faces.push(copy);
        return true;
      },
      async (copy) => {
        search.push(copy);
        return true;
      },
    );
    s.setEnabled(true, false, false, true, true);
    s.store.load();
    s.search.load();
    (s as any).uidByLink = new Map(links(100).map((link) => [link, `vol~${link}`]));
    holding(s, 100);
    return { s, faces, search };
  }

  it("does not send a copy with fewer photos than the last one", async () => {
    const { s, faces } = sharing();
    expect(await s.saveFaces(true)).toEqual({ wrote: true, counts: { faces: 100, photos: 100 } });
    holding(s, 97);
    s.changed();
    expect(await s.saveFaces(true)).toEqual({ blocked: dropTo(97) });
    expect(faces).toHaveLength(1);
    // Still to save, so the next round looks at it again.
    expect(s.facesDirty()).toBe(true);
    s.stop(false);
  });

  it("sends it when forced", async () => {
    const { s, faces } = sharing();
    await s.saveFaces(true);
    holding(s, 97);
    expect(await s.saveFaces(true, true)).toEqual({ wrote: true, counts: { faces: 97, photos: 97 } });
    expect(faces).toHaveLength(2);
    expect(Object.keys(backupBaseline.get("faces")!)).toHaveLength(97);
    s.stop(false);
  });

  it("lets a small drop by, but none during a scan", async () => {
    for (const state of ["models", "waiting", "scanning", "grouping", "finding"]) {
      initStore(mkdtempSync(join(tmpdir(), "pfp-shrink-")));
      const { s, faces } = sharing();
      await s.saveFaces(true);
      holding(s, 99);
      (s as any).status.state = state;
      expect(await s.saveFaces(true)).toEqual({ blocked: dropTo(99) });
      expect(faces).toHaveLength(1);
      (s as any).status.state = "done";
      expect(await s.saveFaces(true)).toEqual({ wrote: true, counts: { faces: 99, photos: 99 } });
      s.stop(false);
    }
  });

  it("does not count the photos gone from the library or hidden", async () => {
    const { s, faces } = sharing();
    await s.saveFaces(true);
    for (const link of links(100).slice(90, 95)) (s as any).uidByLink.delete(link);
    const hidden = new Set(links(100).slice(95).map((link) => `vol~${link}`));
    (s as any).source = { hiddenTest: () => (uid: string) => hidden.has(uid) };
    holding(s, 90);
    expect(await s.saveFaces(true)).toEqual({ wrote: true, counts: { faces: 90, photos: 90 } });
    expect(faces).toHaveLength(2);
    s.stop(false);
  });

  /** The scan paused, so no run lists the library, and what stands in the library's place. */
  function pausedWith(s: FaceScanner, source: ScanSource): void {
    s.setPaused(true);
    s.setSource(source);
    (s as any).uidByLink = new Map();
  }

  const whole = () => library(links(100).map((link) => `vol~${link}`)).source;
  const unlistable = (): ScanSource => ({
    ...library([]).source,
    listUids: async () => {
      throw new Error("offline");
    },
  });

  it("waits when there is a reference and the library cannot be listed", async () => {
    const { s, faces } = sharing();
    await s.saveFaces(true);
    (s as any).uidByLink = new Map();
    holding(s, 100);
    // No source at all, then one whose listing fails.
    expect(await s.saveFaces(true)).toEqual({ skipped: "library-unlisted" });
    pausedWith(s, unlistable());
    expect(await s.saveFaces(true)).toEqual({ skipped: "library-unlisted" });
    expect(faces).toHaveLength(1);
    s.stop(false);
  });

  it("waits when there is a reference and the listing comes back empty", async () => {
    const { s, faces } = sharing();
    await s.saveFaces(true);
    pausedWith(s, library([]).source);
    holding(s, 97);
    expect(await s.saveFaces(true)).toEqual({ skipped: "library-unlisted" });
    expect(faces).toHaveLength(1);
    s.stop(false);
  });

  it("writes a first copy with nothing to weigh it against, the library unlisted", async () => {
    const { s, faces } = sharing();
    pausedWith(s, library([]).source);
    expect(await s.saveFaces(true)).toEqual({ wrote: true, counts: { faces: 100, photos: 100 } });
    expect(faces).toHaveLength(1);
    s.stop(false);
  });

  it("lists the library itself with the scan paused, once, and weighs the copy as usual", async () => {
    const { s, faces } = sharing();
    await s.saveFaces(true);
    const source = whole();
    const listUids = vi.spyOn(source, "listUids");
    pausedWith(s, source);
    holding(s, 97);
    expect(await s.saveFaces(true)).toEqual({ blocked: dropTo(97) });
    expect(s.uidOfLink("p0")).toBe("vol~p0");
    expect(await s.saveFaces(true)).toEqual({ blocked: dropTo(97) });
    expect(listUids).toHaveBeenCalledTimes(1);
    expect(faces).toHaveLength(1);
    holding(s, 100);
    expect(await s.saveFaces(true)).toEqual({ wrote: true, counts: { faces: 100, photos: 100 } });
    s.stop(false);
  });

  it("sends the copy that carries a delete, with the library listed or not", async () => {
    const { s, faces } = sharing();
    await s.saveFaces(true);
    (s as any).uidByLink = new Map();
    (s as any).wipeHere(20, false);
    expect(await s.saveFaces()).toEqual({ wrote: true, counts: { faces: 0, photos: 0 } });
    expect(faces.map((c) => c.facesWipedAt)).toEqual([0, 20]);
    s.stop(false);
  });

  it("does not take a delete saved on an earlier run for one still to go out", async () => {
    const { s, faces } = sharing();
    await s.saveFaces(true);
    // What is known of the saved delete starts over with each run of the app, the reference does not.
    writeBackupFlags({ knownWipe: 20 });
    holding(s, 97);
    expect(await s.saveFaces(true)).toEqual({ blocked: dropTo(97) });
    expect(faces).toHaveLength(1);
    s.stop(false);
  });

  it("carries a delete on with recognition off, when no library will be listed", async () => {
    const { s, faces } = sharing();
    await s.saveFaces(true);
    writeBackupFlags({ knownWipe: 20 });
    s.setEnabled(false);
    (s as any).uidByLink = new Map();
    expect(await s.saveFaces()).toMatchObject({ wrote: true });
    expect(faces).toHaveLength(2);
    expect(s.wipeSaved()).toBe(true);
    s.stop(false);
  });

  it("says why faces are not saved with recognition off", () => {
    const { s } = sharing();
    s.setEnabled(false);
    expect(s.facesSkip(false)).toBe("recognition-off");
    s.stop(false);
  });

  it("says why faces are not saved while names wait for their photos", () => {
    const { s } = sharing();
    s.store.people.heldOver = [{ uid: "vol~p0", box: [0.1, 0.1, 0.3, 0.4], kind: "name", name: "Ann" }];
    expect(s.facesSkip(true)).toBe("names-held");
    s.stop(false);
  });

  it("gives no reason for faces with nothing new, or still to save", async () => {
    const { s } = sharing();
    expect(s.facesSkip(false)).toBeNull();
    await s.saveFaces();
    expect(s.facesSkip(false)).toBeNull();
    s.stop(false);
  });

  it("says why the search index is not saved when indexing is off", () => {
    const { s } = sharing();
    s.setEnabled(true, false, false, true, false);
    expect(s.searchSkip(false)).toBe("index-off");
    s.stop(false);
  });

  it("says when there is no search index to save yet", async () => {
    const { s } = sharing();
    expect(s.searchSkip(true)).toBe("nothing-to-save");
    indexing(s, 1);
    expect(s.searchSkip(true)).toBeNull();
    await s.saveSearch();
    expect(s.searchSkip(false)).toBeNull();
    s.stop(false);
  });

  it("holds a smaller search index back the same way, and forced it goes", async () => {
    const { s, search } = sharing();
    indexing(s, 100);
    expect(await s.saveSearch(true)).toEqual({ wrote: true, counts: { vectors: 100 } });
    indexing(s, 97);
    expect(await s.saveSearch(true)).toEqual({ blocked: dropTo(97) });
    expect(search).toHaveLength(1);
    expect(await s.saveSearch(true, true)).toEqual({ wrote: true, counts: { vectors: 97 } });
    expect(search).toHaveLength(2);
    expect(Object.keys(backupBaseline.get("search")!)).toHaveLength(97);
    s.stop(false);
  });

  it("counts a photo that could not be read as no vector", async () => {
    const { s } = sharing();
    indexing(s, 2);
    s.search.put("vol~p2", null);
    expect(await s.saveSearch(true)).toEqual({ wrote: true, counts: { vectors: 2 } });
    expect(backupBaseline.get("search")).toEqual({ p0: 1, p1: 1 });
    s.stop(false);
  });

  it("waits with the search index too when there is a reference and the library cannot be listed", async () => {
    const { s, search } = sharing();
    indexing(s, 100);
    await s.saveSearch(true);
    pausedWith(s, unlistable());
    indexing(s, 100);
    expect(await s.saveSearch(true)).toEqual({ skipped: "library-unlisted" });
    expect(search).toHaveLength(1);
    s.stop(false);
  });

  it("writes a first search index with nothing to weigh it against, the library unlisted", async () => {
    const { s, search } = sharing();
    indexing(s, 100);
    pausedWith(s, library([]).source);
    expect(await s.saveSearch(true)).toEqual({ wrote: true, counts: { vectors: 100 } });
    expect(search).toHaveLength(1);
    s.stop(false);
  });

  it("weighs the search index too with the scan paused", async () => {
    const { s, search } = sharing();
    indexing(s, 100);
    await s.saveSearch(true);
    pausedWith(s, whole());
    indexing(s, 97);
    expect(await s.saveSearch(true)).toEqual({ blocked: dropTo(97) });
    expect(search).toHaveLength(1);
    s.stop(false);
  });

  it("forgets the reference when the user deletes the faces", async () => {
    const { s } = sharing();
    await s.saveFaces(true);
    expect(backupBaseline.get("faces")).not.toBeNull();
    await s.clearHere();
    expect(backupBaseline.get("faces")).toBeNull();
    s.stop(false);
  });

  it("forgets it for a delete everywhere, for clearing it all, and for a delete from another device", async () => {
    const deletes: ((s: FaceScanner) => unknown)[] = [(s) => s.clearEverywhere(), (s) => s.clearAll(), (s) => (s as any).wipeHere(20, false)];
    for (const remove of deletes) {
      initStore(mkdtempSync(join(tmpdir(), "pfp-shrink-")));
      const { s } = sharing();
      await s.saveFaces(true);
      expect(backupBaseline.get("faces")).not.toBeNull();
      await remove(s);
      expect(backupBaseline.get("faces")).toBeNull();
      s.stop(false);
    }
  });

  it("forgets only the search index's when the user deletes that", () => {
    const { s } = sharing();
    backupBaseline.record("faces", { p0: 1 });
    backupBaseline.record("search", { p0: 1 });
    s.clearSearch();
    expect(backupBaseline.get("search")).toBeNull();
    expect(backupBaseline.get("faces")).toEqual({ p0: 1 });
    s.stop(false);
  });

  it("keeps it through a rescan, so a half-done one is not sent", async () => {
    const { s, faces } = sharing();
    await s.saveFaces(true);
    s.rescan();
    expect(backupBaseline.get("faces")).not.toBeNull();
    expect(await s.saveFaces(true)).toEqual({ blocked: dropTo(0) });
    expect(faces).toHaveLength(1);
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

describe("the full scan", () => {
  beforeEach(() => {
    initStore(mkdtempSync(join(tmpdir(), "pfp-scan-")));
    setDataKey(randomBytes(32));
  });

  /** A scanner whose own run is over and left `uids` scanned; the models open but are never run. */
  async function scanned(uids: string[]) {
    const s = scanner();
    (s as any).openModels = async () => ({});
    const lib = library(uids);
    s.setSource(lib.source);
    await settle(s);
    expect(s.store.scanned().sort()).toEqual(uids);
    return { s, source: lib.source };
  }

  async function ended(s: FaceScanner): Promise<void> {
    while (s.getSweep().running) await new Promise((r) => setTimeout(r, 5));
    await settle(s);
  }

  /** A library whose reading waits until let go, and says when it has begun. */
  function holdReading(source: ScanSource) {
    let begun: () => void = () => {};
    const reading = new Promise<void>((r) => (begun = r));
    let letGo: () => void = () => {};
    const gate = new Promise<void>((r) => (letGo = r));
    source.sweepPictures = async function* () {
      begun();
      await gate;
    };
    return { reading, letGo };
  }

  it("starts no run of the scan while it goes on, and hands back to the scan after", async () => {
    const { s, source } = await scanned(["vol~a"]);
    const { reading, letGo } = holdReading(source);
    const release = vi.spyOn(s as any, "releaseModels");
    s.startLibrarySweep();
    await reading;
    release.mockClear();
    (s as any).kick();
    expect((s as any).running).toBeNull();
    expect(release).not.toHaveBeenCalled();
    letGo();
    await ended(s);
    expect((s as any).recheck).not.toBeNull();
    s.stop(false);
  });

  it("takes the scan's waiting recheck off when it starts", async () => {
    const { s, source } = await scanned(["vol~a"]);
    const { reading, letGo } = holdReading(source);
    expect((s as any).recheck).not.toBeNull();
    s.startLibrarySweep();
    await reading;
    expect((s as any).recheck).toBeNull();
    letGo();
    await ended(s);
    s.stop(false);
  });

  it("marks nothing when the models cannot open, and says only the kind of error", async () => {
    const { s, source } = await scanned(["vol~a", "vol~b"]);
    (s as any).openModels = async () => {
      throw new TypeError("no such file: C:/models/face.onnx");
    };
    source.sweepPictures = async function* (uids) {
      for (const uid of uids) yield { uid, bytes: Buffer.from("picture") };
    };
    const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    s.startLibrarySweep();
    await ended(s);
    const written = log.mock.calls.map(([text]) => String(text));
    log.mockRestore();
    expect(s.store.isSwept("vol~a")).toBe(false);
    expect(s.store.isSwept("vol~b")).toBe(false);
    expect(s.getSweep().running).toBe(false);
    expect(written).toContain("[faces] full scan stopped: TypeError\n");
    s.stop(false);
  });

  /** Models in memory, as a photo read leaves them, each noting when it is let go. */
  function resident(s: FaceScanner) {
    const release = vi.fn(async () => {});
    (s as any).models = { detector: { release }, embedder: { release }, accel: "cpu" };
    return release;
  }

  /** Once the sweep started first has wound down, which is after its status already says stopped. */
  function firstSweep(s: FaceScanner) {
    const sweepAll = vi.spyOn(s as any, "sweepAll");
    return () => sweepAll.mock.results[0]!.value as Promise<void>;
  }

  it("lets the models go when it is stopped", async () => {
    const { s, source } = await scanned(["vol~a"]);
    // Paused, so no run of the scan comes after to let them go in its place.
    s.setPaused(true);
    const { reading, letGo } = holdReading(source);
    const release = resident(s);
    const woundDown = firstSweep(s);
    s.startLibrarySweep();
    await reading;
    s.stopSweep();
    letGo();
    await woundDown();
    expect(release).toHaveBeenCalledTimes(2);
    expect((s as any).models).toBeNull();
    expect(s.store.isSwept("vol~a")).toBe(false);
    s.stop(false);
  });

  it("lets the models go when they fail to open", async () => {
    const { s } = await scanned(["vol~a"]);
    s.setPaused(true);
    const release = resident(s);
    (s as any).openModels = async () => {
      throw new TypeError("no such file");
    };
    const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    s.startLibrarySweep();
    await ended(s);
    log.mockRestore();
    expect(release).toHaveBeenCalledTimes(2);
    expect((s as any).models).toBeNull();
    s.stop(false);
  });

  it("leaves the models to the scan that started again when it was stopped", async () => {
    const { s, source } = await scanned(["vol~a"]);
    const { reading, letGo } = holdReading(source);
    let listed: (uids: string[]) => void = () => {};
    source.listUids = () => new Promise((r) => (listed = r));
    const woundDown = firstSweep(s);
    s.startLibrarySweep();
    await reading;
    const release = resident(s);
    s.stopSweep();
    expect((s as any).running).not.toBeNull();
    letGo();
    await woundDown();
    expect(release).not.toHaveBeenCalled();
    listed(["vol~a"]);
    await settle(s);
    expect(release).toHaveBeenCalledTimes(2);
    s.stop(false);
  });

  it("leaves the models to a full scan started again straight after", async () => {
    const { s, source } = await scanned(["vol~a"]);
    s.setPaused(true);
    const first = holdReading(source);
    const woundDown = firstSweep(s);
    s.startLibrarySweep();
    await first.reading;
    const release = resident(s);
    s.stopSweep();
    const second = holdReading(source);
    s.startLibrarySweep();
    await second.reading;
    first.letGo();
    await woundDown();
    expect(release).not.toHaveBeenCalled();
    second.letGo();
    await ended(s);
    expect(release).toHaveBeenCalledTimes(2);
    s.stop(false);
  });
});
