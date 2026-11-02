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
import {
  attractToNamed,
  clusterFaces,
  isConfident,
  laplacianVariance,
  resolveClusterNames,
  sideways,
  splitOutUnclaimedNames,
  type FaceSample,
} from "./faceCluster.ts";

function unit(...parts: [number, number][]): Float32Array {
  const v = new Float32Array(512);
  for (const [i, x] of parts) v[i] = x;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

const sample = (embedding: Float32Array, extra: Partial<FaceSample> = {}): FaceSample => ({
  embedding, score: 0.9, confident: true, confirmed: false, ...extra,
});

describe("quality", () => {
  it("scores a flat crop as blurred and an edge as sharp", () => {
    expect(laplacianVariance(new Array(25).fill(100), 5, 5)).toBe(0);
    const edge = Array.from({ length: 25 }, (_, i) => (i % 5 < 2 ? 0 : 255));
    expect(laplacianVariance(edge, 5, 5)).toBeGreaterThan(1000);
  });

  it("reads a frontal face as straight and a profile as turned", () => {
    expect(sideways([30, 40, 70, 40, 50, 60, 35, 80, 65, 80])).toBeCloseTo(0);
    // The nose far toward one eye and one mouth corner: a face turned past the phone's gate.
    expect(sideways([30, 40, 48, 40, 60, 60, 35, 80, 50, 80])!).toBeGreaterThan(0.18);
  });

  it("keeps the phone's gates", () => {
    expect(isConfident(0.9, 40, 0.05)).toBe(true);
    expect(isConfident(0.6, 40, 0.05)).toBe(false);
    expect(isConfident(0.9, 5, 0.05)).toBe(false);
    expect(isConfident(0.9, null, 0.3)).toBe(false);
  });
});

describe("grouping", () => {
  it("groups one identity together and keeps another apart", () => {
    const a = clusterFaces([
      sample(unit([1, 1], [100, 0.2])),
      sample(unit([1, 1], [101, 0.2])),
      sample(unit([2, 1], [102, 0.2])),
    ]);
    expect(a[0]).toBe(a[1]);
    expect(a[2]).not.toBe(a[0]);
  });

  it("never lets a weak face open a group of its own", () => {
    const a = clusterFaces([sample(unit([1, 1])), sample(unit([5, 1]), { confident: false })]);
    expect(a[1]).toBe(-1);
  });

  it("names the group holding most of a person, and gives a lone confirmed name its own", () => {
    const assignment = Int32Array.of(0, 0, 1);
    const names = resolveClusterNames(["Ana", "Ana", null], [null, null, "Bia"], assignment);
    expect([...names]).toEqual([[0, "Ana"], [1, "Bia"]]);
    const split = splitOutUnclaimedNames([null, "Caio", null], Int32Array.of(0, 0, 1), new Map([[0, "Ana"]]));
    expect(split.names.get(split.assignment[1])).toBe("Caio");
  });

  it("pulls a split-off face into its named person, unless it was marked as not them", () => {
    const e = [unit([1, 1]), unit([1, 1], [100, 0.1]), unit([1, 1], [101, 0.1])];
    const names = new Map([[0, "Ana"]]);
    const pulled = attractToNamed(e, [0.9, 0.9, 0.9], Int32Array.of(0, 1, 2), names, ["Ana", null, null], [new Set(), new Set(), new Set(["Ana"])]);
    expect(pulled[1]).toBe(0);
    expect(pulled[2]).toBe(2);
  });
});
