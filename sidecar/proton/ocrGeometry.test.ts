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
  LIMIT_SIDE_MAX,
  LIMIT_SIDE_MIN,
  STRIDE,
  boundsOf,
  clipToBounds,
  connectedComponents,
  convexHull,
  detectQuads,
  detectionLimitSide,
  detectorInputSize,
  hullCandidates,
  minimumAreaRectangle,
  onSameRow,
  orderClockwise,
  polygonContainsPoint,
  regionScore,
  shortestSide,
  signedArea,
  sortReadingOrder,
  unclip,
  uprightQuad,
  type Point,
  type ProbabilityMap,
} from "./ocrGeometry.ts";

const P = (x: number, y: number): Point => ({ x, y });
const area = (points: Point[]) => Math.abs(signedArea(points));
function mapOf(width: number, height: number, value: (x: number, y: number) => number): ProbabilityMap {
  const values = new Float32Array(width * height);
  for (let i = 0; i < values.length; i++) values[i] = value(i % width, Math.floor(i / width));
  return { width, height, values };
}
const blockMap = () => mapOf(40, 20, (x, y) => (x >= 5 && x <= 14 && y >= 5 && y <= 9 ? 1 : 0));
/** A blob that half fills the rectangle around it, whose own outline scores one. */
const wedgeMap = () => mapOf(50, 50, (x, y) => (x >= 10 && y >= 10 && x - 10 + (y - 10) <= 19 ? 1 : 0));

describe("the detector's input grid", () => {
  it("rounds to whole strides, never below one, and keeps the frame's proportions", () => {
    expect(detectorInputSize(100, 50)).toEqual([128, 64]);
    expect(detectorInputSize(10, 4)).toEqual([STRIDE, STRIDE]);
    expect(detectorInputSize(4000, 3000)).toEqual([LIMIT_SIDE_MIN, 736]);
    expect(detectorInputSize(1920, 1080)).toEqual([960, 544]);
    expect(detectorInputSize(4000, 3000, 1600)).toEqual([1600, 1216]);
  });

  it("reads a large photo past the old limit, a small one at its own size, and stops at the ceiling", () => {
    expect(detectionLimitSide(4032, 3024)).toBe(LIMIT_SIDE_MAX);
    expect(detectionLimitSide(1200, 900)).toBe(1200);
    expect(detectorInputSize(600, 400, detectionLimitSide(600, 400))).toEqual([608, 416]);
  });
});

describe("the outline geometry", () => {
  it("drops interior and collinear points from a hull", () => {
    const filled: Point[] = [];
    for (let x = 0; x <= 4; x++) for (let y = 0; y <= 3; y++) filled.push(P(x, y));
    const hull = convexHull(filled);
    expect(hull).toHaveLength(4);
    expect(boundsOf(hull)).toEqual({ left: 0, top: 0, right: 4, bottom: 3 });
  });

  it("fits the turned rectangle around a diamond, and keeps an upright block", () => {
    expect(area(minimumAreaRectangle([P(10, 0), P(20, 10), P(10, 20), P(0, 10)]))).toBeCloseTo(200, 0);
    expect(area(minimumAreaRectangle([P(5, 5), P(15, 5), P(15, 9), P(5, 9)]))).toBeCloseTo(40, 0);
  });

  it("orders corners clockwise from the top left", () => {
    expect(orderClockwise([P(20, 10), P(10, 20), P(0, 10), P(10, 0)])).toEqual([P(10, 0), P(20, 10), P(10, 20), P(0, 10)]);
  });

  it("finds a point inside a polygon whichever way round, edges included", () => {
    const square = [P(0, 0), P(10, 0), P(10, 10), P(0, 10)];
    expect(polygonContainsPoint(square, 5, 5)).toBe(true);
    expect(polygonContainsPoint([...square].reverse(), 5, 5)).toBe(true);
    expect(polygonContainsPoint(square, 10.5, 5)).toBe(false);
    expect(polygonContainsPoint(square, 0, 5)).toBe(true);
  });

  it("grows a region outwards on every side", () => {
    const rect = [P(5, 5), P(15, 5), P(15, 9), P(5, 9)];
    const grown = unclip(rect, 1.5);
    const b = boundsOf(grown);
    expect(grown).toHaveLength(4);
    expect(b.left < 5 && b.top < 5 && b.right > 15 && b.bottom > 9).toBe(true);
    expect(area(grown)).toBeGreaterThan(area(rect));
  });

  it("holds a region inside its grid and measures its thinnest side", () => {
    const clipped = clipToBounds([P(-4, -2), P(60, -2), P(60, 40), P(-4, 40)], 40, 20);
    expect(boundsOf(clipped)).toEqual({ left: 0, top: 0, right: 39, bottom: 19 });
    expect(shortestSide([P(0, 0), P(10, 0), P(10, 4), P(0, 4)])).toBeCloseTo(4);
  });

  it("scores a region by the mean probability over its own cells", () => {
    const map = mapOf(6, 4, (x) => (x < 3 ? 1 : 0));
    expect(regionScore(map, [P(0, 0), P(3, 0), P(3, 4), P(0, 4)])).toBeCloseTo(1);
    expect(regionScore(map, [P(0, 0), P(6, 0), P(6, 4), P(0, 4)])).toBeCloseTo(0.5);
  });

  it("scores a blob over its outline, not the rectangle around it, and keeps it", () => {
    const map = wedgeMap();
    const blob = connectedComponents(map).sort((a, b) => b.length - a.length)[0];
    const hull = convexHull(hullCandidates(blob, map.width));
    expect(regionScore(map, hull)).toBeCloseTo(1);
    expect(regionScore(map, minimumAreaRectangle(hull, true))).toBeLessThan(0.6);
    const found = detectQuads(map, 50, 50);
    expect(found).toHaveLength(1);
    expect(found[0].score).toBeCloseTo(1);
  });

  it("builds the outline from the ends of each row and loses nothing", () => {
    const map = wedgeMap();
    const blob = connectedComponents(map).sort((a, b) => b.length - a.length)[0];
    const everyCell = [...blob].map((i) => P(i % map.width, Math.floor(i / map.width)));
    expect(convexHull(hullCandidates(blob, map.width))).toEqual(convexHull(everyCell));
    expect(hullCandidates(blob, map.width).length).toBeLessThan(blob.length / 4);
    expect(hullCandidates(Int32Array.of(2 * 10 + 3), 10)).toEqual([P(3, 2)]);
  });
});

describe("the whole detection chain", () => {
  it("turns one solid block into one region, in image pixels, covering the block", () => {
    const onGrid = detectQuads(blockMap(), 40, 20);
    expect(onGrid).toHaveLength(1);
    expect(onGrid[0].score).toBeCloseTo(1);
    const g = boundsOf(onGrid[0].quad);
    const p = boundsOf(detectQuads(blockMap(), 400, 200)[0].quad);
    expect(p.left).toBeCloseTo(g.left * 10, 1);
    expect(p.bottom).toBeCloseTo(g.bottom * 10, 1);
    expect(g.left < 5 && g.top < 5 && g.right > 14 && g.bottom > 9 && g.left >= 0 && g.top >= 0).toBe(true);
  });

  it("leaves out a weak region and finds nothing in an empty grid", () => {
    expect(detectQuads(mapOf(40, 20, (x, y) => (x >= 5 && x <= 14 && y >= 5 && y <= 9 ? 0.4 : 0)), 40, 20)).toEqual([]);
    expect(detectQuads(mapOf(20, 10, () => 0), 200, 100)).toEqual([]);
  });

  it("puts regions in reading order, a line's runs left to right", () => {
    const map = mapOf(60, 40, (x, y) => {
      const lowerLeft = x >= 4 && x <= 16 && y >= 24 && y <= 30;
      const upperRight = x >= 30 && x <= 46 && y >= 4 && y <= 10;
      const upperLeft = x >= 4 && x <= 16 && y >= 4 && y <= 10;
      return lowerLeft || upperRight || upperLeft ? 1 : 0;
    });
    const found = detectQuads(map, 60, 40).map((f) => boundsOf(f.quad));
    expect(found).toHaveLength(3);
    expect(found[0].top).toBeLessThan(found[2].top);
    expect(found[0].left).toBeLessThan(found[1].left);
    expect(Math.abs(found[0].top - found[1].top)).toBeLessThanOrEqual(1);
  });

  it("keeps two runs of one line of a large photo on one line", () => {
    const left = uprightQuad(100, 1000, 900, 1080);
    const right = uprightQuad(1000, 1030, 1800, 1110);
    expect(onSameRow(left, right)).toBe(true);
    expect(onSameRow(left, uprightQuad(100, 1120, 900, 1200))).toBe(false);
    const ordered = sortReadingOrder([
      { quad: right, score: 0.9 },
      { quad: left, score: 0.9 },
      { quad: uprightQuad(100, 1300, 900, 1380), score: 0.9 },
    ]).map((d) => boundsOf(d.quad));
    expect(ordered.map((b) => b.left)).toEqual([100, 1000, 100]);
  });

  it("joins cells that meet at a corner, keeps apart ones with a gap, and needs the threshold", () => {
    expect(connectedComponents(mapOf(6, 6, (x, y) => ((x === 1 && y === 1) || (x === 2 && y === 2) ? 1 : 0)))).toHaveLength(1);
    expect(connectedComponents(mapOf(6, 6, (x, y) => ((x === 0 && y === 0) || (x === 4 && y === 4) ? 1 : 0)))).toHaveLength(2);
    const edge = connectedComponents(mapOf(4, 4, (x) => (x === 0 ? 0.31 : 0.29)));
    expect(edge).toHaveLength(1);
    expect(edge[0]).toHaveLength(4);
  });
});
