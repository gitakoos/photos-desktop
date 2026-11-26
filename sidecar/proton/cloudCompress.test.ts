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
import { readdirSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";

import { CloudCompressor, compressOne, keptBecause, scaledClaim, worthReplacing } from "./cloudCompress.ts";
import { replacedBy, replacing } from "./dateEdit.ts";
import { StoreLockedError } from "./store.ts";
import { compressionDir, NO_COMPRESSION, setCompression } from "./compression.ts";

const OLD = "vol~old";
const NEW = "vol~new";
const TAKEN = Date.UTC(2022, 6, 1, 9, 0, 0);

let heavy: Buffer;
beforeAll(async () => {
  // A noisy photo saved at the highest quality: a smaller level makes it much lighter.
  const width = 900;
  const height = 600;
  const raw = Buffer.alloc(width * height * 3);
  let seed = 7;
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = seed & 0xff;
  }
  heavy = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
  setCompression({ ...NO_COMPRESSION, tier: "small" });
});

function fake(
  opts: {
    tags?: number[];
    live?: boolean;
    hidden?: boolean;
    bytes?: () => Buffer;
    albums?: string[];
    joinFails?: boolean;
    onUploaded?: () => void;
    /** Drive keeps the copy but the answer never arrives. */
    answerLost?: boolean;
    /** How many duplicate lookups fail before one goes through. */
    lookupFails?: number;
  } = {},
) {
  let lookupFails = opts.lookupFails ?? 0;
  const calls: string[] = [];
  const seen: { meta: any; size: number; name: string } = { meta: null, size: 0, name: "" };
  const nodes = new Map<string, any>();
  nodes.set(OLD, {
    uid: OLD,
    name: { ok: true, value: "IMG_9.jpg" },
    mediaType: "image/jpeg",
    activeRevision: { ok: true, value: { claimedAdditionalMetadata: { Media: { Width: 900, Height: 600 }, Location: { Latitude: 1, Longitude: 2 } } } },
    photo: {
      captureTime: new Date(TAKEN),
      tags: opts.tags ?? [],
      albums: (opts.albums ?? []).map((nodeUid) => ({ nodeUid })),
      relatedPhotoNodeUids: opts.live ? ["vol~v"] : [],
    },
  });
  const photos = {
    getNode: async (uid: string) => nodes.get(uid),
    nodes: { access: { notifyNodeChanged: async () => {} } },
    getFileDownloader: async () => ({
      downloadToStream: (stream: WritableStream<Uint8Array>) => ({
        completion: async () => {
          // As the real SDK does: the end is reported here, the stream is not closed.
          const w = stream.getWriter();
          await w.write(new Uint8Array((opts.bytes ?? (() => heavy))()));
          w.releaseLock();
        },
      }),
    }),
    iterateThumbnails: async function* () {},
    getFileUploader: async (name: string, meta: any) => {
      calls.push("upload");
      seen.meta = meta;
      seen.name = name;
      return {
        uploadFromStream: async (stream: ReadableStream<Uint8Array>) => {
          const reader = stream.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            seen.size += value.byteLength;
          }
          return {
            completion: async () => {
              opts.onUploaded?.();
              nodes.set(NEW, {
                uid: NEW,
                name: { ok: true, value: name },
                sha1: meta.expectedSha1,
                photo: { captureTime: meta.captureTime, tags: [], albums: [], relatedPhotoNodeUids: [] },
              });
              if (opts.answerLost) throw new Error("connection reset");
              return { nodeUid: NEW };
            },
          };
        },
      };
    },
    findPhotoDuplicates: async (name: string, sha1: () => Promise<string>) => {
      calls.push("lookup");
      if (lookupFails-- > 0) throw new Error("Drive did not answer");
      const want = await sha1();
      return [...nodes.values()].filter((n) => n.name?.value === name && n.sha1 === want).map((n) => n.uid);
    },
    updatePhotos: async function* (updates: any[]) {
      calls.push(`tags:${updates[0].tagsToAdd.join(",")}`);
      nodes.get(NEW).photo.tags.push(...updates[0].tagsToAdd);
      yield { ok: true };
    },
  };
  const deps = {
    photos,
    isHidden: () => !!opts.hidden,
    addToAlbum: async (album: string, uids: string[]) => {
      calls.push(`album:${album}`);
      if (opts.joinFails) return uids.map((uid) => ({ uid, ok: false }));
      nodes.get(NEW).photo.albums.push({ nodeUid: album });
      return uids.map((uid) => ({ uid, ok: true }));
    },
    trash: async (uids: string[]) => {
      calls.push(`trash:${uids.join(",")}`);
      for (const uid of uids) if (nodes.has(uid)) nodes.get(uid).trashTime = new Date();
      return uids.map((uid) => ({ uid, ok: true }));
    },
    carry: async (from: string, to: string) => {
      calls.push(`carry:${from}>${to}`);
    },
  };
  return { deps, calls, seen, nodes };
}

const run = (deps: any, entry: any) => compressOne(deps, entry, () => {}, new AbortController().signal, () => {});

describe("Compress on Drive", () => {
  it("replaces a photo with a lighter copy that keeps its date, place and albums, the original trashed last", async () => {
    const { deps, calls, seen } = fake({ tags: [0], albums: ["vol~a"] });
    const entry: any = { uid: OLD, stage: "queued" };
    expect(await run(deps, entry)).toBe("compressed");
    expect(seen.meta.mediaType).toBe("image/jpeg");
    expect(seen.name).toBe("IMG_9.jpg");
    expect(seen.meta.captureTime.getTime()).toBe(TAKEN);
    expect(seen.meta.additionalMetadata.Location).toEqual({ Latitude: 1, Longitude: 2 });
    expect(seen.size).toBeLessThan(heavy.length * 0.9);
    expect(entry.saved).toBe(heavy.length - seen.size);
    expect(calls).toEqual(["upload", "tags:0", "album:vol~a", `carry:${OLD}>${NEW}`, `trash:${OLD}`]);
  });

  it("keeps a photo whose copy would not be a tenth smaller", async () => {
    const small = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#777" } }).jpeg({ quality: 40 }).toBuffer();
    const { deps, calls } = fake({ bytes: () => small });
    expect(await run(deps, { uid: OLD, stage: "queued" })).toBe("kept");
    expect(calls).toEqual([]);
  });

  it("leaves Live Photos, bursts, panoramas, RAW files and hidden photos as they are", async () => {
    for (const opts of [{ live: true }, { tags: [7] }, { tags: [8] }, { hidden: true }]) {
      const { deps, calls } = fake(opts);
      expect(await run(deps, { uid: OLD, stage: "queued" })).toBe("kept");
      expect(calls).toEqual([]);
    }
    expect(keptBecause({ mediaType: "image/x-adobe-dng", photo: {} }, false)).toBe("raw");
    expect(keptBecause({ mediaType: "image/heic", photo: {} }, false)).toBe("type");
    expect(keptBecause({ mediaType: "video/mp4", photo: {} }, false)).toBeNull();
  });

  it("carries on from an uploaded copy without compressing again", async () => {
    const { deps, calls } = fake();
    const entry: any = { uid: OLD, stage: "queued" };
    let first = true;
    await expect(
      compressOne(deps, entry, () => {
        if (first && entry.stage === "uploaded") {
          first = false;
          throw new Error("stopped");
        }
      }, new AbortController().signal, () => {}),
    ).rejects.toThrow("stopped");
    expect(entry.stage).toBe("uploaded");
    expect(await run(deps, entry)).toBe("compressed");
    expect(calls.filter((c) => c === "upload")).toHaveLength(1);
    expect(calls.at(-1)).toBe(`trash:${OLD}`);
  });

  it("knows what is worth replacing and scales the recorded frame", () => {
    expect(worthReplacing(1000, 900)).toBe(true);
    expect(worthReplacing(1000, 901)).toBe(false);
    expect(worthReplacing(0, 1)).toBe(false);
    expect(scaledClaim({ Media: { Width: 4000, Height: 3000 }, Camera: { Model: "x" } }, 0.5)).toEqual({
      Media: { Width: 2000, Height: 1500 },
      Camera: { Model: "x" },
    });
    expect(scaledClaim({ Media: { Width: 10 } }, 1)).toEqual({ Media: { Width: 10 } });
  });
});

describe("Compress on Drive and a photo replaced in the meantime", () => {
  afterEach(() => {
    replacedBy.clear();
    replacing.clear();
  });

  it("compresses the copy that took a trashed original's place, not the original", async () => {
    const { deps, calls, nodes } = fake();
    const MID = "vol~mid";
    nodes.set(MID, { ...nodes.get(OLD), uid: MID });
    nodes.get(OLD).trashTime = new Date();
    replacedBy.set(OLD, MID);
    const entry: any = { uid: OLD, stage: "queued" };
    expect(await run(deps, entry)).toBe("compressed");
    expect(entry.uid).toBe(MID);
    expect(calls).toEqual(["upload", `carry:${MID}>${NEW}`, `trash:${MID}`]);
  });

  it("refuses a photo in the trash that no replacement here took the place of", async () => {
    const { deps, calls, nodes } = fake();
    nodes.get(OLD).trashTime = new Date();
    await expect(run(deps, { uid: OLD, stage: "queued" })).rejects.toThrow(/in the Drive trash/);
    expect(calls).toEqual([]);
  });

  it("moves the copy to the trash and keeps the original when the rest never goes through", async () => {
    const { deps, calls, nodes } = fake({ albums: ["vol~a"], joinFails: true });
    const compressor = new CloudCompressor(1, () => {}, () => []);
    compressor.attach(deps);
    compressor.start([OLD]);
    for (let i = 0; i < 2000 && compressor.getStatus().done < 1; i++) await new Promise((r) => setTimeout(r, 5));
    const status = compressor.getStatus();
    expect(status).toMatchObject({ compressed: 0, failed: 1 });
    expect(status.errors[0].error).toMatch(/copy was moved to the trash and the original kept/);
    expect(calls.filter((c) => c === "upload")).toHaveLength(1);
    expect(calls.filter((c) => c === "album:vol~a")).toHaveLength(3);
    expect(calls.at(-1)).toBe(`trash:${NEW}`);
    expect(nodes.get(OLD).trashTime).toBeUndefined();
  }, 30_000);
});

describe("Compress on Drive giving up on a copy sent but never recorded as up", () => {
  afterEach(() => {
    replacedBy.clear();
    replacing.clear();
  });

  async function givenUp(deps: any): Promise<CloudCompressor> {
    const compressor = new CloudCompressor(1, () => {}, () => []);
    compressor.attach(deps);
    compressor.start([OLD]);
    for (let i = 0; i < 2000 && compressor.getStatus().done < 1; i++) await new Promise((r) => setTimeout(r, 5));
    return compressor;
  }

  it("moves the copy Drive kept to the trash and keeps the original", async () => {
    const { deps, calls, nodes } = fake({ answerLost: true, lookupFails: 2 });
    const status = (await givenUp(deps)).getStatus();
    expect(status).toMatchObject({ compressed: 0, failed: 1 });
    expect(status.errors[0].error).toMatch(/copy was moved to the trash and the original kept/);
    expect(calls.filter((c) => c === "upload")).toHaveLength(1);
    expect(calls.at(-1)).toBe(`trash:${NEW}`);
    expect(nodes.get(NEW).trashTime).toBeDefined();
    expect(nodes.get(OLD).trashTime).toBeUndefined();
  }, 30_000);

  it("says both may be kept when Drive cannot be asked for the copy", async () => {
    const { deps, calls, nodes } = fake({ answerLost: true, lookupFails: 99 });
    const status = (await givenUp(deps)).getStatus();
    expect(status).toMatchObject({ compressed: 0, failed: 1 });
    expect(status.errors[0].error).toMatch(/could not be looked for, so both may be kept/);
    expect(calls.filter((c) => c.startsWith("trash:"))).toEqual([]);
    expect(nodes.get(OLD).trashTime).toBeUndefined();
  }, 30_000);
});

describe("Compress on Drive and a lock while a copy goes up", () => {
  afterEach(() => {
    replacedBy.clear();
    replacing.clear();
  });

  it("finishes with the copy that went up after the lock, with no second copy", async () => {
    const disk = { locked: false, items: [] as any[] };
    const persist = (items: any[]) => {
      if (disk.locked) throw new StoreLockedError();
      disk.items = JSON.parse(JSON.stringify(items));
    };
    let compressor: CloudCompressor;
    let lockOnUpload = true;
    const during: string[] = [];
    const { deps, calls } = fake({
      albums: ["vol~a"],
      onUploaded: () => {
        during.push(...readdirSync(compressionDir()));
        if (!lockOnUpload) return;
        disk.locked = true;
        compressor.detach();
      },
    });
    compressor = new CloudCompressor(1, persist, () => disk.items);
    compressor.attach(deps);
    compressor.start([OLD]);
    for (let i = 0; i < 400 && compressor.getStatus().running; i++) await new Promise((r) => setTimeout(r, 5));
    expect(calls.filter((c) => c === "upload")).toHaveLength(1);
    // The decrypted original is gone before its copy is sent; the copy goes once it is up.
    expect(during.some((n) => n.startsWith("drive-"))).toBe(false);
    expect(readdirSync(compressionDir())).toEqual([]);
    expect(calls).not.toContain(`trash:${OLD}`);
    expect(disk.items).toMatchObject([{ uid: OLD, stage: "queued", sent: { name: "IMG_9.jpg" } }]);

    disk.locked = false;
    lockOnUpload = false;
    compressor.attach({ ...deps });
    for (let i = 0; i < 400 && compressor.getStatus().running; i++) await new Promise((r) => setTimeout(r, 5));
    expect(compressor.getStatus()).toMatchObject({ compressed: 1, failed: 0 });
    expect(compressor.getStatus().savedBytes).toBeGreaterThan(0);
    expect(calls.filter((c) => c === "upload")).toHaveLength(1);
    expect(calls.filter((c) => c === `trash:${OLD}`)).toHaveLength(1);
    expect(calls.slice(-3)).toEqual(["album:vol~a", `carry:${OLD}>${NEW}`, `trash:${OLD}`]);
    expect(disk.items).toEqual([]);
  });
});

describe("Compress on Drive and a step that never answers", () => {
  const never = () => new Promise<never>(() => {});

  it("gives up on a download that stops sending, uploading nothing", async () => {
    const { deps, calls } = fake();
    (deps.photos as any).getFileDownloader = async () => ({ downloadToStream: () => ({ completion: never }) });
    const entry: any = { uid: OLD, stage: "queued" };
    await expect(run({ ...deps, stallMs: 20 }, entry)).rejects.toThrow(/download produced nothing/);
    expect(calls).not.toContain("upload");
    expect(entry.sent).toBeUndefined();
  });

  it("gives up on an upload that sends nothing, stops it, and keeps what the next try looks for", async () => {
    const { deps } = fake();
    let signal: AbortSignal | undefined;
    (deps.photos as any).getFileUploader = async (_n: string, _m: any, s: AbortSignal) => {
      signal = s;
      return { uploadFromStream: async () => ({ completion: never }) };
    };
    const entry: any = { uid: OLD, stage: "queued" };
    await expect(run({ ...deps, stallMs: 5 }, entry)).rejects.toThrow(/upload produced nothing/);
    expect(signal?.aborted).toBe(true);
    expect(entry.sent).toBeDefined();
  });
});
