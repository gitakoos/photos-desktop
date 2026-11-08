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

import "@protontech/crypto/polyfill";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CryptoProxy, initCrypto } from "./crypto.ts";
import { openEnvelope, readFaceCopy, sealEnvelope, writeFaceCopy, type FaceCopy, type SnapshotFace } from "./driveData.ts";
import {
  addFacesToPerson,
  curationKey,
  declineCandidates,
  listPeople,
  mergePeople,
  placeNew,
  regroupAll,
  rejectPerson,
  removePhotosFromPerson,
  renamePerson,
  setPersonCover,
} from "./facePeople.ts";
import { FACE_EMBEDDING_DIM } from "./faceCluster.ts";
import { FACE_MODEL_VERSION, FaceStore, type FaceRecord } from "./faceStore.ts";
import {
  FACE_CLUSTER_PARAMS_VERSION,
  FACE_MODEL_SHA256,
  adoptScanned,
  applyCopy,
  compareWithPhone,
  copyForDrive,
  pairFaces,
} from "./faceSync.ts";
import { initStore, setDataKey } from "./store.ts";
import { direction, faceOf, seeded } from "./testFaces.ts";

type Box = [number, number, number, number];

function local(uid: string, index: number, box: Box, embedding: Float32Array): FaceRecord {
  return { id: `${uid}#${index}`, uid, box, points: [], score: 0.9, blur: 100, sideways: 0, embedding };
}

function phone(key: string, index: number, box: Box, embedding: Float32Array, rejected = false): SnapshotFace {
  return { key, index, box, points: [], score: 0.9, blur: 50, embedding, rejected, person: null, confirmed: null };
}

const copy = (faces: SnapshotFace[]): FaceCopy => ({
  deviceId: "00000000-0000-0000-0000-000000000001",
  deviceLabel: "phone",
  createdAt: 0,
  faceModelVersion: FACE_MODEL_VERSION,
  faceModelSha256: FACE_MODEL_SHA256,
  clusterParamsVersion: FACE_CLUSTER_PARAMS_VERSION,
  embeddingDim: FACE_EMBEDDING_DIM,
  facesWipedAt: 0,
  faces,
  notPerson: [],
  covers: new Map(),
  coverSetAt: new Map(),
  manual: [],
  removals: [],
  namedAt: new Map(),
  nameChanges: [],
  scanned: [...new Set(faces.map((f) => f.key))],
});

beforeEach(() => {
  initStore(mkdtempSync(join(tmpdir(), "pfp-sync-")));
  setDataKey(randomBytes(32));
});

describe("setting the phone's faces beside these", () => {
  it("pairs the same face on the same photo by where it sits", () => {
    const rand = seeded(51);
    const a = direction(rand);
    const b = direction(rand);
    const store = new FaceStore();
    store.load();
    store.put("vol~p1", [local("vol~p1", 0, [0.1, 0.1, 0.3, 0.4], a), local("vol~p1", 1, [0.6, 0.1, 0.8, 0.4], b)]);
    const pairs = pairFaces(store, [
      copy([
        phone("p1", 0, [0.62, 0.12, 0.81, 0.41], faceOf(b, rand, 0.1)),
        phone("p1", 1, [0.11, 0.1, 0.31, 0.4], faceOf(a, rand, 0.1)),
        // A photo not looked at here, and a face on nothing found here: neither pairs.
        phone("p2", 0, [0.1, 0.1, 0.3, 0.4], a),
        phone("p1", 2, [0.4, 0.6, 0.5, 0.7], a),
      ]),
    ]);
    expect(pairs.map((p) => [p.phone.index, p.local.id]).sort()).toEqual([
      [0, "vol~p1#1"],
      [1, "vol~p1#0"],
    ]);
  });

  it("measures how alike the paired faces came out", () => {
    const rand = seeded(52);
    const a = direction(rand);
    const store = new FaceStore();
    store.load();
    store.put("vol~p1", [local("vol~p1", 0, [0.1, 0.1, 0.3, 0.4], a)]);
    const report = compareWithPhone(store, [
      copy([phone("p1", 0, [0.1, 0.1, 0.3, 0.4], a), phone("p1", 1, [0.5, 0.5, 0.6, 0.6], a, true)]),
    ]);
    expect(report.phoneFaces).toBe(1);
    expect(report.pairs).toBe(1);
    expect(report.median).toBeCloseTo(1, 5);
    expect(report.close).toBe(1);
  });
});

describe("sharing the scan with the other device", () => {
  it("takes the photos the other device finished as done here, with their faces and names", () => {
    const rand = seeded(71);
    const a = direction(rand);
    const store = new FaceStore();
    store.load();
    const named = { ...phone("p1", 0, [0.1, 0.1, 0.3, 0.4], a), confirmed: "Anna" };
    const theirs = {
      ...copy([named, phone("p1", 1, [0.5, 0.5, 0.6, 0.6], a, true)]),
      // p2 had no face, p9 is not in this library.
      scanned: ["p1", "p2", "p9"],
    };
    const library = new Map([
      ["p1", "vol~p1"],
      ["p2", "vol~p2"],
    ]);
    expect(adoptScanned(store, theirs, library)).toBe(2);
    expect(store.has("vol~p1") && store.has("vol~p2") && !store.has("vol~p9")).toBe(true);
    expect(store.facesOf("vol~p1").map((f) => f.id)).toEqual(["vol~p1#0"]);
    expect(store.facesOf("vol~p2")).toEqual([]);
    const person = store.people.people.find((x) => x.name === "Anna");
    expect(person && store.people.assign["vol~p1#0"]).toBe(person!.id);
  });

  it("leaves a photo scanned here as it is", () => {
    const rand = seeded(72);
    const a = direction(rand);
    const store = new FaceStore();
    store.load();
    store.put("vol~p1", [local("vol~p1", 0, [0.1, 0.1, 0.3, 0.4], a)]);
    const theirs = copy([phone("p1", 3, [0.6, 0.6, 0.7, 0.7], a)]);
    expect(adoptScanned(store, theirs, new Map([["p1", "vol~p1"]]))).toBe(0);
    expect(store.facesOf("vol~p1").map((f) => f.id)).toEqual(["vol~p1#0"]);
  });
});

describe("this computer's copy on Drive", () => {
  let key: any;
  beforeAll(async () => {
    initCrypto();
    key = await CryptoProxy.generateKey({ userIDs: [{ name: "Owner", email: "owner@example.com" }] } as any);
  }, 30_000);

  it("is written in the phone's format and reads back whole", async () => {
    const rand = seeded(61);
    const a = direction(rand);
    const store = new FaceStore();
    store.load();
    store.put("vol~p1", [local("vol~p1", 0, [0.1, 0.1, 0.3, 0.4], a), local("vol~p1", 1, [0.5, 0.1, 0.7, 0.4], direction(rand))]);
    store.put("vol~p2", [local("vol~p2", 0, [0.2, 0.2, 0.4, 0.5], faceOf(a, rand, 0.2))]);
    store.put("vol~empty", []);
    await placeNew(store);
    const anna = listPeople(store).unnamed.find((x) => x.uids.includes("vol~p1"))!;
    renamePerson(store, anna.id, "Anna");
    store.people.blocked["vol~p1#1"] = ["Anna"];
    store.people.covers.Anna = "vol~p2";
    const written = copyForDrive(store, "Desk", 1234);
    const plain = writeFaceCopy(written);
    const sealed = await sealEnvelope(plain, key, key, 64);
    const opened = await openEnvelope(sealed, [key], [key]);
    expect(opened.ok).toBe(true);
    const { snapshot, copy: back } = readFaceCopy((opened as { ok: true; plain: Buffer }).plain);
    expect(back.deviceId).toBe(written.deviceId);
    expect(back.deviceLabel).toBe("Desk");
    expect(back.faces.length).toBe(3);
    expect(back.faces.find((f) => f.key === "p1" && f.index === 0)!.person).toBe("Anna");
    expect(back.faces[0].embedding).toEqual(store.facesOf(`vol~${back.faces[0].key}`)[back.faces[0].index].embedding);
    expect(back.notPerson).toEqual([{ name: "Anna", key: "p1", index: 1, at: 0 }]);
    // Every photo scanned here goes as a scan marker, which the other device takes as done.
    expect([...back.scanned].sort()).toEqual(store.scanned().map((u) => u.slice(u.indexOf("~") + 1)).sort());
    expect(back.covers.get("Anna")).toBe("p2");
    expect([...snapshot.people[0].keys].sort()).toEqual(["p1", "p2"]);
  });
});

describe("taking in another device's copy", () => {
  /** A photo here with one face, and the phone's copy of the same face under `name`. */
  function oneFace(name: string | null, confirmed = false) {
    const rand = seeded(71);
    const a = direction(rand);
    const store = new FaceStore();
    store.load();
    store.put("vol~p1", [local("vol~p1", 0, [0.1, 0.1, 0.3, 0.4], a)]);
    const face = phone("p1", 0, [0.1, 0.1, 0.3, 0.4], faceOf(a, rand, 0.1));
    if (name) {
      if (confirmed) face.confirmed = name;
      else face.person = name;
    }
    return { store, face, a, rand };
  }

  it("names a face that has no name here", async () => {
    const { store, face } = oneFace("Anna");
    await placeNew(store);
    expect(applyCopy(store, { ...copy([face]), createdAt: 5 })!.named).toBe(1);
    expect(listPeople(store).named.map((x) => x.name)).toEqual(["Anna"]);
    await regroupAll(store);
    expect(listPeople(store).named[0].uids).toEqual(["vol~p1"]);
  });

  it("keeps the name given here when the phone says otherwise", async () => {
    const { store, face } = oneFace("Bela", true);
    await placeNew(store);
    const here = listPeople(store);
    const id = here.named[0]?.id ?? store.people.assign["vol~p1#0"];
    renamePerson(store, id, "Anna");
    const result = applyCopy(store, { ...copy([face]), createdAt: 5 })!;
    expect(result.conflicts).toBe(1);
    expect(listPeople(store).named.map((x) => x.name)).toEqual(["Anna"]);
  });

  it("adds a face the phone found and this computer missed", async () => {
    const { store, rand } = oneFace(null);
    const other = phone("p1", 1, [0.6, 0.2, 0.8, 0.5], direction(rand));
    other.person = "Cili";
    const result = applyCopy(store, { ...copy([other]), createdAt: 5 })!;
    expect(result.added).toBe(1);
    // Saved, it goes back without landmarks, as it came, and not as points at the corner.
    store.flush();
    const reloaded = new FaceStore();
    reloaded.load();
    const added = copyForDrive(reloaded, "Desk", 6).faces.find((f) => f.index === 1)!;
    expect(added.points).toEqual([]);
    expect(store.facesOf("vol~p1").map((f) => f.id)).toEqual(["vol~p1#0", "vol~p1#1"]);
    expect(listPeople(store).named.map((x) => x.name)).toEqual(["Cili"]);
  });

  it("takes each copy once, and its own never", async () => {
    const { store, face } = oneFace("Anna");
    await placeNew(store);
    const own = { ...copy([face]), deviceId: store.people.deviceId ?? "x", createdAt: 9 };
    store.people.deviceId = own.deviceId;
    expect(applyCopy(store, own)).toBeNull();
    expect(applyCopy(store, { ...copy([face]), createdAt: 5 })).not.toBeNull();
    expect(applyCopy(store, { ...copy([face]), createdAt: 5 })).toBeNull();
  });
});

describe("a rename or merge made on another device", () => {
  /** Two photos here, each with one face of its own person, both named: `first` on p1, `second` on p2. */
  async function twoPeople(first: string, second: string | null, at: number) {
    const rand = seeded(81);
    const a = direction(rand);
    const b = direction(rand);
    const store = new FaceStore();
    store.load();
    store.put("vol~p1", [local("vol~p1", 0, [0.1, 0.1, 0.3, 0.4], a)]);
    store.put("vol~p2", [local("vol~p2", 0, [0.1, 0.1, 0.3, 0.4], b)]);
    await placeNew(store);
    const id1 = store.people.assign["vol~p1#0"];
    const id2 = store.people.assign["vol~p2#0"];
    expect(id1).not.toBe(id2);
    renamePerson(store, id1, first, at);
    if (second) renamePerson(store, id2, second, at);
    return { store, id1, id2, a, b, rand };
  }

  const nameOf = (store: FaceStore, uid: string) =>
    store.people.people.find((x) => x.id === store.people.assign[`${uid}#0`])?.name ?? null;

  it("renames the person here when it came after the name held here, and the copy's faces join them", async () => {
    const { store, id1, a, rand } = await twoPeople("Old", null, 10);
    store.people.covers.Old = "vol~p1";
    const added = phone("p1", 1, [0.6, 0.2, 0.8, 0.5], faceOf(a, rand, 0.05));
    added.person = "New";
    const theirs = { ...copy([added]), createdAt: 30, namedAt: new Map([["New", 20]]), nameChanges: [{ from: "Old", to: "New", at: 20 }] };
    expect(applyCopy(store, theirs)!.renamed).toBe(1);
    const person = store.people.people.find((x) => x.id === id1)!;
    expect(person.name).toBe("New");
    expect(store.people.assign["vol~p1#1"]).toBe(id1);
    expect(store.people.covers).toEqual({ New: "vol~p1" });
    expect(store.people.nameChanges).toEqual([{ from: "Old", to: "New", at: 20 }]);
    expect(store.people.namedAt).toEqual({ new: 20 });
    expect(listPeople(store).named.map((x) => x.name)).toEqual(["New"]);
  });

  it("passes over a rename of a name given here afterwards, and keeps the change to hand on", async () => {
    const { store } = await twoPeople("Old", null, 30);
    const theirs = { ...copy([]), createdAt: 40, nameChanges: [{ from: "Old", to: "New", at: 20 }] };
    expect(applyCopy(store, theirs)!.renamed).toBe(0);
    expect(nameOf(store, "vol~p1")).toBe("Old");
    expect(store.people.nameChanges).toEqual([{ from: "Old", to: "New", at: 20 }]);
    expect(store.people.namedAt).toEqual({ old: 30, new: 20 });
  });

  it("folds the person into the one already holding the name", async () => {
    const { store, id2 } = await twoPeople("Al", "Ann", 1);
    store.people.blocked["vol~p9#0"] = ["Al"];
    const theirs = { ...copy([]), createdAt: 9, nameChanges: [{ from: "Al", to: "Ann", at: 5 }] };
    expect(applyCopy(store, theirs)!.renamed).toBe(1);
    expect(listPeople(store).named.map((x) => [x.name, x.uids.sort()])).toEqual([["Ann", ["vol~p1", "vol~p2"]]]);
    expect(store.people.assign["vol~p1#0"]).toBe(id2);
    expect(store.people.blocked["vol~p9#0"]).toEqual(["Ann"]);
    // Taken in again, nothing more happens.
    expect(applyCopy(store, { ...theirs, createdAt: 10 })!.renamed).toBe(0);
    expect(store.people.nameChanges).toHaveLength(1);
  });

  it("finds the person under the name a rename here gave it, when both renamed it from the same name and theirs came later", async () => {
    const { store, id1 } = await twoPeople("Old", null, 1);
    renamePerson(store, id1, "Mine", 10);
    const theirs = { ...copy([]), createdAt: 30, nameChanges: [{ from: "Old", to: "Theirs", at: 20 }] };
    expect(applyCopy(store, theirs)!.renamed).toBe(1);
    expect(nameOf(store, "vol~p1")).toBe("Theirs");
    expect(store.people.namedAt.theirs).toBe(20);
  });

  it("keeps the rename made here when it came after the other device's of the same name", async () => {
    const { store, id1 } = await twoPeople("Old", null, 1);
    renamePerson(store, id1, "Mine", 30);
    const theirs = { ...copy([]), createdAt: 40, nameChanges: [{ from: "Old", to: "Theirs", at: 20 }] };
    expect(applyCopy(store, theirs)!.renamed).toBe(0);
    expect(nameOf(store, "vol~p1")).toBe("Mine");
  });

  it("is written into this computer's copy when made here", async () => {
    const { store, id1, id2 } = await twoPeople("Old", "Bea", 1);
    setPersonCover(store, id1, "vol~p1", 2);
    renamePerson(store, id1, "New", 5);
    mergePeople(store, id2, id1, 7);
    const { copy: back } = readFaceCopy(writeFaceCopy(copyForDrive(store, "Desk", 8)));
    expect(back.nameChanges).toEqual([
      { from: "Old", to: "New", at: 5 },
      { from: "Bea", to: "New", at: 7 },
    ]);
    expect(back.namedAt.get("New")).toBe(7);
    // The cover's time went with the name.
    expect(back.coverSetAt.get("New")).toBe(2);
    expect(store.people.namedAt).toEqual({ new: 7 });
  });
});

describe("the rest of the curation made on another device", () => {
  async function people(first: string, second: string | null, at: number) {
    const rand = seeded(91);
    const a = direction(rand);
    const b = direction(rand);
    const store = new FaceStore();
    store.load();
    store.put("vol~p1", [local("vol~p1", 0, [0.1, 0.1, 0.3, 0.4], a)]);
    store.put("vol~p2", [local("vol~p2", 0, [0.1, 0.1, 0.3, 0.4], b)]);
    await placeNew(store);
    const id1 = store.people.assign["vol~p1#0"];
    const id2 = store.people.assign["vol~p2#0"];
    renamePerson(store, id1, first, at);
    if (second) renamePerson(store, id2, second, at);
    return { store, id1, id2 };
  }

  it("takes a name off here when it was taken off there after it was given here", async () => {
    const { store, id1 } = await people("Ann", null, 5);
    const theirs = { ...copy([]), createdAt: 20, nameChanges: [{ from: "Ann", to: "", at: 9 }] };
    expect(applyCopy(store, theirs)!.renamed).toBe(1);
    expect(store.people.people.find((x) => x.id === id1)!.name).toBeNull();
    expect(store.people.confirmed["vol~p1#0"]).toBeUndefined();
    expect(store.people.namedAt).toEqual({});
    expect(store.people.nameChanges).toEqual([{ from: "Ann", to: "", at: 9 }]);
    // A name given here after that stays.
    const later = await people("Bea", null, 30);
    applyCopy(later.store, { ...theirs, nameChanges: [{ from: "Bea", to: "", at: 9 }] });
    expect(later.store.people.people.find((x) => x.id === later.id1)!.name).toBe("Bea");
  });

  it("takes the later cover, here or there", async () => {
    const { store, id1 } = await people("Ann", null, 1);
    store.put("vol~p3", [local("vol~p3", 0, [0.5, 0.5, 0.6, 0.6], direction(seeded(92)))]);
    setPersonCover(store, id1, "vol~p1", 10);
    const theirs = (setAt: number, createdAt: number) => ({
      ...copy([]),
      createdAt,
      covers: new Map([["Ann", "p3"]]),
      coverSetAt: new Map([["Ann", setAt]]),
    });
    applyCopy(store, theirs(5, 20));
    expect(store.people.covers.Ann).toBe("vol~p1");
    applyCopy(store, theirs(15, 21));
    expect(store.people.covers.Ann).toBe("vol~p3");
    const { copy: back } = readFaceCopy(writeFaceCopy(copyForDrive(store, "Desk", 22)));
    expect(back.coverSetAt.get("Ann")).toBe(15);
  });

  it("takes away a mark taken back there, and a cover dropped there, and hands both on", async () => {
    const { store, id1 } = await people("Ann", null, 1);
    declineCandidates(store, id1, ["vol~p2#0"], 5);
    setPersonCover(store, id1, "vol~p1", 5);
    const theirs = {
      ...copy([]),
      createdAt: 20,
      removals: [
        { kind: 2 as const, name: "Ann", key: "p2", index: 0, at: 9 },
        { kind: 3 as const, name: "Ann", key: "", index: 0, at: 9 },
        { kind: 1 as const, name: "Ann", key: "p7", index: 0, at: 9 },
      ],
    };
    applyCopy(store, theirs);
    expect(store.people.blocked["vol~p2#0"]).toBeUndefined();
    expect(store.people.covers.Ann).toBeUndefined();
    const { copy: back } = readFaceCopy(writeFaceCopy(copyForDrive(store, "Desk", 21)));
    expect(back.removals.map((r) => [r.kind, r.key, r.index, r.at]).sort()).toEqual([
      [1, "p7", 0, 9],
      [2, "p2", 0, 9],
      [3, "", 0, 9],
    ]);
  });

  it("does not bring back what the other device set before a removal made here", async () => {
    const { store, id1, id2 } = await people("Ann", "Bea", 1);
    declineCandidates(store, id1, ["vol~p2#0"], 5);
    declineCandidates(store, id2, ["vol~p1#0"], 6);
    // "Not a person" on a named person takes its marks away, by hand.
    const before = Date.now();
    rejectPerson(store, id2);
    expect(store.people.blocked["vol~p1#0"]).toBeUndefined();
    // Moving a face to Ann takes back the mark that it is not her.
    addFacesToPerson(store, id1, ["vol~p2#0"], 10);
    expect(store.people.blocked["vol~p2#0"]).toBeUndefined();
    expect(store.people.curation[curationKey(2, "Ann", "p2#0")]).toEqual({ kind: 2, name: "Ann", ref: "p2#0", removed: true, at: 10 });
    const face = phone("p1", 0, [0.1, 0.1, 0.3, 0.4], store.facesOf("vol~p1")[0].embedding);
    const theirs = { ...copy([face]), createdAt: 20, notPerson: [{ name: "Bea", key: "p1", index: 0, at: 6 }] };
    applyCopy(store, theirs);
    expect(store.people.blocked["vol~p1#0"]).toBeUndefined();
    // A mark set there after the removal here is taken.
    applyCopy(store, { ...theirs, createdAt: 21, notPerson: [{ name: "Bea", key: "p1", index: 0, at: before + 60_000 }] });
    expect(store.people.blocked["vol~p1#0"]).toEqual(["Bea"]);
  });
});

describe("a photo taken off a person on another device", () => {
  async function confirmedAnn() {
    const rand = seeded(95);
    const a = direction(rand);
    const store = new FaceStore();
    store.load();
    store.put("vol~p1", [local("vol~p1", 0, [0.1, 0.1, 0.3, 0.4], a)]);
    await placeNew(store);
    const id = store.people.assign["vol~p1#0"];
    renamePerson(store, id, "Ann", 1);
    // A merge or a face moved by hand confirms it under the name.
    addFacesToPerson(store, id, ["vol~p1#0"], 2);
    expect(store.people.confirmed["vol~p1#0"]).toBe("Ann");
    const face = phone("p1", 0, [0.1, 0.1, 0.3, 0.4], store.facesOf("vol~p1")[0].embedding);
    return { store, id, face };
  }

  it("leaves them here too when the mark is later than what is held here, over the confirmation here", async () => {
    const { store, id, face } = await confirmedAnn();
    applyCopy(store, { ...copy([face]), createdAt: 300, notPerson: [{ name: "Ann", key: "p1", index: 0, at: 200 }] });
    expect(store.people.blocked["vol~p1#0"]).toEqual(["Ann"]);
    expect(store.people.confirmed["vol~p1#0"]).toBeUndefined();
    expect(store.people.assign["vol~p1#0"]).not.toBe(id);
    expect(store.people.curation[curationKey(2, "Ann", "p1#0")]).toMatchObject({ removed: false, at: 200 });
  });

  it("changes nothing with a mark from a copy that keeps no times", async () => {
    const { store, id, face } = await confirmedAnn();
    applyCopy(store, { ...copy([face]), createdAt: 300, notPerson: [{ name: "Ann", key: "p1", index: 0, at: 0 }] });
    expect(store.people.blocked["vol~p1#0"]).toBeUndefined();
    expect(store.people.confirmed["vol~p1#0"]).toBe("Ann");
    expect(store.people.assign["vol~p1#0"]).toBe(id);
  });
});

describe("the other device's automatic grouping", () => {
  it("names a face here without confirming it; only a name confirmed there is confirmed here", async () => {
    const rand = seeded(101);
    const a = direction(rand);
    const b = direction(rand);
    const store = new FaceStore();
    store.load();
    store.put("vol~p1", [local("vol~p1", 0, [0.1, 0.1, 0.3, 0.4], a), local("vol~p1", 1, [0.6, 0.1, 0.8, 0.4], b)]);
    const grouped = { ...phone("p1", 0, [0.1, 0.1, 0.3, 0.4], a), person: "Ann" };
    const confirmed = { ...phone("p1", 1, [0.6, 0.1, 0.8, 0.4], b), person: "Bob", confirmed: "Bob" };
    expect(applyCopy(store, { ...copy([grouped, confirmed]), createdAt: 5 })!.named).toBe(2);
    const p = store.people;
    expect(p.people.find((x) => x.id === p.assign["vol~p1#0"])!.name).toBe("Ann");
    expect(p.confirmed["vol~p1#0"]).toBeUndefined();
    expect(p.confirmed["vol~p1#1"]).toBe("Bob");
  });

  it("is taken with the photos the other device finished, unconfirmed too", () => {
    const rand = seeded(102);
    const a = direction(rand);
    const store = new FaceStore();
    store.load();
    const grouped = { ...phone("p1", 0, [0.1, 0.1, 0.3, 0.4], a), person: "Ann" };
    expect(adoptScanned(store, copy([grouped]), new Map([["p1", "vol~p1"]]))).toBe(1);
    expect(store.people.assign["vol~p1#0"]).toBeDefined();
    expect(store.people.confirmed["vol~p1#0"]).toBeUndefined();
  });
});

describe("a name taken off here", () => {
  async function unnamedHere() {
    const rand = seeded(103);
    const a = direction(rand);
    const store = new FaceStore();
    store.load();
    store.put("vol~p1", [local("vol~p1", 0, [0.1, 0.1, 0.3, 0.4], a)]);
    await placeNew(store);
    const id = store.people.assign["vol~p1#0"];
    renamePerson(store, id, "Ann", 10);
    renamePerson(store, id, "", 50);
    const face = { ...phone("p1", 0, [0.1, 0.1, 0.3, 0.4], a), confirmed: "Ann" };
    return { store, face, a };
  }

  it("does not come back from a copy made before it was taken off", async () => {
    const { store, face } = await unnamedHere();
    expect(applyCopy(store, { ...copy([face]), createdAt: 40 })!.named).toBe(0);
    expect(store.people.people.some((x) => x.name === "Ann")).toBe(false);
    // A copy made after it was taken off may name the face again.
    expect(applyCopy(store, { ...copy([face]), createdAt: 60 })!.named).toBe(1);
  });

  it("does not come back with the photos the other device finished either", async () => {
    const { store, a } = await unnamedHere();
    const other = { ...phone("p2", 0, [0.1, 0.1, 0.3, 0.4], a), confirmed: "Ann" };
    expect(adoptScanned(store, { ...copy([other]), createdAt: 40 }, new Map([["p2", "vol~p2"]]))).toBe(1);
    expect(store.people.assign["vol~p2#0"]).toBeUndefined();
  });
});

describe("a copy made with other face models", () => {
  it("brings its names by where the faces sit, never its faces or its numbers", async () => {
    const rand = seeded(104);
    const a = direction(rand);
    const store = new FaceStore();
    store.load();
    store.put("vol~p1", [local("vol~p1", 0, [0.1, 0.1, 0.3, 0.4], a)]);
    const named = { ...phone("p1", 0, [0.11, 0.1, 0.31, 0.4], direction(rand)), confirmed: "Ann" };
    const missed = { ...phone("p1", 1, [0.6, 0.1, 0.8, 0.4], direction(rand)), confirmed: "Bob" };
    const elsewhere = phone("p2", 0, [0.1, 0.1, 0.3, 0.4], direction(rand));
    const theirs = { ...copy([named, missed, elsewhere]), createdAt: 5, faceModelVersion: FACE_MODEL_VERSION - 1 };
    const result = applyCopy(store, theirs)!;
    expect(result.added).toBe(0);
    expect(result.named).toBe(1);
    expect(store.facesOf("vol~p1").map((f) => f.id)).toEqual(["vol~p1#0"]);
    expect(store.people.confirmed["vol~p1#0"]).toBe("Ann");
    expect(adoptScanned(store, { ...theirs, faceModelSha256: "00" }, new Map([["p2", "vol~p2"]]))).toBe(0);
    expect(store.has("vol~p2")).toBe(false);
    expect(adoptScanned(store, theirs, new Map([["p2", "vol~p2"]]))).toBe(0);
    expect(adoptScanned(store, { ...copy([elsewhere]), clusterParamsVersion: 2 }, new Map([["p2", "vol~p2"]]))).toBe(0);
  });
});

describe("photos attached to a person by hand on the phone", () => {
  async function annHere() {
    const rand = seeded(105);
    const store = new FaceStore();
    store.load();
    store.put("vol~p1", [local("vol~p1", 0, [0.1, 0.1, 0.3, 0.4], direction(rand))]);
    store.put("vol~p2", []);
    await placeNew(store);
    renamePerson(store, store.people.assign["vol~p1#0"], "Ann", 1);
    return store;
  }

  it("count among the person's photos here, and go into this computer's copy", async () => {
    const store = await annHere();
    const theirs = { ...copy([]), createdAt: 10, manual: [{ name: "Ann", key: "p2", at: 4 }] };
    expect(applyCopy(store, theirs)!.attached).toBe(1);
    expect(listPeople(store).named[0].uids.sort()).toEqual(["vol~p1", "vol~p2"]);
    const { copy: back } = readFaceCopy(writeFaceCopy(copyForDrive(store, "Desk", 11)));
    expect(back.manual).toEqual([{ name: "Ann", key: "p2", at: 4 }]);
    // Taken off there later, it goes here too.
    applyCopy(store, { ...copy([]), createdAt: 20, removals: [{ kind: 1 as const, name: "Ann", key: "p2", index: 0, at: 15 }] });
    expect(listPeople(store).named[0].uids).toEqual(["vol~p1"]);
  });

  it("follow the person through a rename, and leave with the photo taken from them here", async () => {
    const store = await annHere();
    applyCopy(store, { ...copy([]), createdAt: 10, manual: [{ name: "Ann", key: "p2", at: 4 }] });
    const id = listPeople(store).named[0].id;
    renamePerson(store, id, "Anna", 12);
    expect(store.people.manual).toEqual({ Anna: ["p2"] });
    removePhotosFromPerson(store, id, ["vol~p2"], 13);
    expect(store.people.manual).toEqual({});
    expect(listPeople(store).named[0].uids).toEqual(["vol~p1"]);
    // An older copy brings it back no more.
    applyCopy(store, { ...copy([]), createdAt: 30, manual: [{ name: "Anna", key: "p2", at: 4 }] });
    expect(store.people.manual).toEqual({});
  });
});

describe("a hidden photo", () => {
  it("goes into this computer's copy not at all", async () => {
    const rand = seeded(106);
    const a = direction(rand);
    const store = new FaceStore();
    store.load();
    store.put("vol~p1", [local("vol~p1", 0, [0.1, 0.1, 0.3, 0.4], a)]);
    store.put("vol~h", [local("vol~h", 0, [0.1, 0.1, 0.3, 0.4], faceOf(a, rand, 0.1))]);
    await placeNew(store);
    const id = store.people.assign["vol~p1#0"];
    renamePerson(store, id, "Ann", 1);
    setPersonCover(store, id, "vol~h", 2);
    store.people.blocked["vol~h#0"] = ["Bob"];
    store.people.manual.Ann = ["h"];
    const written = copyForDrive(store, "Desk", 3, 0, (uid) => uid === "vol~h");
    expect(written.faces.map((f) => f.key)).toEqual(["p1"]);
    expect(written.markers.map((m) => m.key)).toEqual(["p1"]);
    expect(written.covers).toEqual([]);
    expect(written.notPerson).toEqual([]);
    expect(written.manual).toEqual([]);
  });
});
