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

/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";

import exifr from "exifr";

import {
  asksForChange,
  canCarryDate,
  claimChangedByStrip,
  DateEditor,
  META_READ_MAX_BYTES,
  mergeMeta,
  metaChanges,
  metaInfo,
  missingTags,
  replacedBy,
  replaceOne,
  replacing,
  sameCapture,
  type SentCopy,
  samePlace,
  withClaimedPlace,
  withClaimedStrip,
  type DateEditDeps,
} from "./dateEdit.ts";
import { readTextMeta } from "./metaEdit.ts";
import { emptyLabels, rekeyLabels, setLabels } from "./labelStore.ts";
import { HiddenStore } from "./hidden.ts";
import { emptyPeople, type PeopleState } from "./faceStore.ts";
import { curationKey, rekeyPeople } from "./facePeople.ts";
import { StoreLockedError } from "./store.ts";

const OLD = "vol~old";
const NEW = "vol~new";
const WANT = Date.UTC(2021, 5, 4, 10, 30, 0);
const BEFORE = Date.UTC(2024, 0, 1, 12, 0, 0);

let jpeg: Buffer;
beforeAll(async () => {
  jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#808080" } }).jpeg().toBuffer();
});

type Fake = {
  photos: any;
  uploads: number;
  calls: string[];
  nodes: Map<string, any>;
  /** Runs as a copy finishes going up, before Drive answers with it. */
  onUploaded?: () => void | Promise<void>;
};

/** A Drive that keeps nodes in a map, and a session around it that writes down what it was asked. */
function fake(opts: { albums?: string[]; tags?: number[]; live?: boolean; keepsDate?: boolean; joinFails?: boolean } = {}) {
  const f: Fake = { photos: null, uploads: 0, calls: [], nodes: new Map() };
  f.nodes.set(OLD, {
    uid: OLD,
    name: { ok: true, value: "IMG_1.jpg" },
    mediaType: "image/jpeg",
    activeRevision: { ok: true, value: { claimedAdditionalMetadata: { Camera: { Model: "x" } } } },
    photo: {
      captureTime: new Date(BEFORE),
      tags: opts.tags ?? [],
      albums: (opts.albums ?? []).map((nodeUid) => ({ nodeUid })),
      relatedPhotoNodeUids: opts.live ? ["vol~video"] : [],
    },
  });
  f.photos = {
    getNode: async (uid: string) => f.nodes.get(uid),
    nodes: { access: { notifyNodeChanged: async () => {} } },
    getFileDownloader: async () => ({
      downloadToStream: (stream: WritableStream<Uint8Array>) => ({
        completion: async () => {
          const w = stream.getWriter();
          await w.write(new Uint8Array(jpeg));
          await w.close();
        },
      }),
    }),
    iterateThumbnails: async function* () {},
    getFileUploader: async (name: string, meta: any) => {
      f.uploads++;
      f.calls.push("upload");
      // The first copy is NEW, a later one NEW2, NEW3 and so on.
      const uid = f.uploads === 1 ? NEW : `${NEW}${f.uploads}`;
      return {
        uploadFromStream: async () => ({
          completion: async () => {
            await f.onUploaded?.();
            f.nodes.set(uid, {
              uid,
              sha1: meta.expectedSha1,
              name: { ok: true, value: name },
              mediaType: "image/jpeg",
              activeRevision: { ok: true, value: { claimedAdditionalMetadata: {} } },
              photo: {
                captureTime: opts.keepsDate ? new Date(BEFORE) : meta.captureTime,
                tags: [],
                albums: [],
                relatedPhotoNodeUids: [],
              },
            });
            return { nodeUid: uid };
          },
        }),
      };
    },
    findPhotoDuplicates: async (name: string, sha1: () => Promise<string>) => {
      f.calls.push("lookup");
      const want = await sha1();
      return [...f.nodes.values()].filter((n) => n.name?.value === name && n.sha1 === want).map((n) => n.uid);
    },
    updatePhotos: async function* (updates: any[]) {
      f.calls.push(`tags:${updates[0].tagsToAdd.join(",")}`);
      f.nodes.get(updates[0].nodeUid).photo.tags.push(...updates[0].tagsToAdd);
      yield { ok: true, uid: updates[0].nodeUid };
    },
  };
  const deps: DateEditDeps = {
    photos: f.photos,
    addToAlbum: async (album, uids) => {
      f.calls.push(`album:${album}`);
      if (opts.joinFails) return uids.map((uid) => ({ uid, ok: false }));
      f.nodes.get(uids[0]!).photo.albums.push({ nodeUid: album });
      return uids.map((uid) => ({ uid, ok: true }));
    },
    trash: async (uids) => {
      f.calls.push(`trash:${uids.join(",")}`);
      for (const uid of uids) if (f.nodes.has(uid)) f.nodes.get(uid).trashTime = new Date();
      return uids.map((uid) => ({ uid, ok: true }));
    },
    carry: async (from, to) => {
      f.calls.push(`carry:${from}>${to}`);
    },
  };
  return { f, deps };
}

describe("changing a Drive photo's date", () => {
  it("carries a favourite another device gave the photo after this app cached it", async () => {
    const { f, deps } = fake({ tags: [] });
    // The SDK's cached copy predates the favourite; only a re-read after notifyNodeChanged sees it.
    let notified = false;
    const cached = f.nodes.get(OLD);
    const current = { ...cached, photo: { ...cached.photo, tags: [0] } };
    f.photos.nodes.access.notifyNodeChanged = async (uid: string) => {
      if (uid === OLD) notified = true;
    };
    f.photos.getNode = async (uid: string) => (uid === OLD ? (notified ? current : cached) : f.nodes.get(uid));
    const entry: any = { uid: OLD, captureMs: WANT, stage: "queued" };
    expect(await replaceOne(deps, entry, () => {})).toBe("changed");
    expect(f.calls).toContain("tags:0");
  });

  it("replaces it with a copy in every album, its tags and data carried, and trashes the original last", async () => {
    const { f, deps } = fake({ albums: ["vol~a1", "vol~a2"], tags: [0] });
    const entry: any = { uid: OLD, captureMs: WANT, stage: "queued" };
    expect(await replaceOne(deps, entry, () => {})).toBe("changed");
    expect(f.calls).toEqual(["upload", "tags:0", "album:vol~a1", "album:vol~a2", `carry:${OLD}>${NEW}`, `trash:${OLD}`]);
    expect(f.nodes.get(NEW).photo.captureTime.getTime()).toBe(WANT);
  });

  it("leaves a photo that already shows the date alone", async () => {
    const { f, deps } = fake();
    f.nodes.get(OLD).photo.captureTime = new Date(WANT + 400);
    expect(await replaceOne(deps, { uid: OLD, captureMs: WANT, stage: "queued" } as any, () => {})).toBe("unchanged");
    expect(f.calls).toEqual([]);
  });

  it("keeps the original when the copy cannot join one of its albums", async () => {
    const { f, deps } = fake({ albums: ["vol~a1"], joinFails: true });
    await expect(replaceOne(deps, { uid: OLD, captureMs: WANT, stage: "queued" } as any, () => {})).rejects.toThrow(/album/);
    expect(f.calls.some((c) => c.startsWith("trash"))).toBe(false);
    expect(f.calls.some((c) => c.startsWith("carry"))).toBe(false);
  });

  it("keeps the original when Drive did not take the new date", async () => {
    const { f, deps } = fake({ keepsDate: true });
    await expect(replaceOne(deps, { uid: OLD, captureMs: WANT, stage: "queued" } as any, () => {})).rejects.toThrow(/date/);
    expect(f.calls).toEqual(["upload"]);
  });

  it("carries on after a restart without a second upload", async () => {
    const { f, deps } = fake({ albums: ["vol~a1"] });
    const entry: any = { uid: OLD, captureMs: WANT, stage: "queued" };
    const saves: string[] = [];
    // The first run stops right after the upload was recorded.
    await expect(
      replaceOne(deps, entry, () => {
        saves.push(entry.stage);
        if (entry.stage === "uploaded") throw new Error("stopped");
      }),
    ).rejects.toThrow("stopped");
    expect(entry).toMatchObject({ stage: "uploaded", newUid: NEW, albums: ["vol~a1"] });
    expect(await replaceOne(deps, entry, () => {})).toBe("changed");
    expect(f.uploads).toBe(1);
    expect(f.calls.at(-1)).toBe(`trash:${OLD}`);
  });

  it("never changes one half of a Live Photo", async () => {
    const { f, deps } = fake({ live: true });
    await expect(replaceOne(deps, { uid: OLD, captureMs: WANT, stage: "queued" } as any, () => {})).rejects.toThrow(/Live Photo/);
    expect(f.uploads).toBe(0);
  });

  it("knows what counts as the same date, which tags are missing and which files can carry a date", () => {
    expect(sameCapture(WANT, WANT + 999)).toBe(true);
    expect(sameCapture(WANT, WANT + 60_000)).toBe(false);
    expect(missingTags({ photo: { tags: [3] } }, [0, 3])).toEqual([0]);
    expect(canCarryDate("image/jpeg")).toBe(true);
    expect(canCarryDate("video/quicktime")).toBe(true);
    expect(canCarryDate("image/webp")).toBe(false);
  });
});

/** The fake with the upload's metadata and bytes written down. */
function recording(opts: Parameters<typeof fake>[0] = {}) {
  const made = fake(opts);
  const seen: { meta: any; bytes: Buffer | null } = { meta: null, bytes: null };
  const upload = made.f.photos.getFileUploader;
  made.f.photos.getFileUploader = async (name: string, meta: any) => {
    seen.meta = meta;
    const inner = await upload(name, meta);
    return {
      uploadFromStream: async (stream: ReadableStream<Uint8Array>, thumbs: any) => {
        const chunks: Uint8Array[] = [];
        const reader = stream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        seen.bytes = Buffer.concat(chunks);
        return inner.uploadFromStream(stream, thumbs);
      },
    };
  };
  return { ...made, seen };
}

describe("changing a Drive photo's place", () => {
  it("writes the place into the JPEG and beside it, keeping the date", async () => {
    const { f, deps, seen } = recording({ albums: ["vol~a1"] });
    const entry: any = { uid: OLD, captureMs: 0, place: { lat: 47.4979, lon: 19.0402 }, stage: "queued" };
    expect(await replaceOne(deps, entry, () => {})).toBe("changed");
    expect(seen.meta.captureTime.getTime()).toBe(BEFORE);
    expect(seen.meta.additionalMetadata.Location).toEqual({ Latitude: 47.4979, Longitude: 19.0402 });
    expect(seen.meta.additionalMetadata.Camera).toEqual({ Model: "x" });
    const gps = await exifr.gps(seen.bytes!);
    expect(gps.latitude).toBeCloseTo(47.4979, 4);
    expect(gps.longitude).toBeCloseTo(19.0402, 4);
    expect(f.calls.at(-1)).toBe(`trash:${OLD}`);
  });

  it("takes a place away, and leaves a photo already there alone", async () => {
    const placed = recording();
    placed.f.nodes.get(OLD).activeRevision.value.claimedAdditionalMetadata = { Location: { Latitude: 10, Longitude: 20 } };
    const removed: any = { uid: OLD, captureMs: 0, place: null, stage: "queued" };
    expect(await replaceOne(placed.deps, removed, () => {})).toBe("changed");
    expect(placed.seen.meta.additionalMetadata.Location).toBeUndefined();

    const same = recording();
    same.f.nodes.get(OLD).activeRevision.value.claimedAdditionalMetadata = { Location: { Latitude: 10, Longitude: 20 } };
    const entry: any = { uid: OLD, captureMs: 0, place: { lat: 10, lon: 20 }, stage: "queued" };
    expect(await replaceOne(same.deps, entry, () => {})).toBe("unchanged");
    expect(same.f.uploads).toBe(0);
  });

  it("changes the date and the place in one copy", async () => {
    const { seen, deps } = recording();
    const entry: any = { uid: OLD, captureMs: WANT, place: { lat: -33.45, lon: -70.67 }, stage: "queued" };
    expect(await replaceOne(deps, entry, () => {})).toBe("changed");
    expect(seen.meta.captureTime.getTime()).toBe(WANT);
    expect(seen.meta.additionalMetadata.Location).toEqual({ Latitude: -33.45, Longitude: -70.67 });
    expect((await exifr.gps(seen.bytes!)).latitude).toBeCloseTo(-33.45, 4);
  });

  it("knows what asks for a change and what counts as the same place", () => {
    expect(asksForChange({ uid: "a", captureMs: 0, place: null })).toBe(true);
    expect(asksForChange({ uid: "a", captureMs: 0 })).toBe(false);
    expect(asksForChange({ uid: "a", captureMs: 0, place: { lat: 91, lon: 0 } })).toBe(false);
    expect(samePlace([1, 2], { lat: 1.0000001, lon: 2 })).toBe(true);
    expect(samePlace(null, null)).toBe(true);
    expect(samePlace([1, 2], null)).toBe(false);
    expect(withClaimedPlace({ Location: { Latitude: 1 }, Camera: {} }, null)).toEqual({ Camera: {} });
  });
});

describe("description, copyright and private info", () => {
  let plain: Buffer;
  beforeAll(() => {
    plain = jpeg;
  });
  afterEach(() => {
    jpeg = plain;
  });

  const stamped = async () =>
    sharp({ create: { width: 8, height: 8, channels: 3, background: "#808080" } })
      .jpeg()
      .withExif({ IFD0: { Make: "RealMaker", ImageDescription: "old words" }, IFD2: { DateTimeOriginal: "2024:01:01 12:00:00" } })
      .toBuffer();

  it("writes the text into the copy, keeping the date, the albums and the trash order", async () => {
    const { f, deps, seen } = recording({ albums: ["vol~a1"], tags: [0] });
    const entry: any = { uid: OLD, captureMs: 0, meta: { kind: "text", description: "Sunset", copyright: "(c) Ann" }, stage: "queued" };
    expect(await replaceOne(deps, entry, () => {})).toBe("changed");
    expect(readTextMeta(seen.bytes!)).toMatchObject({ description: "Sunset", copyright: "(c) Ann" });
    expect(seen.meta.captureTime.getTime()).toBe(BEFORE);
    expect(seen.meta.additionalMetadata.Camera).toEqual({ Model: "x" });
    expect(f.calls).toEqual(["upload", "tags:0", "album:vol~a1", `carry:${OLD}>${NEW}`, `trash:${OLD}`]);
  });

  it("leaves a photo that already holds the text alone", async () => {
    const same = recording();
    jpeg = await stamped();
    const entry: any = { uid: OLD, captureMs: 0, meta: { kind: "text", description: "old words" }, stage: "queued" };
    expect(await replaceOne(same.deps, entry, () => {})).toBe("unchanged");
    expect(same.f.uploads).toBe(0);
  });

  it("strips the place and the camera from the file and from the claim", async () => {
    jpeg = await stamped();
    const { f, deps, seen } = recording();
    f.nodes.get(OLD).activeRevision.value.claimedAdditionalMetadata = {
      Location: { Latitude: 1, Longitude: 2 },
      Camera: { Device: "RealMaker", CaptureTime: "2024-01-01T12:00:00.000+00:00" },
    };
    const entry: any = { uid: OLD, captureMs: 0, meta: { kind: "strip", location: true, camera: true, text: false }, stage: "queued" };
    expect(await replaceOne(deps, entry, () => {})).toBe("changed");
    expect(seen.bytes!.includes(Buffer.from("RealMaker"))).toBe(false);
    expect(seen.bytes!.includes(Buffer.from("old words"))).toBe(true);
    expect(seen.meta.additionalMetadata.Location).toBeUndefined();
    expect(seen.meta.additionalMetadata.Camera).toEqual({ CaptureTime: "2024-01-01T12:00:00.000+00:00" });
    expect(seen.meta.captureTime.getTime()).toBe(BEFORE);
    expect(f.calls.at(-1)).toBe(`trash:${OLD}`);
  });

  it("leaves a clean photo alone when asked to strip it", async () => {
    jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#808080" } }).jpeg().toBuffer();
    const { f, deps } = recording();
    const entry: any = { uid: OLD, captureMs: 0, meta: { kind: "strip", location: true, camera: true, text: true }, stage: "queued" };
    expect(await replaceOne(deps, entry, () => {})).toBe("unchanged");
    expect(f.uploads).toBe(0);
  });

  it("refuses a file type it cannot write, with the original untouched", async () => {
    const { f, deps } = recording();
    f.nodes.get(OLD).mediaType = "image/heic";
    const entry: any = { uid: OLD, captureMs: 0, meta: { kind: "text", description: "x" }, stage: "queued" };
    await expect(replaceOne(deps, entry, () => {})).rejects.toThrow(/JPEG and PNG/);
    f.nodes.get(OLD).mediaType = "video/mp4";
    await expect(replaceOne(deps, { ...entry, meta: { kind: "strip", location: true, camera: false, text: false } }, () => {})).rejects.toThrow(/JPEG and PNG/);
    expect(f.calls).toEqual([]);
  });

  it("changes the date and the text in one copy", async () => {
    const { seen, deps } = recording();
    const entry: any = { uid: OLD, captureMs: WANT, meta: { kind: "text", author: "Ann" }, stage: "queued" };
    expect(await replaceOne(deps, entry, () => {})).toBe("changed");
    expect(seen.meta.captureTime.getTime()).toBe(WANT);
    expect(readTextMeta(seen.bytes!)?.author).toBe("Ann");
  });

  it("asks for a change only with a valid request, and takes the claim's place and device out", () => {
    expect(asksForChange({ uid: "a", captureMs: 0, meta: { kind: "text", description: "x" } })).toBe(true);
    expect(asksForChange({ uid: "a", captureMs: 0, meta: { kind: "strip", location: false, camera: false, text: false } })).toBe(false);
    expect(asksForChange({ uid: "a", captureMs: 0, meta: { kind: "other" } as any })).toBe(false);
    expect(withClaimedStrip({ Location: {}, Camera: { Device: "d", SubjectCoordinates: {}, Orientation: 1 } }, { location: false, camera: true })).toEqual({
      Location: {},
      Camera: { SubjectCoordinates: {}, Orientation: 1 },
    });
  });

  it("reads the text of one photo for the panels and says why another cannot change", async () => {
    jpeg = await stamped();
    const { f } = recording();
    f.nodes.set("vol~mov", { uid: "vol~mov", name: { ok: true, value: "a.mov" }, mediaType: "video/quicktime", photo: { relatedPhotoNodeUids: [] } });
    const [one] = await metaInfo(f.photos, [OLD], true);
    expect(one).toMatchObject({ name: "IMG_1.jpg", blocked: null, text: { description: "old words" } });
    const [video] = await metaInfo(f.photos, ["vol~mov"], true);
    expect(video).toMatchObject({ blocked: "type", text: null });
    const [gone] = await metaInfo({ getNode: async () => { throw new Error("x"); } }, ["vol~x"], false);
    expect(gone.blocked).toBe("read");
  });
});

describe("what this computer keeps by a photo, moved to its copy", () => {
  it("moves the labels, leaving the old link an empty, newer entry", () => {
    const state = emptyLabels();
    setLabels(state, "old", ["Trip"], 1);
    expect(rekeyLabels(state, "old", "new", 5)).toBe(true);
    expect(state.photos.new.l).toEqual(["Trip"]);
    expect(state.photos.old).toEqual({ l: [], t: 5 });
    expect(rekeyLabels(state, "old", "new", 6)).toBe(false);
  });

  it("hides the copy of a hidden photo and lists it in its hidden albums", () => {
    const store = new HiddenStore(false);
    store.set("photos", [OLD], true, 1);
    store.set("albums", ["vol~album"], true, 1, new Map([["vol~album", [OLD]]]));
    expect(store.rekeyPhoto(OLD, NEW, 2)).toBe(true);
    const hidden = store.hiddenPhotoTest();
    expect(hidden(NEW)).toBe(true);
    expect(store.rekeyPhoto(OLD, NEW, 3)).toBe(false);
  });

  it("points the people's choices about the faces at the copy", () => {
    const p: PeopleState = emptyPeople();
    p.assign[`${OLD}#0`] = "p1";
    p.confirmed[`${OLD}#0`] = "Anna";
    p.blocked[`${OLD}#1`] = ["Bob"];
    p.rejected = [`${OLD}#2`, "vol~other#0"];
    p.covers.Anna = OLD;
    p.curation[curationKey(2, "Bob", "old#1")] = { kind: 2, name: "Bob", ref: "old#1", removed: false, at: 1 };
    p.curation[curationKey(1, "Anna", "old")] = { kind: 1, name: "Anna", ref: "old", removed: false, at: 1 };
    const ids = new Map([0, 1, 2].map((i) => [`${OLD}#${i}`, `${NEW}#${i}`]));
    rekeyPeople(p, OLD, NEW, ids);
    expect(p.assign).toEqual({ [`${NEW}#0`]: "p1" });
    expect(p.confirmed).toEqual({ [`${NEW}#0`]: "Anna" });
    expect(p.blocked).toEqual({ [`${NEW}#1`]: ["Bob"] });
    expect(p.rejected).toEqual([`${NEW}#2`, "vol~other#0"]);
    expect(p.covers.Anna).toBe(NEW);
    expect(Object.values(p.curation).map((c) => c.ref).sort()).toEqual(["new", "new#1"]);
    expect(p.curation[curationKey(2, "Bob", "new#1")]).toBeDefined();
  });
});

describe("the queue", () => {
  let plain: Buffer;
  beforeAll(() => {
    plain = jpeg;
  });
  afterEach(() => {
    jpeg = plain;
  });

  const stamped = () =>
    sharp({ create: { width: 8, height: 8, channels: 3, background: "#808080" } })
      .jpeg()
      .withExif({ IFD0: { Make: "RealMaker", ImageDescription: "old words" } })
      .toBuffer();

  /** Resolves once the editor has nothing running. */
  async function settled(editor: DateEditor): Promise<void> {
    for (let i = 0; i < 200 && editor.getStatus().running; i++) await new Promise((r) => setTimeout(r, 5));
  }

  it("merges a second metadata request for a waiting photo field by field", () => {
    const strip = { kind: "strip", location: true, camera: false, text: false } as const;
    const merged = mergeMeta(mergeMeta([], strip), { kind: "text", description: "Sunset" });
    expect(merged).toEqual([strip, { kind: "text", description: "Sunset" }]);
    const again = mergeMeta(merged, { kind: "text", copyright: "(c) Ann", description: "Dusk" });
    expect(again[1]).toEqual({ kind: "text", description: "Dusk", copyright: "(c) Ann" });
    expect(mergeMeta(again, { kind: "strip", location: false, camera: true, text: false })[0]).toEqual({ kind: "strip", location: true, camera: true, text: false });
    expect(mergeMeta(again, { kind: "strip", location: false, camera: false, text: true })).toEqual([{ kind: "strip", location: true, camera: false, text: true }]);
    expect(metaChanges([strip, { kind: "text", author: "A" }, { kind: "bogus" }])).toHaveLength(2);
  });

  it("keeps the strip when a description follows it for the same photo, and writes both into one copy", async () => {
    jpeg = await stamped();
    const { f, deps, seen } = recording();
    f.nodes.get(OLD).activeRevision.value.claimedAdditionalMetadata = { Location: { Latitude: 1, Longitude: 2 }, Camera: { Device: "RealMaker" } };
    const editor = new DateEditor(() => {});
    editor.start([{ uid: OLD, captureMs: 0, meta: { kind: "strip", location: true, camera: true, text: false } }]);
    editor.start([{ uid: OLD, captureMs: 0, meta: { kind: "text", description: "Sunset" } }]);
    expect(editor.getStatus().total).toBe(1);
    editor.attach(deps, []);
    await settled(editor);
    expect(editor.getStatus()).toMatchObject({ changed: 1, failed: 0 });
    expect(f.uploads).toBe(1);
    expect(seen.bytes!.includes(Buffer.from("RealMaker"))).toBe(false);
    expect(readTextMeta(seen.bytes!)?.description).toBe("Sunset");
    expect(seen.meta.additionalMetadata.Location).toBeUndefined();
  });

  it("reports a photo asked for again while it is being replaced, never dropping it silently", async () => {
    const { f, deps } = recording();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const getNode = f.photos.getNode;
    f.photos.getNode = async (uid: string) => {
      await gate;
      return getNode(uid);
    };
    const editor = new DateEditor(() => {});
    editor.attach(deps, []);
    editor.start([{ uid: OLD, captureMs: WANT }]);
    await new Promise((r) => setTimeout(r, 5));
    const status = editor.start([{ uid: OLD, captureMs: 0, meta: { kind: "text", description: "Later" } }]);
    expect(status.errors).toEqual([{ uid: OLD, error: expect.stringMatching(/still being changed/), code: "busy" }]);
    expect(status.total).toBe(2);
    release();
    await settled(editor);
    expect(editor.getStatus()).toMatchObject({ total: 2, done: 2, changed: 1, failed: 1 });
    expect(f.uploads).toBe(1);
  });

  it("drops the photos not started when stopped, and takes new ones after", async () => {
    const { f, deps } = recording();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const getNode = f.photos.getNode;
    f.photos.getNode = async (uid: string) => {
      await gate;
      return getNode(uid);
    };
    f.nodes.set("vol~two", { ...f.nodes.get(OLD), uid: "vol~two" });
    const editor = new DateEditor(() => {});
    editor.attach(deps, []);
    editor.start([{ uid: OLD, captureMs: WANT }, { uid: "vol~two", captureMs: WANT }]);
    await new Promise((r) => setTimeout(r, 5));
    expect(editor.stop().cancelled).toBe(true);
    release();
    await settled(editor);
    expect(editor.getStatus()).toMatchObject({ done: 1, changed: 1 });
  });

  it("strips the place Drive holds beside a file that has none in it", async () => {
    const { f, deps, seen } = recording();
    f.nodes.get(OLD).activeRevision.value.claimedAdditionalMetadata = { Location: { Latitude: 1, Longitude: 2 }, Camera: { Model: "x" } };
    const entry: any = { uid: OLD, captureMs: 0, meta: { kind: "strip", location: true, camera: false, text: false }, stage: "queued" };
    expect(await replaceOne(deps, entry, () => {})).toBe("changed");
    expect(seen.meta.additionalMetadata).toEqual({ Camera: { Model: "x" } });
    expect(seen.bytes!.equals(jpeg)).toBe(false);
    expect(claimChangedByStrip({ Camera: { Model: "x" } }, { location: true, camera: true })).toBe(false);
  });

  it("does not read the text of a file too large to hold whole", async () => {
    const { f } = recording();
    const downloader = f.photos.getFileDownloader;
    f.photos.getFileDownloader = async (uid: string) => ({ ...(await downloader(uid)), getClaimedSizeInBytes: () => META_READ_MAX_BYTES + 1 });
    f.nodes.set("vol~huge", { ...f.nodes.get(OLD), uid: "vol~huge" });
    const [one] = await metaInfo(f.photos, ["vol~huge"], true);
    expect(one).toMatchObject({ blocked: null, text: null });
  });
});

describe("a photo replaced again, and a replacement that fails after its copy is up", () => {
  afterEach(() => {
    replacedBy.clear();
    replacing.clear();
  });

  async function settled(editor: DateEditor): Promise<void> {
    for (let i = 0; i < 400 && editor.getStatus().running; i++) await new Promise((r) => setTimeout(r, 5));
  }

  it("works from the copy that took a trashed original's place, never from the original", async () => {
    const { f, deps } = fake();
    expect(await replaceOne(deps, { uid: OLD, captureMs: WANT, stage: "queued" } as any, () => {})).toBe("changed");
    expect(f.nodes.get(OLD).trashTime).toBeDefined();
    const later: any = { uid: OLD, captureMs: 0, place: { lat: 47.5, lon: 19.04 }, stage: "queued" };
    expect(await replaceOne(deps, later, () => {})).toBe("changed");
    expect(later.uid).toBe(NEW);
    expect(f.uploads).toBe(2);
    expect(f.calls.at(-1)).toBe(`trash:${NEW}`);
    expect(f.calls.filter((c) => c === `trash:${OLD}`)).toHaveLength(1);
  });

  it("refuses a photo in the trash that no replacement here took the place of", async () => {
    const { f, deps } = fake();
    f.nodes.get(OLD).trashTime = new Date();
    await expect(replaceOne(deps, { uid: OLD, captureMs: WANT, stage: "queued" } as any, () => {})).rejects.toThrow(/in the Drive trash/);
    expect(f.uploads).toBe(0);
  });

  it("takes a second change asked for the old photo onto its copy", async () => {
    const { f, deps } = fake();
    const editor = new DateEditor(() => {}, 1);
    editor.attach(deps, []);
    editor.start([{ uid: OLD, captureMs: WANT }]);
    await settled(editor);
    editor.start([{ uid: OLD, captureMs: 0, place: { lat: 47.5, lon: 19.04 } }]);
    await settled(editor);
    expect(editor.getStatus()).toMatchObject({ changed: 1, failed: 0 });
    expect(f.uploads).toBe(2);
    expect(f.calls.at(-1)).toBe(`trash:${NEW}`);
    expect(f.nodes.get(`${NEW}2`).trashTime).toBeUndefined();
  });

  it("tries the rest again after a passing failure, without a second upload", async () => {
    const { f, deps } = fake({ albums: ["vol~a1"] });
    const add = deps.addToAlbum;
    let failures = 1;
    deps.addToAlbum = async (album, uids) => (failures-- > 0 ? uids.map((uid) => ({ uid, ok: false })) : add(album, uids));
    const editor = new DateEditor(() => {}, 1);
    editor.attach(deps, []);
    editor.start([{ uid: OLD, captureMs: WANT }]);
    await settled(editor);
    expect(editor.getStatus()).toMatchObject({ changed: 1, failed: 0 });
    expect(f.uploads).toBe(1);
    expect(f.calls.at(-1)).toBe(`trash:${OLD}`);
  });

  it("moves the copy to the trash and keeps the original when the rest never goes through", async () => {
    const { f, deps } = fake({ albums: ["vol~a1"], joinFails: true });
    const editor = new DateEditor(() => {}, 1);
    editor.attach(deps, []);
    editor.start([{ uid: OLD, captureMs: WANT }]);
    await settled(editor);
    const status = editor.getStatus();
    expect(status).toMatchObject({ changed: 0, failed: 1, done: 1 });
    expect(status.errors[0]).toMatchObject({ uid: OLD, error: expect.stringMatching(/copy was moved to the trash and the original kept/) });
    expect(f.uploads).toBe(1);
    expect(f.calls.filter((c) => c === "album:vol~a1")).toHaveLength(3);
    expect(f.calls.at(-1)).toBe(`trash:${NEW}`);
    expect(f.nodes.get(OLD).trashTime).toBeUndefined();
  });

  it("moves a copy that went up unrecorded to the trash and keeps the original when the job is given up", async () => {
    const { f, deps } = fake();
    const upload = f.photos.getFileUploader;
    f.photos.getFileUploader = async (name: string, meta: any) => {
      const uploader = await upload(name, meta);
      return {
        uploadFromStream: async (...args: any[]) => {
          const controller = await uploader.uploadFromStream(...args);
          return {
            completion: async () => {
              await controller.completion();
              throw new Error("connection reset");
            },
          };
        },
      };
    };
    const lookup = f.photos.findPhotoDuplicates;
    let lookupFails = 2;
    f.photos.findPhotoDuplicates = async (name: string, sha1: () => Promise<string>) => {
      if (lookupFails-- > 0) throw new Error("Drive did not answer");
      return lookup(name, sha1);
    };
    const editor = new DateEditor(() => {}, 1);
    editor.attach(deps, []);
    editor.start([{ uid: OLD, captureMs: WANT }]);
    await settled(editor);
    const status = editor.getStatus();
    expect(status).toMatchObject({ changed: 0, failed: 1, done: 1 });
    expect(status.errors[0]).toMatchObject({ uid: OLD, error: expect.stringMatching(/copy was moved to the trash and the original kept/) });
    expect(f.uploads).toBe(1);
    expect(f.calls.at(-1)).toBe(`trash:${NEW}`);
    expect(f.nodes.get(OLD).trashTime).toBeUndefined();
  });

  it("moves what was carried back to the original before taking back a copy whose original would not go", async () => {
    const { f, deps } = fake();
    deps.trash = async (uids) => {
      f.calls.push(`trash:${uids.join(",")}`);
      return uids.map((uid) => ({ uid, ok: uid !== OLD }));
    };
    const editor = new DateEditor(() => {}, 1);
    editor.attach(deps, []);
    editor.start([{ uid: OLD, captureMs: WANT }]);
    await settled(editor);
    expect(editor.getStatus()).toMatchObject({ changed: 0, failed: 1 });
    expect(f.calls.slice(-2)).toEqual([`carry:${NEW}>${OLD}`, `trash:${NEW}`]);
  });

  it("keeps a photo whose copy is up in the queue when the session locks, and finishes it at the next sign-in", async () => {
    const { f, deps } = fake({ albums: ["vol~a1"] });
    let saved: any[] = [];
    const editor = new DateEditor((items) => (saved = JSON.parse(JSON.stringify(items))), 1);
    const add = deps.addToAlbum;
    deps.addToAlbum = async () => {
      editor.detach();
      throw new Error("Not signed in");
    };
    editor.attach(deps, []);
    editor.start([{ uid: OLD, captureMs: WANT }]);
    await settled(editor);
    expect(editor.getStatus()).toMatchObject({ failed: 0, changed: 0 });
    expect(saved).toMatchObject([{ uid: OLD, stage: "uploaded", newUid: NEW }]);
    deps.addToAlbum = add;
    editor.attach(deps, saved);
    await settled(editor);
    expect(editor.getStatus()).toMatchObject({ changed: 1, failed: 0 });
    expect(f.uploads).toBe(1);
    expect(f.calls.at(-1)).toBe(`trash:${OLD}`);
  });
});

describe("a lock or a crash while a copy goes up", () => {
  afterEach(() => {
    replacedBy.clear();
    replacing.clear();
  });

  async function settled(editor: DateEditor): Promise<void> {
    for (let i = 0; i < 400 && editor.getStatus().running; i++) await new Promise((r) => setTimeout(r, 5));
  }

  /** A queue file that refuses writes while `locked` is set, as the sealed store does. */
  function disk() {
    const d = { locked: false, items: [] as any[] };
    const persist = (items: any[]) => {
      if (d.locked) throw new StoreLockedError();
      d.items = JSON.parse(JSON.stringify(items));
    };
    return { d, persist };
  }

  it("finishes with the copy that went up after the lock, with no second copy", async () => {
    const { f, deps } = fake({ albums: ["vol~a1"] });
    const { d, persist } = disk();
    const editor = new DateEditor(persist, 1);
    f.onUploaded = () => {
      d.locked = true;
      editor.detach();
    };
    editor.attach(deps, []);
    editor.start([{ uid: OLD, captureMs: WANT }]);
    await settled(editor);
    // Locked: the copy is up, but the store could not record it.
    expect(f.uploads).toBe(1);
    expect(d.items).toMatchObject([{ uid: OLD, stage: "queued", sent: { name: "IMG_1.jpg" } }]);
    expect(f.calls).not.toContain(`trash:${OLD}`);

    d.locked = false;
    f.onUploaded = undefined;
    editor.attach({ ...deps }, d.items);
    await settled(editor);
    expect(editor.getStatus()).toMatchObject({ changed: 1, failed: 0 });
    expect(f.uploads).toBe(1);
    expect(f.calls.filter((c) => c.startsWith("carry:"))).toEqual([`carry:${OLD}>${NEW}`]);
    expect(f.calls.filter((c) => c === `trash:${OLD}`)).toHaveLength(1);
    expect(f.calls.at(-1)).toBe(`trash:${OLD}`);
    expect(d.items).toEqual([]);
  });

  it("finds the copy after a restart that lost it, and sends none again", async () => {
    const { f, deps } = fake();
    const { d, persist } = disk();
    const first = new DateEditor(persist, 1);
    // The process ends as the copy goes up: nothing after that reaches the disk.
    f.onUploaded = () => {
      d.locked = true;
      first.detach();
    };
    first.attach(deps, []);
    first.start([{ uid: OLD, captureMs: WANT }]);
    await settled(first);
    expect(f.uploads).toBe(1);
    d.locked = false;
    f.onUploaded = undefined;

    const second = new DateEditor(persist, 1);
    second.attach({ ...deps }, d.items);
    await settled(second);
    expect(second.getStatus()).toMatchObject({ changed: 1, failed: 0 });
    expect(f.uploads).toBe(1);
    expect(f.calls).toContain("lookup");
    expect(f.calls.filter((c) => c.startsWith("carry:"))).toEqual([`carry:${OLD}>${NEW}`]);
    expect(f.calls.filter((c) => c === `trash:${OLD}`)).toHaveLength(1);
  });

  it("sends the copy when the one recorded never reached Drive", async () => {
    const { f, deps } = fake();
    const sent: SentCopy = { name: "IMG_1.jpg", sha1: "0".repeat(40), albums: [], tags: [], expectMs: WANT };
    const editor = new DateEditor(() => {}, 1);
    editor.attach(deps, [{ uid: OLD, captureMs: WANT, stage: "queued", sent } as any]);
    await settled(editor);
    expect(editor.getStatus()).toMatchObject({ changed: 1, failed: 0 });
    expect(f.calls.slice(0, 2)).toEqual(["lookup", "upload"]);
    expect(f.uploads).toBe(1);
  });

  it("waits rather than sending a second copy when Drive cannot be asked", async () => {
    const { f, deps } = fake();
    const sent: SentCopy = { name: "IMG_1.jpg", sha1: "0".repeat(40), albums: [], tags: [], expectMs: WANT };
    let refusals = 1;
    const lookup = f.photos.findPhotoDuplicates;
    f.photos.findPhotoDuplicates = async (...args: any[]) => {
      if (refusals-- > 0) throw new Error("offline");
      return lookup(...args);
    };
    const editor = new DateEditor(() => {}, 1);
    editor.attach(deps, [{ uid: OLD, captureMs: WANT, stage: "queued", sent } as any]);
    await settled(editor);
    expect(editor.getStatus()).toMatchObject({ changed: 1, failed: 0 });
    expect(f.uploads).toBe(1);
  });

  it("does no step of a job after the lock, and finishes it after the unlock", async () => {
    const { f, deps } = fake({ albums: ["vol~a1"] });
    const { d, persist } = disk();
    const editor = new DateEditor(persist, 1);
    const carry = deps.carry;
    deps.carry = async (from, to) => {
      // The lock lands while what this computer keeps is being moved.
      d.locked = true;
      editor.detach();
      await carry(from, to);
    };
    editor.attach(deps, []);
    editor.start([{ uid: OLD, captureMs: WANT }]);
    await settled(editor);
    expect(f.calls).not.toContain(`trash:${OLD}`);
    expect(d.items).toMatchObject([{ uid: OLD, stage: "joined", newUid: NEW }]);

    d.locked = false;
    deps.carry = carry;
    editor.attach({ ...deps }, d.items);
    await settled(editor);
    expect(editor.getStatus()).toMatchObject({ changed: 1, failed: 0 });
    expect(f.uploads).toBe(1);
    // Moved again in full once unlocked, then the original trashed once.
    expect(f.calls.filter((c) => c.startsWith("carry:"))).toEqual([`carry:${OLD}>${NEW}`, `carry:${OLD}>${NEW}`]);
    expect(f.calls.filter((c) => c === `trash:${OLD}`)).toHaveLength(1);
  });
});
