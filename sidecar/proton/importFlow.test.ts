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
// The whole import, review to upload, against a library index: what goes up, what goes into
// an album as the photo the library has, and what is held back.

import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import sharp from "sharp";

import * as up from "./upload.ts";
import * as im from "./importMatch.ts";
import * as dup from "./duplicates.ts";

const work = mkdtempSync(join(tmpdir(), "pfp-probe-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
beforeEach(() => up.clearFinishedUploads());

const KEY = new Uint8Array(32).fill(7);
const sha1 = (b: Buffer) => createHash("sha1").update(b).digest("hex");
const T0 = 1_700_000_000; // seconds

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
/** A picture with real structure: random colour blocks. */
async function picture(seed: number, opts: { w?: number; h?: number; q?: number } = {}): Promise<Buffer> {
  const r = rng(seed);
  const bw = 16, bh = 12;
  const raw = Buffer.alloc(bw * bh * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(r() * 256);
  return sharp(raw, { raw: { width: bw, height: bh, channels: 3 } })
    .resize(opts.w ?? 1600, opts.h ?? 1200, { kernel: "cubic" })
    .jpeg({ quality: opts.q ?? 90 })
    .toBuffer();
}
const thumbOf = (full: Buffer) => sharp(full).rotate().resize(512, 512, { fit: "inside" }).jpeg({ quality: 70 }).toBuffer();

function tree(name: string, files: Record<string, string | Buffer>): string {
  const root = join(work, name);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, ...rel.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}
const sidecar = (seconds: number) => JSON.stringify({ photoTakenTime: { timestamp: String(seconds) } });

type Lib = { uid: string; t: number; video?: boolean; bytes?: Buffer; thumb?: Buffer | null; hidden?: boolean; name?: string };

function world(lib: Lib[], opts: { failFirstCommitOf?: string; failAsks?: { name: string; times: number } } = {}) {
  const uploads: { name: string; meta: any; uid: string }[] = [];
  const added: { album: string; uids: string[] }[] = [];
  const asked: string[] = [];
  const committed = new Map<string, string>(); // name -> uid, after a lost answer
  let failed = false;
  const photos: any = {
    findPhotoDuplicates: async (name: string, gen: () => Promise<string>) => {
      asked.push(name);
      if (opts.failAsks?.name === name && opts.failAsks.times > 0) {
        opts.failAsks.times--;
        throw Object.assign(new Error("fetch failed"), { name: "ConnectionError" });
      }
      if (committed.has(name)) return [committed.get(name)!];
      const byName = lib.filter((l) => l.name === name && l.bytes);
      if (byName.length === 0) return [];
      const h = await gen();
      return byName.filter((l) => sha1(l.bytes!) === h).map((l) => l.uid);
    },
    getFileUploader: async (name: string, meta: any) => {
      const uid = `new-${uploads.length + 1}`;
      return {
        uploadFromStream: async (stream: ReadableStream) => {
          const reader = stream.getReader();
          while (!(await reader.read()).done) { /* */ }
          return {
            completion: async () => {
              uploads.push({ name, meta, uid });
              if (opts.failFirstCommitOf === name && !failed) {
                failed = true;
                committed.set(name, uid);
                throw Object.assign(new Error("fetch failed"), { name: "ConnectionError" });
              }
              return { nodeUid: uid };
            },
          };
        },
      };
    },
    experimental: { iterateAlbumUids: async function* () {} },
    iterateNodes: async function* () {},
    iterateAlbum: async function* () {},
    createAlbum: async (name: string) => ({ uid: `album-${name}`, name }),
    addPhotosToAlbum: async function* (album: string, uids: string[]) {
      added.push({ album, uids: [...uids] });
      for (const uid of uids) yield { uid, ok: true };
    },
    updatePhotos: async function* () {},
    deleteAlbum: async () => {},
  };
  const library = async () =>
    new im.LibraryIndex(
      lib.map((l) => ({ uid: l.uid, captureTime: l.t * 1000, video: !!l.video })),
      lib.filter((l) => l.bytes).map((l) => [l.uid, im.contentHashOf(sha1(l.bytes!), KEY)] as [string, string]),
      KEY,
      async (uid: string) => {
        const l = lib.find((x) => x.uid === uid);
        return l?.thumb ? dup.fingerprintOf(l.thumb) : null;
      },
      (uid: string) => !!lib.find((x) => x.uid === uid)?.hidden,
    );
  return { photos, uploads, added, asked, library };
}

async function settle(until: (s: any) => boolean, ms = 20000) {
  for (let t = 0; t < ms / 10; t++) {
    const s = up.getUploadStatus();
    if (until(s)) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("never settled");
}
const finished = (s: any) => !s.importing && !s.running && s.total > 0 && s.done + s.skipped + s.failed === s.total;

async function run(
  root: string,
  w: ReturnType<typeof world>,
  probable = false,
  live = true,
  upload: (verdict: Record<string, number>) => number[] = () => [],
  exclude: (ids: Record<string, string>) => number[] = () => [],
) {
  up.startImport([root]);
  await settle((s) => s.importing?.phase === "ready");
  up.prepareImport(w.photos, {}, {}, w.library);
  const atReview = await settle((s) => s.importing?.phase === "review" && s.importing.checked === s.importing.items);
  const byContent = atReview.importing?.byContent;
  const review = up.getImportReview()!;
  const checks = up.getImportChecks()!;
  const verdict: Record<string, string> = {};
  const ids: Record<string, number> = {};
  for (const i of review.items) {
    verdict[i.name] = `${checks.checks[i.id]}/${checks.reasons[i.id] ?? ""}`;
    ids[i.name] = i.id;
  }
  const byPath: Record<string, string> = {};
  for (const i of review.items) byPath[i.path.split(/[\\/]/).slice(-2).join("/")] = String(i.id);
  up.confirmImport(w.photos, exclude(byPath), true, live, probable, upload(ids));
  let done: any = null;
  try { done = await settle(finished); } catch { done = up.getUploadStatus(); }
  return { verdict, done, byContent, rows: up.getUploadStatus().items.map((i: any) => `${i.name}:${i.status}`) };
}

describe("an export imported against the library", () => {
  it("uploads only what is new, puts what the library has in the album, and never joins a video to an old photo", async () => {
    const A = await picture(1), B = await picture(2), Bre = await sharp(B).resize(1200, 900).jpeg({ quality: 60 }).toBuffer();
    const L1s = await picture(3), L1v = Buffer.alloc(5000, 1);
    const L2s = await picture(4), L2v = Buffer.alloc(5000, 2);
    const L3s = await picture(5), L3v = Buffer.alloc(5000, 3);
    const N = await picture(6), H = await picture(7), V = Buffer.alloc(6000, 9), V2 = Buffer.alloc(6000, 8);
    const root = tree("matrix", {
      "Trip/a(1).jpg": A, "Trip/metadata/a(1).jpg.json": sidecar(T0 + 10),
      "Trip/b.jpg": Bre, "Trip/metadata/b.jpg.json": sidecar(T0 + 20),
      "Trip/IMG_1.jpg": L1s, "Trip/IMG_1.mov": L1v, "Trip/metadata/IMG_1.jpg.json": sidecar(T0 + 30), "Trip/metadata/IMG_1.mov.json": sidecar(T0 + 30),
      "Trip/IMG_2.jpg": L2s, "Trip/IMG_2.mov": L2v, "Trip/metadata/IMG_2.jpg.json": sidecar(T0 + 40), "Trip/metadata/IMG_2.mov.json": sidecar(T0 + 40),
      "Trip/IMG_3.jpg": L3s, "Trip/IMG_3.mov": L3v, "Trip/metadata/IMG_3.jpg.json": sidecar(T0 + 50), "Trip/metadata/IMG_3.mov.json": sidecar(T0 + 50),
      "Trip/new.jpg": N, "Trip/metadata/new.jpg.json": sidecar(T0 + 60),
      "Trip/h.jpg": H, "Trip/metadata/h.jpg.json": sidecar(T0 + 70),
      "Trip/v.mp4": V2, "Trip/metadata/v.mp4.json": sidecar(T0 + 80),
    });
    const w = world([
      { uid: "lib-a", t: T0 + 10, bytes: A, name: "a.jpg" },
      { uid: "lib-b", t: T0 + 20, bytes: B, thumb: await thumbOf(B), name: "b.jpg" },
      { uid: "lib-l1", t: T0 + 30, bytes: L1s, name: "IMG_1.HEIC" },
      { uid: "lib-l2v", t: T0 + 40, video: true, bytes: L2v, name: "other.mov" },
      { uid: "lib-h", t: T0 + 70, bytes: H, hidden: true, name: "h0.jpg" },
      { uid: "lib-v", t: T0 + 80, video: true, bytes: V, name: "v0.mp4" },
    ]);
    const r = await run(root, w);
    expect(r.byContent).toBe(true);
    expect(r.verdict["a(1).jpg"]).toBe("already/same_file");
    expect(r.verdict["b.jpg"]).toBe("probable/same_time_look");
    expect(r.verdict["v.mp4"]).toBe("probable/same_time_video");
    expect(w.uploads.map((u) => u.name).sort()).toEqual(["IMG_3.jpg", "IMG_3.mov", "new.jpg"]);
    for (const u of w.uploads) if (u.meta.mainPhotoNodeUid) expect(u.meta.mainPhotoNodeUid.startsWith("new-")).toBe(true);
    const album = w.added.flatMap((a) => a.uids);
    expect(album).toEqual(expect.arrayContaining(["lib-a", "lib-b", "lib-l1"]));
    // Neither a hidden photo, nor a video that only shares the second.
    expect(album).not.toContain("lib-h");
    expect(album).not.toContain("lib-v");
  });

  it("uploads a probable one when it is asked for, and only that one", async () => {
    const B = await picture(12), Bre = await sharp(B).resize(1200, 900).jpeg({ quality: 60 }).toBuffer();
    const C = await picture(13), Cre = await sharp(C).resize(1200, 900).jpeg({ quality: 60 }).toBuffer();
    const root = tree("ask", {
      "Trip/b.jpg": Bre, "Trip/metadata/b.jpg.json": sidecar(T0 + 20),
      "Trip/c.jpg": Cre, "Trip/metadata/c.jpg.json": sidecar(T0 + 25),
    });
    const w = world([
      { uid: "lib-b", t: T0 + 20, bytes: B, thumb: await thumbOf(B), name: "bb.jpg" },
      { uid: "lib-c", t: T0 + 25, bytes: C, thumb: await thumbOf(C), name: "cc.jpg" },
    ]);
    await run(root, w, false, true, (ids) => [ids["c.jpg"]]);
    expect(w.uploads.map((u) => u.name)).toEqual(["c.jpg"]);
    expect(w.added.flatMap((a) => a.uids)).toContain("lib-b");
  });

  it("holds back a copy whose library photo's look cannot be read", async () => {
    const C = await picture(21), Cre = await sharp(C).jpeg({ quality: 55 }).toBuffer();
    const root = tree("nothumb", { "Trip/c.jpg": Cre, "Trip/metadata/c.jpg.json": sidecar(T0 + 100) });
    const w = world([{ uid: "lib-c", t: T0 + 100, bytes: C, thumb: null, name: "c0.jpg" }]);
    const r = await run(root, w);
    expect(r.verdict["c.jpg"]).toBe("probable/same_time");
    expect(w.uploads).toEqual([]);
  });

  it("uploads the same bytes once when the export holds them under two names, into every album", async () => {
    const X = await picture(31);
    const root = tree("twice", { "Trip/x.jpg": X, "Trip/x(1).jpg": X, "Other/y.jpg": X });
    const w = world([{ uid: "lib-z", t: 5, bytes: await picture(99), name: "z.jpg" }]);
    await run(root, w);
    expect(w.uploads).toHaveLength(1);
    const albums = new Set(w.added.filter((a) => a.uids.includes(w.uploads[0].uid)).map((a) => a.album));
    expect(albums).toEqual(new Set(["album-Trip", "album-Other"]));
  });

  it("uploads a burst's next frame when the library has only the first", async () => {
    const F1 = await picture(41), F2 = await sharp(F1).modulate({ brightness: 1.03 }).jpeg({ quality: 88 }).toBuffer();
    const root = tree("burst", {
      "Trip/f1.jpg": F1, "Trip/metadata/f1.jpg.json": sidecar(T0 + 200),
      "Trip/f2.jpg": F2, "Trip/metadata/f2.jpg.json": sidecar(T0 + 200),
    });
    const w = world([{ uid: "lib-f1", t: T0 + 200, bytes: F1, thumb: await thumbOf(F1), name: "f1.jpg" }]);
    const r = await run(root, w);
    expect(r.verdict["f1.jpg"]).toBe("already/same_file");
    expect(w.uploads.map((u) => u.name)).toEqual(["f2.jpg"]);
  });

  it("still uploads a Live Photo's video when its photo's answer was lost and found on the retry", async () => {
    const S = await picture(51), M = Buffer.alloc(5000, 5);
    const root = tree("retry", { "Trip/IMG_9.jpg": S, "Trip/IMG_9.mov": M });
    const w = world([{ uid: "lib-z", t: 5, bytes: await picture(98), name: "z.jpg" }], { failFirstCommitOf: "IMG_9.jpg" });
    await run(root, w);
    const video = w.uploads.find((u) => u.name === "IMG_9.mov");
    expect(video?.meta.mainPhotoNodeUid).toBe(w.uploads.find((u) => u.name === "IMG_9.jpg")?.uid);
  }, 30000);

  it("says when it could only check by name and bytes", async () => {
    const A = await picture(61);
    const root = tree("noindex", { "Trip/a(1).jpg": A });
    const w = world([{ uid: "lib-a", t: T0, bytes: A, name: "a.jpg" }]);
    (w as any).library = async () => {
      throw new Error("timeline stalled");
    };
    const r = await run(root, w);
    expect(r.byContent).toBe(false);
  });

  it("never joins a video to a photo the library had, when a try failed before asking", async () => {
    const S = await picture(81), M = Buffer.alloc(5000, 7);
    const root = tree("ask-failed", { "Trip/IMG_7.jpg": S, "Trip/IMG_7.mov": M });
    // The library has the still under its name; the review's question and the upload's first fail.
    const w = world([{ uid: "lib-s7", t: 5, bytes: S, name: "IMG_7.jpg" }], { failAsks: { name: "IMG_7.jpg", times: 2 } });
    (w as any).library = async () => {
      throw new Error("timeline stalled");
    };
    const r = await run(root, w, false, true, (ids) => [ids["IMG_7.jpg"]]);
    expect(r.verdict["IMG_7.jpg"]).toBe("probable/unchecked");
    expect(w.uploads.find((u) => u.meta.mainPhotoNodeUid === "lib-s7")).toBeUndefined();
    expect(w.uploads).toEqual([]);
  }, 30000);

  it("uploads a copy in its own album when the first of two equal files is left out", async () => {
    const X = await picture(91);
    const root = tree("copy-left", { "Trip/x.jpg": X, "Other/y.jpg": X });
    const w = world([{ uid: "lib-z", t: 5, bytes: await picture(97), name: "z.jpg" }]);
    // Whichever of the two the check took first, that one is left out.
    let first = "";
    await run(root, w, false, true, () => [], (byPath) => {
      const checks = up.getImportChecks()!;
      const a = Number(byPath["Trip/x.jpg"]);
      first = checks.reasons[a] === "same_in_export" ? "Other/y.jpg" : "Trip/x.jpg";
      return [Number(byPath[first])];
    });
    expect(w.uploads).toHaveLength(1);
    const album = first === "Trip/x.jpg" ? "album-Other" : "album-Trip";
    expect(w.added.filter((a) => a.uids.includes(w.uploads[0].uid)).map((a) => a.album)).toEqual([album]);
  });

  it("uploads three equal files once when the first is left out, into the others' albums", async () => {
    const X = await picture(93);
    const root = tree("copy-three", { "A/x.jpg": X, "B/x(1).jpg": X, "C/y.jpg": X });
    const w = world([{ uid: "lib-z", t: 5, bytes: await picture(96), name: "z.jpg" }]);
    let firstAlbum = "";
    await run(root, w, false, true, () => [], (byPath) => {
      const checks = up.getImportChecks()!;
      const paths = ["A/x.jpg", "B/x(1).jpg", "C/y.jpg"];
      const first = paths.find((p) => checks.reasons[Number(byPath[p])] !== "same_in_export")!;
      firstAlbum = first.split("/")[0];
      return [Number(byPath[first])];
    });
    expect(w.uploads).toHaveLength(1);
    const albums = w.added.filter((a) => a.uids.includes(w.uploads[0].uid)).map((a) => a.album).sort();
    expect(albums).toEqual(["A", "B", "C"].filter((a) => a !== firstAlbum).map((a) => `album-${a}`));
  });

  it("draws the review's tile pictures from the export, and reads nothing else", async () => {
    const P = await picture(95);
    const root = tree("thumbs", { "Trip/p.jpg": P });
    const w = world([]);
    up.startImport([root]);
    await settle((s) => s.importing?.phase === "ready");
    up.prepareImport(w.photos, {}, {}, w.library);
    await settle((s) => s.importing?.phase === "review" && s.importing.checked === s.importing.items);
    const path = up.getImportReview()!.items[0].path;
    const [own, other] = await up.importThumbnails([path, join(root, "..", "elsewhere.jpg")]);
    expect(own).toMatch(/^data:image\/jpeg;base64,/);
    expect(other).toBeNull();
    up.discardImport();
  });
});

