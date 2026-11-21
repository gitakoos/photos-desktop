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
import { beforeAll, describe, expect, it } from "vitest";

import { EMBEDDING_DIM, type SearchCopy } from "./semantic.ts";
import { initStore, setDataKey, writeSealedAtomic } from "./store.ts";
import {
  NO_THEME,
  THEME_TABLE,
  ThemeIndex,
  cacheKey,
  classifyThemeScores,
  classifyVector,
  decodeAssignments,
  decodePrompts,
  encodeAssignments,
  encodePrompts,
  type ThemeAssignment,
} from "./themes.ts";

const IDS = [10, 11, 12, 13];
const ONE = 0x3c00;
const HALF = 0x3800;

describe("the theme rule", () => {
  it("gives nothing when the best score is under the top threshold", () => {
    expect(classifyThemeScores([0.19, 0.1, 0, 0], IDS)).toEqual(NO_THEME);
  });

  it("gives the best theme alone at the top threshold", () => {
    const a = classifyThemeScores([0.1, 0.2, 0.15, 0], IDS);
    expect(a).toEqual({ first: 11, firstScore: 0.2, second: -1, secondScore: 0 });
  });

  it("adds a second theme only above its own threshold and within the margin of the best", () => {
    expect(classifyThemeScores([0.3, 0.234, 0, 0], IDS).second).toBe(-1);
    expect(classifyThemeScores([0.3, 0.28, 0, 0], IDS).second).toBe(-1);
    const both = classifyThemeScores([0.3, 0.29, 0, 0], IDS);
    expect(both.first).toBe(10);
    expect(both.second).toBe(11);
    expect(both.secondScore).toBeCloseTo(0.29, 6);
  });

  it("keeps one second theme, the closest, and breaks ties to the lowest index", () => {
    const three = classifyThemeScores([0.3, 0.29, 0.295, 0], IDS);
    expect([three.first, three.second]).toEqual([10, 12]);
    const tie = classifyThemeScores([0.3, 0.3, 0.3, 0], IDS);
    expect([tie.first, tie.second]).toEqual([10, 11]);
  });

  it("scores a theme as its best prompt and ignores a vector of another width", () => {
    const e = (i: number, n = 4) => Float32Array.from({ length: n }, (_, d) => (d === i ? 1 : 0));
    const prompts = [[e(0), e(1)], [e(2)]];
    expect(classifyVector(e(1), prompts, [5, 6])).toMatchObject({ first: 5, firstScore: 1, second: -1 });
    expect(classifyVector(e(2), prompts, [5, 6]).first).toBe(6);
    expect(classifyVector(e(3), prompts, [5, 6])).toEqual(NO_THEME);
    expect(classifyVector(e(1, 3), prompts, [5, 6])).toEqual(NO_THEME);
  });

  it("has unique ids and slugs, every theme with a prompt", () => {
    expect(new Set(THEME_TABLE.map((c) => c.id)).size).toBe(THEME_TABLE.length);
    expect(new Set(THEME_TABLE.map((c) => c.slug)).size).toBe(THEME_TABLE.length);
    expect(THEME_TABLE).toHaveLength(20);
    expect(THEME_TABLE.every((c) => c.prompts.length > 0)).toBe(true);
  });
});

describe("the cache files", () => {
  const entries = new Map<string, ThemeAssignment>([
    ["a", { first: 3, firstScore: 0.5, second: 9, secondScore: 0.25 }],
    ["b~é", NO_THEME],
  ]);

  it("reads back what was written", () => {
    expect(decodeAssignments(encodeAssignments(entries))).toEqual(entries);
  });

  it("is dropped when the model or the table generation changed, or the file is cut or foreign", () => {
    const blob = encodeAssignments(entries, "model-a|1");
    expect(decodeAssignments(blob, "model-a|1")).toEqual(entries);
    expect(decodeAssignments(blob, "model-a|2")).toBeNull();
    expect(decodeAssignments(blob, "model-b|1")).toBeNull();
    expect(decodeAssignments(blob.subarray(0, blob.length - 3), "model-a|1")).toBeNull();
    expect(decodeAssignments(Buffer.from("not a cache file at all"), "model-a|1")).toBeNull();
  });

  it("keeps the prompt vectors per generation and count", () => {
    const vectors = [Float32Array.from([1, 0]), Float32Array.from([0, 1])];
    expect(decodePrompts(encodePrompts(vectors, "k|1"), 2, "k|1")).toEqual(vectors);
    expect(decodePrompts(encodePrompts(vectors, "k|1"), 3, "k|1")).toBeNull();
    expect(decodePrompts(encodePrompts(vectors, "k|1"), 2, "k|2")).toBeNull();
  });

  it("is keyed by the table generation", () => {
    expect(cacheKey()).toMatch(/\|\d+$/);
  });
});

describe("the index", () => {
  beforeAll(() => {
    initStore(mkdtempSync(join(tmpdir(), "pfp-themes-")));
    setDataKey(randomBytes(32));
  });

  const prompts = THEME_TABLE.flatMap((c) => c.prompts);
  /** The first prompt of a theme, which the fake text encoder puts on its own axis. */
  const axis = (slug: string) => prompts.indexOf(THEME_TABLE.find((c) => c.slug === slug)!.prompts[0]);
  const unitAxis = (text: string) =>
    Float32Array.from({ length: EMBEDDING_DIM }, (_, d) => (d === prompts.indexOf(text) ? 1 : 0));

  function harness() {
    const dir = mkdtempSync(join(tmpdir(), "pfp-themes-dir-"));
    const state = { embedded: 0 };
    const make = () =>
      new ThemeIndex({
        dir: () => dir,
        yieldNow: () => new Promise((r) => setImmediate(r)),
        embed: async (text) => {
          state.embedded++;
          return unitAxis(text);
        },
      });
    return { dir, state, make };
  }

  /** A search copy whose photo `key` shows the given themes, by the axes of their first prompts. */
  function copyOf(photos: Record<string, string[]>): SearchCopy {
    const keys = Object.keys(photos);
    const vectors = new Uint16Array(keys.length * EMBEDDING_DIM);
    keys.forEach((k, i) => {
      const slugs = photos[k];
      for (const s of slugs) vectors[i * EMBEDDING_DIM + axis(s)] = slugs.length === 1 ? ONE : HALF;
    });
    return { keys, vectors };
  }

  const keysOf = (index: ThemeIndex, slug: string) => index.snapshot().themes.find((t) => t.slug === slug)?.keys;

  it("classifies the library in the background and groups it best first", async () => {
    const { make } = harness();
    const index = make();
    const first = index.request([copyOf({ a: ["beach"], b: ["food"], c: ["beach", "sunsets"], d: [] })]);
    expect(first.syncing).toBe(true);
    await index.settled();
    expect(index.snapshot().syncing).toBe(false);
    expect(keysOf(index, "beach")).toEqual(["a", "c"]);
    expect(keysOf(index, "sunsets")).toEqual(["c"]);
    expect(keysOf(index, "food")).toEqual(["b"]);
    expect(index.snapshot().themes.some((t) => t.keys.includes("d"))).toBe(false);
  });

  it("scores only the photos it has not seen, and forgets removed ones", async () => {
    const { make, state } = harness();
    const index = make();
    index.request([copyOf({ a: ["beach"], b: ["food"] })]);
    await index.settled();
    expect(state.embedded).toBe(prompts.length);

    // `a` now carries another picture under the same key: a rescore would move it to food.
    index.request([copyOf({ a: ["food"], b: ["food"], c: ["pets"] })]);
    await index.settled();
    expect(state.embedded).toBe(prompts.length);
    expect(keysOf(index, "beach")).toEqual(["a"]);
    expect(keysOf(index, "pets")).toEqual(["c"]);

    index.request([copyOf({ c: ["pets"] })]);
    await index.settled();
    expect(keysOf(index, "beach")).toBeUndefined();
    expect(keysOf(index, "food")).toBeUndefined();
    expect(keysOf(index, "pets")).toEqual(["c"]);
  });

  it("does no work for a library it already holds", async () => {
    const { make } = harness();
    const index = make();
    const copy = copyOf({ a: ["beach"] });
    index.request([copy]);
    await index.settled();
    expect(index.request([copy]).syncing).toBe(false);
  });

  it("is read back from disk by the next run without embedding anything", async () => {
    const { make, state } = harness();
    const copy = copyOf({ a: ["beach"], b: ["food"] });
    const one = make();
    one.request([copy]);
    await one.settled();
    const embedded = state.embedded;

    const two = make();
    expect(two.request([copy]).syncing).toBe(false);
    expect(state.embedded).toBe(embedded);
    expect(keysOf(two, "beach")).toEqual(["a"]);
  });

  it("starts over when the cached generation is not the running one", async () => {
    const { dir, make, state } = harness();
    const copy = copyOf({ a: ["beach"] });
    const one = make();
    one.request([copy]);
    await one.settled();

    const stale = new Map([["a", { first: 0, firstScore: 1, second: -1, secondScore: 0 }]]);
    writeSealedAtomic(join(dir, "assign.enc"), encodeAssignments(stale, "other|0"));
    writeSealedAtomic(join(dir, "prompts.enc"), encodePrompts([Float32Array.from([1])], "other|0"));
    const before = state.embedded;

    const two = make();
    expect(two.request([copy]).syncing).toBe(true);
    await two.settled();
    expect(state.embedded).toBe(before + prompts.length);
    expect(keysOf(two, "beach")).toEqual(["a"]);
    expect(keysOf(two, "food")).toBeUndefined();
  });

  it("holds nothing while the text model is missing, and tries again on the next ask", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pfp-themes-dir-"));
    let model = false;
    const index = new ThemeIndex({
      dir: () => dir,
      yieldNow: () => new Promise((r) => setImmediate(r)),
      embed: async (text) => (model ? unitAxis(text) : null),
    });
    const copy = copyOf({ a: ["beach"] });
    index.request([copy]);
    await index.settled();
    expect(index.snapshot().themes).toEqual([]);
    model = true;
    index.request([copy]);
    await index.settled();
    expect(keysOf(index, "beach")).toEqual(["a"]);
  });

  it("keeps a zero vector, which the phone writes for an unreadable photo, out of every theme", async () => {
    const { make } = harness();
    const index = make();
    index.request([{ keys: ["z"], vectors: new Uint16Array(EMBEDDING_DIM) }]);
    await index.settled();
    expect(index.snapshot().themes).toEqual([]);
  });
});
