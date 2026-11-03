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

import { describe, expect, it } from "vitest";
import { emptyFaces, Replica, FACE_EMBED_SHA256 } from "./mlReplica.ts";
import { writeFacesSnapshot, parseFacesSnapshot, type FacesSnap, type SnapFace } from "./mlSnapshot.ts";

const ME = "aaaaaaaa-0000-0000-0000-000000000001";
const PHONE = "bbbbbbbb-0000-0000-0000-000000000002";

/** A unit vector pointing mostly along `axis`, a little along `jitter`: faces on one axis are
 *  one person, cosine about 0.98 apart; different axes are about 0 apart. */
function identity(axis: number, jitter = 0): Float32Array {
  const v = new Float32Array(512);
  v[axis] = 1;
  v[100 + jitter] = 0.2;
  let n = 0;
  for (const x of v) n += x * x;
  return v.map((x) => x / Math.sqrt(n));
}

function face(key: string, index: number, axis: number, extra: Partial<SnapFace> = {}): SnapFace {
  return {
    key, index, box: [0.1 * index, 0.1, 0.1 * index + 0.2, 0.4], score: 0.9, blur: 40, rejected: false,
    person: null, confirmed: null, points: Float32Array.of(30, 40, 70, 40, 50, 60, 35, 80, 65, 80),
    embedding: identity(axis, index), ...extra,
  };
}

function phone(createdAt: number, faces: SnapFace[], extra: Partial<FacesSnap> = {}): FacesSnap {
  return {
    ...emptyFaces(PHONE, "Pixel"), createdAt, modelSha256: FACE_EMBED_SHA256,
    faces, markers: [...new Set(faces.map((f) => f.key))].map((key) => ({ key, hiRes: false })), ...extra,
  };
}

function replica(): Replica {
  return new Replica(ME, "Windows PC", "clip");
}

const named = (r: Replica) => r.view().people.filter((p) => p.name).map((p) => [p.name, [...p.keys].sort()]);

describe("merging the phone's copy", () => {
  it("keeps the phone's names and groups its unnamed faces", () => {
    const r = replica();
    r.setCopies([phone(1000, [
      face("p1", 0, 1, { person: "Ana", confirmed: "Ana" }),
      face("p2", 0, 1, { person: "Ana" }),
      face("p3", 0, 2),
      face("p4", 0, 2),
    ])], []);
    expect(named(r)).toEqual([["Ana", ["p1", "p2"]]]);
    const unnamed = r.view().people.filter((p) => !p.name);
    expect(unnamed).toHaveLength(1);
    expect([...unnamed[0].keys].sort()).toEqual(["p3", "p4"]);
  });

  it("lets a newer edit here win over the phone, and a newer phone save win over an older edit", () => {
    const r = replica();
    r.setCopies([phone(1000, [face("p1", 0, 1, { confirmed: "Ana" }), face("p2", 0, 1, { confirmed: "Ana" })])], []);
    const [p1] = r.refs(["p1#0"]);
    r.apply({ t: r.clock(500), kind: "confirm", faces: [p1], name: "Bia" });
    expect(named(r)).toEqual([["Ana", ["p2"]], ["Bia", ["p1"]]]);

    // The phone saves again later, unaware, with the same old value: that is no new decision.
    r.setCopies([phone(5000, [face("p1", 0, 1, { confirmed: "Ana" }), face("p2", 0, 1, { confirmed: "Ana" })])], []);
    expect(named(r)).toEqual([["Ana", ["p2"]], ["Bia", ["p1"]]]);

    // Later still, someone on the phone does decide p1 is Carla: that newer decision wins.
    r.setCopies([phone(9000, [face("p1", 0, 1, { confirmed: "Carla" }), face("p2", 0, 1, { confirmed: "Ana" })])], []);
    expect(named(r)).toEqual([["Ana", ["p2"]], ["Carla", ["p1"]]]);
  });

  it("takes a photo the phone stopped holding under a person as removed, dated by that save", () => {
    const r = replica();
    const base = [face("p1", 0, 1, { confirmed: "Ana" }), face("p2", 0, 1, { confirmed: "Ana" })];
    r.setCopies([phone(1000, base, { manual: [{ name: "Ana", key: "p9" }] })], []);
    expect(r.person("n:Ana")!.keys).toContain("p9");
    r.setCopies([phone(2000, base)], []);
    expect(r.person("n:Ana")!.keys).not.toContain("p9");
  });

  it("dates an edit past every copy it has seen, so a slow clock cannot lose it", () => {
    const r = replica();
    r.setCopies([phone(10_000, [face("p1", 0, 1, { confirmed: "Ana" }), face("p2", 0, 1, { confirmed: "Ana" })])], []);
    expect(r.clock(5)).toBe(10_001);
  });

  it("applies a rename to copies that never heard of it, and merges onto a name in use", () => {
    const r = replica();
    r.setCopies([phone(1000, [
      face("p1", 0, 1, { confirmed: "Ana" }), face("p2", 0, 1, { confirmed: "Ana" }),
      face("p3", 0, 2, { confirmed: "Annie" }), face("p4", 0, 2, { confirmed: "Annie" }),
    ])], []);
    r.apply({ t: r.clock(), kind: "alias", from: "Annie", to: "Ana" });
    expect(named(r)).toEqual([["Ana", ["p1", "p2", "p3", "p4"]]]);
  });

  it("frees a renamed-away name when it is given to someone on purpose", () => {
    const r = replica();
    r.setCopies([phone(1000, [
      face("p1", 0, 1, { confirmed: "Ana" }), face("p2", 0, 1, { confirmed: "Ana" }),
      face("p3", 0, 2), face("p4", 0, 2),
    ])], []);
    r.apply({ t: r.clock(), kind: "alias", from: "Ana", to: "Ana Maria" });
    expect(r.isAliased("Ana")).toBe(true);
    const group = r.view().people.find((p) => !p.name)!;
    const t = r.clock();
    r.apply({ t, kind: "alias", from: "Ana", to: "Ana" });
    r.apply({ t, kind: "confirm", faces: r.refs(group.faces), name: "Ana" });
    expect(named(r)).toEqual([["Ana", ["p3", "p4"]], ["Ana Maria", ["p1", "p2"]]]);
    // The phone, saving again later without having heard of any of it, still lands right.
    r.setCopies([phone(r.clock() + 10, [
      face("p1", 0, 1, { confirmed: "Ana" }), face("p2", 0, 1, { confirmed: "Ana" }),
      face("p3", 0, 2), face("p4", 0, 2),
    ])], []);
    expect(named(r)).toEqual([["Ana", ["p3", "p4"]], ["Ana Maria", ["p1", "p2"]]]);
  });

  it("drops a photo from a person and keeps it out", () => {
    const r = replica();
    r.setCopies([phone(1000, [
      face("p1", 0, 1, { confirmed: "Ana" }), face("p2", 0, 1, { person: "Ana" }), face("p3", 0, 1, { person: "Ana" }),
    ])], []);
    const t = r.clock();
    const refs = r.facesOn("n:Ana", ["p3"]);
    r.apply({ t, kind: "notPerson", faces: refs, name: "Ana", on: true });
    r.apply({ t, kind: "unassign", faces: refs });
    expect(named(r)).toEqual([["Ana", ["p1", "p2"]]]);
    // It travels in the copy this device saves.
    const out = parseFacesSnapshot(writeFacesSnapshot(r.exportFaces(9)));
    expect(out.notPerson).toEqual([{ name: "Ana", key: "p3", index: 0 }]);
  });

  it("hides a person by removing their faces from People", () => {
    const r = replica();
    r.setCopies([phone(1000, [face("p1", 0, 1, { confirmed: "Statue" }), face("p2", 0, 1, { confirmed: "Statue" })])], []);
    const p = r.person("n:Statue")!;
    r.apply({ t: r.clock(), kind: "reject", faces: r.refs(p.faces) });
    expect(r.view().people).toEqual([]);
    expect(r.exportFaces().faces.every((f) => f.rejected)).toBe(true);
  });

  it("adds photos by hand and picks a cover", () => {
    const r = replica();
    r.setCopies([phone(1000, [face("p1", 0, 1, { confirmed: "Ana" }), face("p2", 0, 1, { confirmed: "Ana" })])], []);
    const t = r.clock();
    r.apply({ t, kind: "manual", keys: ["p9"], name: "Ana", on: true });
    r.apply({ t, kind: "cover", name: "Ana", key: "p2" });
    const ana = r.person("n:Ana")!;
    expect([...ana.keys].sort()).toEqual(["p1", "p2", "p9"]);
    expect(ana.cover?.key).toBe("p2");
  });

  it("takes a photo's faces from the newest scan and carries curation over by where the face sits", () => {
    const r = replica();
    // The phone named the face on p1; this PC scanned p1 later and numbered its faces apart.
    r.setCopies([phone(1000, [face("p1", 0, 1, { confirmed: "Ana" }), face("p2", 0, 1, { confirmed: "Ana" })])], []);
    r.addScan("p1", [{ ...face("p1", 5, 1), box: [0.01, 0.1, 0.21, 0.4] }], null, 2000);
    const ana = r.person("n:Ana")!;
    expect(ana.faces.sort()).toEqual(["p1#5", "p2#0"]);
    expect(r.view().scanned).toBe(2);
  });

  it("writes everything every device knows into this device's copy", () => {
    const r = replica();
    r.setCopies([phone(1000, [face("p1", 0, 1, { confirmed: "Ana" }), face("p2", 0, 1, { confirmed: "Ana" })])], []);
    r.addScan("p7", [face("p7", 0, 3)], Uint16Array.from({ length: 512 }, () => 0x3c00), 3000);
    const out = r.exportFaces(4000);
    expect(out.deviceId).toBe(ME);
    expect(out.faces.map((f) => f.key).sort()).toEqual(["p1", "p2", "p7"]);
    expect(out.markers.map((m) => m.key).sort()).toEqual(["p1", "p2", "p7"]);
    expect(r.exportSearch(4000).vectors.has("p7")).toBe(true);
  });

  it("reads this device's own copy as a fallback: it fills in, and gives way to any other say", () => {
    // Alone, the own copy brings back what it held.
    const r = replica();
    const mine = { ...emptyFaces(ME, "Windows PC"), createdAt: 99_999, modelSha256: FACE_EMBED_SHA256, faces: [face("p1", 0, 1, { confirmed: "Old" })] };
    r.setCopies([mine], []);
    expect(named(r)).toEqual([["Old", ["p1"]]]);
    // A phone's copy saved before it, saying otherwise, still wins: the own copy only relays.
    r.setCopies([mine, phone(1000, [face("p1", 0, 1, { confirmed: "New" })])], []);
    expect(named(r)).toEqual([["New", ["p1"]]]);
  });

  it("suggests an unnamed group that looks like a named person", () => {
    const r = replica();
    r.setCopies([phone(1000, [
      face("p1", 0, 1, { confirmed: "Ana" }), face("p2", 0, 1, { confirmed: "Ana" }),
      { ...face("p3", 0, 1), embedding: blend(1, 9, 0.55) }, { ...face("p4", 0, 1), embedding: blend(1, 9, 0.55) },
    ])], []);
    const s = r.suggestionsFor("Ana");
    expect(s.length).toBe(1);
    expect(s[0].faces.map((id) => id.split("#")[0]).sort()).toEqual(["p3", "p4"]);
  });
});

/** A unit vector between two identities: cosine `w`-ish to the first. */
function blend(a: number, b: number, w: number): Float32Array {
  const v = new Float32Array(512);
  v[a] = w;
  v[b] = Math.sqrt(1 - w * w);
  return v;
}

describe("reusing the grouping across edits", () => {
  it("answers exactly what a fresh merge does, edit after edit", () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const faces: SnapFace[] = [];
    for (let i = 0; i < 120; i++) {
      const axis = rnd() < 0.8 ? 1 + Math.floor(rnd() * 6) : 20 + i;
      // A mix of clear and weak faces, so confirming weak ones is exercised too.
      faces.push(face(`k${i}`, 0, axis, { score: 0.55 + rnd() * 0.4, blur: rnd() < 0.3 ? 5 : 40, embedding: identity(axis, i % 50) }));
    }
    const copy = phone(1000, faces);
    const warm = replica();
    warm.setCopies([copy], []);
    const edits: ((r: Replica) => void)[] = [
      (r) => r.apply({ t: 2000, kind: "confirm", faces: r.refs(r.view().people.find((p) => !p.name)!.faces), name: "Ana" }),
      (r) => r.apply({ t: 3000, kind: "confirm", faces: r.refs(r.view().people.filter((p) => !p.name)[0].faces), name: "Bia" }),
      (r) => r.apply({ t: 4000, kind: "alias", from: "Bia", to: "Ana" }),
      (r) => r.apply({ t: 5000, kind: "confirm", faces: r.refs(["k7#0", "k9#0"]), name: "Caio" }),
    ];
    warm.view();
    const first = warm.clusterCache;
    let reused = 0;
    for (const edit of edits) {
      const had = warm.clusterCache;
      edit(warm);
      warm.view();
      if (warm.clusterCache === had) reused++;
      const cold = replica();
      cold.setCopies([copy], []);
      cold.ops = [...warm.ops];
      expect(warm.view()).toEqual(cold.view());
    }
    // Naming and merging groups never needed the faces grouped again.
    expect(reused).toBeGreaterThanOrEqual(3);
    expect(first).not.toBeNull();
    // And looking at the same copies again keeps the grouping it already has.
    const before = warm.clusterCache;
    warm.setCopies([copy], []);
    warm.view();
    expect(warm.clusterCache).toBe(before);
  });
});

describe("the faces on one photo", () => {
  it("tags each face with its own person, and names a lone face from the viewer", () => {
    const r = replica();
    // p1 holds two people: Ana on the left, a stranger on the right.
    const right = (f: SnapFace): SnapFace => ({ ...f, box: [0.6, 0.1, 0.8, 0.4] });
    r.setCopies([phone(1000, [
      face("p1", 0, 1, { confirmed: "Ana" }), right(face("p1", 1, 7)),
      face("p2", 0, 1, { confirmed: "Ana" }),
    ])], []);
    const tags = r.photoFaces("p1");
    expect(tags.map((f) => [f.face, f.name, f.person])).toEqual([
      ["p1#0", "Ana", "n:Ana"],
      ["p1#1", null, null],
    ]);
    r.apply({ t: r.clock(), kind: "confirm", faces: r.refs(["p1#1"]), name: "Bia" });
    expect(r.photoFaces("p1").map((f) => f.name)).toEqual(["Ana", "Bia"]);
    expect(r.person("n:Bia")!.keys).toEqual(["p1"]);
  });
});

describe("photos no longer in the library", () => {
  it("are neither grouped nor suggested, yet stay in the copy this device saves", () => {
    const r = replica();
    // A group that looks like Ana, on photos since trashed (p3, p4): the "See all 0 photos" case.
    r.setCopies([phone(1000, [
      face("p1", 0, 1, { confirmed: "Ana" }), face("p2", 0, 1, { confirmed: "Ana" }),
      { ...face("p3", 0, 1), embedding: blend(1, 9, 0.55) }, { ...face("p4", 0, 1), embedding: blend(1, 9, 0.55) },
    ], { manual: [{ name: "Ana", key: "p9" }] })], []);
    expect(r.suggestionsFor("Ana")).toHaveLength(1);
    r.setLibrary(["p1", "p2"]);
    expect(r.suggestionsFor("Ana")).toEqual([]);
    expect(r.view().suggestions).toEqual([]);
    expect(r.view().people.map((p) => [p.name, [...p.keys].sort()])).toEqual([["Ana", ["p1", "p2"]]]);
    expect(r.exportFaces().faces.map((f) => f.key).sort()).toEqual(["p1", "p2", "p3", "p4"]);
    expect(r.exportFaces().manual).toEqual([{ name: "Ana", key: "p9" }]);
  });
});

describe("the faces known on a photo, read without a merge", () => {
  it("are the very faces the merge keeps for it, a thorough scan winning over an ordinary one", () => {
    const r = replica();
    r.setCopies([phone(1000, [face("p1", 0, 1, { confirmed: "Ana" }), face("p1", 1, 2), face("p2", 0, 1)])], []);
    const merged = (key: string) => r.view().people.flatMap((p) => p.faces).filter((id) => id.startsWith(`${key}#`)).sort();
    expect(r.knownFaces("p1").map((f) => f.id).sort()).toEqual(["p1#0", "p1#1"]);
    // This PC's thorough look at p1 finds three faces; from then on they are the ones kept.
    r.addScan("p1", [face("p1", 0, 1), face("p1", 1, 2), face("p1", 2, 3)], undefined, 2000, true);
    expect(r.knownFaces("p1").map((f) => f.index)).toEqual([0, 1, 2]);
    r.fresh();
    expect(r.view().scanned).toBe(2);
    expect(merged("p1").length).toBeGreaterThan(0);
    expect(r.knownFaces("p9")).toEqual([]);
  });
});

describe("merging likely matches on their own", () => {
  it("folds a look-alike group into the named person, never one marked as not them, nor two names", () => {
    const r = replica();
    r.setCopies([phone(1000, [
      face("a1", 0, 1, { confirmed: "Ana" }), face("a2", 0, 1, { confirmed: "Ana" }),
      face("b1", 0, 3, { confirmed: "Bia" }), face("b2", 0, 3, { confirmed: "Bia" }),
      // Looks like Ana.
      { ...face("p3", 0, 1), embedding: blend(1, 9, 0.55) }, { ...face("p4", 0, 1), embedding: blend(1, 9, 0.55) },
      // Looks like Bia, but one of its faces was marked as not Bia.
      { ...face("q1", 0, 3), embedding: blend(3, 11, 0.55) }, { ...face("q2", 0, 3), embedding: blend(3, 11, 0.55) },
      // Looks like no one.
      face("z1", 0, 20), face("z2", 0, 20),
    ], { notPerson: [{ name: "Bia", key: "q1", index: 0 }] })], []);

    const pairs = r.autoMergePairs();
    expect(pairs.map((p) => [p.name, p.faces.map((f) => f.id.split("#")[0]).sort()])).toEqual([["Ana", ["p3", "p4"]]]);
    for (const p of pairs) r.apply({ t: r.clock(), kind: "confirm", faces: p.faces, name: p.name });
    expect(named(r)).toEqual([["Ana", ["a1", "a2", "p3", "p4"]], ["Bia", ["b1", "b2"]]]);
    // Nothing left to fold: a second pass merges nothing.
    expect(r.autoMergePairs()).toEqual([]);
  });
});

describe("the same copies, in any order", () => {
  it("group the same way, whatever order Drive lists them in", () => {
    const other = (createdAt: number, faces: SnapFace[]) => ({ ...phone(createdAt, faces), deviceId: "cccccccc-0000-0000-0000-000000000003" });
    const a = phone(1000, [face("p1", 0, 1, { confirmed: "Ana" }), face("p2", 0, 1), face("p3", 0, 2)]);
    const b = other(2000, [face("p4", 0, 1), face("p5", 0, 2), face("p6", 0, 2)]);
    const one = replica();
    one.setCopies([a, b], []);
    const two = replica();
    two.setCopies([b, a], []);
    const people = (r: Replica) => r.view().people.map((p) => [p.name, [...p.keys].sort()]);
    expect(people(two)).toEqual(people(one));
  });
});

describe("a grouping that holds", () => {
  it("keeps a face under the name the last grouping gave it, and a known face keeps its number", () => {
    const r = replica();
    r.setCopies([phone(1000, [face("p1", 0, 1, { confirmed: "Ana" }), face("p2", 0, 1), face("p3", 0, 1)])], []);
    expect(named(r)).toEqual([["Ana", ["p1", "p2", "p3"]]]);
    // A fresh replica that remembers the last grouping names the same faces the same way.
    const again = replica();
    again.lastNames = new Map(r.lastNames);
    again.setCopies([phone(1000, [face("p1", 0, 1, { confirmed: "Ana" }), face("p2", 0, 1), face("p3", 0, 1)])], []);
    expect(named(again)).toEqual(named(r));
    // A second look keeps the phone's number 3 for the face it knew and numbers the new one after.
    again.addScan("p2", [{ ...face("p2", 0, 1), index: 3 }, { ...face("p2", 9, 7), index: undefined }], undefined, 2000, true);
    expect(again.local.faces.filter((f) => f.key === "p2").map((f) => f.index)).toEqual([3, 4]);
  });

  it("does not offer again a group holding a face marked as not that person", () => {
    const r = replica();
    r.setCopies([phone(1000, [
      face("a1", 0, 1, { confirmed: "Ana" }), face("a2", 0, 1, { confirmed: "Ana" }),
      { ...face("p3", 0, 1), embedding: blend(1, 9, 0.55) }, { ...face("p4", 0, 1), embedding: blend(1, 9, 0.55) },
    ], { notPerson: [{ name: "Ana", key: "p3", index: 0 }] })], []);
    expect(r.suggestionsFor("Ana")).toEqual([]);
  });
});


describe("an index that never shrinks", () => {
  it("keeps every device's decisions after a copy is deleted from Drive", () => {
    const r = replica();
    r.setCopies([phone(1000, [face("p1", 0, 1, { confirmed: "Ana" }), face("p2", 0, 1, { confirmed: "Ana" }), face("p3", 0, 2, { confirmed: "Bia" })])], []);
    const [p3] = r.refs(["p3#0"]);
    r.apply({ t: r.clock(), kind: "confirm", faces: [p3], name: "Carla" });
    const before = named(r);
    const saved = parseFacesSnapshot(writeFacesSnapshot(r.exportFaces(5000)));

    // The phone's copy is gone from Drive; this device starts again with only its own copy.
    const again = replica();
    again.ops = [...r.ops];
    again.setOwn(saved, null);
    again.setCopies([], []);
    expect(named(again)).toEqual(before);
    expect(again.exportFaces(6000).faces).toHaveLength(3);
  });

  it("joins the faces two devices found on one photo, once each", () => {
    const r = replica();
    // The phone found two faces on p1; this PC's thorough look found the left one and a third.
    r.setCopies([phone(1000, [face("p1", 0, 1, { confirmed: "Ana" }), { ...face("p1", 1, 2), box: [0.5, 0.1, 0.7, 0.4] }])], []);
    r.addScan("p1", [
      { ...face("p1", 0, 1), box: [0.01, 0.1, 0.21, 0.41] },
      { ...face("p1", 1, 3), box: [0.75, 0.5, 0.95, 0.8] },
    ], undefined, 2000, true);
    const onP1 = r.exportFaces(3000).faces.filter((f) => f.key === "p1");
    expect(onP1).toHaveLength(3);
    expect(new Set(onP1.map((f) => f.index)).size).toBe(3);
    // The phone's name stays on the face it named, wherever this PC numbered it.
    expect(named(r)).toEqual([["Ana", ["p1"]]]);
  });

  it("takes the vector a device made over another's mark that it could not read the photo", () => {
    const r = replica();
    r.setCopies([], [{ deviceId: PHONE, deviceLabel: "Pixel", createdAt: 1000, modelId: "clip", dim: 512, vectors: new Map([["p1", new Uint16Array(512).fill(1)]]) }]);
    r.addScan("p1", [], null, 5000, true);
    expect(r.searchVectors().get("p1")).not.toBeNull();
  });
});
