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

import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { crc32 } from "node:zlib";

import sharp from "sharp";
import { PhotoTag } from "@protontech/drive-sdk";

import { importStagingDir, isStagedImport, openFresh, planExport, sweepStaleStaging, unpackZip } from "./importer.ts";
import {
  clearFinishedUploads,
  confirmImport,
  discardImport,
  getImportChecks,
  getImportReview,
  getUploadStatus,
  prepareImport,
  startImport,
} from "./upload.ts";

const work = mkdtempSync(join(tmpdir(), "pfp-import-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
beforeEach(() => clearFinishedUploads());

const isMedia = (name: string) => /\.(jpe?g|png|mp4)$/i.test(name);
const isLiveMedia = (name: string) => /\.(jpe?g|png|heic|mov|mp4)$/i.test(name);

/** Writes `files` under a fresh folder, creating the folders on the way. */
function tree(name: string, files: Record<string, string | Buffer>): string {
  const root = join(work, name);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, ...rel.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

/** A sidecar as Takeout and Ente both write one. */
function sidecar(seconds: number, extra: object = {}): string {
  return JSON.stringify({ photoTakenTime: { timestamp: String(seconds) }, ...extra });
}

/** A zip's DOS time and date fields for the local time `when`. */
function dosStamp(when: Date): { time: number; date: number } {
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
    date: ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

/**
 * A zip of `files`, stored rather than compressed: enough for the reader, and small
 * enough to build here without a zip library. Every entry carries `when`, or no time.
 */
function zipOf(files: Record<string, string | Buffer>, when?: Date): Buffer {
  const stamp = when ? dosStamp(when) : { time: 0, date: 0 };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function jpeg(colour: number): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: { r: colour, g: 80, b: 140 } } })
    .jpeg()
    .toBuffer();
}

describe("reading an export folder", () => {
  it("reads an Ente export into items with their albums and sidecars", async () => {
    const root = tree("ente", {
      "Trip/beach.jpg": "x",
      "Trip/metadata/beach.jpg.json": sidecar(1595500000),
      "Uncategorized/loose.jpg": "x",
      "Uncategorized/metadata/loose.jpg.json": sidecar(1600000000),
      "export_status.json": "{}",
    });

    const { items } = await planExport([root], isMedia);

    const beach = items.find((i) => i.file.endsWith("beach.jpg"))!;
    const loose = items.find((i) => i.file.endsWith("loose.jpg"))!;
    expect(items).toHaveLength(2);
    expect(beach.album).toBe("Trip");
    expect(beach.sidecar?.takenMs).toBe(1595500000000);
    expect(loose.album).toBeNull();
    expect(loose.sidecar?.takenMs).toBe(1600000000000);
  });

  it("reads a Takeout split in two as one export", async () => {
    const one = tree("takeout-1", {
      "Takeout/Google Photos/Vacation/IMG_1.jpg": "x",
      "Takeout/Google Photos/Photos from 2020/IMG_2.jpg": "x",
    });
    const two = tree("takeout-2", {
      "Takeout/Google Photos/Vacation/IMG_1.jpg.supplemental-metadata.json": sidecar(1590000000),
      "Takeout/Google Photos/Photos from 2020/IMG_2.jpg.json": sidecar(1580000000),
    });

    const { items } = await planExport([one, two], isMedia);

    const vacation = items.find((i) => i.album === "Vacation")!;
    expect(vacation.sidecar?.takenMs).toBe(1590000000000);
    expect(items.find((i) => i.file.endsWith("IMG_2.jpg"))?.album).toBeNull();
  });

  it("pairs a Live Photo's still and video of the same name into one item", async () => {
    const root = tree("live", {
      "Trip/IMG_1234.HEIC": "still",
      "Trip/IMG_1234.MOV": "motion",
      "Trip/clip.mp4": "just a video",
    });

    const { items } = await planExport([root], isLiveMedia);

    const live = items.find((i) => i.file.endsWith("IMG_1234.HEIC"))!;
    expect(live.liveVideo?.endsWith("IMG_1234.MOV")).toBe(true);
    // The paired video is part of the photo, not an item of its own; an unpaired one is.
    expect(items.some((i) => i.file.endsWith("IMG_1234.MOV"))).toBe(false);
    expect(items.find((i) => i.file.endsWith("clip.mp4"))?.liveVideo).toBeUndefined();
  });

  it("marks Ente's favourites rather than making a Favorites album", async () => {
    const root = tree("ente-favourites", {
      "Trip/a.jpg": "the same bytes",
      "Favorites/a.jpg": "the same bytes",
      "Favorites/b.jpg": "only a favourite",
    });

    const { items } = await planExport([root], isMedia);

    expect(items).toHaveLength(2);
    const a = items.find((i) => i.file.endsWith("a.jpg"))!;
    const b = items.find((i) => i.file.endsWith("b.jpg"))!;
    // The copy in Favorites marks the photo in Trip, which uploads once, into Trip.
    expect(a.album).toBe("Trip");
    expect(a.sidecar?.favorited).toBe(true);
    // A favourite with no other copy goes to the timeline, still a favourite.
    expect(b.album).toBeNull();
    expect(b.sidecar?.favorited).toBe(true);
    expect(items.some((i) => i.album === "Favorites")).toBe(false);
  });

  it("makes one item of a photo copied into several folders, kept in its albums", async () => {
    const root = tree("copies", {
      // Ente: the same photo in two albums.
      "Trip/a.jpg": "the same bytes",
      "Party/a.jpg": "the same bytes",
      // Takeout: an album's photo also in its year folder.
      "Takeout/Google Photos/Photos from 2020/b.jpg": "bytes of b",
      "Takeout/Google Photos/Vacation/b.jpg": "bytes of b",
      // Same name and same size, different photos: never merged.
      "One/c.jpg": "cccc-one",
      "Two/c.jpg": "cccc-two",
    });

    const { items } = await planExport([root], isMedia);
    const named = (n: string) => items.filter((i) => i.file.endsWith(n));

    expect(named("a.jpg")).toHaveLength(1);
    expect([named("a.jpg")[0].album, ...(named("a.jpg")[0].alsoIn ?? [])].sort()).toEqual(["Party", "Trip"]);
    expect(named("b.jpg")).toHaveLength(1);
    expect(named("b.jpg")[0].album).toBe("Vacation");
    expect(named("b.jpg")[0].alsoIn).toBeUndefined();
    expect(named("c.jpg")).toHaveLength(2);
  });

  it("never imports what Ente moved into its Trash folder", async () => {
    const root = tree("ente-trash", {
      "export_status.json": "{}",
      "Trip/kept.jpg": "x",
      "Trash/Trip/deleted.jpg": "x",
      "Trash/Trip/metadata/deleted.jpg.json": sidecar(1500000000),
    });

    const { items } = await planExport([root], isMedia);

    expect(items.map((i) => basename(i.file))).toEqual(["kept.jpg"]);
  });

  it("does not pair a still and a video that only share a name", async () => {
    const root = tree("live-namesake", {
      // Ente numbered the second still, but its video kept the plain name.
      "Trip/IMG_1.jpg": "an older photo",
      "Trip/metadata/IMG_1.jpg.json": sidecar(1500000000),
      "Trip/IMG_1(1).jpg": "the live still",
      "Trip/metadata/IMG_1(1).jpg.json": sidecar(1600000000),
      "Trip/IMG_1.mov": "the live video",
      "Trip/metadata/IMG_1.mov.json": sidecar(1600000000),
    });

    const { items } = await planExport([root], isLiveMedia);

    expect(items).toHaveLength(3);
    expect(items.every((i) => !i.liveVideo)).toBe(true);
  });

  it("leaves a name with more than one still or video unpaired", async () => {
    const root = tree("live-ambiguous", {
      "A/IMG_9.jpg": "x",
      "A/IMG_9.heic": "x",
      "A/IMG_9.mov": "x",
    });

    const { items } = await planExport([root], isLiveMedia);

    expect(items).toHaveLength(3);
    expect(items.every((i) => !i.liveVideo)).toBe(true);
  });
});

describe("unpacking a zip", () => {
  it("unpacks the media and sidecars into the staging folder, and nothing else", async () => {
    const zip = join(work, "export.zip");
    writeFileSync(
      zip,
      zipOf({
        "Trip/beach.jpg": "photo bytes",
        "Trip/metadata/beach.jpg.json": sidecar(1595500000),
        "Trip/notes.txt": "not media",
      }),
    );

    const progress: number[] = [];
    const root = await unpackZip(zip, isMedia, (done) => progress.push(done));

    expect(isStagedImport(root)).toBe(true);
    expect(readFileSync(join(root, "Trip", "beach.jpg"), "utf8")).toBe("photo bytes");
    expect(existsSync(join(root, "Trip", "metadata", "beach.jpg.json"))).toBe(true);
    expect(existsSync(join(root, "Trip", "notes.txt"))).toBe(false);
    expect(progress[progress.length - 1]).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
  });

  it("reports progress while one large entry is still being written", async () => {
    const zip = join(work, "big.zip");
    const size = 13 * 1024 * 1024;
    writeFileSync(zip, zipOf({ "Trip/long.mp4": Buffer.alloc(size, 7) }));

    const progress: number[] = [];
    const root = await unpackZip(zip, isMedia, (done) => progress.push(done));

    const during = progress.filter((done) => done > 0 && done < size);
    expect(during.length).toBeGreaterThanOrEqual(2);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress[progress.length - 1]).toBe(size);
    rmSync(root, { recursive: true, force: true });
  }, 30_000);

  it("clears only unpacked exports older than a day", async () => {
    const zip = join(work, "keep.zip");
    writeFileSync(zip, zipOf({ "Trip/a.jpg": "x" }));
    const fresh = await unpackZip(zip, isMedia);
    const old = await unpackZip(zip, isMedia);
    const later = Date.now() + 25 * 3600_000;
    utimesSync(fresh, new Date(later), new Date(later));

    await sweepStaleStaging(later);

    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(old)).toBe(false);
    rmSync(fresh, { recursive: true, force: true });
  });

  it("stages in the folder the host names, and only one named for imports", () => {
    const before = process.env.PFP_IMPORT_DIR;
    try {
      process.env.PFP_IMPORT_DIR = join(work, "cache", "pfp-import");
      expect(importStagingDir()).toBe(join(work, "cache", "pfp-import"));
      process.env.PFP_IMPORT_DIR = join(work, "cache");
      expect(importStagingDir()).toBe(join(tmpdir(), "pfp-import"));
    } finally {
      if (before === undefined) delete process.env.PFP_IMPORT_DIR;
      else process.env.PFP_IMPORT_DIR = before;
    }
  });

  it("keeps both of two entries whose names differ only in case", async () => {
    const zip = join(work, "case.zip");
    writeFileSync(zip, zipOf({ "Trip/IMG_1.jpg": "upper", "Trip/img_1.jpg": "lower" }));

    const root = await unpackZip(zip, isMedia);

    // A disk that ignores case keeps the second as `img_1 (2).jpg`; one that minds case keeps both names.
    const names = readdirSync(join(root, "Trip"));
    expect(names).toHaveLength(2);
    const bodies = names.map((n) => readFileSync(join(root, "Trip", n), "utf8")).sort();
    expect(bodies).toEqual(["lower", "upper"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("opens a taken name as the next free one, and never writes over it", async () => {
    const dir = join(work, "fresh");
    mkdirSync(dir, { recursive: true });
    const taken = join(dir, "beach.jpg");
    writeFileSync(taken, "first");

    const second = await openFresh(taken);
    await second.handle.writeFile("second");
    await second.handle.close();
    const third = await openFresh(taken);
    await third.handle.close();

    expect(second.path).toBe(join(dir, "beach (2).jpg"));
    expect(third.path).toBe(join(dir, "beach (3).jpg"));
    expect(readFileSync(taken, "utf8")).toBe("first");
    expect(readFileSync(second.path, "utf8")).toBe("second");
  });

  it("skips an entry that climbs out of the folder and unpacks the rest", async () => {
    const zip = join(work, "evil.zip");
    writeFileSync(zip, zipOf({ "../escaped.jpg": "x", "kept.jpg": "y" }));

    const root = await unpackZip(zip, isMedia);

    expect(existsSync(join(tmpdir(), "escaped.jpg"))).toBe(false);
    expect(existsSync(join(importStagingDir(), "escaped.jpg"))).toBe(false);
    expect(readdirSync(root)).toEqual(["kept.jpg"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("unpacks a zip that holds a `/` entry of its own, as a Dropbox download does", async () => {
    const zip = join(work, "dropbox.zip");
    writeFileSync(zip, zipOf({ "/": "", "beach.jpg": "root photo", "Trip/sea.jpg": "album photo" }));

    const root = await unpackZip(zip, isMedia);

    expect(readFileSync(join(root, "beach.jpg"), "utf8")).toBe("root photo");
    expect(readFileSync(join(root, "Trip", "sea.jpg"), "utf8")).toBe("album photo");
    rmSync(root, { recursive: true, force: true });
  });

  it("gives each unpacked file the time its zip entry records", async () => {
    const zip = join(work, "dated.zip");
    writeFileSync(zip, zipOf({ "a.jpg": "x" }, new Date(2019, 6, 14, 9, 30, 20)));

    const root = await unpackZip(zip, isMedia);

    expect(statSync(join(root, "a.jpg")).mtime.getTime()).toBe(new Date(2019, 6, 14, 9, 30, 20).getTime());
    rmSync(root, { recursive: true, force: true });
  });

  it("leaves the unpack time on a file whose zip entry records no time", async () => {
    const zip = join(work, "undated.zip");
    writeFileSync(zip, zipOf({ "a.jpg": "x" }));
    const before = Date.now() - 5_000;

    const root = await unpackZip(zip, isMedia);

    expect(statSync(join(root, "a.jpg")).mtime.getTime()).toBeGreaterThan(before);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("importing an export", () => {
  /** An uploader that records what each file went up with. `existing` names files the library has. */
  function recorder(existing: Record<string, string> = {}) {
    const uploads: { name: string; meta: any; uid: string }[] = [];
    const added: { album: string; uids: string[] }[] = [];
    const photos = {
      findPhotoDuplicates: async (name: string): Promise<string[]> =>
        existing[name] ? [existing[name]] : [],
      getFileUploader: async (name: string, meta: any) => {
        const uid = `uid-${uploads.length + 1}`;
        uploads.push({ name, meta, uid });
        return {
          uploadFromStream: async (stream: ReadableStream) => {
            const reader = stream.getReader();
            while (!(await reader.read()).done) {
              /* discarded */
            }
            return { completion: async () => ({ nodeUid: uid }) };
          },
        };
      },
      experimental: { iterateAlbumUids: async function* () {} },
      iterateNodes: async function* () {},
      iterateAlbum: async function* () {},
      createAlbum: async (name: string) => ({ uid: `album-${name}`, name }),
      addPhotosToAlbum: async function* (album: string, uids: string[]) {
        added.push({ album, uids });
        for (const uid of uids) yield { uid, ok: true };
      },
      deleteAlbum: async () => {},
    };
    return { photos, uploads, added };
  }

  async function settle(until: (s: ReturnType<typeof getUploadStatus>) => boolean) {
    for (let tick = 0; tick < 500; tick++) {
      const s = getUploadStatus();
      if (until(s)) return s;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("the import never settled");
  }

  const finished = (s: ReturnType<typeof getUploadStatus>) =>
    !s.importing && !s.running && s.total > 0 && s.done + s.skipped + s.failed === s.total;

  /** Runs an import up to its review, with every item checked against the library. */
  async function toReview(paths: string[], photos: any) {
    startImport(paths);
    const ready = await settle((s) => s.importing?.phase === "ready");
    // The status is one live record, so the folders are read before it moves on.
    const roots = [...ready.importing!.roots!];
    prepareImport(photos);
    await settle(
      (s) => s.importing?.phase === "review" && s.importing.checked === s.importing.items,
    );
    return { roots, review: getImportReview()!, checks: getImportChecks()! };
  }

  it("reviews a zip export before anything uploads, then uploads it with its metadata", async () => {
    const zip = join(work, "ente.zip");
    writeFileSync(
      zip,
      zipOf({
        "Trip/beach.jpg": await jpeg(120),
        "Trip/metadata/beach.jpg.json": sidecar(1595500000, {
          geoData: { latitude: 41.38, longitude: 2.17 },
          favorited: true,
        }),
      }),
    );
    const { photos, uploads, added } = recorder();

    const { roots, review } = await toReview([zip], photos);

    expect(uploads).toHaveLength(0);
    expect(review.items).toHaveLength(1);
    expect(review.items[0]).toMatchObject({ name: "beach.jpg", album: "Trip", takenMs: 1595500000000 });
    expect(review.items[0].latitude).toBe(41.38);

    confirmImport(photos);
    const done = await settle(finished);

    expect(done.done).toBe(1);
    expect(uploads[0].meta.captureTime.getTime()).toBe(1595500000000);
    expect(uploads[0].meta.additionalMetadata.Location).toEqual({ Latitude: 41.38, Longitude: 2.17 });
    expect(uploads[0].meta.tags).toContain(PhotoTag.Favorites);
    expect(added).toEqual([{ album: "album-Trip", uids: ["uid-1"] }]);
    // The unpacked export is gone once its last photo is in.
    await settle(() => !existsSync(roots[0]));
  });

  it("marks what the library already has, and leaves out what was taken off the list", async () => {
    const root = tree("review-pick", {
      "Trip/old.jpg": await jpeg(10),
      "Trip/new.jpg": await jpeg(20),
      "Trip/skip.jpg": await jpeg(30),
    });
    const { photos, uploads } = recorder({ "old.jpg": "existing-old" });

    const { review, checks } = await toReview([root], photos);
    const id = (name: string) => review.items.find((i) => i.name === name)!.id;

    expect(checks.checks[id("old.jpg")]).toBe("already");
    expect(checks.checks[id("new.jpg")]).toBe("new");

    confirmImport(photos, [id("skip.jpg")]);
    const done = await settle(finished);

    expect(uploads.map((u) => u.name)).toEqual(["new.jpg"]);
    expect(done.skipped).toBe(1);
    expect(done.total).toBe(2);
  });

  it("refuses an Import pressed before the check ends, and then uploads only what is new", async () => {
    const root = tree("confirm-early", {
      "A/old.jpg": await jpeg(11),
      "A/new.jpg": await jpeg(12),
    });
    const { photos, uploads } = recorder({ "old.jpg": "existing-old" });
    // The library check is slow, so the review is confirmed with nothing checked yet.
    const answer = photos.findPhotoDuplicates;
    let slow = true;
    photos.findPhotoDuplicates = async (name: string) => {
      if (slow) await new Promise((r) => setTimeout(r, 300));
      return answer(name);
    };

    startImport([root]);
    await settle((s) => s.importing?.phase === "ready");
    prepareImport(photos);
    await settle((s) => s.importing?.phase === "review");
    expect(getUploadStatus().importing?.checked).toBe(0);
    expect(() => confirmImport(photos)).toThrow();
    slow = false;
    await settle((s) => (s.importing?.checked ?? 0) === 2);
    confirmImport(photos);
    const done = await settle(finished);

    expect(uploads.map((u) => u.name)).toEqual(["new.jpg"]);
    expect(done.done).toBe(1);
    expect(done.skipped).toBe(1);
  });

  it("does not ask the library again about what the review found new", async () => {
    const root = tree("no-second-check", { "A/one.jpg": await jpeg(90), "A/two.jpg": await jpeg(95) });
    const { photos } = recorder();
    let asked = 0;
    const find = photos.findPhotoDuplicates;
    photos.findPhotoDuplicates = async (name: string) => {
      asked++;
      return find(name);
    };

    await toReview([root], photos);
    expect(asked).toBe(2);
    confirmImport(photos);
    const done = await settle(finished);

    expect(done.done).toBe(2);
    expect(asked).toBe(2);
  });

  it("uploads a Live Photo's video as part of its photo", async () => {
    const root = tree("live-upload", {
      "Trip/IMG_1234.jpg": await jpeg(50),
      "Trip/IMG_1234.mov": Buffer.alloc(4096, 1),
    });
    const { photos, uploads, added } = recorder();

    const { review } = await toReview([root], photos);
    expect(review.items).toHaveLength(1);
    expect(review.items[0].live?.name).toBe("IMG_1234.mov");

    confirmImport(photos);
    const done = await settle(finished);

    expect(done.done).toBe(2);
    const still = uploads.find((u) => u.name === "IMG_1234.jpg")!;
    const motion = uploads.find((u) => u.name === "IMG_1234.mov")!;
    expect(still.meta.tags).toContain(PhotoTag.LivePhotos);
    expect(motion.meta.mainPhotoNodeUid).toBe(still.uid);
    // Only the photo goes into the album: its video comes along with it.
    expect(added).toEqual([{ album: "album-Trip", uids: [still.uid] }]);
  });

  it("uploads a photo copied into two albums once, and puts it in both", async () => {
    const photo = await jpeg(80);
    const root = tree("two-albums", { "Trip/a.jpg": photo, "Party/a.jpg": photo });
    const { photos, uploads, added } = recorder();

    const { review } = await toReview([root], photos);
    expect(review.items).toHaveLength(1);

    confirmImport(photos);
    const done = await settle((s) => finished(s) && added.length === 2);

    expect(uploads).toHaveLength(1);
    expect(done.total).toBe(1);
    expect(added.map((a) => a.album).sort()).toEqual(["album-Party", "album-Trip"]);
    expect(added.every((a) => a.uids.length === 1 && a.uids[0] === uploads[0].uid)).toBe(true);
  });

  it("uploads a Live Photo's two files separately when asked to", async () => {
    const root = tree("live-separate", {
      "A/IMG_7.jpg": await jpeg(60),
      "A/IMG_7.mov": Buffer.alloc(4096, 2),
    });
    const { photos, uploads } = recorder();

    await toReview([root], photos);
    confirmImport(photos, [], true, false);
    await settle(finished);

    expect(uploads).toHaveLength(2);
    expect(uploads.every((u) => !u.meta.mainPhotoNodeUid)).toBe(true);
  });

  it("deletes the unpacked export when the review is discarded", async () => {
    const zip = join(work, "discard.zip");
    writeFileSync(zip, zipOf({ "A/x.jpg": await jpeg(70) }));
    const { photos, uploads } = recorder();

    const { roots } = await toReview([zip], photos);
    discardImport();

    await settle(() => !existsSync(roots[0]));
    expect(getImportReview()).toBeNull();
    expect(getUploadStatus().importing).toBeUndefined();
    expect(uploads).toHaveLength(0);
  });

  it("imports a plain zip of photos with no sidecars: root photos on the timeline, a folder as an album", async () => {
    const zip = join(work, "plain.zip");
    const shot = await sharp(await jpeg(150))
      .withExif({ IFD2: { DateTimeOriginal: "2021:03:04 05:06:07" } })
      .jpeg()
      .toBuffer();
    writeFileSync(zip, zipOf({ "/": "", "IMG_beach.jpg": await jpeg(30), "Trip/IMG_sea.jpg": shot }, new Date(2018, 1, 2, 3, 4, 6)));
    const { photos, uploads, added } = recorder();

    const { roots, review } = await toReview([zip], photos);

    const byName = Object.fromEntries(review.items.map((i) => [i.name, i]));
    expect(byName["IMG_beach.jpg"]).toMatchObject({ album: null, takenMs: new Date(2018, 1, 2, 3, 4, 6).getTime() });
    expect(byName["IMG_sea.jpg"]).toMatchObject({ album: "Trip", takenMs: new Date(2021, 2, 4, 5, 6, 7).getTime() });

    confirmImport(photos);
    const done = await settle(finished);

    expect(done.done).toBe(2);
    const sent = Object.fromEntries(uploads.map((u) => [u.name, u.meta.captureTime.getTime()]));
    expect(sent).toEqual({
      "IMG_beach.jpg": new Date(2018, 1, 2, 3, 4, 6).getTime(),
      "IMG_sea.jpg": new Date(2021, 2, 4, 5, 6, 7).getTime(),
    });
    expect(added).toHaveLength(1);
    expect(added[0].album).toBe("album-Trip");
    await settle(() => !existsSync(roots[0]));
  });

  it("reports an export with nothing in it", async () => {
    const root = tree("empty-export", { "notes.txt": "nothing to see" });

    startImport([root]);
    await settle((s) => s.importing?.phase === "ready");
    prepareImport(recorder().photos);
    const s = await settle((x) => !x.importing && !!x.importError);

    expect(s.importError).toMatch(/No photos or videos/);
  });
});
