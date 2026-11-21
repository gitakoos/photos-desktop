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
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import {
  readFaceCopy,
  readFacesSnapshot,
  writeFaceCopy,
  type FaceCopy,
  type FaceCopyToWrite,
  type SnapshotFace,
} from "./driveData.ts";
import {
  hidePerson,
  listPeople,
  listSuggestions,
  nameFaces,
  renamePerson,
  showPerson,
  facesOnPhoto,
} from "./facePeople.ts";
import { FACE_EMBEDDING_DIM } from "./faceCluster.ts";
import { FACE_MODEL_VERSION, FaceStore } from "./faceStore.ts";
import { FACE_CLUSTER_PARAMS_VERSION, FACE_MODEL_SHA256, applyCopy, copyForDrive } from "./faceSync.ts";
import { isHiddenToken } from "./personName.ts";
import { initStore, setDataKey } from "./store.ts";
import { direction, faceOf, seeded } from "./testFaces.ts";

const TOKEN = "hidden" + "0123456789abcdef0123456789abcdef";
const PHONE_ID = "00000000-0000-0000-0000-000000000001";
const hexOf = (text: string) => Buffer.from(text.replace(/\s+/g, ""), "hex");

/** The spec's test vector: 2 keys, "Anna" hidden at 1700000000000, a token person shown again at 1700000001000. */
const specInput = (): FaceCopyToWrite => ({
  deviceId: "d1",
  deviceLabel: "Phone",
  createdAt: 1700000002000,
  faceModelVersion: 7,
  faceModelSha256: "ab",
  clusterParamsVersion: 1,
  embeddingDim: 2,
  faces: [
    {
      key: "k1",
      index: 0,
      box: [0.25, 0.5, 0.75, 1],
      score: 0.875,
      blur: 2,
      rejected: false,
      person: "Anna",
      confirmed: null,
      points: [1, 2],
      embedding: new Float32Array([1, -1]),
    },
    {
      key: "k2",
      index: 0,
      box: [0.25, 0.5, 0.75, 1],
      score: 0.875,
      blur: 2,
      rejected: false,
      person: TOKEN,
      confirmed: TOKEN,
      points: [1, 2],
      embedding: new Float32Array([1, -1]),
    },
  ],
  notPerson: [],
  covers: [],
  hiddenPeople: [
    { name: "Anna", hidden: true, at: 1700000000000 },
    { name: TOKEN, hidden: false, at: 1700000001000 },
  ],
  markers: [
    { key: "k1", swept: false },
    { key: "k2", swept: false },
  ],
});

describe("the face copy, version 7", () => {
  it("is written as the golden vector and reads back with its hidden people", () => {
    const golden = hexOf(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "testdata", "v7_hidden_golden.hex"), "utf8"));
    const written = writeFaceCopy(specInput());
    expect(written.toString("hex")).toBe(golden.toString("hex"));
    const { copy, snapshot } = readFaceCopy(golden);
    expect(copy.hiddenPeople).toEqual([
      { name: "Anna", hidden: true, at: 1700000000000 },
      { name: TOKEN, hidden: false, at: 1700000001000 },
    ]);
    expect(copy.faces.map((f) => f.person)).toEqual(["Anna", TOKEN]);
    // Anna is hidden and the token is never a name: neither is listed.
    expect(snapshot.people).toEqual([]);
  });

  it("carries version 7 and ten counts, with the hidden records last", () => {
    const written = writeFaceCopy(specInput());
    expect(written.readUInt32LE(8)).toBe(7);
    // Two records of 14 bytes (tag, person, flags, time), then the end marker.
    expect(written[written.length - 1 - 28]).toBe(0x0b);
    expect(written[written.length - 1 - 14]).toBe(0x0b);
    expect(written[written.length - 1]).toBe(0xff);
    const none = specInput();
    none.hiddenPeople = [];
    expect(readFaceCopy(writeFaceCopy(none)).copy.hiddenPeople).toEqual([]);
  });

  it("refuses a flag bit other than the first, and a negative time", () => {
    const written = writeFaceCopy(specInput());
    const at = written.length - 1 - 14;
    expect(written[at]).toBe(0x0b);
    const flags = Buffer.from(written);
    flags[at + 5] = 0x03;
    expect(() => readFaceCopy(flags)).toThrow("a hidden-person flag 3");
    const negative = Buffer.from(written);
    negative.writeBigInt64LE(-1n, at + 6);
    expect(() => readFaceCopy(negative)).toThrow("a negative hide time");
  });

  it("is refused by a count that outruns the file", () => {
    const written = writeFaceCopy(specInput());
    expect(() => readFaceCopy(written.subarray(0, written.length - 3))).toThrow();
  });
});

const copyOf = (hidden: FaceCopy["hiddenPeople"], extra: Partial<FaceCopy> = {}): FaceCopy => ({
  deviceId: PHONE_ID,
  deviceLabel: "phone",
  createdAt: 10,
  faceModelVersion: FACE_MODEL_VERSION,
  faceModelSha256: FACE_MODEL_SHA256,
  clusterParamsVersion: FACE_CLUSTER_PARAMS_VERSION,
  embeddingDim: FACE_EMBEDDING_DIM,
  facesWipedAt: 0,
  faces: [],
  notPerson: [],
  covers: new Map(),
  coverSetAt: new Map(),
  manual: [],
  removals: [],
  namedAt: new Map(),
  nameChanges: [],
  scanned: [],
  hiddenPeople: hidden,
  ...extra,
});

/** A person of `photos` photos, each with one face near `base`; named, or an unnamed group. */
function addPerson(store: FaceStore, name: string | null, base: Float32Array, rand: () => number, photos = 3): string {
  const p = store.people;
  const id = `p${p.nextId++}`;
  p.people.push({ id, name, isOther: false });
  if (name) p.namedAt[name.toLowerCase()] = 1;
  for (let i = 0; i < photos; i++) {
    const uid = `vol~${name ?? "u"}${id}-${i}`;
    const face = { id: `${uid}#0`, uid, box: [0.1, 0.1, 0.3, 0.4] as [number, number, number, number], points: [], score: 0.9, blur: 100, sideways: 0, embedding: faceOf(base, rand, 0.1) };
    store.put(uid, [face]);
    p.assign[face.id] = id;
    if (name) p.confirmed[face.id] = name;
  }
  store.markPeople();
  return id;
}

let store: FaceStore;

beforeEach(() => {
  initStore(mkdtempSync(join(tmpdir(), "pfp-hidden-")));
  setDataKey(randomBytes(32));
  store = new FaceStore();
  store.load();
});

describe("hiding a person here", () => {
  it("takes a named person out of People and the suggestions, and back", () => {
    const rand = seeded(5);
    const a = direction(rand);
    const anna = addPerson(store, "Anna", a, rand);
    const group = addPerson(store, null, a, rand);
    expect(listSuggestions(store).map((s) => [s.unnamed, s.named])).toEqual([[group, anna]]);
    hidePerson(store, anna, 100);
    let people = listPeople(store);
    expect(people.named).toEqual([]);
    expect(people.hidden.map((x) => x.name)).toEqual(["Anna"]);
    expect(people.suggestions).toEqual([]);
    expect(store.people.hidden.anna).toEqual({ name: "Anna", hidden: true, at: 100 });
    showPerson(store, anna, 200);
    people = listPeople(store);
    expect(people.named.map((x) => x.name)).toEqual(["Anna"]);
    expect(people.hidden).toEqual([]);
    expect(store.people.hidden.anna).toEqual({ name: "Anna", hidden: false, at: 200 });
  });

  it("labels an unnamed group with a token that is never shown, and shows it again unnamed", () => {
    const rand = seeded(6);
    const group = addPerson(store, null, direction(rand), rand);
    hidePerson(store, group, 100);
    const person = store.people.people.find((x) => x.id === group)!;
    expect(isHiddenToken(person.name!)).toBe(true);
    expect(Object.values(store.people.confirmed).every((n) => n === person.name)).toBe(true);
    const people = listPeople(store);
    expect(people.unnamed).toEqual([]);
    expect(people.hidden).toHaveLength(1);
    expect(people.hidden[0].name).toBeNull();
    expect(facesOnPhoto(store, Object.keys(store.people.assign)[0].split("#")[0])[0]).toMatchObject({ personId: null, name: null });
    const token = person.name!;
    showPerson(store, group, 200);
    expect(person.name).toBeNull();
    expect(store.people.confirmed).toEqual({});
    expect(store.people.nameChanges).toContainEqual({ from: token, to: "", at: 200 });
    expect(store.people.hidden[token]).toEqual({ name: token, hidden: false, at: 200 });
    expect(listPeople(store).unnamed.map((x) => x.id)).toEqual([group]);
  });

  it("never lets a reserved name be typed", () => {
    const rand = seeded(7);
    const group = addPerson(store, null, direction(rand), rand);
    expect(() => renamePerson(store, group, TOKEN)).toThrow("cannot be used");
    expect(() => nameFaces(store, ["x#0"], "hiddenanything")).toThrow("cannot be used");
  });

  it("moves the hidden row with a rename, and drops it when the name is taken off", () => {
    const rand = seeded(8);
    const anna = addPerson(store, "Anna", direction(rand), rand);
    hidePerson(store, anna, 100);
    renamePerson(store, anna, "Anne", 150);
    expect(store.people.hidden.anna).toBeUndefined();
    expect(store.people.hidden.anne).toEqual({ name: "Anne", hidden: true, at: 100 });
    renamePerson(store, anna, "", 160);
    expect(store.people.hidden.anne).toBeUndefined();
  });
});

describe("taking a hidden person in from another device", () => {
  it("applies the later of two settings of a name and passes over the older", () => {
    const rand = seeded(9);
    addPerson(store, "Anna", direction(rand), rand);
    const first = applyCopy(store, copyOf([{ name: "anna", hidden: true, at: 100 }], { createdAt: 10 }))!;
    expect(first.hiddenChanged).toBe(1);
    expect(listPeople(store).hidden.map((x) => x.name)).toEqual(["Anna"]);
    // An older show does not undo it; a later one does.
    expect(applyCopy(store, copyOf([{ name: "Anna", hidden: false, at: 50 }], { createdAt: 20 }))!.hiddenChanged).toBe(0);
    expect(listPeople(store).hidden).toHaveLength(1);
    expect(applyCopy(store, copyOf([{ name: "Anna", hidden: false, at: 300 }], { createdAt: 30 }))!.hiddenChanged).toBe(1);
    expect(listPeople(store).hidden).toEqual([]);
    expect(listPeople(store).named.map((x) => x.name)).toEqual(["Anna"]);
  });

  it("takes the same copy in again as nothing", () => {
    const hidden = [{ name: "Anna", hidden: true, at: 100 }];
    expect(applyCopy(store, copyOf(hidden))).not.toBeNull();
    const before = JSON.stringify(store.people);
    expect(applyCopy(store, copyOf(hidden))).toBeNull();
    expect(applyCopy(store, copyOf(hidden, { createdAt: 11 }))!.hiddenChanged).toBe(0);
    expect(JSON.stringify({ ...store.people, applied: {} })).toBe(JSON.stringify({ ...JSON.parse(before), applied: {} }));
  });

  it("moves a row with a name change there, and drops it for a name taken off there", () => {
    applyCopy(store, copyOf([{ name: "Anna", hidden: true, at: 100 }]));
    const rand = seeded(10);
    addPerson(store, "Anna", direction(rand), rand);
    store.people.hidden.anna = { name: "Anna", hidden: true, at: 100 };
    applyCopy(store, copyOf([], { createdAt: 20, nameChanges: [{ from: "Anna", to: "Anne", at: 150 }] }));
    expect(store.people.hidden.anna).toBeUndefined();
    expect(store.people.hidden.anne).toMatchObject({ hidden: true, at: 100 });
    applyCopy(store, copyOf([], { createdAt: 30, nameChanges: [{ from: "Anne", to: "", at: 200 }] }));
    expect(store.people.hidden.anne).toBeUndefined();
    // A hide older than the take-off is not brought back for a name nobody holds.
    expect(applyCopy(store, copyOf([{ name: "Anne", hidden: true, at: 120 }], { createdAt: 40 }))!.hiddenChanged).toBe(0);
  });

  it("takes a token group in as an ordinary name, hidden and never shown by it", () => {
    const rand = seeded(11);
    const base = direction(rand);
    const face: SnapshotFace = {
      key: "p1",
      index: 0,
      box: [0.1, 0.1, 0.3, 0.4],
      points: [],
      score: 0.9,
      blur: 50,
      embedding: base,
      rejected: false,
      person: TOKEN,
      confirmed: TOKEN,
    };
    store.put("vol~p1", [{ id: "vol~p1#0", uid: "vol~p1", box: face.box, points: [], score: 0.9, blur: 100, sideways: 0, embedding: base }]);
    store.put("vol~p2", [{ id: "vol~p2#0", uid: "vol~p2", box: face.box, points: [], score: 0.9, blur: 100, sideways: 0, embedding: faceOf(base, rand, 0.1) }]);
    const both = [face, { ...face, key: "p2", embedding: faceOf(base, rand, 0.1) }];
    applyCopy(store, copyOf([{ name: TOKEN, hidden: true, at: 100 }], { faces: both, scanned: ["p1", "p2"] }));
    const people = listPeople(store);
    expect(people.hidden).toHaveLength(1);
    expect(people.hidden[0].name).toBeNull();
    expect(people.named).toEqual([]);
    // Shown again there: the label comes off the faces here.
    applyCopy(store, copyOf([{ name: TOKEN, hidden: false, at: 200 }], { createdAt: 20, nameChanges: [{ from: TOKEN, to: "", at: 200 }] }));
    expect(listPeople(store).hidden).toEqual([]);
    expect(store.people.people.some((x) => x.name && isHiddenToken(x.name))).toBe(false);
  });

  it("reads this computer's own copy back as no change", () => {
    const rand = seeded(12);
    const anna = addPerson(store, "Anna", direction(rand), rand);
    const group = addPerson(store, null, direction(rand), rand);
    hidePerson(store, anna, 100);
    hidePerson(store, group, 110);
    const own = readFaceCopy(writeFaceCopy(copyForDrive(store, "Desk", 500))).copy;
    expect(own.hiddenPeople).toHaveLength(2);
    const before = JSON.stringify({ ...store.people, applied: {} });
    expect(applyCopy(store, { ...own, createdAt: 600 }, true)!.hiddenChanged).toBe(0);
    expect(JSON.stringify({ ...store.people, applied: {} })).toBe(before);
    expect(listPeople(store).hidden).toHaveLength(2);
  });

  it("writes a person shown again too, so the show crosses devices", () => {
    const rand = seeded(13);
    const anna = addPerson(store, "Anna", direction(rand), rand);
    hidePerson(store, anna, 100);
    showPerson(store, anna, 200);
    const written = copyForDrive(store, "Desk", 500);
    expect(written.hiddenPeople).toEqual([{ name: "Anna", hidden: false, at: 200 }]);
  });
});

describe("reading a hidden person from the snapshot of people", () => {
  it("leaves out a hidden person and a token, and keeps a person shown again", () => {
    const base = specInput();
    base.faces.push({ ...base.faces[0], key: "k3", person: "Zoe" });
    base.hiddenPeople = [
      { name: "Anna", hidden: true, at: 10 },
      { name: "Zoe", hidden: true, at: 10 },
      { name: "Zoe", hidden: false, at: 20 },
      { name: TOKEN, hidden: true, at: 10 },
    ];
    // Two rows of one name cannot be written; the snapshot reads the later per name.
    const rows = base.hiddenPeople;
    base.hiddenPeople = [rows[0], rows[2], rows[3]];
    const snap = readFacesSnapshot(writeFaceCopy(base));
    expect(snap.people.map((p) => p.name)).toEqual(["Zoe"]);
  });
});
