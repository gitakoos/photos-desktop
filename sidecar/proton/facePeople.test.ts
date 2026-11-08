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
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { direction, faceOf, seeded } from "./testFaces.ts";
import { dot } from "./faceCluster.ts";
import {
  addFacesToPerson,
  autoMerge,
  curationKey,
  declineCandidates,
  dismissSuggestion,
  facesOnPhoto,
  listLoose,
  nameFaces,
  notThisPerson,
  personCandidates,
  reconsiderLeftovers,
  rejectFaces,
  listPeople,
  listSuggestions,
  mergePeople,
  mergeSplitGroups,
  groupMergeOwed,
  placeNew,
  regroupAll,
  rejectPerson,
  removePhotosFromPerson,
  rekeyPeople,
  renamePerson,
  Stopped,
  takeHeldOver,
} from "./facePeople.ts";
import { FACE_EMBEDDING_DIM } from "./faceCluster.ts";
import { FACE_MODEL_VERSION, FaceStore, decodeShard, encodeShard, rekeyNames, type FaceRecord } from "./faceStore.ts";
import { foldPersonName, legacyFoldPersonName } from "./personName.ts";
import { FACES_DIR, PEOPLE_FILE, initStore, setDataKey, wipeCache, writeSealedAtomic } from "./store.ts";

function face(uid: string, index: number, embedding: Float32Array, score = 0.9): FaceRecord {
  return {
    id: `${uid}#${index}`,
    uid,
    box: [0.1, 0.1, 0.3, 0.4],
    points: [0.15, 0.2, 0.25, 0.2, 0.2, 0.25, 0.16, 0.32, 0.24, 0.32],
    score,
    blur: 100,
    sideways: 0.02,
    embedding,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pfp-faces-"));
  initStore(dir);
  setDataKey(randomBytes(32));
});

/** A library of `count` photos of each of two people. */
function library(store: FaceStore, count = 4) {
  const rand = seeded(11);
  const anna = direction(rand);
  const bela = direction(rand);
  for (let i = 0; i < count; i++) {
    store.put(`a${i}`, [face(`a${i}`, 0, faceOf(anna, rand))]);
    store.put(`b${i}`, [face(`b${i}`, 0, faceOf(bela, rand))]);
  }
  return { anna, bela, rand };
}

describe("the face store", () => {
  it("writes the faces back sealed and reads them again", () => {
    const store = new FaceStore();
    store.load();
    library(store);
    store.put("empty", []);
    store.put("a-photo-uid-that-must-stay-hidden", []);
    store.people.grouped = true;
    store.markPeople();
    store.flush();

    const files = readdirSync(join(dir, FACES_DIR));
    expect(files).toContain("people.enc");
    // Nothing readable on disk: no uid in the clear. A long one, so random bytes cannot spell it.
    for (const name of files) {
      expect(readFileSync(join(dir, FACES_DIR, name)).includes("a-photo-uid-that-must-stay-hidden")).toBe(false);
    }

    const again = new FaceStore();
    again.load();
    expect(again.has("empty")).toBe(true);
    expect(again.facesOf("a0")[0].embedding).toEqual(store.facesOf("a0")[0].embedding);
    expect(again.people.grouped).toBe(true);
  });

  it("drops a shard that will not open instead of failing on it", () => {
    const store = new FaceStore();
    store.load();
    library(store);
    store.flush();
    const shard = readdirSync(join(dir, FACES_DIR)).find((n) => n.startsWith("s"))!;
    writeFileSync(join(dir, FACES_DIR, shard), randomBytes(200));
    const again = new FaceStore();
    expect(() => again.load()).not.toThrow();
    expect(existsSync(join(dir, FACES_DIR, shard))).toBe(false);
  });

  it("round-trips a face with no landmarks among others", () => {
    const rand = seeded(4);
    const bare = { ...face("x", 0, direction(rand)), points: [] };
    const shard = new Map([
      ["x", [bare, face("x", 1, direction(rand))]],
      ["y", [face("y", 0, direction(rand))]],
    ]);
    const back = decodeShard(encodeShard(shard));
    expect(back.get("x")!.map((f) => f.id)).toEqual(["x#0", "x#1"]);
    expect(back.get("y")![0].embedding).toEqual(shard.get("y")![0].embedding);
  });

  it("takes the other devices' copies in again after a shard was lost", () => {
    const store = new FaceStore();
    store.load();
    library(store);
    store.people.applied = { phone: 5 };
    store.markPeople();
    store.flush();
    const shard = readdirSync(join(dir, FACES_DIR)).find((n) => n.startsWith("s"))!;
    // Sealed fine, but not a shard this build can read: the way a malformed record left one.
    writeSealedAtomic(join(dir, FACES_DIR, shard), Buffer.from("PFPF but not a shard"));
    const again = new FaceStore();
    again.load();
    expect(again.people.applied).toEqual({});
  });

  it("round-trips a shard byte for byte", () => {
    const rand = seeded(3);
    const shard = new Map([["x", [face("x", 0, direction(rand)), face("x", 1, direction(rand))]]]);
    const back = decodeShard(encodeShard(shard));
    expect(back.get("x")!.map((f) => f.id)).toEqual(["x#0", "x#1"]);
    expect(back.get("x")![1].embedding).toEqual(shard.get("x")![1].embedding);
  });

  it("keeps a photo with more faces than seven bits can count", () => {
    const rand = seeded(6);
    const many = Array.from({ length: 130 }, (_, i) => face("crowd", i, direction(rand)));
    const shard = new Map([
      ["crowd", many],
      ["next", [face("next", 0, direction(rand))]],
    ]);
    const back = decodeShard(encodeShard(shard));
    expect(back.get("crowd")!.length).toBe(130);
    expect(back.get("crowd")![129].id).toBe("crowd#129");
    expect(back.get("next")![0].embedding).toEqual(shard.get("next")![0].embedding);
  });

  it("keeps the landmarks, and reads a first-generation shard without its landmarks", () => {
    const rand = seeded(7);
    const f = { ...face("x", 3, direction(rand)), points: [410, 300, 450, 300, 430, 320, 415, 340, 445, 340] };
    expect(decodeShard(encodeShard(new Map([["x", [f]]]))).get("x")![0].points).toEqual(f.points);
    // The first generation: a seven-bit count with the swept bit on top, and landmarks as shares.
    const name = Buffer.from("x", "utf8");
    const old = Buffer.alloc(12 + 2 + name.length + 1 + 1 + (17 + FACE_EMBEDDING_DIM) * 4);
    old.writeUInt32LE(0x50465046, 0);
    old.writeUInt32LE(1, 4);
    old.writeUInt32LE(1, 8);
    let o = 12;
    old.writeUInt16LE(name.length, o);
    o += 2;
    name.copy(old, o);
    o += name.length;
    old.writeUInt8(1 | 0x80, o++);
    old.writeUInt8(3, o++);
    for (const v of [...f.box, 0.6, 0.5, 0.7, 0.5, 0.65, 0.55, 0.62, 0.6, 0.68, 0.6, f.score, f.blur, f.sideways]) {
      old.writeFloatLE(v, o);
      o += 4;
    }
    for (let i = 0; i < FACE_EMBEDDING_DIM; i++) {
      old.writeFloatLE(f.embedding[i], o);
      o += 4;
    }
    const back = decodeShard(old).get("x")!;
    expect(back.map((r) => r.id)).toEqual(["x#3"]);
    expect(back[0].points).toEqual([]);
    expect(back[0].box[2]).toBeCloseTo(f.box[2], 6);
  });

  it("keeps the names, marks and removals over a change of the face models, and puts them back where the faces sit", () => {
    const store = new FaceStore();
    store.load();
    const rand = seeded(8);
    const at = (x: number): [number, number, number, number] => [x, 0.1, x + 0.2, 0.4];
    store.put("vol~p", [
      { ...face("vol~p", 0, direction(rand)), box: at(0.1) },
      { ...face("vol~p", 1, direction(rand)), box: at(0.5) },
    ]);
    store.put("vol~q", [{ ...face("vol~q", 0, direction(rand)), box: at(0.1) }]);
    const p = store.people;
    p.people.push({ id: "p1", name: "Ann", isOther: false });
    p.assign["vol~p#0"] = "p1";
    p.blocked["vol~p#1"] = ["Ann"];
    p.rejected = ["vol~q#0"];
    p.covers.Ann = "vol~p";
    p.namedAt.ann = 5;
    p.deviceId = "00000000-0000-4000-8000-000000000009";
    store.markPeople();
    store.flush();
    // The same file under the models before.
    writeSealedAtomic(join(dir, FACES_DIR, PEOPLE_FILE), Buffer.from(JSON.stringify({ ...p, version: FACE_MODEL_VERSION - 1 })));

    const again = new FaceStore();
    again.load();
    expect(again.scanned()).toEqual([]);
    expect(again.people.version).toBe(FACE_MODEL_VERSION);
    expect(again.people.heldOver.map((h) => [h.uid, h.kind, h.name]).sort()).toEqual([
      ["vol~p", "name", "Ann"],
      ["vol~p", "not", "Ann"],
      ["vol~q", "rejected", ""],
    ]);
    expect(again.people.covers).toEqual({ Ann: "vol~p" });
    expect(again.people.namedAt).toEqual({ ann: 5 });
    expect(again.people.deviceId).toBe(p.deviceId);

    // The new models find the faces again, numbered their own way.
    again.put("vol~p", [
      { ...face("vol~p", 0, direction(rand)), box: at(0.52) },
      { ...face("vol~p", 1, direction(rand)), box: at(0.11) },
    ]);
    expect(takeHeldOver(again)).toBe(2);
    const ann = again.people.people.find((x) => x.name === "Ann")!;
    expect(again.people.assign["vol~p#1"]).toBe(ann.id);
    expect(again.people.confirmed["vol~p#1"]).toBe("Ann");
    expect(again.people.blocked["vol~p#0"]).toEqual(["Ann"]);
    // The photo not looked at yet keeps its removal waiting, until it is known it will not be.
    expect(again.people.heldOver.map((h) => h.uid)).toEqual(["vol~q"]);
    takeHeldOver(again, () => false);
    expect(again.people.heldOver).toEqual([]);
  });

  it("keeps the faces of a photo in the trash, and drops nothing for a listing that lost most of the library", () => {
    const store = new FaceStore();
    store.load();
    const rand = seeded(9);
    for (let i = 0; i < 30; i++) store.put(`vol~k${i}`, [face(`vol~k${i}`, 0, direction(rand))]);
    store.people.confirmed["vol~k0#0"] = "Ann";
    const all = new Set(store.scanned());
    all.delete("vol~k0");
    all.delete("vol~k1");
    expect(store.keepOnly(all, new Set(["k0"]))).toBe(1);
    expect(store.has("vol~k0") && !store.has("vol~k1")).toBe(true);
    expect(store.people.confirmed["vol~k0#0"]).toBe("Ann");
    // Most of the library gone at once: not believed.
    expect(store.keepOnly(new Set(["vol~k2", "vol~k3"]))).toBe(0);
    expect(store.scanned().length).toBe(29);
    expect(store.keepOnly(new Set())).toBe(0);
  });

  it("puts a photo's faces together with those of a copy already scanned, keeping what was decided on each", () => {
    const store = new FaceStore();
    store.load();
    const rand = seeded(10);
    const at = (x: number): [number, number, number, number] => [x, 0.1, x + 0.2, 0.4];
    store.put("vol~old", [
      { ...face("vol~old", 0, direction(rand)), box: at(0.1) },
      { ...face("vol~old", 1, direction(rand)), box: at(0.5) },
      { ...face("vol~old", 2, direction(rand)), box: at(0.75) },
    ]);
    store.put("vol~new", [
      { ...face("vol~new", 0, direction(rand)), box: at(0.51) },
      { ...face("vol~new", 2, direction(rand)), box: at(0.12) },
    ]);
    const p = store.people;
    p.people.push({ id: "p1", name: "Ann", isOther: false }, { id: "p2", name: "Bob", isOther: false });
    p.assign["vol~old#0"] = "p1";
    p.confirmed["vol~old#0"] = "Ann";
    p.assign["vol~old#1"] = "p2";
    p.confirmed["vol~old#1"] = "Bob";
    p.blocked["vol~old#2"] = ["Bob"];
    p.assign["vol~new#0"] = "p1";
    p.confirmed["vol~new#0"] = "Ann";
    p.covers.Ann = "vol~old";
    p.curation[curationKey(2, "Bob", "old#2")] = { kind: 2, name: "Bob", ref: "old#2", removed: false, at: 7 };
    const moved = store.movePhoto("vol~old", "vol~new")!;
    expect([...moved.merged].sort()).toEqual(["vol~old#0", "vol~old#1"]);
    expect(moved.ids.get("vol~old#0")).toBe("vol~new#2");
    expect(moved.ids.get("vol~old#1")).toBe("vol~new#0");
    // Its own index is taken there: the lowest free one.
    expect(moved.ids.get("vol~old#2")).toBe("vol~new#1");
    rekeyPeople(p, "vol~old", "vol~new", moved.ids, moved.merged);
    expect(store.has("vol~old")).toBe(false);
    expect(store.facesOf("vol~new").map((f) => f.id).sort()).toEqual(["vol~new#0", "vol~new#1", "vol~new#2"]);
    // A face confirmed on the copy keeps its name; one with nothing decided takes the old face's.
    expect(p.confirmed["vol~new#0"]).toBe("Ann");
    expect(p.confirmed["vol~new#2"]).toBe("Ann");
    expect(p.assign["vol~new#2"]).toBe("p1");
    expect(p.blocked["vol~new#1"]).toEqual(["Bob"]);
    expect(p.curation[curationKey(2, "Bob", "new#1")]).toMatchObject({ at: 7 });
    expect(p.covers.Ann).toBe("vol~new");
    expect(Object.keys(p.assign).some((id) => id.startsWith("vol~old"))).toBe(false);
  });

  it("goes with the account on sign-out", () => {
    const store = new FaceStore();
    store.load();
    library(store);
    store.flush();
    wipeCache();
    const again = new FaceStore();
    again.load();
    expect(again.scanned()).toEqual([]);
  });
});

describe("people", () => {
  it("form from new faces and keep their names through a regroup", async () => {
    const store = new FaceStore();
    store.load();
    library(store);
    await placeNew(store);
    let { unnamed } = listPeople(store);
    expect(unnamed.map((p) => p.uids.length).sort()).toEqual([4, 4]);
    const annaId = unnamed.find((p) => p.uids.includes("a0"))!.id;
    renamePerson(store, annaId, "Anna");
    await regroupAll(store);
    const after = listPeople(store);
    expect(after.named.map((p) => [p.name, p.id, p.uids.length])).toEqual([["Anna", annaId, 4]]);
    ({ unnamed } = after);
    expect(unnamed.length).toBe(1);
  });

  it("put two people together when one is given the other's name", async () => {
    const store = new FaceStore();
    store.load();
    library(store);
    await placeNew(store);
    const [first, second] = listPeople(store).unnamed;
    renamePerson(store, first.id, "Anna");
    const kept = renamePerson(store, second.id, "anna");
    expect(kept).toBe(first.id);
    expect(listPeople(store).named[0].uids.length).toBe(8);
  });

  it("merge, and stay merged after a regroup", async () => {
    const store = new FaceStore();
    store.load();
    library(store);
    await placeNew(store);
    const [first, second] = listPeople(store).unnamed;
    renamePerson(store, first.id, "Anna");
    mergePeople(store, second.id, first.id);
    await regroupAll(store);
    expect(listPeople(store).named[0].uids.length).toBe(8);
  });

  it("go away with every similar face when they are not a person", async () => {
    const store = new FaceStore();
    store.load();
    const { anna, rand } = library(store, 3);
    await placeNew(store);
    const annaGroup = listPeople(store).unnamed.find((p) => p.uids.includes("a0"))!;
    // A face of the same thing that landed elsewhere goes too.
    store.put("a9", [face("a9", 0, faceOf(anna, rand, 0.3))]);
    store.people.assign["a9#0"] = "elsewhere";
    rejectPerson(store, annaGroup.id);
    expect(store.people.rejected).toContain("a9#0");
    await regroupAll(store);
    expect(listPeople(store).unnamed.some((p) => p.uids.includes("a0"))).toBe(false);
  });

  it("lose a photo taken away from them, for good", async () => {
    const store = new FaceStore();
    store.load();
    library(store);
    await placeNew(store);
    const annaGroup = listPeople(store).unnamed.find((p) => p.uids.includes("a0"))!;
    renamePerson(store, annaGroup.id, "Anna");
    removePhotosFromPerson(store, annaGroup.id, ["a1"]);
    await regroupAll(store);
    const anna = listPeople(store).named.find((p) => p.name === "Anna")!;
    expect(anna.uids).not.toContain("a1");
    expect(anna.uids.length).toBe(3);
  });

  it("are not regrouped over a change made while the regroup ran", async () => {
    const store = new FaceStore();
    store.load();
    library(store);
    await placeNew(store);
    const target = listPeople(store).unnamed[0];
    const run = regroupAll(store);
    renamePerson(store, target.id, "Anna");
    await expect(run).rejects.toBeInstanceOf(Stopped);
    expect(listPeople(store).named[0].name).toBe("Anna");
  });

  it("follow the photos still in the library", async () => {
    const store = new FaceStore();
    store.load();
    library(store);
    await placeNew(store);
    store.keepOnly(new Set(["a0", "a1"]));
    const { unnamed } = listPeople(store);
    expect(unnamed.map((p) => p.uids.sort())).toEqual([["a0", "a1"]]);
  });

  /** A unit direction mixed from `from` toward `base` until it sits at least `cosine` from `base`. */
  function steer(base: Float32Array, from: Float32Array, cosine: number): Float32Array {
    for (let t = 0; t <= 1; t += 0.01) {
      const mix = base.map((x, i) => x * t + from[i] * (1 - t));
      let n = 0;
      for (const v of mix) n += v * v;
      const unitMix = mix.map((v) => v / Math.sqrt(n));
      if (dot(unitMix, base) >= cosine) return unitMix;
    }
    return base;
  }

  /** Anna named, and a group of hers too far off to join her on its own, close enough to offer. */
  async function annaAndLookalike() {
    const store = new FaceStore();
    store.load();
    const rand = seeded(21);
    const anna = direction(rand);
    let older = direction(rand);
    // Steer a second direction to sit about 0.5 from hers: past the offer bar, short of joining.
    for (let t = 0; t < 1; t += 0.01) {
      const mix = anna.map((x, i) => x * t + older[i] * (1 - t));
      let n = 0;
      for (const v of mix) n += v * v;
      const unitMix = mix.map((v) => v / Math.sqrt(n));
      if (dot(unitMix, anna) >= 0.5) {
        older = unitMix;
        break;
      }
    }
    for (let i = 0; i < 4; i++) store.put(`a${i}`, [face(`a${i}`, 0, faceOf(anna, rand, 0.3))]);
    for (let i = 0; i < 3; i++) store.put(`o${i}`, [face(`o${i}`, 0, faceOf(older, rand, 0.3))]);
    await placeNew(store);
    const annaId = listPeople(store).unnamed.find((x) => x.uids.includes("a0"))!.id;
    renamePerson(store, annaId, "Anna");
    return { store, annaId };
  }

  it("offer a group that might be a named person", async () => {
    const { store, annaId } = await annaAndLookalike();
    const [suggestion] = listSuggestions(store);
    expect(suggestion.named).toBe(annaId);
    expect(listPeople(store).unnamed.find((x) => x.id === suggestion.unnamed)!.uids).toContain("o0");
  });

  it("stop offering a pair once it is a different person, through a regroup too", async () => {
    const { store, annaId } = await annaAndLookalike();
    const [suggestion] = listSuggestions(store);
    dismissSuggestion(store, suggestion.unnamed, annaId);
    expect(listSuggestions(store)).toEqual([]);
    await regroupAll(store);
    expect(listSuggestions(store)).toEqual([]);
    expect(listPeople(store).named[0].uids).not.toContain("o0");
  });

  it("leave a group short of the joining bar to be merged by hand", async () => {
    const { store } = await annaAndLookalike();
    expect(listSuggestions(store)[0].similarity).toBeLessThan(0.58);
    expect(autoMerge(store)).toBe(0);
    expect(listPeople(store).named[0].uids.length).toBe(4);
    expect(listSuggestions(store)).toHaveLength(1);
  });

  it("merge a group past the joining bar by themselves, without confirming its faces", () => {
    const store = new FaceStore();
    store.load();
    const rand = seeded(22);
    const anna = direction(rand);
    const near = steer(anna, direction(rand), 0.7);
    for (let i = 0; i < 3; i++) store.put(`a${i}`, [face(`a${i}`, 0, faceOf(anna, rand, 0.1))]);
    for (let i = 0; i < 3; i++) store.put(`n${i}`, [face(`n${i}`, 0, faceOf(near, rand, 0.1))]);
    const p = store.people;
    p.people.push({ id: "p1", name: "Anna", isOther: false }, { id: "p2", name: null, isOther: false });
    for (let i = 0; i < 3; i++) {
      p.assign[`a${i}#0`] = "p1";
      p.confirmed[`a${i}#0`] = "Anna";
      p.assign[`n${i}#0`] = "p2";
    }
    expect(listSuggestions(store)[0].similarity).toBeGreaterThan(0.58);
    expect(autoMerge(store)).toBe(1);
    expect(listPeople(store).named[0].uids.length).toBe(6);
    expect(p.confirmed["n0#0"]).toBeUndefined();
    expect(p.confirmed["a0#0"]).toBe("Anna");
  });

  it("never merge two named people by themselves", async () => {
    const { store } = await annaAndLookalike();
    const other = listPeople(store).unnamed[0];
    renamePerson(store, other.id, "Bela");
    expect(autoMerge(store)).toBe(0);
    expect(listPeople(store).named.length).toBe(2);
  });

  it("offer photos that might be a named person, take the ones added, and drop the ones declined", async () => {
    const { store, annaId } = await annaAndLookalike();
    const offered = personCandidates(store, annaId);
    expect(offered.map((c) => c.uid).sort()).toEqual(["o0", "o1", "o2"]);
    addFacesToPerson(store, annaId, [offered[0].faceId]);
    declineCandidates(store, annaId, [offered[1].faceId]);
    const left = personCandidates(store, annaId).map((c) => c.uid);
    expect(left).toEqual([offered[2].uid]);
    await regroupAll(store);
    const anna = listPeople(store).named[0];
    expect(anna.uids).toContain(offered[0].uid);
    expect(anna.uids).not.toContain(offered[1].uid);
  });

  it("take a leftover face in once the named person it matches is known", async () => {
    const store = new FaceStore();
    store.load();
    const rand = seeded(31);
    const anna = direction(rand);
    // A weak face of hers arrives first, with nobody to join, and is left over.
    store.put("w0", [face("w0", 0, faceOf(anna, rand, 0.3), 0.5)]);
    await placeNew(store);
    expect(listPeople(store).leftover).toBe(1);
    for (let i = 0; i < 4; i++) store.put(`a${i}`, [face(`a${i}`, 0, faceOf(anna, rand, 0.3))]);
    await placeNew(store);
    const annaId = listPeople(store).unnamed[0].id;
    renamePerson(store, annaId, "Anna");
    expect(reconsiderLeftovers(store)).toBe(1);
    expect(listPeople(store).named[0].uids).toContain("w0");
  });

  it("never take a leftover face into a person it was marked as not being", async () => {
    const store = new FaceStore();
    store.load();
    const rand = seeded(32);
    const anna = direction(rand);
    store.put("w0", [face("w0", 0, faceOf(anna, rand, 0.3), 0.5)]);
    await placeNew(store);
    for (let i = 0; i < 4; i++) store.put(`a${i}`, [face(`a${i}`, 0, faceOf(anna, rand, 0.3))]);
    await placeNew(store);
    const annaId = listPeople(store).unnamed[0].id;
    renamePerson(store, annaId, "Anna");
    declineCandidates(store, annaId, ["w0#0"]);
    expect(reconsiderLeftovers(store)).toBe(0);
  });

  it("list the loose faces, and name them into a new person or an existing one", async () => {
    const store = new FaceStore();
    store.load();
    const rand = seeded(41);
    // Three strangers, each in one photo: no group worth naming, so all three are loose.
    for (let i = 0; i < 3; i++) store.put(`s${i}`, [face(`s${i}`, 0, direction(rand))]);
    await placeNew(store);
    expect(listLoose(store).total).toBe(3);
    const id = nameFaces(store, ["s0#0"], "Cili");
    expect(listPeople(store).named.map((x) => [x.id, x.name])).toEqual([[id, "Cili"]]);
    expect(nameFaces(store, ["s1#0"], "cili")).toBe(id);
    expect(listLoose(store).faces.map((f) => f.faceId)).toEqual(["s2#0"]);
    rejectFaces(store, ["s2#0"]);
    expect(listLoose(store).total).toBe(0);
    await regroupAll(store);
    expect(listPeople(store).named[0].uids.sort()).toEqual(["s0", "s1"]);
  });

  it("confirm a group's faces when it is given a name", async () => {
    const store = new FaceStore();
    store.load();
    library(store);
    await placeNew(store);
    const group = listPeople(store).unnamed.find((x) => x.uids.includes("a0"))!;
    renamePerson(store, group.id, "Anna");
    for (let i = 0; i < 4; i++) expect(store.people.confirmed[`a${i}#0`]).toBe("Anna");
    expect(store.people.confirmed["b0#0"]).toBeUndefined();
  });

  it("let one face go from a named person, from the viewer", async () => {
    const store = new FaceStore();
    store.load();
    library(store);
    await placeNew(store);
    const group = listPeople(store).unnamed.find((x) => x.uids.includes("a0"))!;
    renamePerson(store, group.id, "Anna", 1);
    store.people.manual.Anna = ["a1", "elsewhere"];
    expect(notThisPerson(store, "a1#0", 9)).toBe(true);
    const p = store.people;
    expect(p.assign["a1#0"]).not.toBe(group.id);
    expect(p.confirmed["a1#0"]).toBeUndefined();
    expect(p.blocked["a1#0"]).toEqual(["Anna"]);
    expect(p.curation[curationKey(2, "Anna", "a1#0")]).toMatchObject({ removed: false, at: 9 });
    expect(p.manual.Anna).toEqual(["elsewhere"]);
    expect(p.curation[curationKey(1, "Anna", "a1")]).toMatchObject({ removed: true, at: 9 });
    expect(listPeople(store).named[0].uids).not.toContain("a1");
    await regroupAll(store);
    expect(listPeople(store).named[0].uids).not.toContain("a1");
    // A face in nobody's group is nobody's to let go of.
    expect(notThisPerson(store, "a1#0")).toBe(false);
  });

  it("tell who is on a photo, left to right", async () => {
    const store = new FaceStore();
    store.load();
    const rand = seeded(42);
    const right = { ...face("g", 1, direction(rand)), box: [0.6, 0.1, 0.8, 0.4] as [number, number, number, number] };
    const left = { ...face("g", 0, direction(rand)), box: [0.1, 0.1, 0.3, 0.4] as [number, number, number, number] };
    store.put("g", [right, left]);
    await placeNew(store);
    nameFaces(store, ["g#1"], "Dora");
    const faces = facesOnPhoto(store, "g");
    expect(faces.map((f) => [f.faceId, f.name])).toEqual([
      ["g#0", null],
      ["g#1", "Dora"],
    ]);
  });
});

describe("folding split groups", () => {
  function splitStore(names: [string | null, string | null], blockSecond = false) {
    const store = new FaceStore();
    store.load();
    const rand = seeded(31);
    const anna = direction(rand);
    const stranger = direction(rand);
    for (let i = 0; i < 3; i++) store.put(`a${i}`, [face(`a${i}`, 0, faceOf(anna, rand, 0.1))]);
    for (let i = 0; i < 2; i++) store.put(`b${i}`, [face(`b${i}`, 0, faceOf(anna, rand, 0.1))]);
    for (let i = 0; i < 2; i++) store.put(`s${i}`, [face(`s${i}`, 0, faceOf(stranger, rand, 0.1))]);
    const p = store.people;
    p.people.push(
      { id: "p1", name: names[0], isOther: false },
      { id: "p2", name: names[1], isOther: false },
      { id: "p3", name: null, isOther: false },
    );
    for (let i = 0; i < 3; i++) p.assign[`a${i}#0`] = "p1";
    for (let i = 0; i < 2; i++) p.assign[`b${i}#0`] = "p2";
    for (let i = 0; i < 2; i++) p.assign[`s${i}#0`] = "p3";
    if (blockSecond && names[0]) p.blocked["b0#0"] = [names[0]];
    return store;
  }

  it("fold two groups of one person and leave a stranger apart", async () => {
    const store = splitStore([null, null]);
    expect(await mergeSplitGroups(store)).toBe(1);
    const p = store.people;
    expect(p.assign["b0#0"]).toBe("p1");
    expect(p.assign["s0#0"]).toBe("p3");
    expect(p.people.map((x) => x.id).sort()).toEqual(["p1", "p3"]);
  });

  it("keep the named group and confirm nothing it takes in", async () => {
    const store = splitStore([null, "Anna"]);
    expect(await mergeSplitGroups(store)).toBe(1);
    const p = store.people;
    expect(p.assign["a0#0"]).toBe("p2");
    expect(p.confirmed["a0#0"]).toBeUndefined();
  });

  it("never fold two names, nor a group marked as not being the name", async () => {
    expect(await mergeSplitGroups(splitStore(["Anna", "Bela"]))).toBe(0);
    expect(await mergeSplitGroups(splitStore(["Anna", null], true))).toBe(0);
  });

  it("change nothing when the user edits meanwhile", async () => {
    const store = splitStore([null, null]);
    let asked = 0;
    await expect(
      mergeSplitGroups(store, () => {
        if (asked++ === 1) store.edits++;
        return true;
      }),
    ).rejects.toBeInstanceOf(Stopped);
    expect(store.people.assign["b0#0"]).toBe("p2");
  });

  it("owe the fold only past the regroup's own merge limit", () => {
    const store = new FaceStore();
    store.load();
    for (let i = 0; i < 401; i++) store.people.people.push({ id: `p${i}`, name: null, isOther: false });
    expect(groupMergeOwed(store)).toBe(true);
    store.people.people.splice(0, 2);
    expect(groupMergeOwed(store)).toBe(false);
  });
});

describe("telling names apart", () => {
  it("set case and spaces aside and keep accents, as the phone does", () => {
    expect(foldPersonName(" Adam ")).toBe(foldPersonName("adam"));
    expect(foldPersonName("ÁDÁM")).toBe(foldPersonName("ádám"));
    expect(foldPersonName("Ádám")).not.toBe(foldPersonName("Adam"));
    expect(foldPersonName("Ádám")).toBe(foldPersonName("Ádám"));
  });

  it("put the keys an older build stored onto the new fold", () => {
    const store = new FaceStore();
    store.load();
    const p = store.people;
    p.people.push({ id: "p1", name: "Ádám", isOther: false }, { id: "p2", name: "Adam", isOther: false });
    p.namedAt[legacyFoldPersonName("Ádám")] = 500;
    p.curation[`2\u0000${legacyFoldPersonName("Ádám")}\u0000l1#0`] = { kind: 2, name: "Ádám", ref: "l1#0", removed: false, at: 7 };
    p.curation[`2\u0000${legacyFoldPersonName("Adam")}\u0000l2#0`] = { kind: 2, name: "Adam", ref: "l2#0", removed: true, at: 9 };
    rekeyNames(p);
    expect(p.namedAt[foldPersonName("Ádám")]).toBe(500);
    expect(p.namedAt[foldPersonName("Adam")]).toBe(500);
    expect(Object.keys(p.curation).sort()).toEqual(
      [`2\u0000${foldPersonName("Adam")}\u0000l2#0`, `2\u0000${foldPersonName("Ádám")}\u0000l1#0`].sort(),
    );
  });
});
