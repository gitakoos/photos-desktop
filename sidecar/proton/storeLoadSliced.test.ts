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

// The face data and the search index read a large library at the start of a scan pass. Read
// straight, they held the sidecar for seconds (about 0.7 s at 50,000 faces, 5 to 10 s at 150,000,
// and about 1 s for the vectors of 150,000 photos), so every call the window made waited.

import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { FACE_EMBEDDING_DIM } from "./faceCluster.ts";
import { FaceStore, type FaceRecord } from "./faceStore.ts";
import { SearchStore } from "./searchIndex.ts";
import { EMBEDDING_DIM } from "./semantic.ts";
import { initStore, setDataKey } from "./store.ts";
import { direction, seeded } from "./testFaces.ts";

beforeEach(() => {
  initStore(mkdtempSync(join(tmpdir(), "pfp-sliced-load-")));
  setDataKey(randomBytes(32));
});

/**
 * Beside the other test files the machine is shared and their garbage is collected on this thread
 * too, so the bound in milliseconds holds only for this file run on its own:
 * `PFP_TIMED=1 npx vitest run proton/storeLoadSliced.test.ts`. The straight read is always the
 * slower by far.
 */
const timedAlone = process.env.PFP_TIMED === "1";

/** A turn at every step, so a small store is read across many turns too. */
const everyStep = () => new Promise<void>((resolve) => setImmediate(resolve));

function face(uid: string, index: number, embedding: Float32Array): FaceRecord {
  return {
    id: `${uid}#${index}`,
    uid,
    box: [0.1, 0.1, 0.3, 0.4],
    points: [0.15, 0.2, 0.25, 0.2, 0.2, 0.25, 0.16, 0.32, 0.24, 0.32],
    score: 0.9,
    blur: 100,
    sideways: 0.02,
    embedding,
  };
}

/** A face store of `photos` photos with two faces each, written to disk. */
function writeFaces(photos: number): void {
  const rand = seeded(5);
  const store = new FaceStore();
  store.load();
  store.people.deviceId = "bench-device";
  for (let p = 0; p < photos; p++) {
    const uid = `vol~photo${p}`;
    store.put(uid, [face(uid, 0, direction(rand)), face(uid, 1, direction(rand))]);
  }
  store.flush();
  expect(store.allFaces()[0].embedding.length).toBe(FACE_EMBEDDING_DIM);
}

/** A search index of `photos` photos, every tenth one unreadable, written to disk. */
function writeVectors(photos: number): void {
  const store = new SearchStore();
  store.load();
  for (let p = 0; p < photos; p++) {
    const v = new Uint16Array(EMBEDDING_DIM);
    for (let k = 0; k < EMBEDDING_DIM; k++) v[k] = (p * 31 + k * 7) & 0xffff;
    store.put(`vol~photo${p}`, p % 10 === 0 ? null : v);
  }
  store.flush();
}

/** The longest the event loop's timers ran late while `work` ran. */
async function lagDuring(work: () => unknown): Promise<number> {
  await new Promise((r) => setTimeout(r, 20));
  let lag = 0;
  let last = performance.now();
  const tick = setInterval(() => {
    const now = performance.now();
    lag = Math.max(lag, now - last - 5);
    last = now;
  }, 5);
  try {
    await work();
    await new Promise((r) => setTimeout(r, 20));
    return lag;
  } finally {
    clearInterval(tick);
  }
}

/**
 * The least `lagDuring` of three runs of `work`. A step of the read that holds the thread holds it
 * in every run; a busy machine stalling this process lands on one run now and then, and on a sliced
 * read, being the longer, more often than on the straight one.
 */
async function leastLag(work: () => unknown): Promise<number> {
  let least = Infinity;
  for (let run = 0; run < 3; run++) least = Math.min(least, await lagDuring(work));
  return least;
}

describe("the face data read a slice at a time", { timeout: 120_000 }, () => {
  it("holds what a straight read holds", async () => {
    writeFaces(800);
    const straight = new FaceStore();
    straight.load();
    const sliced = new FaceStore();
    await sliced.loadSliced(everyStep);
    expect(sliced.isLoaded()).toBe(true);
    expect(sliced.allFaces()).toEqual(straight.allFaces());
    expect(sliced.people).toEqual(straight.people);
    expect(sliced.allFaces()).toHaveLength(1600);
  });

  it("keeps the sidecar answering while a large library is read", async () => {
    writeFaces(10_000);
    // The sliced reads first: the straight one's garbage, collected later, would land on them.
    let store = new FaceStore();
    const sliced = await leastLag(() => (store = new FaceStore()).loadSliced());
    const straight = await lagDuring(() => new FaceStore().load());
    process.stderr.write(`[test] 20,000 faces read: straight late ${straight.toFixed(0)} ms, sliced late ${sliced.toFixed(0)} ms\n`);
    expect(store.allFaces()).toHaveLength(20_000);
    expect(straight).toBeGreaterThan(sliced * 3);
    if (timedAlone) expect(sliced).toBeLessThan(50);
  });

  it("leaves a store read straight meanwhile as it is", async () => {
    writeFaces(200);
    const store = new FaceStore();
    const reading = store.loadSliced(everyStep);
    await everyStep();
    store.load();
    const uid = "vol~added-meanwhile";
    store.put(uid, [face(uid, 0, direction(seeded(9)))]);
    await reading;
    expect(store.has(uid)).toBe(true);
    expect(store.allFaces()).toHaveLength(401);
  });

  it("leaves a store let go meanwhile let go", async () => {
    writeFaces(200);
    const store = new FaceStore();
    const reading = store.loadSliced(everyStep);
    await everyStep();
    store.unload();
    await reading;
    expect(store.isLoaded()).toBe(false);
    expect(store.allFaces()).toHaveLength(0);
  });
});

describe("the search index read a slice at a time", { timeout: 120_000 }, () => {
  it("holds what a straight read holds", async () => {
    writeVectors(900);
    const straight = new SearchStore();
    straight.load();
    const sliced = new SearchStore();
    await sliced.loadSliced(everyStep);
    expect(sliced.isLoaded()).toBe(true);
    expect(sliced.entries()).toEqual(straight.entries());
    expect(sliced.counts()).toEqual({ indexed: 810, unreadable: 90 });
  });

  it("keeps the sidecar answering while a large index is read", async () => {
    writeVectors(60_000);
    let store = new SearchStore();
    const sliced = await leastLag(() => (store = new SearchStore()).loadSliced());
    const straight = await lagDuring(() => new SearchStore().load());
    process.stderr.write(`[test] 60,000 vectors read: straight late ${straight.toFixed(0)} ms, sliced late ${sliced.toFixed(0)} ms\n`);
    expect(store.counts().indexed + store.counts().unreadable).toBe(60_000);
    expect(straight).toBeGreaterThan(sliced * 3);
    if (timedAlone) expect(sliced).toBeLessThan(50);
  });

  it("leaves an index emptied or let go meanwhile as it is", async () => {
    writeVectors(300);
    const emptied = new SearchStore();
    const reading = emptied.loadSliced(everyStep);
    await everyStep();
    emptied.clear();
    await reading;
    expect(emptied.counts()).toEqual({ indexed: 0, unreadable: 0 });

    writeVectors(300);
    const gone = new SearchStore();
    const reading2 = gone.loadSliced(everyStep);
    await everyStep();
    gone.unload();
    await reading2;
    expect(gone.isLoaded()).toBe(false);
  });
});
