/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";

import { COVER_SIZE, FaceCovers, cutFace, faceSquare, parseFaceBox, type FaceBox } from "./faceCover.ts";

/** A `width` x `height` JPEG, black but for a white square at `box`. */
async function picture(width: number, height: number, box: FaceBox, orientation?: number): Promise<Buffer> {
  const [l, t, r, b] = box;
  const spot = await sharp({
    create: { width: Math.round((r - l) * width), height: Math.round((b - t) * height), channels: 3, background: "#fff" },
  })
    .png()
    .toBuffer();
  let img = sharp({ create: { width, height, channels: 3, background: "#000" } })
    .composite([{ input: spot, left: Math.round(l * width), top: Math.round(t * height) }])
    .jpeg();
  if (orientation) img = img.withMetadata({ orientation });
  return img.toBuffer();
}

describe("the face square", () => {
  it("is 1.4 times the face's longer side, centred on it", () => {
    expect(faceSquare([0.4, 0.4, 0.5, 0.5], 1000, 1000)).toEqual({ left: 380, top: 380, size: 140 });
  });

  it("near an edge, zooms in to keep the face centred, down to 1.2 times it", () => {
    // 65 px from the edge: a 130 px square around it, centred, rather than 140 moved aside.
    expect(faceSquare([0.015, 0.4, 0.115, 0.5], 1000, 1000)).toEqual({ left: 0, top: 385, size: 130 });
    // Touching the edge: 1.2 times the face, inside the picture, as near centre as it can be.
    expect(faceSquare([0, 0, 0.1, 0.1], 1000, 500)).toEqual({ left: 0, top: 0, size: 120 });
    expect(faceSquare([0.95, 0.9, 1, 1], 1000, 500)).toEqual({ left: 940, top: 440, size: 60 });
  });

  it("is never larger than the picture's shorter side", () => {
    expect(faceSquare([0, 0, 1, 1], 1200, 800)).toEqual({ left: 200, top: 0, size: 800 });
  });
});

describe("a face box from a URL", () => {
  it("reads four shares", () => {
    expect(parseFaceBox("0.1,0.2,0.3,0.4")).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it.each(["", "0.1,0.2,0.3", "a,b,c,d", "0.5,0.2,0.3,0.4", "0,0,1.5,1", "-0.1,0,0.5,0.5", "1e-3,0,1,1", "Infinity,0,1,1"])(
    "refuses %j",
    (text) => {
      expect(parseFaceBox(text)).toBeNull();
    },
  );
});

describe("cutting a face", () => {
  it("returns a small square of the face", async () => {
    const box: FaceBox = [0.5, 0.2, 0.7, 0.45];
    const cut = await cutFace(await picture(2000, 1500, box), box);
    const meta = await sharp(cut!).metadata();
    expect(meta.width).toBe(COVER_SIZE);
    expect(meta.height).toBe(COVER_SIZE);
    // The face is in the middle of the cut.
    const { data } = await sharp(cut!).extract({ left: 150, top: 150, width: 20, height: 20 }).greyscale().raw().toBuffer({ resolveWithObject: true });
    expect(Math.min(...data)).toBeGreaterThan(200);
  });

  it("cuts from the upright picture when EXIF turns it", async () => {
    // Stored 1500 x 2000 and turned a quarter (orientation 6): shown 2000 x 1500. The box is
    // where the face is in the picture as shown, which is where the scan found it.
    const shown: FaceBox = [0.5, 0.2, 0.7, 0.45];
    const stored = await sharp(await picture(2000, 1500, shown)).rotate(-90).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const cut = await cutFace(stored, shown);
    const { data } = await sharp(cut!).extract({ left: 150, top: 150, width: 20, height: 20 }).greyscale().raw().toBuffer({ resolveWithObject: true });
    expect(Math.min(...data)).toBeGreaterThan(200);
  });

  it("does not enlarge a cut smaller than a cover", async () => {
    const box: FaceBox = [0.4, 0.4, 0.5, 0.5];
    const cut = await cutFace(await picture(200, 200, box), box);
    expect((await sharp(cut!).metadata()).width).toBe(28);
  });
});

describe("the cover cache", () => {
  const box: FaceBox = [0.4, 0.4, 0.5, 0.5];

  it("fetches a picture once for any number of asks, and keeps the cut", async () => {
    const jpeg = await picture(400, 400, box);
    let fetched = 0;
    const covers = new FaceCovers(async () => {
      fetched++;
      return { bytes: jpeg, keep: true };
    });
    const live = new AbortController().signal;
    const [a, b] = await Promise.all([covers.get("u", box, live), covers.get("u", box, live)]);
    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(await covers.get("u", box, live)).toBe(a);
    expect(fetched).toBe(1);
  });

  it("never fetches for an ask given up while it waited in line", async () => {
    const jpeg = await picture(400, 400, box);
    const asked: string[] = [];
    const release: (() => void)[] = [];
    const covers = new FaceCovers(async (uid) => {
      asked.push(uid);
      await new Promise<void>((r) => release.push(r));
      return { bytes: jpeg, keep: true };
    });
    const live = new AbortController().signal;
    const first = covers.get("a", box, live);
    const second = covers.get("b", box, live);
    const leaving = new AbortController();
    const third = covers.get("c", box, leaving.signal);
    const fourth = covers.get("d", box, live);
    await Promise.resolve();
    expect(asked).toEqual(["a", "b"]);
    leaving.abort();
    expect(await third).toBeNull();
    release.shift()!();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual(["a", "b", "d"]);
    release.shift()!();
    release.shift()!();
    await Promise.all([second, fourth]);
    expect(asked).toEqual(["a", "b", "d"]);
  });

  it("keeps a cut in line for a second ask when the first ask leaves", async () => {
    const jpeg = await picture(400, 400, box);
    const release: (() => void)[] = [];
    const asked: string[] = [];
    const covers = new FaceCovers(async (uid) => {
      asked.push(uid);
      await new Promise<void>((r) => release.push(r));
      return { bytes: jpeg, keep: true };
    });
    const live = new AbortController().signal;
    // Two cuts take both places, so the third waits in line.
    const busy = [covers.get("a", box, live), covers.get("b", box, live)];
    const first = new AbortController();
    const firstAsk = covers.get("c", box, first.signal);
    // The same cover is asked for again (a second card, or the card back on screen) before
    // the first ask is cancelled.
    const secondAsk = covers.get("c", box, live);
    first.abort();
    await vi.waitFor(() => expect(release.length).toBe(2));
    release.shift()!();
    await vi.waitFor(() => expect(asked).toEqual(["a", "b", "c"]));
    await vi.waitFor(() => expect(release.length).toBe(2));
    release.splice(0).forEach((go) => go());
    await Promise.all(busy);
    expect(await secondAsk).not.toBeNull();
    expect(await firstAsk).toBe(await secondAsk);
  });

  it("starts a fresh cut for an ask that comes after the only earlier one left", async () => {
    const jpeg = await picture(400, 400, box);
    const release: (() => void)[] = [];
    const covers = new FaceCovers(async () => {
      await new Promise<void>((r) => release.push(r));
      return { bytes: jpeg, keep: true };
    });
    const live = new AbortController().signal;
    const busy = [covers.get("a", box, live), covers.get("b", box, live)];
    const first = new AbortController();
    const firstAsk = covers.get("c", box, first.signal);
    // The card scrolls away (its request cancelled), then back (asked again).
    first.abort();
    const secondAsk = covers.get("c", box, live);
    expect(await firstAsk).toBeNull();
    await vi.waitFor(() => expect(release.length).toBe(2));
    release.splice(0).forEach((go) => go());
    await Promise.all(busy);
    await vi.waitFor(() => expect(release.length).toBe(1));
    release.splice(0).forEach((go) => go());
    expect(await secondAsk).not.toBeNull();
  });

  it("gives up a cut in line once every ask has left, and starts afresh for a new one", async () => {
    const jpeg = await picture(400, 400, box);
    const release: (() => void)[] = [];
    const asked: string[] = [];
    const covers = new FaceCovers(async (uid) => {
      asked.push(uid);
      await new Promise<void>((r) => release.push(r));
      return { bytes: jpeg, keep: true };
    });
    const live = new AbortController().signal;
    const busy = [covers.get("a", box, live), covers.get("b", box, live)];
    const one = new AbortController();
    const two = new AbortController();
    const asks = [covers.get("c", box, one.signal), covers.get("c", box, two.signal)];
    one.abort();
    two.abort();
    expect(await Promise.all(asks)).toEqual([null, null]);
    const again = covers.get("c", box, live);
    await vi.waitFor(() => expect(release.length).toBe(2));
    release.shift()!();
    await vi.waitFor(() => expect(asked).toEqual(["a", "b", "c"]));
    await vi.waitFor(() => expect(release.length).toBe(2));
    release.splice(0).forEach((go) => go());
    await Promise.all(busy);
    expect(await again).not.toBeNull();
    expect(asked).toEqual(["a", "b", "c"]);
  });

  it("does not keep a cut made from a stand-in picture, so the next ask tries again", async () => {
    const jpeg = await picture(400, 400, box);
    let asks = 0;
    const covers = new FaceCovers(async () => {
      asks++;
      return { bytes: jpeg, keep: asks > 1 };
    });
    const live = new AbortController().signal;
    expect(await covers.get("u", box, live)).not.toBeNull();
    expect(covers.size()).toBe(0);
    await covers.get("u", box, live);
    expect(covers.size()).toBe(1);
    await covers.get("u", box, live);
    expect(asks).toBe(2);
  });

  it("joins a cut already being made even when everyone before has left", async () => {
    const jpeg = await picture(400, 400, box);
    let fetched = 0;
    let release!: () => void;
    const covers = new FaceCovers(async () => {
      fetched++;
      await new Promise<void>((r) => (release = r));
      return { bytes: jpeg, keep: true };
    });
    const first = new AbortController();
    const firstAsk = covers.get("u", box, first.signal);
    await vi.waitFor(() => expect(fetched).toBe(1));
    first.abort();
    const again = covers.get("u", box, new AbortController().signal);
    release();
    expect(await again).not.toBeNull();
    expect(await firstAsk).toBe(await again);
    expect(fetched).toBe(1);
  });

  it("answers null when there is no picture, and forgets everything at clear", async () => {
    const jpeg = await picture(400, 400, box);
    const covers = new FaceCovers(async (uid) => (uid === "none" ? null : { bytes: jpeg, keep: true }));
    const live = new AbortController().signal;
    expect(await covers.get("none", box, live)).toBeNull();
    await covers.get("u", box, live);
    expect(covers.size()).toBe(1);
    covers.clear();
    expect(covers.size()).toBe(0);
  });

  it("does not keep a cut that finishes after a clear", async () => {
    const jpeg = await picture(400, 400, box);
    let release!: () => void;
    const covers = new FaceCovers(async () => {
      await new Promise<void>((r) => (release = r));
      return { bytes: jpeg, keep: true };
    });
    const pending = covers.get("u", box, new AbortController().signal);
    await new Promise((r) => setTimeout(r, 0));
    covers.clear();
    release();
    await pending;
    expect(covers.size()).toBe(0);
  });
});

describe("a small cover", () => {
  const box: FaceBox = [0.4, 0.3, 0.6, 0.6];

  it("is cut from the grid thumbnail when the face has pixels enough there, without a preview", async () => {
    const thumb = await picture(512, 384, box);
    let previews = 0;
    const covers = new FaceCovers(
      async () => {
        previews++;
        return { bytes: await picture(2000, 1500, box), keep: true };
      },
      { thumbnail: async () => thumb },
    );
    const cut = await covers.get("vol~a", box, new AbortController().signal, 128);
    expect(previews).toBe(0);
    expect((await sharp(cut!).metadata()).width).toBe(128);
  });

  it("waits for the preview when the face is too small in the thumbnail for the size asked", async () => {
    const tiny: FaceBox = [0.45, 0.45, 0.5, 0.5];
    let previews = 0;
    const covers = new FaceCovers(
      async () => {
        previews++;
        return { bytes: await picture(2000, 1500, tiny), keep: true };
      },
      { thumbnail: async () => picture(512, 384, tiny) },
    );
    await covers.get("vol~a", tiny, new AbortController().signal, 256);
    expect(previews).toBe(1);
  });

  it("is kept sealed for the next run, by its size", async () => {
    const disk = new Map<string, Buffer>();
    const store = { get: (k: string) => disk.get(k) ?? null, put: (k: string, b: Buffer) => void disk.set(k, b) };
    const thumb = await picture(512, 384, box);
    let thumbs = 0;
    const first = new FaceCovers(async () => null, {
      thumbnail: async () => {
        thumbs++;
        return thumb;
      },
      disk: store,
    });
    await first.get("vol~a", box, new AbortController().signal, 128);
    expect(disk.size).toBe(1);
    // A new run: the cut comes from the disk, nothing fetched.
    const second = new FaceCovers(async () => null, {
      thumbnail: async () => {
        thumbs++;
        return thumb;
      },
      disk: store,
    });
    expect(await second.get("vol~a", box, new AbortController().signal, 128)).not.toBeNull();
    expect(thumbs).toBe(1);
    // Another size is another cut.
    await second.get("vol~a", box, new AbortController().signal, 192);
    expect(disk.size).toBe(2);
  });
});

describe("an ask given up while the thumbnail is tried", () => {
  it("fetches no preview, and its answer settles", async () => {
    const tiny: FaceBox = [0.45, 0.45, 0.5, 0.5];
    let previews = 0;
    const covers = new FaceCovers(
      async () => {
        previews++;
        return null;
      },
      {
        thumbnail: async (_uid, gone) => {
          await new Promise((r) => setTimeout(r, 5));
          return gone.aborted ? null : picture(512, 384, tiny);
        },
      },
    );
    const leaving = new AbortController();
    const asked = covers.get("vol~a", tiny, leaving.signal, 256);
    leaving.abort();
    expect(await asked).toBeNull();
    expect(previews).toBe(0);
  });
});

describe("cutting many small covers", () => {
  it("cuts three at a time, in order, and one given up while waiting leaves its place", async () => {
    const box: FaceBox = [0.4, 0.3, 0.6, 0.6];
    const thumb = await picture(512, 384, box);
    const covers = new FaceCovers(async () => null, { thumbnail: async () => thumb });
    const inside = covers as unknown as { thumbBusy: number; thumbLine: unknown[] };
    const leaving = new AbortController();
    const asks = Array.from({ length: 12 }, (_, i) =>
      covers.get(`vol~p${i}`, box, i === 7 ? leaving.signal : new AbortController().signal, 128),
    );
    // Let every ask reach the line.
    for (let i = 0; i < 20 && inside.thumbLine.length < 9; i++) await new Promise((r) => setImmediate(r));
    expect(inside.thumbBusy).toBe(3);
    expect(inside.thumbLine.length).toBe(9);
    leaving.abort();
    expect(inside.thumbLine.length).toBe(8);
    const got = await Promise.all(asks);
    expect(got.filter((c) => c !== null)).toHaveLength(11);
    expect(got[7]).toBeNull();
    // Every turn given back.
    expect(inside.thumbBusy).toBe(0);
    expect(inside.thumbLine.length).toBe(0);
  });
});
