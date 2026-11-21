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
// an album as the photo the library has, and that only the same bytes are ever held back.

import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";

import * as up from "./upload.ts";
import * as im from "./importMatch.ts";
import { forgetCompressedUploads, rememberCompressedUpload } from "./compressedUploads.ts";
import { initStore, setDataKey } from "./store.ts";

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

/** A library photo; `live` is the video joined to it, for a Live Photo, `liveTrashed` once trashed. */
type Lib = { uid: string; video?: boolean; bytes?: Buffer; live?: Buffer; liveTrashed?: boolean; hidden?: boolean; name?: string };

function world(
  lib: Lib[],
  opts: { failFirstCommitOf?: string; failAsks?: { name: string; times: number }; unlisted?: string[] } = {},
) {
  const uploads: { name: string; meta: any; uid: string }[] = [];
  const added: { album: string; uids: string[] }[] = [];
  const asked: string[] = [];
  const looked: string[] = [];
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
    getNode: async (uid: string) => {
      looked.push(uid);
      const owner = lib.find((l) => l.live && `${l.uid}-video` === uid);
      if (owner) {
        return {
          uid,
          trashTime: owner.liveTrashed ? new Date(0) : undefined,
          photo: { contentHash: im.contentHashOf(sha1(owner.live!), KEY), relatedPhotoNodeUids: [] },
        };
      }
      const l = lib.find((x) => x.uid === uid);
      if (!l && !uploads.some((u) => u.uid === uid)) throw new Error("no such node");
      return { uid, photo: { relatedPhotoNodeUids: l?.live ? [`${uid}-video`] : [] } };
    },
    iterateNodes: async function* (uids: string[]) {
      for (const uid of uids) if (lib.some((l) => l.uid === uid) || uploads.some((u) => u.uid === uid)) yield { uid };
    },
    // Where the SDK keeps the photo root's hash key.
    photos: {
      timeline: {
        photoShares: { getRootIDs: async () => ({ volumeId: "vol", rootNodeId: "root" }) },
        nodesService: { getNodeKeys: async () => ({ hashKey: KEY }) },
      },
    },
    iterateAlbum: async function* () {},
    createAlbum: async (name: string) => ({ uid: `album-${name}`, name }),
    addPhotosToAlbum: async function* (album: string, uids: string[]) {
      added.push({ album, uids: [...uids] });
      for (const uid of uids) yield { uid, ok: true };
    },
    updatePhotos: async function* () {},
    deleteAlbum: async () => {},
  };
  // The listing went through every photo, unless told it missed some.
  const listed = new Set(lib.map((l) => l.uid).filter((u) => !opts.unlisted?.includes(u)));
  const library = async () =>
    new im.LibraryIndex(
      lib.map((l) => l.uid),
      [
        ...lib.filter((l) => l.bytes && listed.has(l.uid)).map((l) => [l.uid, im.contentHashOf(sha1(l.bytes!), KEY)] as [string, string]),
        // A Live Photo's video is listed under its photo, as the timeline listing's related photos.
        ...lib.filter((l) => l.live && listed.has(l.uid)).map((l) => [l.uid, im.contentHashOf(sha1(l.live!), KEY)] as [string, string]),
      ],
      listed,
      KEY,
      (uid: string) => !!lib.find((x) => x.uid === uid)?.hidden,
    );
  return { photos, uploads, added, asked, looked, library };
}

/** A My files folder "Trip" holding `files`, and what the move sent to the Drive trash. */
function myFiles(files: { uid: string; name: string; bytes: Buffer }[]) {
  const trashed: string[] = [];
  const entity = (uid: string, name: string, type: "file" | "folder", size = 0) => ({
    uid,
    name: { ok: true, value: name },
    type,
    activeRevision: { ok: true, value: { claimedSize: size, claimedModificationTime: new Date(2021, 4, 6, 7, 8, 9) } },
  });
  const client = {
    getNode: async (uid: string) => {
      const f = files.find((x) => x.uid === uid);
      return f ? entity(f.uid, f.name, "file", f.bytes.length) : entity("trip", "Trip", "folder");
    },
    iterateFolderChildren: async function* (uid: string) {
      if (uid === "trip") for (const f of files) yield entity(f.uid, f.name, "file", f.bytes.length);
    },
    getFileDownloader: async (uid: string) => ({
      downloadToStream: (sink: WritableStream<Uint8Array>) => ({
        completion: async () => {
          const writer = sink.getWriter();
          await writer.write(new Uint8Array(files.find((x) => x.uid === uid)!.bytes));
          await writer.close();
        },
      }),
    }),
    trashNodes: async function* (uids: string[]) {
      for (const uid of uids) {
        trashed.push(uid);
        yield { uid, ok: true };
      }
    },
  };
  return { client, trashed };
}

/** Moves the folder from My files into the library, through the review, nothing left out. */
async function move(client: any, w: ReturnType<typeof world>) {
  up.startMyFilesImport(client, [{ uid: "trip", name: "Trip" }], [], true);
  await settle((s) => s.importing?.phase === "ready");
  up.prepareImport(w.photos, {}, {}, w.library);
  await settle((s) => s.importing?.phase === "review" && s.importing.checked === s.importing.items);
  up.confirmImport(w.photos, [], true, true);
  return settle((s) => !!s.moveResult);
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
  for (const i of review.items) verdict[i.name] = `${checks.checks[i.id]}/${checks.reasons[i.id] ?? ""}`;
  const byPath: Record<string, string> = {};
  for (const i of review.items) byPath[i.path.split(/[\\/]/).slice(-2).join("/")] = String(i.id);
  up.confirmImport(w.photos, exclude(byPath), true, true);
  let done: any = null;
  try { done = await settle(finished); } catch { done = up.getUploadStatus(); }
  return { verdict, done, byContent, rows: up.getUploadStatus().items.map((i: any) => `${i.name}:${i.status}`) };
}

describe("the videos Drive keeps with a library photo", () => {
  const still = (related: string[]) => ({ uid: "s", photo: { relatedPhotoNodeUids: related } });
  /** A library whose photo "s" keeps `video` with it, as Drive answers for each node. */
  const nodes = (video: object | null) => async (uid: string) => (uid === "s" ? still(["v"]) : (video ?? { ok: false }));
  const keyed = {
    timeline: {
      photoShares: { getRootIDs: async () => ({ volumeId: "vol", rootNodeId: "root" }) },
      nodesService: { getNodeKeys: async () => ({ hashKey: KEY }) },
    },
  };
  const M = Buffer.alloc(100, 1);

  it("are none when the photo keeps no video", async () => {
    const photos = { getNode: async () => still([]), photos: keyed };
    expect(await up.videosKeptWith(photos, "s", async () => sha1(M))).toEqual({ any: false, same: false });
  });

  it("count a video that cannot be read as kept, and match no bytes with it", async () => {
    const photos = { getNode: nodes(null), photos: keyed };
    expect(await up.videosKeptWith(photos, "s", async () => sha1(M))).toEqual({ any: true, same: false });
  });

  it("match no bytes without the photo root's hash key", async () => {
    const photos = { getNode: nodes({ uid: "v", photo: { contentHash: im.contentHashOf(sha1(M), KEY) } }) };
    expect(await up.videosKeptWith(photos, "s", async () => sha1(M))).toEqual({ any: true, same: false });
  });

  it("match the same bytes only in a video that is not in the trash", async () => {
    const node = (trashed: boolean) => ({
      getNode: nodes({ uid: "v", trashTime: trashed ? new Date(0) : undefined, photo: { contentHash: im.contentHashOf(sha1(M), KEY) } }),
      photos: keyed,
    });
    expect(await up.videosKeptWith(node(false), "s", async () => sha1(M))).toEqual({ any: true, same: true });
    expect(await up.videosKeptWith(node(true), "s", async () => sha1(M))).toEqual({ any: false, same: false });
  });

  it("are read from Drive, not from the cache", async () => {
    const changed: string[] = [];
    const photos = {
      getNode: nodes({ uid: "v", photo: { contentHash: im.contentHashOf(sha1(M), KEY) } }),
      nodes: { access: { notifyNodeChanged: async (uid: string) => void changed.push(uid) } },
      photos: keyed,
    };
    await up.videosKeptWith(photos, "s", async () => sha1(M));
    expect(changed).toEqual(["s", "v"]);
  });

  it("fail when the photo cannot be read", async () => {
    const photos = { getNode: async () => ({ ok: false }) };
    await expect(up.videosKeptWith(photos, "s", async () => sha1(M))).rejects.toThrow("its photo could not be read");
  });
});

describe("what a move from My files lets go", () => {
  const sourceOf = new Map([["s.jpg", "f-s"], ["s.mov", "f-v"], ["p.jpg", "f-p"]]);
  const kept = [{ file: "s.jpg", liveVideo: "s.mov" }, { file: "p.jpg" }];

  it("never an original skipped with no photo of its own", () => {
    const photo = (f: string) => ({ "s.jpg": "lib-s", "p.jpg": "lib-p" } as Record<string, string>)[f] ?? null;
    expect(up.moveOutcomes(kept, sourceOf, () => "skipped", photo)).toEqual([
      { source: "f-s", settled: true, photo: "lib-s" },
      { source: "f-v", settled: false, photo: null },
      { source: "f-p", settled: true, photo: "lib-p" },
    ]);
  });

  it("an original that went up, or whose bytes the library has", () => {
    const photo = (f: string) => ({ "s.jpg": "lib-s", "s.mov": "new-1", "p.jpg": "new-2" } as Record<string, string>)[f] ?? null;
    const outcomes = up.moveOutcomes(kept, sourceOf, (f) => (f === "s.jpg" ? "skipped" : "done"), photo);
    expect(outcomes.every((o) => o.settled)).toBe(true);
    expect(up.moveOutcomes(kept, sourceOf, () => "failed", photo).some((o) => o.settled)).toBe(false);
  });
});

describe("an export imported against the library", () => {
  it("holds back only the same bytes, under any name, and uploads everything else", async () => {
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
      { uid: "lib-a", bytes: A, name: "a.jpg" },
      { uid: "lib-b", bytes: B, name: "b.jpg" },
      { uid: "lib-l1", bytes: L1s, name: "IMG_1.HEIC" },
      { uid: "lib-l2v", video: true, bytes: L2v, name: "other.mov" },
      { uid: "lib-h", bytes: H, hidden: true, name: "h0.jpg" },
      { uid: "lib-v", video: true, bytes: V, name: "v0.mp4" },
    ]);
    const r = await run(root, w);
    expect(r.byContent).toBe(true);
    expect(r.verdict["a(1).jpg"]).toBe("already/same_file");
    expect(r.verdict["h.jpg"]).toBe("already/same_file");
    // Another encoding of a library photo, and another video of the same moment, are new.
    expect(r.verdict["b.jpg"]).toBe("new/");
    expect(r.verdict["v.mp4"]).toBe("new/");
    expect(r.verdict["IMG_2.jpg"]).toBe("new/");
    // IMG_1's still is in the library with no video: the video goes up, joined to it. IMG_2's
    // video is in the library already: its new still goes up alone, the video not again.
    expect(w.uploads.map((u) => u.name).sort()).toEqual(["IMG_1.mov", "IMG_2.jpg", "IMG_3.jpg", "IMG_3.mov", "b.jpg", "new.jpg", "v.mp4"]);
    expect(w.uploads.find((u) => u.name === "IMG_1.mov")?.meta.mainPhotoNodeUid).toBe("lib-l1");
    expect(w.uploads.find((u) => u.name === "IMG_3.mov")?.meta.mainPhotoNodeUid).toBe(w.uploads.find((u) => u.name === "IMG_3.jpg")?.uid);
    expect(r.rows).toContain("IMG_2.mov:skipped");
    const album = w.added.flatMap((a) => a.uids);
    expect(album).toEqual(expect.arrayContaining(["lib-a", "lib-l1", "lib-l2v"]));
    // Never a hidden photo.
    expect(album).not.toContain("lib-h");
  });

  it("uploads the same bytes once when the export holds them under two names, into every album", async () => {
    const X = await picture(31);
    const root = tree("twice", { "Trip/x.jpg": X, "Trip/x(1).jpg": X, "Other/y.jpg": X });
    const w = world([{ uid: "lib-z", bytes: await picture(99), name: "z.jpg" }]);
    await run(root, w);
    expect(w.uploads).toHaveLength(1);
    const albums = new Set(w.added.filter((a) => a.uids.includes(w.uploads[0].uid)).map((a) => a.album));
    expect(albums).toEqual(new Set(["album-Trip", "album-Other"]));
  });

  it("keeps a Live Photo's video when the same still is in the export once more without one", async () => {
    const X = await picture(33), M = Buffer.alloc(5000, 21);
    // Either one may be the still that goes up, as the two are hashed side by side: both
    // layouts, a few times over.
    for (const [still, live, round] of [["A", "B"], ["B", "A"]].flatMap(([a, b]) => [1, 2, 3].map((n) => [a, b, n]))) {
      const root = tree(`twice-live-${still}${round}`, { [`${still}/x.jpg`]: X, [`${live}/IMG_7.jpg`]: X, [`${live}/IMG_7.mov`]: M });
      const w = world([{ uid: "lib-z", bytes: await picture(98), name: "z.jpg" }]);
      await run(root, w);
      expect(w.uploads.map((u) => u.name).filter((n) => n.endsWith(".jpg"))).toHaveLength(1);
      expect(w.uploads.filter((u) => u.name === "IMG_7.mov")).toHaveLength(1);
    }
  });

  it("merges the same bytes inside the export also when the library's hashes cannot be had", async () => {
    const X = await picture(32);
    const root = tree("twice-noindex", { "Trip/x.jpg": X, "Other/y.jpg": X });
    const w = world([]);
    (w as any).library = async () => null;
    const r = await run(root, w);
    expect(r.byContent).toBe(false);
    expect(w.uploads).toHaveLength(1);
  });

  it("uploads a burst's next frame when the library has only the first", async () => {
    const F1 = await picture(41), F2 = await sharp(F1).modulate({ brightness: 1.03 }).jpeg({ quality: 88 }).toBuffer();
    const root = tree("burst", {
      "Trip/f1.jpg": F1, "Trip/metadata/f1.jpg.json": sidecar(T0 + 200),
      "Trip/f2.jpg": F2, "Trip/metadata/f2.jpg.json": sidecar(T0 + 200),
    });
    const w = world([{ uid: "lib-f1", bytes: F1, name: "f1.jpg" }]);
    const r = await run(root, w);
    expect(r.verdict["f1.jpg"]).toBe("already/same_file");
    expect(w.uploads.map((u) => u.name)).toEqual(["f2.jpg"]);
  });

  it("still uploads a Live Photo's video when its photo's answer was lost and found on the retry", async () => {
    const S = await picture(51), M = Buffer.alloc(5000, 5);
    const root = tree("retry", { "Trip/IMG_9.jpg": S, "Trip/IMG_9.mov": M });
    const w = world([{ uid: "lib-z", bytes: await picture(98), name: "z.jpg" }], { failFirstCommitOf: "IMG_9.jpg" });
    await run(root, w);
    const video = w.uploads.find((u) => u.name === "IMG_9.mov");
    expect(video?.meta.mainPhotoNodeUid).toBe(w.uploads.find((u) => u.name === "IMG_9.jpg")?.uid);
  }, 30000);

  it("says when it could only check by name and bytes, and then still holds back the same name and bytes", async () => {
    const A = await picture(61);
    // Whichever of the two is checked first: the renamed copy before the library's name, then after.
    for (const [n, files] of [
      ["noindex", { "A/a(1).jpg": A, "B/a.jpg": A }],
      ["noindex2", { "A/a.jpg": A, "B/a(1).jpg": A }],
    ] as const) {
      const w = world([{ uid: "lib-a", bytes: A, name: "a.jpg" }]);
      (w as any).library = async () => {
        throw new Error("timeline stalled");
      };
      const r = await run(tree(n, files), w);
      expect(r.byContent).toBe(false);
      expect(w.uploads).toEqual([]);
      expect(new Set(w.added.flatMap((a) => a.uids))).toEqual(new Set(["lib-a"]));
      expect(new Set(w.added.map((a) => a.album))).toEqual(new Set(["album-A", "album-B"]));
    }
  });

  it("does not trust a listing that missed a photo: the library's hashes are not used", async () => {
    const A = await picture(62);
    const root = tree("unlisted", { "Trip/a(1).jpg": A });
    const w = world([{ uid: "lib-a", bytes: A, name: "a.jpg" }, { uid: "lib-q", bytes: await picture(63), name: "q.jpg" }], {
      unlisted: ["lib-q"],
    });
    const r = await run(root, w);
    expect(r.byContent).toBe(false);
    // Proton's own check by name finds nothing under the new name: it counts as new.
    expect(r.verdict["a(1).jpg"]).toBe("new/");
  });

  it("counts a file whose check failed as new, and asks about it again when it uploads", async () => {
    const S = await picture(81), M = Buffer.alloc(5000, 7);
    const root = tree("ask-failed", { "Trip/IMG_7.jpg": S, "Trip/IMG_7.mov": M });
    // The library has the still under its name; the review's question fails.
    const w = world([{ uid: "lib-s7", bytes: S, name: "IMG_7.jpg" }], { failAsks: { name: "IMG_7.jpg", times: 1 } });
    (w as any).library = async () => {
      throw new Error("timeline stalled");
    };
    const r = await run(root, w);
    expect(r.verdict["IMG_7.jpg"]).toBe("new/");
    expect(w.asked.filter((n) => n === "IMG_7.jpg")).toHaveLength(2);
    expect(r.rows).toContain("IMG_7.jpg:skipped");
    // The library's still has no video: this one goes up joined to it.
    expect(w.uploads.map((u) => [u.name, u.meta.mainPhotoNodeUid])).toEqual([["IMG_7.mov", "lib-s7"]]);
  }, 30000);

  it("uploads a copy in its own album when the first of two equal files is left out", async () => {
    const X = await picture(91);
    const root = tree("copy-left", { "Trip/x.jpg": X, "Other/y.jpg": X });
    const w = world([{ uid: "lib-z", bytes: await picture(97), name: "z.jpg" }]);
    // Whichever of the two the check took first, that one is left out.
    let first = "";
    await run(root, w, (byPath) => {
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
    const w = world([{ uid: "lib-z", bytes: await picture(96), name: "z.jpg" }]);
    let firstAlbum = "";
    await run(root, w, (byPath) => {
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

  it("uploads a Live Photo's video on its own when the library's photo keeps a video with other bytes", async () => {
    const S = await picture(101), M = Buffer.alloc(5000, 11), Mlib = Buffer.alloc(5200, 12);
    const root = tree("live-has", { "Trip/IMG_4.jpg": S, "Trip/IMG_4.mov": M });
    const w = world([{ uid: "lib-s4", bytes: S, live: Mlib, name: "IMG_4.HEIC" }]);
    const r = await run(root, w);
    expect(r.verdict["IMG_4.jpg"]).toBe("already/same_file");
    expect(w.uploads.map((u) => [u.name, u.meta.mainPhotoNodeUid])).toEqual([["IMG_4.mov", undefined]]);
    expect(r.rows).toEqual(["IMG_4.jpg:skipped", "IMG_4.mov:done"]);
    expect(w.added.flatMap((a) => a.uids)).toEqual(expect.arrayContaining(["lib-s4", w.uploads[0].uid]));
  });

  it("finds a Live Photo's video among the videos Drive keeps with the library's photo when the library's hashes cannot be had", async () => {
    const S = await picture(107), M = Buffer.alloc(5000, 17);
    const root = tree("live-kept-noindex", { "Trip/IMG_11.jpg": S, "Trip/IMG_11.mov": M });
    const w = world([{ uid: "lib-s11", bytes: S, live: M, name: "IMG_11.jpg" }]);
    (w as any).library = async () => null;
    const r = await run(root, w);
    expect(r.byContent).toBe(false);
    expect(w.uploads).toEqual([]);
    expect(r.rows).toEqual(["IMG_11.jpg:skipped", "IMG_11.mov:skipped"]);
  });

  it("joins a Live Photo's video to the library's photo when the only video kept with it is in the trash", async () => {
    const S = await picture(108), M = Buffer.alloc(5000, 18);
    const root = tree("live-kept-trashed", { "Trip/IMG_12.jpg": S, "Trip/IMG_12.mov": M });
    const w = world([{ uid: "lib-s12", bytes: S, live: M, liveTrashed: true, name: "IMG_12.jpg" }]);
    (w as any).library = async () => null;
    const r = await run(root, w);
    expect(w.uploads.map((u) => [u.name, u.meta.mainPhotoNodeUid])).toEqual([["IMG_12.mov", "lib-s12"]]);
    expect(r.rows).toEqual(["IMG_12.jpg:skipped", "IMG_12.mov:done"]);
  });

  it("reads the library's photo afresh once a video is joined to it", async () => {
    const S = await picture(113), M = Buffer.alloc(5000, 27);
    const root = tree("live-join-refresh", { "Trip/IMG_17.jpg": S, "Trip/IMG_17.mov": M });
    const w = world([{ uid: "lib-s17", bytes: S, name: "IMG_17.jpg" }]);
    const changed: string[] = [];
    w.photos.nodes = { access: { notifyNodeChanged: async (uid: string) => void changed.push(`${uid}@${w.uploads.length}`) } };
    await run(root, w);
    expect(w.uploads.map((u) => [u.name, u.meta.mainPhotoNodeUid])).toEqual([["IMG_17.mov", "lib-s17"]]);
    expect(changed).toEqual(["lib-s17@0", "lib-s17@1"]);
  });

  it("uploads every different video of a still the export holds twice, the first joined to it", async () => {
    const X = await picture(109), M1 = Buffer.alloc(5000, 19), M2 = Buffer.alloc(5100, 20);
    const root = tree("twice-two-videos", { "A/IMG_13.jpg": X, "A/IMG_13.mov": M1, "B/IMG_13.jpg": X, "B/IMG_13.mov": M2 });
    const w = world([{ uid: "lib-z", bytes: await picture(94), name: "z.jpg" }]);
    await run(root, w);
    const still = w.uploads.filter((u) => u.name === "IMG_13.jpg");
    const videos = w.uploads.filter((u) => u.name === "IMG_13.mov");
    expect(still).toHaveLength(1);
    expect(videos.map((v) => v.meta.mainPhotoNodeUid)).toEqual([still[0].uid, undefined]);
  });

  it("uploads the video of a renamed copy of a still when it differs from the kept still's video", async () => {
    const X = await picture(112), M1 = Buffer.alloc(5000, 25), M2 = Buffer.alloc(5100, 26);
    const root = tree("renamed-two-videos", { "A/IMG_16.jpg": X, "A/IMG_16.mov": M1, "B/IMG_16(1).jpg": X, "B/IMG_16(1).mov": M2 });
    const w = world([{ uid: "lib-z", bytes: await picture(92), name: "z.jpg" }]);
    await run(root, w);
    const still = w.uploads.filter((u) => u.name.endsWith(".jpg"));
    const videos = w.uploads.filter((u) => u.name.endsWith(".mov"));
    expect(still).toHaveLength(1);
    expect(videos.map((v) => v.meta.mainPhotoNodeUid)).toEqual([still[0].uid, undefined]);
  });

  it("uploads one video of a still the export holds twice with the same video", async () => {
    const X = await picture(110), M = Buffer.alloc(5000, 23);
    const root = tree("twice-same-video", { "A/IMG_14.jpg": X, "A/IMG_14.mov": M, "B/IMG_14.jpg": X, "B/IMG_14.mov": M });
    const w = world([{ uid: "lib-z", bytes: await picture(93), name: "z.jpg" }]);
    await run(root, w);
    expect(w.uploads.map((u) => u.name).sort()).toEqual(["IMG_14.jpg", "IMG_14.mov"]);
  });

  it("finds a Live Photo's video by its bytes beside the library's photo, without asking again", async () => {
    const S = await picture(102), M = Buffer.alloc(5000, 13);
    const root = tree("live-same", { "Trip/IMG_6.jpg": S, "Trip/IMG_6.mov": M });
    const w = world([{ uid: "lib-s6", bytes: S, live: M, name: "IMG_6.HEIC" }]);
    const r = await run(root, w);
    expect(w.uploads).toEqual([]);
    expect(w.looked).toEqual([]);
    expect(r.rows).toEqual(["IMG_6.jpg:skipped", "IMG_6.mov:skipped"]);
  });

  it("checks against an empty library by content, and uploads everything", async () => {
    const A = await picture(103), B = await picture(104);
    const root = tree("empty-lib", { "Trip/a.jpg": A, "Trip/b.jpg": B });
    const w = world([]);
    const r = await run(root, w);
    expect(r.byContent).toBe(true);
    expect(r.verdict).toEqual({ "a.jpg": "new/", "b.jpg": "new/" });
    expect(w.uploads.map((u) => u.name).sort()).toEqual(["a.jpg", "b.jpg"]);
  });

  it("moves a Live Photo out of My files whole when its video went up beside the library's still", async () => {
    const S = await picture(105), M = Buffer.alloc(5000, 14);
    const { client, trashed } = myFiles([
      { uid: "f-still", name: "IMG_5.jpg", bytes: S },
      { uid: "f-video", name: "IMG_5.mov", bytes: M },
    ]);
    const w = world([{ uid: "lib-s5", bytes: S, name: "IMG_5.HEIC" }]);
    const done = await move(client, w);
    expect(w.uploads.map((u) => u.name)).toEqual(["IMG_5.mov"]);
    expect(trashed.sort()).toEqual(["f-still", "f-video"]);
    expect(done.moveResult).toMatchObject({ moved: 2, kept: 0 });
  });

  it("moves a Live Photo out of My files whole when its video went up on its own beside the library's still and its other video", async () => {
    const S = await picture(106), M = Buffer.alloc(5000, 15), Mlib = Buffer.alloc(5300, 16);
    const { client, trashed } = myFiles([
      { uid: "f-still", name: "IMG_8.jpg", bytes: S },
      { uid: "f-video", name: "IMG_8.mov", bytes: M },
    ]);
    const w = world([{ uid: "lib-s8", bytes: S, live: Mlib, name: "IMG_8.HEIC" }]);
    const done = await move(client, w);
    expect(w.uploads.map((u) => [u.name, u.meta.mainPhotoNodeUid])).toEqual([["IMG_8.mov", undefined]]);
    expect(trashed.sort()).toEqual(["f-still", "f-video"]);
    expect(done.moveResult).toMatchObject({ moved: 2, kept: 0 });
  });

  it("keeps a moved Live Photo's video in My files when it fails to go up", async () => {
    const S = await picture(111), M = Buffer.alloc(5000, 24);
    const { client, trashed } = myFiles([
      { uid: "f-still", name: "IMG_15.jpg", bytes: S },
      { uid: "f-video", name: "IMG_15.mov", bytes: M },
    ]);
    const w = world([{ uid: "lib-s15", bytes: S, name: "IMG_15.HEIC" }]);
    w.photos.getNode = async () => {
      throw new Error("no such node");
    };
    const done = await move(client, w);
    expect(w.uploads).toEqual([]);
    expect(trashed).toEqual(["f-still"]);
    expect(done.moveResult).toMatchObject({ moved: 1, kept: 1 });
  }, 30000);

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

  it("finds its own lighter copy of a file the review found new, by what this computer uploaded", async () => {
    initStore(mkdtempSync(join(tmpdir(), "pfp-ledger-")));
    setDataKey(randomBytes(32));
    forgetCompressedUploads();
    const V = Buffer.alloc(7000, 21);
    const root = tree("ledger", { "Trip/clip.mp4": V });
    // The library holds only the lighter copy, whose bytes are not the file's.
    const w = world([{ uid: "lib-light", video: true, bytes: Buffer.alloc(3000, 22), name: "clip.mp4" }]);
    rememberCompressedUpload(sha1(V), "lib-light");
    const r = await run(root, w);
    expect(r.verdict["clip.mp4"]).toBe("new/");
    expect(w.uploads).toEqual([]);
    expect(r.rows).toEqual(["clip.mp4:skipped"]);
    expect(w.added.flatMap((a) => a.uids)).toEqual(["lib-light"]);
  });
});

