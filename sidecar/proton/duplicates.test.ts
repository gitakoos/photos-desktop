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

/** "seed" or "seed.flips": the seed's fingerprint with that many of its bits turned over. */
function lookOf(text: string): Fingerprint {
  // A trailing "p": a page, bright and colourless in the middle.
  const page = text.endsWith("p");
  const [seed, flips = "0"] = text.replace(/p$/, "").split(".");
  const fp = page ? { ...fpOf(Number(seed)), color: new Uint8Array(COLOR_BYTES).fill(235) } : fpOf(Number(seed));
  const bits = Uint32Array.from(fp.bits);
  for (let b = 0; b < Number(flips); b++) bits[b % 8] ^= 1 << Math.floor(b / 8);
  return { ...fp, bits };
}

/**
 * Steps between the test photos' times: hours and minutes apart, and never a whole number of
 * hours, so look-alikes are only that, not one photo dated the same moment or a burst.
 */
const SPREAD = 7_777_777;

/**
 * A library of photos whose thumbnail bytes name the fingerprint they make. `t` counts steps of
 * SPREAD; `ms` gives a capture time as it is.
 */
function finder(
  photos: { uid: string; t: number; look: number | string | null; ms?: number; video?: boolean; size?: number; length?: number }[],
  unanswered: string[] = [],
) {
  const asked: string[] = [];
  const source: DuplicateSource = {
    list: async () => photos.map((p) => ({ uid: p.uid, captureTime: p.ms ?? p.t * SPREAD, video: p.video })),
    async *thumbnails(uids) {
      for (const uid of uids) {
        asked.push(uid);
        if (unanswered.includes(uid)) continue;
        const look = photos.find((p) => p.uid === uid)!.look;
        yield { uid, bytes: look === null ? null : Buffer.from(String(look)) };
      }
    },
    details: async (uids) =>
      photos
        .filter((p) => uids.includes(p.uid))
        .map((p) => ({ uid: p.uid, size: p.size ?? null, durationMs: p.length ?? null })),
  };
  const f = new DuplicateFinder(async (bytes) => lookOf(bytes.toString()), false, 0, 0);
  f.setSource(source);
  return { f, asked };
}
const allThere = async (uids: string[]) => new Set(uids);
const listing = (pairs: [string, string | null][]) => ({ Photos: pairs.map(([LinkID, ContentHash]) => ({ LinkID, ContentHash })) });

describe("the duplicate finder", () => {
  it("tells one photo in two files, a burst and look-alikes apart", async () => {
    const T = 1_700_000_000_000;
    const { f } = finder([
      // One photo twice, the copy dated in another time zone.
      { uid: "v~p1", t: 0, look: 1, ms: T },
      { uid: "v~p2", t: 0, look: 1, ms: T + 2 * 3_600_000 + 500 },
      // A burst: shots a second apart, each like the one before.
      { uid: "v~b1", t: 0, look: 2, ms: T + 100_000 },
      { uid: "v~b2", t: 0, look: 2, ms: T + 101_000 },
      { uid: "v~b3", t: 0, look: 2, ms: T + 102_000 },
      // The same scene a day later: only a look-alike.
      { uid: "v~s1", t: 0, look: 3, ms: T + 300_000 },
      { uid: "v~s2", t: 0, look: 3, ms: T + 86_400_000 + 7_000_000 },
    ]);
    f.start();
    await f.settled();
    const g = f.groups();
    expect(g.same.map((x) => x.uids)).toEqual([["v~p1", "v~p2"]]);
    expect(g.burst.map((x) => x.uids)).toEqual([["v~b1", "v~b2", "v~b3"]]);
    expect(g.similar.map((x) => x.uids)).toEqual([["v~s1", "v~s2"]]);
  });

  it("keeps a video and a frame of a series out of the same-photo group", async () => {
    const T = 1_700_000_000_000;
    const H = 3_600_000;
    const { f } = finder([
      // A still and its Live Photo video, the same second.
      { uid: "v~still", t: 0, look: 6, ms: T },
      { uid: "v~live", t: 0, look: 6, ms: T, video: true },
      // A webcam every 30 s of a still scene: frames whole hours apart are not copies.
      { uid: "v~w1", t: 0, look: 7, ms: T + 10 * 60_000 },
      { uid: "v~w2", t: 0, look: 7, ms: T + 10 * 60_000 + 30_000 },
      { uid: "v~w3", t: 0, look: 7, ms: T + 10 * 60_000 + H },
      { uid: "v~w4", t: 0, look: 7, ms: T + 10 * 60_000 + H + 30_000 },
      // Two shots a second apart, a blink between them: a burst, not one photo twice.
      { uid: "v~k1", t: 0, look: "8", ms: T + 5 * H },
      { uid: "v~k2", t: 0, look: "8.6", ms: T + 5 * H + 1_000 },
    ]);
    f.start();
    await f.settled();
    const g = f.groups();
    expect(g.same).toEqual([]);
    expect(g.burst.map((x) => x.uids)).toEqual([["v~k1", "v~k2"]]);
  });

  it("pairs one video in two files and keeps the larger, but not two videos of other lengths", async () => {
    const T = 1_700_000_000_000;
    const { f } = finder([
      // The original and a lighter copy, its start a second off and a frame shorter.
      { uid: "v~orig", t: 0, look: 11, ms: T, video: true, size: 20_000_000, length: 30_000 },
      { uid: "v~lite", t: 0, look: "11.20", ms: T + 1_000, video: true, size: 4_000_000, length: 29_960 },
      // The same again, a Google copy dated in local time against the file's UTC.
      { uid: "v~utc", t: 0, look: 14, ms: T + 300_000, video: true, size: 50_000_000, length: 61_000 },
      { uid: "v~local", t: 0, look: "14.10", ms: T + 300_000 + 2 * 3_600_000, video: true, size: 8_000_000, length: 61_000 },
      // Two clips started the same second at one scene, of other lengths.
      { uid: "v~c1", t: 0, look: 12, ms: T + 600_000, video: true, size: 9_000_000, length: 12_000 },
      { uid: "v~c2", t: 0, look: 12, ms: T + 600_000, video: true, size: 5_000_000, length: 7_000 },
    ]);
    f.start();
    await f.settled();
    const g = f.groups();
    expect(g.same).toEqual([
      {
        key: "v~local|v~utc",
        kind: "same",
        uids: ["v~utc", "v~local"],
        times: [T + 300_000, T + 300_000 + 2 * 3_600_000],
        keep: 0,
      },
      { key: "v~lite|v~orig", kind: "same", uids: ["v~orig", "v~lite"], times: [T, T + 1_000], keep: 0 },
    ]);
    expect(g.similar.map((x) => x.uids)).toEqual([["v~c1", "v~c2"]]);
  });

  it("pairs two videos of one size and length whatever their dates, and keeps the oldest", async () => {
    const T = 1_700_000_000_000;
    const { f } = finder([
      { uid: "v~first", t: 0, look: 15, ms: T, video: true, size: 7_340_032, length: 18_200 },
      // The same file with a rewritten header, dated the day it was uploaded somewhere.
      { uid: "v~again", t: 0, look: "15.2", ms: T + 400 * 86_400_000, video: true, size: 7_340_032, length: 18_200 },
      // Another clip of that size and length that looks different: not paired.
      { uid: "v~other", t: 0, look: 16, ms: T + 3_000, video: true, size: 7_340_032, length: 18_200 },
    ]);
    f.start();
    await f.settled();
    const same = f.groups().same;
    expect(same.map((x) => x.uids)).toEqual([["v~first", "v~again"]]);
    expect(same[0].keep).toBeUndefined();
  });

  it("puts an original, its same-size twin and its lighter copy in one group", async () => {
    const T = 1_700_000_000_000;
    const { f } = finder([
      { uid: "v~orig", t: 0, look: 22, ms: T, video: true, size: 20_000_000, length: 30_000 },
      { uid: "v~twin", t: 0, look: "22.2", ms: T + 90 * 86_400_000, video: true, size: 20_000_000, length: 30_000 },
      { uid: "v~lite", t: 0, look: "22.20", ms: T, video: true, size: 4_000_000, length: 29_960 },
    ]);
    f.start();
    await f.settled();
    const same = f.groups().same;
    expect(same).toHaveLength(1);
    expect(new Set(same[0].uids)).toEqual(new Set(["v~orig", "v~twin", "v~lite"]));
    expect(same[0].uids[same[0].keep!]).not.toBe("v~lite");
  });

  it("suggests no keeper for photos: a larger export is not the original", async () => {
    const T = 1_700_000_000_000;
    const { f } = finder([
      { uid: "v~heic", t: 0, look: 13, ms: T, size: 900_000 },
      { uid: "v~jpeg", t: 0, look: "13.4", ms: T, size: 5_000_000 },
    ]);
    f.start();
    await f.settled();
    expect(f.groups().same[0].keep).toBeUndefined();
  });

  it("keeps the next largest video once the largest is trashed, and none when a size is unknown", async () => {
    const T = 1_700_000_000_000;
    const { f } = finder([
      { uid: "v~20", t: 0, look: 17, ms: T, video: true, size: 20_000_000, length: 40_000 },
      { uid: "v~10", t: 0, look: "17.4", ms: T + 500, video: true, size: 10_000_000, length: 40_000 },
      { uid: "v~4", t: 0, look: "17.8", ms: T + 1_000, video: true, size: 4_000_000, length: 39_960 },
      { uid: "v~u1", t: 0, look: 18, ms: T + 900_000, video: true, size: 9_000_000, length: 20_000 },
      { uid: "v~u2", t: 0, look: "18.4", ms: T + 900_500, video: true, length: 20_000 },
    ]);
    f.start();
    await f.settled();
    const byKey = (key: string) => f.groups().same.find((g) => g.uids.includes(key))!;
    expect(byKey("v~20")).toMatchObject({ uids: ["v~20", "v~10", "v~4"], keep: 0 });
    expect(byKey("v~u1").keep).toBeUndefined();
    f.removed(["v~20"]);
    expect(byKey("v~10")).toMatchObject({ uids: ["v~10", "v~4"], keep: 0 });
  });

  it("does not pair a dashcam's segments, back-to-back short clips, or a timelapse hours apart", async () => {
    const T = 1_700_000_000_000;
    const H = 3_600_000;
    const photos: Parameters<typeof finder>[0] = [];
    // Five padded segments of one size and length, a minute apart, of one road at night.
    for (let k = 0; k < 5; k++) {
      photos.push({ uid: `v~seg${k}`, t: 0, look: 19, ms: T + k * 60_000, video: true, size: 104_857_600, length: 60_000 });
    }
    // Two 2.5 s clips, the second started 2 s after the first.
    photos.push({ uid: "v~q1", t: 0, look: 20, ms: 2 * T, video: true, size: 3_000_000, length: 2_500 });
    photos.push({ uid: "v~q2", t: 0, look: "20.2", ms: 2 * T + 2_000, video: true, size: 2_900_000, length: 2_400 });
    // A timelapse of fixed clips every 10 minutes: clips whole hours apart are other clips.
    for (let k = 0; k < 13; k++) {
      photos.push({ uid: `v~tl${k}`, t: 0, look: 21, ms: 3 * T + k * 600_000, video: true, size: 5_000_000 + k, length: 10_000 });
    }
    const { f } = finder(photos);
    f.start();
    await f.settled();
    expect(f.groups().same).toEqual([]);
  });

  it("does not take pages photographed one after another for a burst", async () => {
    const T = 1_700_000_000_000;
    const { f } = finder([
      // Three pages of one book, a second apart: alike at the usual bar.
      { uid: "v~pg1", t: 0, look: "23.0p", ms: T },
      { uid: "v~pg2", t: 0, look: "23.30p", ms: T + 1_000 },
      { uid: "v~pg3", t: 0, look: "23.60p", ms: T + 2_000 },
      // A page retaken held steady: one shot of it.
      { uid: "v~rt1", t: 0, look: "24.0p", ms: T + 600_000 },
      { uid: "v~rt2", t: 0, look: "24.8p", ms: T + 601_000 },
      // The same distances between ordinary shots are a burst as before.
      { uid: "v~ph1", t: 0, look: "25", ms: T + 1_200_000 },
      { uid: "v~ph2", t: 0, look: "25.30", ms: T + 1_201_000 },
      { uid: "v~ph3", t: 0, look: "25.60", ms: T + 1_202_000 },
    ]);
    f.start();
    await f.settled();
    expect(f.groups().burst.map((x) => x.uids)).toEqual([
      ["v~ph1", "v~ph2", "v~ph3"],
      ["v~rt1", "v~rt2"],
    ]);
    // Pages of one book still look alike: shown as similar, not as a burst.
    expect(f.groups().similar.map((x) => x.uids)).toEqual([["v~pg1", "v~pg2", "v~pg3"]]);
  });

  it("finds a burst when another scene shot the same second sorts in between", async () => {
    const T = 1_700_000_000_000;
    const { f } = finder([
      { uid: "v~a1", t: 0, look: "9", ms: T },
      { uid: "v~x", t: 0, look: 10, ms: T },
      { uid: "v~a2", t: 0, look: "9.20", ms: T + 1_000 },
      { uid: "v~a3", t: 0, look: "9.40", ms: T + 2_000 },
    ]);
    f.start();
    await f.settled();
    expect(f.groups().burst.map((x) => x.uids)).toEqual([["v~a1", "v~a2", "v~a3"]]);
  });

  it("ends a burst at a gap or at a shot that looks different", async () => {
    const T = 1_700_000_000_000;
    const { f } = finder([
      // Two shots a second and a half apart, alike but not one picture.
      { uid: "v~a", t: 0, look: "4", ms: T },
      { uid: "v~b", t: 0, look: "4.30", ms: T + 1_500 },
      { uid: "v~c", t: 0, look: 5, ms: T + 2_500 },
      { uid: "v~d", t: 0, look: "4", ms: T + 60_000 },
    ]);
    f.start();
    await f.settled();
    const g = f.groups();
    expect(g.burst.map((x) => x.uids)).toEqual([["v~a", "v~b"]]);
    // d looks like a but a minute later: not part of the burst, and not the same photo.
    expect(g.same).toEqual([]);
  });

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
    expect(g.identical).toEqual([{ key: "v~a|v~b", kind: "identical", uids: ["v~b", "v~a"], times: [SPREAD, 3 * SPREAD] }]);
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
      list: async () => photos.map((p) => ({ uid: p.uid, captureTime: p.t * SPREAD })),
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
      list: async () => photos.map((p) => ({ uid: p.uid, captureTime: p.t * SPREAD })),
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
