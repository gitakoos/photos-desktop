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
  MAX_DESKEW_DEGREES,
  MERGE_OVERLAP_RATIO,
  cleanTextBlocks,
  deskewAllowanceDegrees,
  deskewed,
  fusedRuns,
  looksReadable,
  quadOverlapRatio,
  quadTiltDegrees,
  type TextBlock,
} from "./ocrCleanup.ts";
import { boundsOf, uprightQuad, type Quad } from "./ocrGeometry.ts";

const block = (text: string, confidence: number, quad: Quad): TextBlock => ({ text, confidence, quad });
/** A run of `width` by `height` about a centre, turned by `degrees`. */
function run(cx: number, cy: number, width: number, height: number, degrees: number): Quad {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const corner = (dx: number, dy: number) => ({ x: cx + dx * c - dy * s, y: cy + dx * s + dy * c });
  return [corner(-width / 2, -height / 2), corner(width / 2, -height / 2), corner(width / 2, height / 2), corner(-width / 2, height / 2)];
}
const chain = () => [
  block("one", 0.9, uprightQuad(100, 100, 300, 160)),
  block("two", 0.8, uprightQuad(190, 100, 400, 160)),
  block("three", 0.7, uprightQuad(290, 100, 500, 160)),
];

describe("laying flat what only looks tilted", () => {
  it("measures the tilt whichever way a run leans", () => {
    expect(quadTiltDegrees(uprightQuad(100, 100, 500, 140))).toBeCloseTo(0);
    expect(quadTiltDegrees(run(300, 200, 400, 40, 7))).toBeCloseTo(7);
    expect(quadTiltDegrees(run(300, 200, 400, 40, -7))).toBeCloseTo(7);
  });

  it("allows a shorter run more tilt, up to the ceiling", () => {
    expect(deskewAllowanceDegrees(10)).toBeCloseTo(3.43, 2);
    expect(deskewAllowanceDegrees(6)).toBeCloseTo(5.71, 2);
    expect(deskewAllowanceDegrees(4)).toBeGreaterThan(deskewAllowanceDegrees(8));
    expect(deskewAllowanceDegrees(2)).toBe(MAX_DESKEW_DEGREES);
    expect(deskewAllowanceDegrees(0.5)).toBe(MAX_DESKEW_DEGREES);
  });

  it("lays a slightly tilted run flat at its own size and centre", () => {
    const flat = deskewed(run(300, 200, 400, 40, 2.5));
    expect(flat[0].y).toBeCloseTo(flat[1].y);
    expect(flat[1].x - flat[0].x).toBeCloseTo(400);
    expect(flat[3].y - flat[0].y).toBeCloseTo(40);
    expect((flat[0].x + flat[1].x) / 2).toBeCloseTo(300);
    expect((flat[0].y + flat[3].y) / 2).toBeCloseTo(200);
  });

  it("keeps the photo's own angles: a long line at 7, any run at 12, a sign at 25, a vertical caption", () => {
    for (const q of [run(300, 200, 400, 40, 12), run(300, 200, 400, 40, 7), run(200, 100, 60, 30, 25), run(300, 200, 400, 40, 90)]) {
      expect(deskewed(q)).toBe(q);
    }
    expect(quadTiltDegrees(deskewed(run(200, 100, 60, 30, 7)))).toBeCloseTo(0);
    const square = uprightQuad(100, 100, 500, 140);
    expect(deskewed(square)).toEqual(square);
  });
});

describe("one run, one reading", () => {
  it("fuses two readings of one heading into the surer one", () => {
    const kept = fusedRuns([block("Heading", 0.71, uprightQuad(100, 100, 500, 160)), block("Heading", 0.94, run(302, 132, 402, 62, 2))]);
    expect(kept).toHaveLength(1);
    expect(kept[0].text).toBe("Heading");
    expect(kept[0].confidence).toBeCloseTo(0.94);
  });

  it("folds a reading inside another into it, and joins two pieces of one line", () => {
    const folded = fusedRuns([block("HEADING", 0.8, uprightQuad(100, 100, 500, 160)), block("HEAD", 0.9, uprightQuad(150, 110, 300, 150))]);
    expect(folded).toMatchObject([{ text: "HEADING" }]);
    expect(folded[0].confidence).toBeCloseTo(0.9);
    const joined = fusedRuns([block("Frozen", 0.9, uprightQuad(100, 100, 400, 160)), block("No More", 0.8, uprightQuad(260, 100, 520, 160))]);
    expect(joined[0].text).toBe("Frozen No More");
    expect(joined[0].confidence).toBeCloseTo(0.846, 2);
  });

  it("fuses a sliver standing across a run, covering every piece", () => {
    const heading = block("Frozen No More", 0.88, uprightQuad(100, 100, 500, 160));
    const sliver = block("No", 0.92, uprightQuad(280, 80, 330, 200));
    expect(quadOverlapRatio(heading.quad, sliver.quad)).toBeLessThan(MERGE_OVERLAP_RATIO);
    const fused = fusedRuns([heading, sliver]);
    expect(fused).toHaveLength(1);
    expect(fused[0].text).toBe("Frozen No More");
    expect(fused[0].confidence).toBeCloseTo(0.92);
    const b = boundsOf(fused[0].quad);
    expect([b.left, b.top, b.right, b.bottom].map((v) => Math.round(v))).toEqual([100, 80, 500, 200]);
  });

  it("joins a chain into one run whatever order the page arrived in", () => {
    const pieces = chain();
    const expected = fusedRuns(pieces)[0];
    expect(expected.text).toBe("one two three");
    for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      const fused = fusedRuns(order.map((i) => pieces[i]));
      expect(fused).toHaveLength(1);
      expect(fused[0].text).toBe(expected.text);
      expect(fused[0].confidence).toBeCloseTo(expected.confidence);
    }
  });

  it("keeps lines that merely touch, columns that run into each other, and separate runs apart", () => {
    expect(fusedRuns([block("first line", 0.9, uprightQuad(100, 100, 500, 140)), block("second line", 0.6, uprightQuad(100, 135, 500, 175))])).toHaveLength(2);
    expect(fusedRuns([block("left column", 0.9, uprightQuad(100, 100, 310, 160)), block("right column", 0.9, uprightQuad(300, 100, 520, 160))])).toHaveLength(2);
    expect(fusedRuns([block("left", 0.9, uprightQuad(100, 100, 300, 160)), block("right", 0.9, uprightQuad(400, 100, 600, 160))])).toHaveLength(2);
    const longer = fusedRuns([block("Head", 0.9, uprightQuad(100, 100, 500, 160)), block("Heading", 0.9, uprightQuad(102, 101, 498, 159))]);
    expect(longer[0].text).toBe("Heading");
  });

  it("measures overlap against the smaller of the two", () => {
    const big = uprightQuad(0, 0, 100, 100);
    expect(quadOverlapRatio(big, big)).toBeCloseTo(1);
    expect(quadOverlapRatio(big, uprightQuad(20, 20, 60, 60))).toBeCloseTo(1);
    expect(quadOverlapRatio(big, uprightQuad(200, 200, 300, 300))).toBeCloseTo(0);
    expect(quadOverlapRatio(big, uprightQuad(50, 50, 150, 150))).toBeCloseTo(0.25);
  });
});

describe("what counts as text", () => {
  it("drops the empty, the unsure and marks with no letter or digit", () => {
    expect(looksReadable("", 0.99)).toBe(false);
    expect(looksReadable("   ", 0.99)).toBe(false);
    expect(looksReadable("uncertain", 0.42)).toBe(false);
    for (const marks of ["|", ".-.", "«»"]) expect(looksReadable(marks, 0.95)).toBe(false);
  });

  it("holds one or two characters to the higher bar and a word to the ordinary one", () => {
    expect(looksReadable("O", 0.62)).toBe(false);
    expect(looksReadable("l1", 0.7)).toBe(false);
    expect(looksReadable("7", 0.95)).toBe(true);
    expect(looksReadable("OK", 0.86)).toBe(true);
    expect(looksReadable("Fahrenheit", 0.55)).toBe(true);
    expect(looksReadable("őrző", 0.55)).toBe(true);
  });

  it("levels and fuses a page in one pass", () => {
    const cleaned = cleanTextBlocks([
      block("Heading", 0.7, run(300, 130, 400, 60, 1)),
      block("Heading", 0.92, uprightQuad(100, 100, 500, 160)),
      block("on a sign", 0.88, run(300, 400, 300, 50, 22)),
    ]);
    expect(cleaned).toHaveLength(2);
    expect(cleaned[0].text).toBe("Heading");
    expect(cleaned[0].confidence).toBeCloseTo(0.92);
    expect(quadTiltDegrees(cleaned[0].quad)).toBeCloseTo(0);
    expect(quadTiltDegrees(cleaned[1].quad)).toBeCloseTo(22);
    expect(cleanTextBlocks([])).toEqual([]);
  });
});
