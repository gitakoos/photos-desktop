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

// What a page of readings goes through between the models and the screen, as on the phone: the
// runs that only look tilted are laid flat, readings that landed on top of each other are fused
// into one run, and readings that are no text at all are left out.

import { signedArea, uprightQuad, type Point, type Quad } from "./ocrGeometry.ts";

export type TextBlock = { text: string; confidence: number; quad: Quad };

/** How far a fitted rectangle's two ends are pulled by the outline, as a share of the run's height. */
const FIT_WOBBLE = 0.6;
/** Ceiling on the tilt any run is laid flat from, in degrees. */
export const MAX_DESKEW_DEGREES = 10;
/** Share of the smaller quad the other has to cover to be one detection whatever their shapes. */
export const MERGE_OVERLAP_RATIO = 0.6;
/** Share of the shorter run's height two readings share across the line to be one run. */
export const SAME_LINE_BAND_RATIO = 0.6;
/** Share of the shorter run's length two readings share along the line to be one run. */
export const SAME_RUN_SPAN_RATIO = 0.5;
/** Confidence a reading needs before it is shown at all. */
export const MIN_READ_CONFIDENCE = 0.5;
/** Longest reading held to the short-text bar, in letters and digits. */
export const SHORT_TEXT_LENGTH = 2;
/** Confidence a one or two character reading needs instead. */
export const SHORT_TEXT_MIN_CONFIDENCE = 0.8;
const EPSILON = 1e-6;

export function cleanTextBlocks(blocks: TextBlock[]): TextBlock[] {
  return fusedRuns(blocks.map((b) => ({ ...b, quad: deskewed(b.quad) })));
}

/** The acute angle a quad's text sits at, in degrees from horizontal. */
export function quadTiltDegrees(quad: Quad): number {
  const [tl, tr, br, bl] = quad;
  const dx = tr.x - tl.x + (br.x - bl.x);
  const dy = tr.y - tl.y + (br.y - bl.y);
  if (Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON) return 0;
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI;
  const folded = ((degrees % 180) + 180) % 180;
  return folded > 90 ? 180 - folded : folded;
}

/** The tilt a run this many times as long as tall may carry before it counts as the photo's own. */
export function deskewAllowanceDegrees(lengthOverHeight: number): number {
  if (lengthOverHeight <= EPSILON) return MAX_DESKEW_DEGREES;
  return Math.min(MAX_DESKEW_DEGREES, (Math.atan(FIT_WOBBLE / lengthOverHeight) * 180) / Math.PI);
}

/** The quad laid flat about its centre when its tilt is within its own allowance, else as it was. */
export function deskewed(quad: Quad): Quad {
  const length = quadLength(quad);
  const height = quadHeight(quad);
  if (height <= EPSILON) return quad;
  if (quadTiltDegrees(quad) > deskewAllowanceDegrees(length / height)) return quad;
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4;
  const cy = quad.reduce((s, p) => s + p.y, 0) / 4;
  return uprightQuad(cx - length / 2, cy - height / 2, cx + length / 2, cy + height / 2);
}

/**
 * The readings that landed on top of each other fused into one run each: the connected sets of
 * `sameRun`, each named by and placed at its earliest member, so a page comes out the same twice.
 */
export function fusedRuns(blocks: TextBlock[]): TextBlock[] {
  if (blocks.length < 2) return blocks;
  const group = blocks.map((_, i) => i);
  const root = (i: number) => {
    while (group[i] !== i) i = group[i];
    return i;
  };
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      if (!sameRun(blocks[i].quad, blocks[j].quad)) continue;
      const a = root(i);
      const b = root(j);
      if (a < b) group[b] = a;
      else if (b < a) group[a] = b;
    }
  }
  const groups = new Map<number, TextBlock[]>();
  blocks.forEach((b, i) => {
    const r = root(i);
    const list = groups.get(r);
    if (list) list.push(b);
    else groups.set(r, [b]);
  });
  return [...groups.values()].map((parts) => (parts.length === 1 ? parts[0] : fused(parts)));
}

function sameRun(a: Quad, b: Quad): boolean {
  if (quadOverlapRatio(a, b) >= MERGE_OVERLAP_RATIO) return true;
  const along = readingAxis(dominant([a, b]));
  const across = { x: -along.y, y: along.x };
  return spanOverlapRatio(a, b, across) >= SAME_LINE_BAND_RATIO && spanOverlapRatio(a, b, along) >= SAME_RUN_SPAN_RATIO;
}

function fused(parts: TextBlock[]): TextBlock {
  const along = readingAxis(dominant(parts.map((p) => p.quad)));
  const across = { x: -along.y, y: along.x };
  const ordered = [...parts].sort(
    (p, q) =>
      spanAlong(p.quad, along)[0] - spanAlong(q.quad, along)[0] ||
      spanAlong(p.quad, across)[0] - spanAlong(q.quad, across)[0] ||
      (p.text < q.text ? -1 : p.text > q.text ? 1 : 0),
  );
  const segments = segmentsOf(ordered);
  const characters = segments.reduce((n, s) => n + s.text.length, 0);
  return {
    text: segments.map((s) => s.text).join(" "),
    confidence:
      characters <= 0
        ? Math.max(...parts.map((p) => p.confidence))
        : segments.reduce((n, s) => n + s.text.length * s.confidence, 0) / characters,
    quad: coveringQuad(
      parts.map((p) => p.quad),
      along,
      across,
    ),
  };
}

/** One entry per distinct piece of text, each with the surer reading of it. */
function segmentsOf(ordered: TextBlock[]): { text: string; confidence: number }[] {
  const segments: { text: string; confidence: number }[] = [];
  for (const part of ordered) {
    const text = part.text.trim();
    if (!text) continue;
    const lower = text.toLowerCase();
    const carried = segments.findIndex((s) => s.text.toLowerCase().includes(lower));
    if (carried >= 0) {
      segments[carried] = { ...segments[carried], confidence: Math.max(segments[carried].confidence, part.confidence) };
      continue;
    }
    const widened = segments.findIndex((s) => lower.includes(s.text.toLowerCase()));
    if (widened >= 0) {
      segments[widened] = { text, confidence: Math.max(segments[widened].confidence, part.confidence) };
      continue;
    }
    segments.push({ text, confidence: part.confidence });
  }
  return segments;
}

/** How much of the smaller of two quads the other covers, 0 to 1. */
export function quadOverlapRatio(a: Quad, b: Quad): number {
  const smaller = Math.min(Math.abs(signedArea(a)), Math.abs(signedArea(b)));
  if (smaller <= EPSILON) return 0;
  return Math.min(Math.max(intersectionArea(a, b) / smaller, 0), 1);
}

/**
 * Whether a reading is worth showing: some letter or digit in it, the confidence bar met, and a
 * one or two character reading held to a higher bar, since a single glyph's probability is not
 * the evidence a whole word's worth is; that is what keeps icons and logos from reading as text.
 */
export function looksReadable(text: string, confidence: number): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (confidence < MIN_READ_CONFIDENCE) return false;
  const readable = [...trimmed].filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
  if (readable === 0) return false;
  return readable > SHORT_TEXT_LENGTH || confidence >= SHORT_TEXT_MIN_CONFIDENCE;
}

function edge(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function quadLength(q: Quad): number {
  return (edge(q[0], q[1]) + edge(q[3], q[2])) / 2;
}

function quadHeight(q: Quad): number {
  return (edge(q[0], q[3]) + edge(q[1], q[2])) / 2;
}

function readingAxis(q: Quad): Point {
  const dx = q[1].x - q[0].x + (q[2].x - q[3].x);
  const dy = q[1].y - q[0].y + (q[2].y - q[3].y);
  const length = Math.hypot(dx, dy);
  if (length < EPSILON) return { x: 1, y: 0 };
  return { x: dx / length, y: dy / length };
}

/** The longest quad, ties settled by tilt and then position, so the pair's order never matters. */
function dominant(quads: Quad[]): Quad {
  const rank = (q: Quad): number[] => [-quadLength(q), quadTiltDegrees(q), q[0].x, q[0].y];
  return quads.reduce((best, q) => {
    const a = rank(q);
    const b = rank(best);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? q : best;
    return best;
  });
}

function spanAlong(q: Quad, d: Point): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of q) {
    const p = c.x * d.x + c.y * d.y;
    lo = Math.min(lo, p);
    hi = Math.max(hi, p);
  }
  return [lo, hi];
}

function spanOverlapRatio(a: Quad, b: Quad, d: Point): number {
  const [as, ae] = spanAlong(a, d);
  const [bs, be] = spanAlong(b, d);
  const shorter = Math.min(ae - as, be - bs);
  if (shorter <= EPSILON) return 0;
  return Math.min(Math.max((Math.min(ae, be) - Math.max(as, bs)) / shorter, 0), 1);
}

function coveringQuad(quads: Quad[], along: Point, across: Point): Quad {
  let minA = Infinity;
  let maxA = -Infinity;
  let minC = Infinity;
  let maxC = -Infinity;
  for (const q of quads) {
    const [sa, ea] = spanAlong(q, along);
    const [sc, ec] = spanAlong(q, across);
    minA = Math.min(minA, sa);
    maxA = Math.max(maxA, ea);
    minC = Math.min(minC, sc);
    maxC = Math.max(maxC, ec);
  }
  const corner = (a: number, c: number): Point => ({ x: along.x * a + across.x * c, y: along.y * a + across.y * c });
  return [corner(minA, minC), corner(maxA, minC), corner(maxA, maxC), corner(minA, maxC)];
}

/** The area two convex polygons share, by clipping one against each edge of the other. */
function intersectionArea(a: Point[], b: Point[]): number {
  if (a.length < 3 || b.length < 3) return 0;
  const clip = signedArea(b) < 0 ? [...b].reverse() : b;
  let output = signedArea(a) < 0 ? [...a].reverse() : a;
  for (let i = 0; i < clip.length; i++) {
    if (output.length < 3) return 0;
    const s = clip[i];
    const e = clip[(i + 1) % clip.length];
    const input = output;
    const next: Point[] = [];
    for (let k = 0; k < input.length; k++) {
      const current = input[k];
      const previous = input[(k - 1 + input.length) % input.length];
      const currentInside = side(s, e, current) >= 0;
      const previousInside = side(s, e, previous) >= 0;
      if (currentInside) {
        if (!previousInside) {
          const x = crossing(previous, current, s, e);
          if (x) next.push(x);
        }
        next.push(current);
      } else if (previousInside) {
        const x = crossing(previous, current, s, e);
        if (x) next.push(x);
      }
    }
    output = next;
  }
  return Math.abs(signedArea(output));
}

function side(s: Point, e: Point, p: Point): number {
  return (e.x - s.x) * (p.y - s.y) - (e.y - s.y) * (p.x - s.x);
}

function crossing(from: Point, to: Point, s: Point, e: Point): Point | null {
  const sx = to.x - from.x;
  const sy = to.y - from.y;
  const ex = e.x - s.x;
  const ey = e.y - s.y;
  const denominator = sx * ey - sy * ex;
  if (Math.abs(denominator) < EPSILON) return null;
  const t = ((s.x - from.x) * ey - (s.y - from.y) * ex) / denominator;
  return { x: from.x + sx * t, y: from.y + sy * t };
}
