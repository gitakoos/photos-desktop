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

/*
 * The DB post-processing and the geometry helpers below are derived from mobile_ocr, which is MIT
 * licensed:
 *
 *   Copyright (c) 2025 Laurens Priem
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, subject to the conditions of the MIT License.
 */

// Where the words are: the text detector's probability grid turned into outlines in the
// photo's own pixels, as the phone does it.

export type Point = { x: number; y: number };

/** Four corners around one run of text, following its reading direction: top left, top right, bottom right, bottom left. */
export type Quad = [Point, Point, Point, Point];

export type Bounds = { left: number; top: number; right: number; bottom: number };

/** The detector's answer: per cell of its input grid, how strongly it is part of a word. */
export type ProbabilityMap = { width: number; height: number; values: Float32Array };

export type DetectedQuad = { quad: Quad; score: number };

/** Probability above which a cell counts as part of a word. */
const BINARY_THRESHOLD = 0.3;
/** Mean probability a region has to reach to be reported at all. */
const BOX_THRESHOLD = 0.6;
/** How far a region is grown back out to cover the strokes the threshold ate. */
const UNCLIP_RATIO = 1.8;
/** Shortest side, in grid cells, a grown region has to keep. */
const MIN_SIDE = 3;
/** Ceiling on how many regions are examined, largest first. */
const MAX_COMPONENTS = 1000;
/** How far two runs' tops may sit apart and still be one line, as a share of the shorter run's height. */
const SAME_ROW_SLACK_RATIO = 0.5;
const EPSILON = 1e-6;

/** The network's own downsampling factor; its input is a whole number of these. */
export const STRIDE = 32;
/** Smallest longest side the detector works at. */
export const LIMIT_SIDE_MIN = 960;
/** Largest longest side the detector works at: past it the wait outgrows what it finds. */
export const LIMIT_SIDE_MAX = 2048;

export function boundsOf(points: readonly Point[]): Bounds {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const p of points) {
    left = Math.min(left, p.x);
    top = Math.min(top, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
  }
  return { left, top, right, bottom };
}

export function uprightQuad(left: number, top: number, right: number, bottom: number): Quad {
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

/**
 * The longest side a frame is brought to before the detector looks at it. A frame smaller than
 * the ceiling keeps its own size, since nothing is gained by enlarging it; one larger is brought
 * down to the ceiling, which carries the small print a 960 pixel read never sees.
 */
export function detectionLimitSide(width: number, height: number): number {
  const longest = Math.max(width, height);
  if (longest <= 0) return LIMIT_SIDE_MIN;
  return Math.min(Math.max(longest, LIMIT_SIDE_MIN), LIMIT_SIDE_MAX);
}

/** The detector's input size: within `limitSide`, a whole number of strides, never below one. */
export function detectorInputSize(width: number, height: number, limitSide = LIMIT_SIDE_MIN): [number, number] {
  const longest = Math.max(width, height);
  const ratio = longest > limitSide ? limitSide / longest : 1;
  const w = Math.max(1, Math.round(width * ratio));
  const h = Math.max(1, Math.round(height * ratio));
  return [roundUpToStride(w), roundUpToStride(h)];
}

function roundUpToStride(value: number): number {
  return Math.max(Math.floor((value + STRIDE - 1) / STRIDE) * STRIDE, STRIDE);
}

/**
 * The map's regions as outlines in the pixels of an `imageWidth` by `imageHeight` frame: threshold
 * the map, take each connected blob, score its own outline against the map, wrap the survivors in
 * their smallest rotated rectangle, grow that back out, and only then scale to the frame, so every
 * bar above is in grid cells and a large photo is judged like a small one. Reading order.
 */
export function detectQuads(map: ProbabilityMap, imageWidth: number, imageHeight: number): DetectedQuad[] {
  if (map.width <= 0 || map.height <= 0 || imageWidth <= 0 || imageHeight <= 0) return [];
  const components = connectedComponents(map)
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_COMPONENTS);
  const scaleX = imageWidth / map.width;
  const scaleY = imageHeight / map.height;
  const found: DetectedQuad[] = [];
  for (const component of components) {
    if (component.length < 4) continue;
    const hull = convexHull(hullCandidates(component, map.width));
    if (hull.length < 3) continue;
    const score = regionScore(map, hull);
    if (score < BOX_THRESHOLD) continue;
    const rect = minimumAreaRectangle(hull, true);
    if (rect.length === 0) continue;
    const grown = unclip(rect, UNCLIP_RATIO);
    if (grown.length === 0) continue;
    const grownRect = minimumAreaRectangle(grown, false);
    if (grownRect.length === 0) continue;
    if (shortestSide(grownRect) < MIN_SIDE) continue;
    const clipped = clipToBounds(grownRect, map.width, map.height);
    const scaled = clipped.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY }));
    found.push({ quad: quadOf(orderClockwise(scaled)), score });
  }
  return sortReadingOrder(found);
}

/** Top to bottom, and left to right within a line. */
export function sortReadingOrder(quads: DetectedQuad[]): DetectedQuad[] {
  if (quads.length < 2) return quads;
  const byTop = [...quads].sort((a, b) => boundsOf(a.quad).top - boundsOf(b.quad).top);
  const ordered: DetectedQuad[] = [];
  let index = 0;
  while (index < byTop.length) {
    const first = byTop[index].quad;
    let end = index + 1;
    while (end < byTop.length && onSameRow(first, byTop[end].quad)) end++;
    ordered.push(...byTop.slice(index, end).sort((a, b) => boundsOf(a.quad).left - boundsOf(b.quad).left));
    index = end;
  }
  return ordered;
}

/** Whether `other` sits on `first`'s line: their tops within half the shorter run's height. */
export function onSameRow(first: Quad, other: Quad): boolean {
  const a = boundsOf(first);
  const b = boundsOf(other);
  const shorter = Math.min(a.bottom - a.top, b.bottom - b.top);
  return Math.abs(b.top - a.top) <= Math.max(shorter, 1) * SAME_ROW_SLACK_RATIO;
}

function quadOf(corners: Point[]): Quad {
  if (corners.length === 4) return [corners[0], corners[1], corners[2], corners[3]];
  const b = boundsOf(corners);
  return uprightQuad(b.left, b.top, b.right, b.bottom);
}

/**
 * The only cells of a blob that can carry its outline: the leftmost and rightmost of every row.
 * Lossless, since any cell between them is inside the hull already, and it turns the hull's input
 * from the blob's area into twice its height.
 */
export function hullCandidates(component: Int32Array, width: number): Point[] {
  if (component.length === 0 || width <= 0) return [];
  let minRow = Infinity;
  let maxRow = -Infinity;
  for (const index of component) {
    const row = Math.floor(index / width);
    if (row < minRow) minRow = row;
    if (row > maxRow) maxRow = row;
  }
  const rows = maxRow - minRow + 1;
  const leftmost = new Int32Array(rows).fill(0x7fffffff);
  const rightmost = new Int32Array(rows).fill(-1);
  for (const index of component) {
    const row = Math.floor(index / width) - minRow;
    const column = index % width;
    if (column < leftmost[row]) leftmost[row] = column;
    if (column > rightmost[row]) rightmost[row] = column;
  }
  const points: Point[] = [];
  for (let row = 0; row < rows; row++) {
    if (rightmost[row] < leftmost[row]) continue;
    const y = row + minRow;
    points.push({ x: leftmost[row], y });
    if (rightmost[row] !== leftmost[row]) points.push({ x: rightmost[row], y });
  }
  return points;
}

/** Every 8-connected blob of above-threshold cells, as the flat indices of its cells. */
export function connectedComponents(map: ProbabilityMap): Int32Array[] {
  const { width, height, values } = map;
  const visited = new Uint8Array(width * height);
  const components: Int32Array[] = [];
  let stack = new Int32Array(256);
  let blob = new Int32Array(256);
  for (let start = 0; start < width * height; start++) {
    if (visited[start] || values[start] <= BINARY_THRESHOLD) continue;
    let top = 0;
    let count = 0;
    stack[top++] = start;
    visited[start] = 1;
    while (top > 0) {
      const index = stack[--top];
      if (count === blob.length) {
        const grown = new Int32Array(blob.length * 2);
        grown.set(blob);
        blob = grown;
      }
      blob[count++] = index;
      const cx = index % width;
      const cy = (index - cx) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          if (nx < 0 || nx >= width) continue;
          const neighbour = ny * width + nx;
          if (visited[neighbour] || values[neighbour] <= BINARY_THRESHOLD) continue;
          visited[neighbour] = 1;
          if (top === stack.length) {
            const grown = new Int32Array(stack.length * 2);
            grown.set(stack);
            stack = grown;
          }
          stack[top++] = neighbour;
        }
      }
    }
    components.push(blob.slice(0, count));
  }
  return components;
}

/** Mean probability over the cells a convex polygon covers, edges counted as inside. */
export function regionScore(map: ProbabilityMap, polygon: Point[]): number {
  if (polygon.length < 3) return 0;
  const clamp = (v: number, hi: number) => Math.min(Math.max(v, 0), hi);
  const b = boundsOf(polygon);
  const minX = clamp(Math.floor(b.left), map.width - 1);
  const maxX = clamp(Math.ceil(b.right), map.width - 1);
  const minY = clamp(Math.floor(b.top), map.height - 1);
  const maxY = clamp(Math.ceil(b.bottom), map.height - 1);
  if (maxX < minX || maxY < minY) return 0;
  const edges = polygon.length;
  const ox = new Float64Array(edges);
  const oy = new Float64Array(edges);
  const ax = new Float64Array(edges);
  const ay = new Float64Array(edges);
  for (let i = 0; i < edges; i++) {
    const a = polygon[i];
    const c = polygon[i + 1 === edges ? 0 : i + 1];
    ox[i] = a.x;
    oy[i] = a.y;
    ax[i] = c.x - a.x;
    ay[i] = c.y - a.y;
  }
  let sum = 0;
  let count = 0;
  for (let y = minY; y <= maxY; y++) {
    const cellY = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const cellX = x + 0.5;
      let positive = false;
      let negative = false;
      let inside = true;
      for (let i = 0; i < edges; i++) {
        const cross = ax[i] * (cellY - oy[i]) - ay[i] * (cellX - ox[i]);
        if (cross > 0) positive = true;
        else if (cross < 0) negative = true;
        if (positive && negative) {
          inside = false;
          break;
        }
      }
      if (inside) {
        sum += map.values[y * map.width + x];
        count++;
      }
    }
  }
  return count > 0 ? sum / count : 0;
}

/** Whether (x, y) is inside a convex polygon, edges counted as inside. */
export function polygonContainsPoint(polygon: Point[], x: number, y: number): boolean {
  if (polygon.length < 3) return false;
  let positive = false;
  let negative = false;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (cross > 0) positive = true;
    else if (cross < 0) negative = true;
    if (positive && negative) return false;
  }
  return true;
}

/** Monotone-chain convex hull; collinear points are dropped. */
export function convexHull(points: Point[]): Point[] {
  if (points.length < 3) return points;
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const lower: Point[] = [];
  const upper: Point[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  if (lower.length === 0 || upper.length === 0) return [];
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** The smallest-area rectangle around the points, by rotating calipers over the hull. */
export function minimumAreaRectangle(points: Point[], alreadyConvex = false): Point[] {
  const hull = alreadyConvex ? points : convexHull(points);
  if (hull.length < 3) return [];
  let best: Point[] = [];
  let smallest = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const origin = hull[i];
    const along = normalize({ x: hull[(i + 1) % hull.length].x - origin.x, y: hull[(i + 1) % hull.length].y - origin.y });
    if (!along) continue;
    const across = { x: -along.y, y: along.x };
    let minAlong = Infinity;
    let maxAlong = -Infinity;
    let minAcross = Infinity;
    let maxAcross = -Infinity;
    for (const p of hull) {
      const dx = p.x - origin.x;
      const dy = p.y - origin.y;
      const projected = dx * along.x + dy * along.y;
      const offset = dx * across.x + dy * across.y;
      minAlong = Math.min(minAlong, projected);
      maxAlong = Math.max(maxAlong, projected);
      minAcross = Math.min(minAcross, offset);
      maxAcross = Math.max(maxAcross, offset);
    }
    const width = maxAlong - minAlong;
    const height = maxAcross - minAcross;
    const area = width * height;
    if (area < smallest && width > 1e-3 && height > 1e-3) {
      smallest = area;
      const corner = (a: number, b: number) => ({
        x: origin.x + along.x * a + across.x * b,
        y: origin.y + along.y * a + across.y * b,
      });
      best = [corner(minAlong, minAcross), corner(maxAlong, minAcross), corner(maxAlong, maxAcross), corner(minAlong, maxAcross)];
    }
  }
  if (best.length) return best;
  const b = boundsOf(hull);
  return uprightQuad(b.left, b.top, b.right, b.bottom);
}

/** The polygon grown outwards by its area over its perimeter, times `ratio`. */
export function unclip(polygon: Point[], ratio: number): Point[] {
  if (polygon.length < 3) return [];
  const p = perimeter(polygon);
  if (p <= EPSILON) return [];
  const offset = (Math.abs(signedArea(polygon)) * ratio) / p;
  if (offset <= EPSILON) return polygon;
  const expanded = offsetPolygon(polygon, offset);
  return expanded.length >= 3 ? expanded : [];
}

function offsetPolygon(polygon: Point[], offset: number): Point[] {
  const count = polygon.length;
  const ccw = signedArea(polygon) > 0;
  const out: Point[] = [];
  for (let i = 0; i < count; i++) {
    const prev = polygon[(i - 1 + count) % count];
    const cur = polygon[i];
    const next = polygon[(i + 1) % count];
    const incoming = normalize({ x: cur.x - prev.x, y: cur.y - prev.y });
    const outgoing = normalize({ x: next.x - cur.x, y: next.y - cur.y });
    if (!incoming || !outgoing) continue;
    const nIn = ccw ? { x: incoming.y, y: -incoming.x } : { x: -incoming.y, y: incoming.x };
    const nOut = ccw ? { x: outgoing.y, y: -outgoing.x } : { x: -outgoing.y, y: outgoing.x };
    const sIn = { x: cur.x + nIn.x * offset, y: cur.y + nIn.y * offset };
    const sOut = { x: cur.x + nOut.x * offset, y: cur.y + nOut.y * offset };
    out.push(intersect(sIn, incoming, sOut, outgoing) ?? cur);
  }
  return out;
}

function intersect(p: Point, d: Point, q: Point, e: Point): Point | null {
  const denominator = d.x * e.y - d.y * e.x;
  if (Math.abs(denominator) < EPSILON) return null;
  const t = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / denominator;
  return { x: p.x + d.x * t, y: p.y + d.y * t };
}

/** The points held inside a `width` by `height` grid, edges included. */
export function clipToBounds(points: Point[], width: number, height: number): Point[] {
  return points.map((p) => ({ x: Math.min(Math.max(p.x, 0), width - 1), y: Math.min(Math.max(p.y, 0), height - 1) }));
}

/** Four corners clockwise from the one nearest the frame's origin. */
export function orderClockwise(points: Point[]): Point[] {
  if (points.length !== 4) return points;
  const cx = points.reduce((s, p) => s + p.x, 0) / 4;
  const cy = points.reduce((s, p) => s + p.y, 0) / 4;
  const byAngle = [...points].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let first = 0;
  let smallest = byAngle[0].x + byAngle[0].y;
  for (let i = 1; i < 4; i++) {
    const sum = byAngle[i].x + byAngle[i].y;
    if (sum < smallest) {
      smallest = sum;
      first = i;
    }
  }
  return [0, 1, 2, 3].map((k) => byAngle[(first + k) % 4]);
}

export function shortestSide(polygon: Point[]): number {
  if (polygon.length < 2) return 0;
  let shortest = Infinity;
  for (let i = 0; i < polygon.length; i++) shortest = Math.min(shortest, distance(polygon[i], polygon[(i + 1) % polygon.length]));
  return shortest === Infinity ? 0 : shortest;
}

export function signedArea(points: readonly Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y - points[j].x * points[i].y;
  }
  return area / 2;
}

function perimeter(points: Point[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i++) total += distance(points[i], points[(i + 1) % points.length]);
  return total;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function normalize(v: Point): Point | null {
  const length = Math.hypot(v.x, v.y);
  if (length < EPSILON) return null;
  return { x: v.x / length, y: v.y / length };
}
