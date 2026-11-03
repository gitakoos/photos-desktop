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
import { readFacesSnapshot, readSearchSnapshot } from "./driveData.ts";
import {
  floatToHalf,
  parseFacesSnapshot,
  parseSearchSnapshot,
  withoutSaveTime,
  writeFacesSnapshot,
  writeSearchSnapshot,
  type FacesSnap,
} from "./mlSnapshot.ts";

function emb(seed: number, dim = 4): Float32Array {
  return Float32Array.from({ length: dim }, (_, i) => Math.fround(Math.sin(seed + i)));
}

function snap(): FacesSnap {
  return {
    deviceId: "11111111-2222-3333-4444-555555555555",
    deviceLabel: "Windows PC",
    createdAt: 1_700_000_000_000,
    modelVersion: 7,
    modelSha256: "abc",
    clusterParams: 1,
    dim: 4,
    faces: [
      { key: "linkA", index: 0, box: [0.1, 0.2, 0.3, 0.4], score: 0.9, blur: 30, rejected: false, person: "Ana", confirmed: "Ana", points: Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10), embedding: emb(1) },
      { key: "linkB", index: 1, box: [0.5, 0.5, 0.6, 0.7], score: 0.7, blur: null, rejected: true, person: null, confirmed: null, points: new Float32Array(0), embedding: emb(2) },
      { key: "content://phone/1", index: 0, box: [0, 0, 1, 1], score: 0.8, blur: null, rejected: false, person: "Ana", confirmed: null, points: new Float32Array(0), embedding: emb(3) },
    ],
    manual: [{ name: "Bruno", key: "linkC" }],
    notPerson: [{ name: "Ana", key: "linkB", index: 1 }],
    covers: [{ name: "Ana", key: "linkA" }],
    markers: [{ key: "linkA", hiRes: true }, { key: "linkB", hiRes: false }],
  };
}

describe("face snapshot", () => {
  it("round-trips every record, leaving out keys that name one phone's files", () => {
    const back = parseFacesSnapshot(writeFacesSnapshot(snap()));
    expect(back.deviceId).toBe(snap().deviceId);
    expect(back.createdAt).toBe(snap().createdAt);
    expect(back.faces).toHaveLength(2);
    expect(back.faces[0]).toMatchObject({ key: "linkA", index: 0, person: "Ana", confirmed: "Ana", rejected: false, blur: 30 });
    expect([...back.faces[0].points]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect([...back.faces[0].embedding]).toEqual([...emb(1)]);
    expect(back.faces[1]).toMatchObject({ rejected: true, blur: null, person: null });
    expect(back.manual).toEqual([{ name: "Bruno", key: "linkC" }]);
    expect(back.notPerson).toEqual([{ name: "Ana", key: "linkB", index: 1 }]);
    expect(back.covers).toEqual([{ name: "Ana", key: "linkA" }]);
    expect(back.markers).toEqual([{ key: "linkA", hiRes: true }, { key: "linkB", hiRes: false }]);
  });

  it("is read by the people view's own reader as the phone's would be", () => {
    const people = readFacesSnapshot(writeFacesSnapshot(snap())).people;
    expect(people.map((p) => [p.name, [...p.keys]])).toEqual([
      ["Ana", ["linkA"]],
      ["Bruno", ["linkC"]],
    ]);
  });
});

describe("search snapshot", () => {
  it("round-trips vectors at half precision and tombstones as a flag", () => {
    const vectors = new Map<string, Uint16Array | null>([
      ["k1", Uint16Array.of(floatToHalf(0.5), floatToHalf(-0.25), 0, floatToHalf(1))],
      ["k2", null],
    ]);
    const bytes = writeSearchSnapshot({ deviceId: "d", deviceLabel: "PC", createdAt: 5, modelId: "m", dim: 4, vectors });
    const back = parseSearchSnapshot(bytes);
    expect([...back.vectors.keys()]).toEqual(["k1", "k2"]);
    expect([...back.vectors.get("k1")!]).toEqual([...vectors.get("k1")!]);
    expect(back.vectors.get("k2")).toBeNull();
    // The existing reader skips the tombstone and keeps the vector.
    expect(readSearchSnapshot(bytes).keys).toEqual(["k1"]);
  });

  it("rounds to half the phone's way, ties to even", () => {
    expect(floatToHalf(1)).toBe(0x3c00);
    expect(floatToHalf(-2)).toBe(0xc000);
    expect(floatToHalf(65504)).toBe(0x7bff);
    expect(floatToHalf(1e6)).toBe(0x7c00);
    expect(floatToHalf(0)).toBe(0);
    // 1 + 2^-11 is exactly halfway between two halves: it rounds to the even one.
    expect(floatToHalf(1 + 2 ** -11)).toBe(0x3c00);
  });
});

describe("telling two saves of one index apart", () => {
  it("reads the same with the save time blanked, and differently once anything else changes", () => {
    const a = writeFacesSnapshot({ ...snap(), createdAt: 1 });
    const b = writeFacesSnapshot({ ...snap(), createdAt: 999_999 });
    expect(a.equals(b)).toBe(false);
    expect(withoutSaveTime(a).equals(withoutSaveTime(b))).toBe(true);
    const c = writeFacesSnapshot({ ...snap(), createdAt: 1, covers: [] });
    expect(withoutSaveTime(a).equals(withoutSaveTime(c))).toBe(false);
    // The original is left as it was.
    expect(parseFacesSnapshot(a).createdAt).toBe(1);
  });
});
