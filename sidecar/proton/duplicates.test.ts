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
import { beforeAll, describe, expect, it } from "vitest";

import {
  DuplicateFinder,
  IgnoredGroups,
  deletableAcross,
  deletableExtras,
  fingerprintOf,
  groupKey,
  withListingTap,
  type DuplicateSource,
} from "./duplicates.ts";
import { COLOR_BYTES, distance, type Fingerprint } from "./pdq.ts";
import { initStore, setDataKey } from "./store.ts";

beforeAll(() => {
  initStore(mkdtempSync(join(tmpdir(), "pfp-dup-")));
  setDataKey(randomBytes(32));
});

describe("what may be moved to the trash", () => {
  it("is every copy but the kept ones, and nothing when no kept copy is left", () => {
    expect(deletableExtras(["a", "b", "c"], new Set(["a"]), new Set())).toEqual(["b", "c"]);
    expect(deletableExtras(["a", "b"], new Set(), new Set())).toEqual([]);
    expect(deletableExtras(["a", "b"], new Set(["a"]), new Set(["a"]))).toEqual([]);
    expect(deletableExtras(["a", "b"], new Set(["z"]), new Set())).toEqual([]);
  });

  it("never takes the last copy of a pair shown on two cards with opposite keepers", () => {
    const ids = deletableAcross(
      [
        { uids: ["a", "b"], keep: new Set(["a"]) },
        { uids: ["a", "b"], keep: new Set(["b"]) },
      ],
      [],
      new Set(),
    );
    expect(ids).toEqual(["b"]);
  });

  it("stands a group down when its keeper goes with a whole group", () => {
    const ids = deletableAcross([{ uids: ["b", "c"], keep: new Set(["b"]) }], [["a", "b"]], new Set());
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("ignored groups", () => {
  it("stay ignored while every copy was in the remembered group", () => {
    const ignored = new IgnoredGroups([groupKey(["c", "a", "b"])]);
    expect(ignored.covering(["a", "b", "c"])).toHaveLength(1);
    expect(ignored.covering(["b", "a"])).toHaveLength(1);
    expect(ignored.covering(["a", "d"])).toHaveLength(0);
  });
});

const colour = new Uint8Array(COLOR_BYTES).fill(100);
const fpOf = (seed: number): Fingerprint => ({
  bits: Uint32Array.from({ length: 8 }, (_, i) => (Math.imul(seed + 1, 2654435761) ^ Math.imul(i + 7, 40503)) >>> 0),
  quality: 80,
  color: colour,
});

/** A library of photos whose thumbnail bytes name the fingerprint they make. */
function finder(photos: { uid: string; t: number; look: number | null }[], unanswered: string[] = []) {
  const asked: string[] = [];
  const source: DuplicateSource = {
    list: async () => photos.map((p) => ({ uid: p.uid, captureTime: p.t })),
    async *thumbnails(uids) {
      for (const uid of uids) {
        asked.push(uid);
        if (unanswered.includes(uid)) continue;
        const look = photos.find((p) => p.uid === uid)!.look;
        yield { uid, bytes: look === null ? null : Buffer.from(String(look)) };
      }
    },
  };
  const f = new DuplicateFinder(async (bytes) => fpOf(Number(bytes.toString())), false, 0, 0);
  f.setSource(source);
  return { f, asked };
}
const allThere = async (uids: string[]) => new Set(uids);
const listing = (pairs: [string, string | null][]) => ({ Photos: pairs.map(([LinkID, ContentHash]) => ({ LinkID, ContentHash })) });

describe("the duplicate finder", () => {
  it("groups identical copies by content hash and look-alikes by fingerprint, each photo once", async () => {
    const { f } = finder([
      { uid: "v~a", t: 3, look: 1 },
      { uid: "v~b", t: 1, look: 1 },
      { uid: "v~c", t: 2, look: 2 },
      { uid: "v~d", t: 4, look: 2 },
      { uid: "v~e", t: 5, look: 3 },
      { uid: "v~f", t: 6, look: 1 },
    ]);
    f.takeListing("v", listing([["a", "h1"], ["b", "h1"], ["c", "h2"], ["d", null], ["e", "h3"], ["f", "h4"]]));
    f.start();
    await f.settled();
    const g = f.groups();
    expect(g.identical).toEqual([{ key: "v~a|v~b", kind: "identical", uids: ["v~b", "v~a"], times: [1, 3] }]);
    // f looks like a and b, but those two are shown as identical only.
    expect(g.similar.map((x) => x.uids)).toEqual([["v~c", "v~d"]]);
    expect(f.getStatus()).toMatchObject({ state: "done", done: 6, total: 6 });
  });

  it("asks again for a photo the source did not answer, and not for one without a thumbnail", async () => {
    const photos = [
      { uid: "v~a", t: 1, look: 1 },
      { uid: "v~b", t: 2, look: null },
      { uid: "v~c", t: 3, look: 1 },
    ];
    const { f, asked } = finder(photos, ["v~c"]);
    f.start();
    await f.settled();
    expect(f.groups().similar).toEqual([]);
    asked.length = 0;
    f.start();
    await f.settled();
    expect(asked).toEqual(["v~c"]);
  });

  it("moves to the trash only what a group it holds lets go, and drops those from the groups", async () => {
    const { f } = finder([
      { uid: "v~a", t: 1, look: 5 },
      { uid: "v~b", t: 2, look: 5 },
      { uid: "v~c", t: 3, look: 5 },
      { uid: "v~x", t: 4, look: 9 },
    ]);
    f.start();
    await f.settled();
    const trashed: string[] = [];
    const trashNodes = async (uids: string[]) => {
      trashed.push(...uids);
      return uids.map((uid) => ({ uid, ok: true }));
    };
    // A photo that is no duplicate, asked for as if it were in the group: the group is left alone.
    expect(await f.trash([{ uids: ["v~a", "v~x"], keep: ["v~a"] }], [], trashNodes, allThere)).toEqual({ trashed: [], failed: 0, skipped: 1 });
    // Nothing kept: nothing goes.
    expect((await f.trash([{ uids: ["v~a", "v~b", "v~c"], keep: [] }], [], trashNodes, allThere)).trashed).toEqual([]);
    expect(await f.trash([{ uids: ["v~a", "v~b", "v~c"], keep: ["v~a"] }], [], trashNodes, allThere)).toEqual({ trashed: ["v~b", "v~c"], failed: 0, skipped: 0 });
    expect(trashed).toEqual(["v~b", "v~c"]);
    expect(f.groups().similar).toEqual([]);
  });

  it("leaves a group alone when its kept copy is gone from Drive, or was trashed elsewhere in the app", async () => {
    const { f } = finder([
      { uid: "v~a", t: 1, look: 5 },
      { uid: "v~b", t: 2, look: 5 },
      { uid: "v~c", t: 3, look: 7 },
      { uid: "v~d", t: 4, look: 7 },
    ]);
    f.start();
    await f.settled();
    const trashed: string[] = [];
    const trashNodes = async (uids: string[]) => {
      trashed.push(...uids);
      return uids.map((uid) => ({ uid, ok: true }));
    };
    const deletedOnThePhone = async (uids: string[]) => new Set(uids.filter((u) => u !== "v~a"));
    expect(await f.trash([{ uids: ["v~a", "v~b"], keep: ["v~a"] }], [], trashNodes, deletedOnThePhone)).toEqual({
      trashed: [],
      failed: 0,
      skipped: 1,
    });
    f.removed(["v~c"]);
    await f.current();
    expect(f.groups().similar.map((g) => g.uids)).toEqual([["v~a", "v~b"]]);
    expect((await f.trash([{ uids: ["v~c", "v~d"], keep: ["v~c"] }], [], trashNodes, allThere)).skipped).toBe(1);
    expect(trashed).toEqual([]);
  });

  it("answers for the groups at once, before and while they are worked out", async () => {
    const { f } = finder([
      { uid: "v~a", t: 1, look: 5 },
      { uid: "v~b", t: 2, look: 5 },
    ]);
    expect(f.groups().ready).toBe(false);
    f.start();
    await f.settled();
    expect(f.groups()).toMatchObject({ ready: true, similar: [{ uids: ["v~a", "v~b"] }] });
  });

  it("works the groups out soon after the scan is through, not at the next scheduled round", async () => {
    const photos = [{ uid: "v~a", t: 1, look: 5 }];
    const source: DuplicateSource = {
      list: async () => photos.map((p) => ({ uid: p.uid, captureTime: p.t })),
      async *thumbnails(uids) {
        for (const uid of uids) yield { uid, bytes: Buffer.from("5") };
      },
    };
    const f = new DuplicateFinder(async (b) => fpOf(Number(b.toString())), false, 0, 60_000);
    f.setSource(source);
    f.start();
    await f.settled();
    // A second scan, right after a grouping, finds a look-alike.
    photos.push({ uid: "v~b", t: 2, look: 5 });
    f.start();
    while (f.getStatus().state === "scanning") await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 700));
    expect(f.groups().similar.map((g) => g.uids)).toEqual([["v~a", "v~b"]]);
  });

  it("counts a copy the trash refused as failed and keeps it in its group", async () => {
    const { f } = finder([
      { uid: "v~a", t: 1, look: 5 },
      { uid: "v~b", t: 2, look: 5 },
      { uid: "v~c", t: 3, look: 5 },
    ]);
    f.start();
    await f.settled();
    const result = await f.trash(
      [{ uids: ["v~a", "v~b", "v~c"], keep: ["v~a"] }],
      [],
      async (uids) => uids.map((uid) => ({ uid, ok: uid !== "v~c" })),
      allThere,
    );
    expect(result).toEqual({ trashed: ["v~b"], failed: 1, skipped: 0 });
    expect(f.groups().similar.map((g) => g.uids)).toEqual([["v~a", "v~c"]]);
  });

  it("sets an ignored group apart until it is brought back", async () => {
    const { f } = finder([
      { uid: "v~a", t: 1, look: 5 },
      { uid: "v~b", t: 2, look: 5 },
    ]);
    f.start();
    await f.settled();
    f.ignore(["v~b", "v~a"]);
    expect(f.groups().similar).toEqual([]);
    expect(f.groups().ignored).toHaveLength(1);
    f.unignore(["v~a", "v~b"]);
    expect(f.groups().similar).toHaveLength(1);
  });

  it("keeps its fingerprints and ignored groups sealed across a restart", async () => {
    const photos = [
      { uid: "v~a", t: 1, look: 5 },
      { uid: "v~b", t: 2, look: 5 },
      { uid: "v~c", t: 3, look: 6 },
      { uid: "v~d", t: 4, look: 6 },
    ];
    const asked: string[] = [];
    const source: DuplicateSource = {
      list: async () => photos.map((p) => ({ uid: p.uid, captureTime: p.t })),
      async *thumbnails(uids) {
        asked.push(...uids);
        for (const uid of uids) yield { uid, bytes: Buffer.from(String(photos.find((p) => p.uid === uid)!.look)) };
      },
    };
    const make = () => {
      const f = new DuplicateFinder(async (b) => fpOf(Number(b.toString())), true, 0, 0);
      f.setSource(source);
      return f;
    };
    const first = make();
    first.start();
    await first.settled();
    first.ignore(["v~c", "v~d"]);
    asked.length = 0;
    const second = make();
    second.start();
    await second.settled();
    expect(asked).toEqual([]);
    expect(second.groups().similar.map((g) => g.uids)).toEqual([["v~a", "v~b"]]);
    expect(second.groups().ignored.map((g) => g.uids)).toEqual([["v~c", "v~d"]]);
  });
});

describe("the listing tap", () => {
  it("reads the content hashes of a timeline page and leaves the answer whole for the library", async () => {
    const pages: [string, unknown][] = [];
    const body = { Photos: [{ LinkID: "L1", ContentHash: "h" }] };
    const client = {
      fetchJson: async (_req: { url: string; method: string }) => new Response(JSON.stringify(body), { status: 200 }),
      fetchBlob: async () => new Response(""),
    };
    const tapped = withListingTap(client, (v, j) => pages.push([v, j]));
    const res = await tapped.fetchJson({ url: "https://drive-api.proton.me/drive/volumes/V%3D/photos?PreviousPageLastLinkID=x", method: "GET" });
    expect(await res.json()).toEqual(body);
    await tapped.fetchJson({ url: "https://drive-api.proton.me/drive/volumes/V/photos/xyz", method: "GET" });
    await tapped.fetchJson({ url: "https://drive-api.proton.me/drive/volumes/V/photos", method: "POST" });
    await new Promise((r) => setTimeout(r, 0));
    expect(pages).toEqual([["V=", body]]);
    expect(typeof tapped.fetchBlob).toBe("function");
  });
});

describe("a thumbnail's fingerprint", () => {
  it("is close for a smaller re-encoded copy and far for another picture", async () => {
    const width = 512;
    const height = 384;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        pixels[i] = (x * 255) / width;
        pixels[i + 1] = (y * 255) / height;
        pixels[i + 2] = (Math.trunc(x / 40) + Math.trunc(y / 40)) % 2 ? 200 : 40;
      }
    const raw = { raw: { width, height, channels: 3 as const } };
    const original = await sharp(pixels, raw).jpeg({ quality: 92 }).toBuffer();
    const copy = await sharp(pixels, raw).resize(300).jpeg({ quality: 60 }).toBuffer();
    const other = await sharp(pixels, raw).flop().flip().jpeg().toBuffer();
    const [a, b, c] = await Promise.all([fingerprintOf(original), fingerprintOf(copy), fingerprintOf(other)]);
    expect(distance(a!.bits, b!.bits)).toBeLessThanOrEqual(16);
    expect(distance(a!.bits, c!.bits)).toBeGreaterThan(64);
  });
});
