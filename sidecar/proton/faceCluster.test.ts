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
import { direction, faceOf, seeded } from "./testFaces.ts";
import {
  assignIncremental,
  attractToNamedClusters,
  clusterFaces,
  dot,
  meanDirection,
  resolveClusterNames,
  splitOutUnclaimedNames,
  suggestPersonMatches,
  type FaceSample,
} from "./faceCluster.ts";

const sample = (embedding: Float32Array, score = 0.9, confident = true, confirmed = false): FaceSample => ({
  embedding,
  score,
  confident,
  confirmed,
});

describe("grouping faces", () => {
  it("keeps two people apart and every face of one together", async () => {
    const rand = seeded(1);
    const a = direction(rand);
    const b = direction(rand);
    const samples = [
      ...Array.from({ length: 6 }, () => sample(faceOf(a, rand))),
      ...Array.from({ length: 5 }, () => sample(faceOf(b, rand))),
    ];
    const groups = await clusterFaces(samples);
    expect(new Set(groups.slice(0, 6)).size).toBe(1);
    expect(new Set(groups.slice(6)).size).toBe(1);
    expect(groups[0]).not.toBe(groups[6]);
  });

  it("does not let a weak face that matches nothing open a group", async () => {
    const rand = seeded(2);
    const groups = await clusterFaces([sample(direction(rand), 0.9, true), sample(direction(rand), 0.65, false)]);
    expect(groups[0]).toBe(0);
    expect(groups[1]).toBe(-1);
  });

  it("holds a weak face to a stricter distance", async () => {
    const rand = seeded(3);
    const a = direction(rand);
    // Built to sit between the normal bar (0.58) and the strict one (0.66).
    let weak = faceOf(a, rand, 1.2);
    while (dot(weak, a) < 0.6 || dot(weak, a) > 0.64) weak = faceOf(a, rand, 1.2);
    const groups = await clusterFaces([sample(a, 0.95), sample(weak, 0.7, false)]);
    expect(groups[1]).toBe(-1);
    const confident = await clusterFaces([sample(a, 0.95), sample(weak, 0.7, true)]);
    expect(confident[1]).toBe(confident[0]);
  });

  it("can be stopped part way", async () => {
    const rand = seeded(4);
    const samples = Array.from({ length: 300 }, () => sample(direction(rand)));
    let calls = 0;
    await expect(
      clusterFaces(samples, undefined, undefined, () => {
        if (++calls > 2) throw new Error("stop");
      }),
    ).rejects.toThrow("stop");
  });
});

describe("placing new faces", () => {
  it("joins the closest person, or none", () => {
    const rand = seeded(5);
    const a = direction(rand);
    const b = direction(rand);
    const placed = assignIncremental(
      [sample(faceOf(a, rand)), sample(faceOf(b, rand)), sample(direction(rand))],
      [a, b],
    );
    expect(Array.from(placed)).toEqual([0, 1, -1]);
  });
});

describe("names across a regroup", () => {
  it("follow the group that holds most of the person's faces", () => {
    const names = resolveClusterNames(
      ["p1", "p1", "p1", null],
      [null, null, null, "Anna"],
      Int32Array.from([0, 0, 0, 1]),
      new Map([["p1", "Anna"]]),
    );
    expect(names.get(0)).toBe("Anna");
    expect(names.has(1)).toBe(false);
  });

  it("give a confirmed name that won nothing a group of its own", () => {
    const { assignment, names } = splitOutUnclaimedNames(
      [null, "Bela", null],
      Int32Array.from([0, 0, 0]),
      new Map([[0, "Anna"]]),
    );
    expect(assignment[1]).toBe(1);
    expect(names.get(1)).toBe("Bela");
    expect(assignment[0]).toBe(0);
  });

  it("pull split faces into a named person, never into one they are not", () => {
    const rand = seeded(6);
    const a = direction(rand);
    const faces = [faceOf(a, rand), faceOf(a, rand), faceOf(a, rand)];
    const out = attractToNamedClusters(
      faces,
      [0.9, 0.8, 0.8],
      Int32Array.from([0, 1, 2]),
      new Map([[0, "Anna"]]),
      [null, null, null],
      0.58,
      [undefined, undefined, new Set(["Anna"])],
    );
    expect(Array.from(out)).toEqual([0, 0, 2]);
  });
});

describe("suggestions", () => {
  it("offer an unnamed group to the closest named person", () => {
    const rand = seeded(7);
    const a = direction(rand);
    const b = direction(rand);
    const out = suggestPersonMatches(
      [
        ["anna", meanDirection([faceOf(a, rand), faceOf(a, rand)])],
        ["bela", meanDirection([faceOf(b, rand)])],
      ],
      [["u1", meanDirection([faceOf(a, rand)])], ["u2", direction(rand)]],
    );
    expect(out.map((s) => [s.named, s.unnamed])).toEqual([["anna", "u1"]]);
  });
});
