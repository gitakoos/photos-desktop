/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { dot, FACE_CLUSTER_MERGE_THRESHOLD } from "./faceCluster.ts";
import { curationKey, regroupAll } from "./facePeople.ts";
import { applySplit, planSplit, sortYear, splitStart, undoSplit } from "./faceSplit.ts";
import { FaceStore, type FaceRecord } from "./faceStore.ts";
import { initStore, setDataKey } from "./store.ts";
import { direction, faceOf, seeded } from "./testFaces.ts";

beforeEach(() => {
  initStore(mkdtempSync(join(tmpdir(), "pfp-split-")));
  setDataKey(randomBytes(32));
});

function unit(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  return v.map((x) => x / Math.sqrt(n));
}

const face = (uid: string, index: number, embedding: Float32Array, score = 0.9): FaceRecord => ({
  id: `${uid}#${index}`,
  uid,
  box: [0.1 + index * 0.4, 0.1, 0.3 + index * 0.4, 0.4],
  points: [],
  score,
  blur: 100,
  sideways: 0,
  embedding,
});

/**
 * Two siblings put together as one person, "Alex", every face confirmed as Alex the way naming
 * a group confirms it: `alex` and `sam` photos of one each, and `both` photos with the two.
 * `apart` is how far Sam's identity is from Alex's: small is a lookalike, 0 a twin.
 */
function merged(apart: number, alex = 120, sam = 90, both = 6) {
  const rand = seeded(7);
  const a = direction(rand);
  const b = unit(a.map((x, i) => x + apart * (direction(rand)[i] ?? 0)));
  const store = new FaceStore();
  store.load();
  const p = store.people;
  p.people.push({ id: "pA", name: "Alex", isOther: false });
  const truth = new Map<string, "a" | "b">();
  const put = (uid: string, faces: FaceRecord[]) => {
    store.put(uid, faces);
    for (const f of faces) {
      p.assign[f.id] = "pA";
      p.confirmed[f.id] = "Alex";
    }
  };
  for (let i = 0; i < alex; i++) {
    const f = face(`vol~a${i}`, 0, faceOf(a, rand, 0.55));
    put(f.uid, [f]);
    truth.set(f.id, "a");
  }
  for (let i = 0; i < sam; i++) {
    const f = face(`vol~b${i}`, 0, faceOf(b, rand, 0.55));
    put(f.uid, [f]);
    truth.set(f.id, "b");
  }
  for (let i = 0; i < both; i++) {
    const uid = `vol~ab${i}`;
    const fa = face(uid, 0, faceOf(a, rand, 0.55));
    const fb = face(uid, 1, faceOf(b, rand, 0.55));
    put(uid, [fa, fb]);
    truth.set(fa.id, "a");
    truth.set(fb.id, "b");
  }
  p.grouped = true;
  return { store, truth, a, b };
}

const pick = (truth: Map<string, "a" | "b">, side: "a" | "b", n: number) =>
  [...truth].filter(([, s]) => s === side).slice(0, n).map(([id]) => id);

describe("siblings grouped as one person", () => {
  it("really are one group to the grouping's own rule", () => {
    const { a, b } = merged(0.6);
    expect(dot(a, b)).toBeGreaterThan(FACE_CLUSTER_MERGE_THRESHOLD);
  });

  it("are split apart from five faces of each", async () => {
    const { store, truth } = merged(0.6);
    const plan = await planSplit(store, "pA", "Sam", { a: pick(truth, "a", 5), b: pick(truth, "b", 5) });
    expect(plan.verdict).toBe("reliable");
    let wrong = 0;
    // Every face sorted to a side is on the right one; the rest wait for the user.
    const sides = new Map<string, string>();
    for (const f of plan.leastSureA) sides.set(f.faceId, "a");
    for (const f of plan.leastSureB) sides.set(f.faceId, "b");
    for (const [id, s] of sides) if (truth.get(id) !== s) wrong++;
    expect(wrong).toBe(0);
    expect(plan.counts.a + plan.counts.b).toBeGreaterThan(truth.size * 0.8);
  });

  it("keep two faces of one photo apart", async () => {
    const { store, truth } = merged(0.6);
    const applied = await applySplit(store, "pA", "Sam", { a: pick(truth, "a", 5), b: pick(truth, "b", 5) }, 50);
    expect(applied.moved).toBeGreaterThan(0);
    const p = store.people;
    for (let i = 0; i < 6; i++) {
      const left = p.assign[`vol~ab${i}#0`];
      const right = p.assign[`vol~ab${i}#1`];
      if (p.confirmed[`vol~ab${i}#0`] && p.confirmed[`vol~ab${i}#1`]) expect(left).not.toBe(right);
    }
  });

  it("stay split through a regroup, by the confirmations and marks the split leaves", async () => {
    const { store, truth } = merged(0.6);
    const applied = await applySplit(store, "pA", "Sam", { a: pick(truth, "a", 5), b: pick(truth, "b", 5) }, 50);
    const p = store.people;
    const sam = p.people.find((x) => x.name === "Sam")!;
    const moved = Object.entries(p.assign).filter(([, id]) => id === sam.id).map(([id]) => id);
    // The examples picked for Sam are among the faces moved.
    expect(moved.length).toBe(applied.moved);
    for (const id of moved.filter((id) => !pick(truth, "b", 5).includes(id))) {
      expect(p.confirmed[id]).toBe("Sam");
      expect(p.blocked[id]).toContain("Alex");
      expect(p.curation[curationKey(2, "Alex", id.slice(id.indexOf("~") + 1))]).toMatchObject({ removed: false, at: 50 });
    }
    await regroupAll(store);
    const samAfter = store.people.people.find((x) => x.name === "Sam")!;
    const after = Object.entries(store.people.assign).filter(([, id]) => id === samAfter.id).map(([id]) => id);
    expect(after.sort()).toEqual(moved.sort());
  });

  it("go back as they were on undo, marked off the other person for the other device", async () => {
    const { store, truth } = merged(0.6);
    const before = JSON.stringify({ assign: store.people.assign, confirmed: store.people.confirmed });
    const applied = await applySplit(store, "pA", "Sam", { a: pick(truth, "a", 5), b: pick(truth, "b", 5) }, 50);
    const sam = store.people.people.find((x) => x.name === "Sam")!.id;
    const moved = Object.entries(store.people.assign).filter(([, id]) => id === sam).map(([id]) => id);
    const undone = undoSplit(store, applied.undo, 60);
    expect(undone).toMatchObject({ ok: true, skipped: 0 });
    const p = store.people;
    expect(JSON.stringify({ assign: p.assign, confirmed: p.confirmed })).toBe(before);
    // Each face that went to Sam is marked not Sam, now, so a device that took the split moves it back.
    for (const id of moved) {
      expect(p.blocked[id]).toEqual(["Sam"]);
      expect(p.curation[curationKey(2, "Sam", id.slice(id.indexOf("~") + 1))]).toMatchObject({ removed: false, at: 60 });
      expect(p.curation[curationKey(2, "Alex", id.slice(id.indexOf("~") + 1))]).toMatchObject({ removed: true, at: 60 });
    }
    expect(p.people.some((x) => x.name === "Sam")).toBe(false);
    expect(undoSplit(store, applied.undo, 70).ok).toBe(false);
  });

  it("leave a face changed after the split as it is on undo", async () => {
    const { store, truth } = merged(0.6);
    const applied = await applySplit(store, "pA", "Sam", { a: pick(truth, "a", 5), b: pick(truth, "b", 5) }, 50);
    const sam = store.people.people.find((x) => x.name === "Sam")!.id;
    const movedBack = Object.entries(store.people.assign).find(([, id]) => id === sam)![0];
    store.people.assign[movedBack] = "pA";
    store.people.confirmed[movedBack] = "Alex";
    const undone = undoSplit(store, applied.undo, 60);
    expect(undone.skipped).toBe(1);
    expect(store.people.blocked[movedBack]).toEqual(["Alex"]);
  });

  it("leave the unsure faces exactly as they were, confirmations and all", async () => {
    const { store, truth } = merged(0.25);
    const plan = await planSplit(store, "pA", "Sam", { a: pick(truth, "a", 3), b: pick(truth, "b", 3) });
    expect(plan.counts.unsure).toBeGreaterThan(0);
    await applySplit(store, "pA", "Sam", { a: pick(truth, "a", 3), b: pick(truth, "b", 3) }, 50);
    for (const f of plan.unsure) {
      expect(store.people.assign[f.faceId]).toBe("pA");
      expect(store.people.confirmed[f.faceId]).toBe("Alex");
    }
  });
});

describe("a split from few or uneven examples", () => {
  it("sorts most faces with three of one and sixty of the other, the other already named", async () => {
    const { store, truth } = merged(0.6);
    const p = store.people;
    p.people.push({ id: "pS", name: "Sam", isOther: false });
    // Sixty of Sam's faces already moved and confirmed by hand.
    for (const id of pick(truth, "b", 60)) {
      p.assign[id] = "pS";
      p.confirmed[id] = "Sam";
    }
    const plan = await planSplit(store, "pA", "Sam", { a: pick(truth, "a", 3), b: [] });
    expect(plan.counts.a).toBeGreaterThan(80);
    expect(plan.verdict).not.toBe("few");
  });

  it("asks for more examples when one side has a single one", async () => {
    const { store, truth } = merged(0.6);
    const plan = await planSplit(store, "pA", "Sam", { a: pick(truth, "a", 4), b: pick(truth, "b", 1) });
    expect(plan.verdict).toBe("few");
  });
});

/**
 * Two siblings over the years, two years apart, both grouped as Alex: a face is who it is plus
 * how old they are, and age moves a face further than who does, so each sibling as a baby looks
 * like the other as a baby more than like themselves at eight. `times` dates each photo.
 */
function growingUp(apart = 0.6, perYear = 14, seed = 11, spread = 0.45) {
  const rand = seeded(seed);
  const idA = direction(rand);
  const idB = unit(idA.map((x, i) => x + apart * (direction(rand)[i] ?? 0)));
  // Age: a walk, a new step each year, so near ages look alike and far ones do not.
  const ages: Float32Array[] = [];
  let walk = new Float32Array(idA.length);
  for (let k = 0; k <= 10; k++) {
    walk = walk.map((x, i) => x + (direction(rand)[i] ?? 0));
    ages.push(unit(walk));
  }
  const store = new FaceStore();
  store.load();
  const p = store.people;
  p.people.push({ id: "pA", name: "Alex", isOther: false });
  const truth = new Map<string, "a" | "b">();
  const yearOf = new Map<string, number>();
  const times = new Map<string, number>();
  for (let year = 2016; year <= 2026; year++) {
    for (const [side, id, born] of [["a", idA, 2016], ["b", idB, 2018]] as const) {
      const age = year - born;
      if (age < 0) continue;
      for (let i = 0; i < perYear; i++) {
        const base = unit(id.map((x, j) => x + 1.6 * ages[age][j]));
        const f = face(`vol~${side}${year}-${i}`, 0, faceOf(base, rand, spread));
        store.put(f.uid, [f]);
        p.assign[f.id] = "pA";
        p.confirmed[f.id] = "Alex";
        truth.set(f.id, side);
        yearOf.set(f.id, year);
        times.set(f.uid, Date.UTC(year, 5, 1));
      }
    }
  }
  p.grouped = true;
  return { store, truth, yearOf, times };
}

describe("siblings growing up", () => {
  it("are offered to pick from year by year, the newest first, where the two ends are the two", () => {
    const { store, truth, times } = growingUp();
    const start = splitStart(store, "pA", times);
    expect(start.contrast[0].year).toBe(2026);
    // The newest year's two ends, taken in turn: each end is one sibling.
    const newest = start.contrast.filter((f) => f.year === start.contrast[0].year);
    expect(newest.length).toBeGreaterThanOrEqual(6);
    const even = new Set(newest.filter((_, i) => i % 2 === 0).map((f) => truth.get(f.faceId)));
    const odd = new Set(newest.filter((_, i) => i % 2 === 1).map((f) => truth.get(f.faceId)));
    expect(even.size).toBe(1);
    expect(odd.size).toBe(1);
    expect(even).not.toEqual(odd);
  });

  /**
   * Splits `growingUp(apart)`, from five faces of each in 2026 or from every face the pick
   * screen offers answered rightly: how the faces ended up.
   */
  async function splitFrom(apart: number, examples: "2026" | "offered", dated = true, seed = 11, spread = 0.45) {
    const { store, truth, yearOf, times } = growingUp(apart, 14, seed, spread);
    const picked: { a: string[]; b: string[] } = { a: [], b: [] };
    if (examples === "2026") {
      for (const side of ["a", "b"] as const)
        picked[side] = [...truth].filter(([id, s]) => s === side && yearOf.get(id) === 2026).slice(0, 5).map(([id]) => id);
    } else {
      for (const f of splitStart(store, "pA", times).contrast) picked[truth.get(f.faceId)!].push(f.faceId);
    }
    const plan = await planSplit(store, "pA", "Sam", picked, dated ? times : undefined);
    await applySplit(store, "pA", "Sam", picked, 50, dated ? times : undefined);
    const sam = store.people.people.find((x) => x.name === "Sam")!.id;
    const unsure = new Set(plan.unsure.map((f) => f.faceId));
    let wrong = 0;
    for (const [id, side] of truth) {
      const moved = store.people.assign[id] === sam;
      // An unsure face is left with Alex as it was: not a sort, right or wrong.
      if (!moved && unsure.has(id)) continue;
      if (moved !== (side === "b")) wrong++;
    }
    return { plan, wrong, faces: truth.size };
  }

  it("are sorted year by year from examples of the newest, two years out, and none the wrong way", async () => {
    const { plan, wrong, faces } = await splitFrom(0.6, "2026");
    expect(wrong).toBe(0);
    expect(plan.verdict).toBe("reliable");
    expect(plan.byYear[0].year).toBe(2026);
    expect(plan.byYear.reduce((n, r) => n + r.a + r.b + r.unsure, 0)).toBe(faces);
    // The examples' year and the two before it are sorted; the years further wait for examples.
    for (const row of plan.byYear) {
      if (row.year! >= 2024) expect(row.unsure).toBeLessThanOrEqual(1);
      else expect(row.a + row.b).toBe(0);
    }
    expect(plan.waiting).toEqual([2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016]);
  });

  it("are sorted in every year from the faces offered year by year", async () => {
    const { plan, wrong } = await splitFrom(0.6, "offered");
    expect(wrong).toBe(0);
    expect(plan.verdict).toBe("reliable");
    // Only the years before the younger was born, with no examples of both to be had.
    expect(plan.waiting.every((y) => y < 2018)).toBe(true);
    for (const row of plan.byYear) if (row.year! >= 2018) expect(row.unsure).toBeLessThanOrEqual(1);
  });

  it("are not sorted by age instead of who, as without the dates", async () => {
    const undated = await splitFrom(0.6, "2026", false);
    expect(undated.wrong).toBeGreaterThan(0);
  });

  it("closer alike or less clear, from 2026 alone, none the wrong way either way", async () => {
    for (const seed of [11, 12, 13])
      for (const [apart, spread] of [
        [0.45, 0.45],
        [0.5, 0.6],
        [0.6, 0.6],
      ]) {
        const { plan, wrong } = await splitFrom(apart, "2026", true, seed, spread);
        expect(wrong, `apart ${apart}, spread ${spread}, seed ${seed}`).toBe(0);
        // Of the 84 faces of the three years in reach, at least half (the examples' year all).
        expect(plan.counts.a + plan.counts.b).toBeGreaterThanOrEqual(42);
      }
  });

  it("leave a year that is not two groups, as the year next to it has them, unsorted", () => {
    const rand = seeded(3);
    const one = direction(rand);
    // One child's faces only: the two-means splits them by noise, and their leans do not follow.
    const faces = Array.from({ length: 20 }, (_, i) => face(`vol~x${i}`, 0, faceOf(one, rand, 0.5)));
    const leans = faces.map(() => (rand() - 0.5) * 0.04);
    expect(sortYear(faces, leans)).toBeNull();
    expect(sortYear(faces.slice(0, 4), leans.slice(0, 4))).toBeNull();
    expect(sortYear(faces, leans.map(() => null))).toBeNull();
  });

  it("closer alike, from the faces offered year by year, are sorted, none the wrong way", async () => {
    const close = await splitFrom(0.45, "offered");
    expect(close.wrong).toBe(0);
    expect(close.plan.counts.unsure).toBeLessThan(close.faces * 0.15);
    const closer = await splitFrom(0.35, "offered");
    expect(closer.wrong).toBe(0);
    expect(closer.plan.counts.a + closer.plan.counts.b).toBeGreaterThan(closer.faces * 0.6);
  });
});

describe("twins", () => {
  it("are said to be too alike to split reliably, and mostly left for the user", async () => {
    const { store, truth } = merged(0);
    const plan = await planSplit(store, "pA", "Sam", { a: pick(truth, "a", 5), b: pick(truth, "b", 5) });
    expect(plan.verdict === "unreliable" || plan.verdict === "weak").toBe(true);
  });
});

describe("opening a split", () => {
  it("offers the photos with both, faces from both ends, and what another device said", () => {
    const { store, truth } = merged(0.6);
    const fromPhone = pick(truth, "b", 3);
    for (const id of fromPhone) store.people.conflicts[id] = { there: "Sam", device: "phone", at: 9 };
    const start = splitStart(store, "pA");
    expect(start.faces).toBe(truth.size);
    expect(start.pairs.length).toBe(6);
    expect(start.contrast.length).toBe(16);
    // The two ends are the two siblings: the alternating picks come from both.
    const ends = new Set(start.contrast.slice(0, 4).map((f) => truth.get(f.faceId)));
    expect(ends).toEqual(new Set(["a", "b"]));
    expect(start.elsewhere.map((e) => e.name)).toEqual(["Sam"]);
    expect([...start.elsewhere[0].faceIds].sort()).toEqual([...fromPhone].sort());
  });

  it("is refused for the leftovers, and for the person's own name as the other", async () => {
    const { store, truth } = merged(0.6);
    store.people.people.push({ id: "pX", name: null, isOther: true });
    expect(() => splitStart(store, "pX")).toThrow();
    await expect(planSplit(store, "pA", "alex", { a: pick(truth, "a", 1), b: pick(truth, "b", 1) })).rejects.toThrow();
    await expect(planSplit(store, "pA", "Sam", { a: [], b: pick(truth, "b", 1) })).rejects.toThrow();
  });
});
