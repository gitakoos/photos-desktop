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
  COLOR_BYTES,
  MATCH_THRESHOLD,
  MAX_COLOR_DISTANCE,
  clusterSimilar,
  clusterSimilarAsync,
  colorDistance,
  distance,
  fingerprintFromPixels,
  isUsable,
  matches,
  type Fingerprint,
} from "./pdq.ts";

const W = 128;
const H = 128;

function build(px: (x: number, y: number) => [number, number, number]): Uint8Array {
  const out = new Uint8Array(W * H * 3);
  let i = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [r, g, b] = px(x, y);
      out[i++] = r;
      out[i++] = g;
      out[i++] = b;
    }
  return out;
}
const grey = (v: number): [number, number, number] => [v, v, v];
/** A ramp for structure plus a checkerboard for edges, kept mid-range so a shift never clips. */
const textured = (tint: (v: number) => [number, number, number]) =>
  build((x, y) => {
    const ramp = Math.trunc((x * 80) / W) + Math.trunc((y * 40) / H);
    const checker = (Math.trunc(x / 12) + Math.trunc(y / 12)) % 2 === 0 ? 40 : 0;
    return tint(Math.min(255, 15 + ramp + checker));
  });
const fp = (px: Uint8Array) => fingerprintFromPixels(px, W, H, 3);

describe("the duplicate fingerprint", () => {
  it("is the same for the same picture", () => {
    const a = fp(textured(grey));
    const b = fp(textured(grey));
    expect(distance(a.bits, b.bits)).toBe(0);
    expect(colorDistance(a.color, b.color)).toBe(0);
    expect(matches(a, b)).toBe(true);
  });

  it("barely moves when the whole picture is brighter", () => {
    const a = fp(textured(grey));
    const b = fp(textured((v) => grey(Math.min(255, v + 30))));
    expect(distance(a.bits, b.bits)).toBeLessThanOrEqual(4);
  });

  it("leaves out a near-flat frame and keeps a detailed one", () => {
    for (const v of [0, 128, 255]) expect(isUsable(fp(build(() => grey(v))))).toBe(false);
    expect(isUsable(fp(textured(grey)))).toBe(true);
  });

  it("tells two different layouts apart", () => {
    const a = fp(build((x) => grey(x < W / 2 ? 40 : 210)));
    const b = fp(build((_, y) => grey(y < H / 2 ? 40 : 210)));
    expect(distance(a.bits, b.bits)).toBeGreaterThan(MATCH_THRESHOLD);
    expect(matches(a, b)).toBe(false);
  });

  it("tells one layout in two colours apart", () => {
    const red = fp(textured((v) => [v, 0, 0]));
    const blue = fp(textured((v) => [0, 0, v]));
    expect(colorDistance(red.color, blue.color)).toBeGreaterThan(MAX_COLOR_DISTANCE);
    expect(matches(red, blue)).toBe(false);
  });

  it("reads the pixels of a picture with a fourth channel the same", () => {
    const rgb = textured(grey);
    const rgba = new Uint8Array(W * H * 4);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) rgba.set([rgb[i], rgb[i + 1], rgb[i + 2], 255], j);
    expect(distance(fp(rgb).bits, fingerprintFromPixels(rgba, W, H, 4).bits)).toBe(0);
  });
});

const sameColor = new Uint8Array(COLOR_BYTES).fill(100);
const print = (bits: Uint32Array, color = sameColor): Fingerprint => ({ bits, quality: 80, color });
function flip(base: Uint32Array, from: number, count: number): Uint32Array {
  const out = Uint32Array.from(base);
  for (let k = 0; k < count; k++) {
    const i = (from + k) % 256;
    out[i >>> 5] ^= 1 << (i & 31);
  }
  return out;
}
/** The smallest index of each cluster, so two partitions compare whatever roots they picked. */
function canonical(roots: Int32Array): number[] {
  const min = new Map<number, number>();
  roots.forEach((r, i) => min.set(r, Math.min(min.get(r) ?? i, i)));
  return [...roots].map((r) => min.get(r)!);
}
function bruteForce(fps: Fingerprint[]): Int32Array {
  const parent = Int32Array.from(fps.keys());
  const find = (x: number): number => (parent[x] === x ? x : find(parent[x]));
  for (let i = 0; i < fps.length; i++)
    for (let j = i + 1; j < fps.length; j++) if (matches(fps[i], fps[j])) parent[find(i)] = find(j);
  return parent.map((_, i) => find(i));
}
/** A seeded generator, so a failure repeats. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

describe("grouping the fingerprints", () => {
  it("puts identical ones together and far ones apart", () => {
    const a = new Uint32Array(8);
    const roots = clusterSimilar([print(a), print(Uint32Array.from(a)), print(flip(a, 10, 90))]);
    expect(roots[0]).toBe(roots[1]);
    expect(roots[2]).not.toBe(roots[0]);
  });

  it("joins a chain of near-duplicates into one group", () => {
    const a = new Uint32Array(8);
    const b = flip(a, 0, 40);
    const c = flip(b, 40, 40);
    expect(distance(a, c)).toBeGreaterThan(MATCH_THRESHOLD);
    const roots = clusterSimilar([print(a), print(b), print(c)]);
    expect(new Set(roots).size).toBe(1);
  });

  it("keeps one layout in two colours apart", () => {
    const red = new Uint8Array(COLOR_BYTES).map((_, i) => (i % 3 === 0 ? 255 : 0));
    const blue = new Uint8Array(COLOR_BYTES).map((_, i) => (i % 3 === 2 ? 255 : 0));
    const bits = flip(new Uint32Array(8), 5, 3);
    const roots = clusterSimilar([print(bits, red), print(Uint32Array.from(bits), blue)]);
    expect(roots[0]).not.toBe(roots[1]);
  });

  it("groups exactly as comparing every pair would, within the exact range", () => {
    const next = rng(20260913);
    const palettes = [new Uint8Array(COLOR_BYTES).fill(30), new Uint8Array(COLOR_BYTES).fill(200), sameColor];
    const fps: Fingerprint[] = [];
    for (let i = 0; i < 40; i++) fps.push(print(Uint32Array.from({ length: 8 }, next), palettes[next() % 3]));
    for (let i = 0; i < 12; i++) {
      const base = fps[next() % 40];
      fps.push(print(flip(base.bits, next() % 256, next() % 32), palettes[next() % 3]));
    }
    expect(canonical(clusterSimilar(fps))).toEqual(canonical(bruteForce(fps)));
  });

  it("groups the same when made a slice at a time", async () => {
    const next = rng(4242);
    const fps: Fingerprint[] = [];
    for (let i = 0; i < 2700; i++) fps.push(print(Uint32Array.from({ length: 8 }, next)));
    for (let i = 0; i < 300; i++) fps.push(print(flip(fps[next() % 2700].bits, next() % 256, next() % 40)));
    let pauses = 0;
    const sliced = await clusterSimilarAsync(fps, async () => void pauses++);
    expect(pauses).toBeGreaterThan(0);
    expect(canonical(sliced)).toEqual(canonical(clusterSimilar(fps)));
  });
});
