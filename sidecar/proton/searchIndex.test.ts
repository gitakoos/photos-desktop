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
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  CLIP_SIDE,
  SearchStore,
  clipPlanes,
  compareSearch,
  decodeShard,
  encodeShard,
  fillFromCopies,
  floatToHalf,
  toHalves,
} from "./searchIndex.ts";
import { EMBEDDING_DIM, halfToFloatTable, rank } from "./semantic.ts";
import { SEARCH_DIR, initStore, setDataKey } from "./store.ts";
import { direction, seeded } from "./testFaces.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pfp-search-"));
  initStore(dir);
  setDataKey(randomBytes(32));
});

describe("half precision", () => {
  it("comes back within half a step of every value", () => {
    const table = halfToFloatTable();
    const rand = seeded(81);
    for (let i = 0; i < 2000; i++) {
      const v = (rand() - 0.5) * 2 ** Math.floor(rand() * 20 - 14);
      const back = table[floatToHalf(v)];
      const step = Math.abs(v) < 6.1e-5 ? 2 ** -24 : 2 ** (Math.floor(Math.log2(Math.abs(v))) - 10);
      expect(Math.abs(back - v)).toBeLessThanOrEqual(step / 2 + 1e-12);
    }
    expect(table[floatToHalf(0)]).toBe(0);
    expect(table[floatToHalf(1)]).toBe(1);
    expect(table[floatToHalf(-0.5)]).toBe(-0.5);
    expect(table[floatToHalf(1e6)]).toBe(Infinity);
  });

  it("keeps a unit vector's direction", () => {
    const v = direction(seeded(82));
    const h = toHalves(v);
    const table = halfToFloatTable();
    let dot = 0;
    for (let i = 0; i < v.length; i++) dot += v[i] * table[h[i]];
    expect(dot).toBeCloseTo(1, 3);
  });
});

describe("the encoder's input", () => {
  it("lays the square out as red, green and blue planes, normalised the CLIP way", () => {
    const rgb = new Uint8Array(CLIP_SIDE * CLIP_SIDE * 3).fill(255);
    rgb[0] = 0;
    const planes = clipPlanes(rgb);
    expect(planes.length).toBe(3 * CLIP_SIDE * CLIP_SIDE);
    expect(planes[0]).toBeCloseTo((0 - 0.48145466) / 0.26862954, 5);
    expect(planes[1]).toBeCloseTo((1 - 0.48145466) / 0.26862954, 5);
    expect(planes[CLIP_SIDE * CLIP_SIDE]).toBeCloseTo((1 - 0.4578275) / 0.26130258, 5);
  });
});

describe("the search index made here", () => {
  it("is written sealed and read back, the unreadable photos with it", () => {
    const store = new SearchStore();
    store.load();
    const rand = seeded(83);
    store.put("vol~a", toHalves(direction(rand)));
    store.put("vol~b", null);
    store.put("vol~a-photo-that-must-stay-hidden", null);
    store.flush();
    for (const name of readdirSync(join(dir, SEARCH_DIR))) {
      expect(readFileSync(join(dir, SEARCH_DIR, name)).includes("vol~a-photo-that-must-stay-hidden")).toBe(false);
    }
    const again = new SearchStore();
    again.load();
    expect(again.has("vol~a")).toBe(true);
    expect(again.has("vol~b")).toBe(true);
    expect(again.counts()).toEqual({ indexed: 1, unreadable: 2 });
    expect(again.copy().keys).toEqual(["a"]);
  });

  it("moves a photo's vector to the copy a date change made, and survives a reload", () => {
    const store = new SearchStore();
    store.load();
    const v = toHalves(direction(seeded(85)));
    store.put("vol~old", v);
    store.put("vol~other", toHalves(direction(seeded(86))));
    expect(store.move("vol~old", "vol~new")).toBe(true);
    expect(store.has("vol~old")).toBe(false);
    expect(store.get("vol~new")).toEqual(v);
    // Nothing left to move, and a copy that already has its own vector is not overwritten.
    expect(store.move("vol~old", "vol~new")).toBe(false);
    expect(store.move("vol~other", "vol~new")).toBe(false);
    store.flush();
    const again = new SearchStore();
    again.load();
    expect(again.has("vol~old")).toBe(false);
    expect(again.get("vol~new")).toEqual(v);
  });

  it("round-trips a shard", () => {
    const v = toHalves(direction(seeded(84)));
    const back = decodeShard(encodeShard(new Map([["x", v], ["y", null]])));
    expect(back.get("x")).toEqual(v);
    expect(back.get("y")).toBeNull();
  });

  it("is ranked with the phone's, a photo in both once", () => {
    const rand = seeded(85);
    const cat = direction(rand);
    const store = new SearchStore();
    store.load();
    store.put("vol~here", toHalves(cat));
    store.put("vol~both", toHalves(cat));
    const phone = { keys: ["both", "phoneonly"], vectors: new Uint16Array(2 * EMBEDDING_DIM) };
    phone.vectors.set(toHalves(cat), 0);
    phone.vectors.set(toHalves(direction(rand)), EMBEDDING_DIM);
    const hits = rank([phone, store.copy()], cat, 10, 0.5);
    expect(hits.map((h) => h.key).sort()).toEqual(["both", "here"]);
  });

  it("is measured against the phone's on the photos both indexed", () => {
    const rand = seeded(86);
    const v = direction(rand);
    const store = new SearchStore();
    store.load();
    store.put("vol~p", toHalves(v));
    const phone = { keys: ["p", "zero"], vectors: new Uint16Array(2 * EMBEDDING_DIM) };
    phone.vectors.set(toHalves(v), 0);
    const report = compareSearch(store.copy(), [phone]);
    expect(report.pairs).toBe(1);
    expect(report.median).toBeCloseTo(1, 3);
  });
});

describe("the other devices' vectors", () => {
  const vec = (v: number) => new Uint16Array(EMBEDDING_DIM).fill(v);
  it("fill only the photos with no vector here, and never one the other device could not read", () => {
    const here = new Map<string, Uint16Array | null>([
      ["v~a", vec(1)],
      ["v~b", null],
    ]);
    const store = { get: (uid: string) => here.get(uid), put: (uid: string, v: Uint16Array | null) => void here.set(uid, v) };
    const keys = ["a", "b", "c", "d", "gone"];
    const vectors = new Uint16Array(keys.length * EMBEDDING_DIM);
    vectors.set(vec(7), 0);
    vectors.set(vec(7), EMBEDDING_DIM);
    vectors.set(vec(7), 2 * EMBEDDING_DIM);
    // "d" stays all zeros: a photo the phone could not read.
    vectors.set(vec(7), 4 * EMBEDDING_DIM);
    const uidByLink = new Map([
      ["a", "v~a"],
      ["b", "v~b"],
      ["c", "v~c"],
      ["d", "v~d"],
    ]);
    expect(fillFromCopies(store, [{ keys, vectors }], uidByLink)).toBe(2);
    expect(here.get("v~a")![0]).toBe(1);
    expect(here.get("v~b")![0]).toBe(7);
    expect(here.get("v~c")![0]).toBe(7);
    expect(here.has("v~d")).toBe(false);
    expect(fillFromCopies(store, [{ keys, vectors }], uidByLink)).toBe(0);
  });
});
