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

// Ported from the Android app's CropGeometryTest.kt so the desktop crop math stays in
// lockstep with it. Same cases, same numbers.

import { describe, it, expect } from "vitest";
import {
  boxHeight,
  boxWidth,
  centeredCrop,
  CROP_ASPECTS,
  type CropBox,
  type CropHandle,
  lockRatio,
  resizeCrop,
  turned,
} from "./editorCrop";

const minPx = 32;
const boundsW = 4000;
const boundsH = 3000;

const box = (left: number, top: number, right: number, bottom: number): CropBox => ({
  left,
  top,
  right,
  bottom,
});

/** Rounding to whole pixels perturbs the ratio by up to half a pixel on the derived axis. */
function expectRatio(expected: number, b: CropBox) {
  const tolerance = expected / boxHeight(b) + 0.001;
  expect(Math.abs(expected - boxWidth(b) / boxHeight(b))).toBeLessThanOrEqual(tolerance);
}

function expectInBounds(b: CropBox, bw = boundsW, bh = boundsH) {
  expect(b.left).toBeGreaterThanOrEqual(0);
  expect(b.top).toBeGreaterThanOrEqual(0);
  expect(b.right).toBeLessThanOrEqual(bw);
  expect(b.bottom).toBeLessThanOrEqual(bh);
}

const LOCKED_HANDLES: CropHandle[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "top",
  "bottom",
  "left",
  "right",
];

describe("centeredCrop", () => {
  it("pillarboxes a square out of a landscape source", () => {
    expect(centeredCrop(4000, 3000, 1)).toEqual(box(500, 0, 3500, 3000));
  });

  it("letterboxes a wide shape out of a portrait source", () => {
    const b = centeredCrop(3000, 4000, 16 / 9);
    expect(b.left).toBe(0);
    expect(b.right).toBe(3000);
    expectRatio(16 / 9, b);
    expect(Math.abs(b.top - (4000 - b.bottom))).toBeLessThanOrEqual(1);
  });

  it("selects the whole image at the source ratio", () => {
    expect(centeredCrop(4000, 3000, 4 / 3)).toEqual(box(0, 0, 4000, 3000));
  });
});

describe("free-form resize", () => {
  it("a corner drag moves only its own two edges", () => {
    const out = resizeCrop(box(0, 0, 4000, 3000), "top-left", 1000, 500, null, boundsW, boundsH, minPx);
    expect(out).toEqual(box(1000, 500, 4000, 3000));
  });

  it("an edge drag moves only its own edge", () => {
    const out = resizeCrop(box(100, 200, 3000, 2000), "right", 2500, 1234, null, boundsW, boundsH, minPx);
    expect(out).toEqual(box(100, 200, 2500, 2000));
  });

  it("cannot cross the opposite edge", () => {
    const out = resizeCrop(box(0, 0, 4000, 3000), "top-left", 3999, 2999, null, boundsW, boundsH, minPx);
    expect(out.left).toBe(4000 - minPx);
    expect(out.top).toBe(3000 - minPx);
  });
});

describe("a locked corner", () => {
  it("keeps the ratio", () => {
    const start = box(0, 0, 4000, 3000);
    const out = resizeCrop(start, "top-left", 1500, 1900, 4 / 3, boundsW, boundsH, minPx);
    expectRatio(4 / 3, out);
    expectInBounds(out);
    expect(boxWidth(out)).toBeLessThan(boxWidth(start));
  });

  it("leaves the opposite corner alone", () => {
    const out = resizeCrop(box(0, 0, 4000, 3000), "top-left", 1500, 1900, 4 / 3, boundsW, boundsH, minPx);
    expect(out.right).toBe(4000);
    expect(out.bottom).toBe(3000);
  });

  it("the bottom-right corner pins the top-left", () => {
    const out = resizeCrop(box(400, 300, 3600, 2700), "bottom-right", 2000, 1000, 1, boundsW, boundsH, minPx);
    expect(out.left).toBe(400);
    expect(out.top).toBe(300);
    expectRatio(1, out);
  });

  it("follows whichever axis the finger reached furthest", () => {
    const out = resizeCrop(box(0, 0, 4000, 3000), "top-left", 3900, 100, 1, boundsW, boundsH, minPx);
    expect(boxHeight(out)).toBeGreaterThan(2500);
    expectRatio(1, out);
  });
});

describe("the edge of the photo", () => {
  it("a locked drag past the edge stays inside and keeps the ratio", () => {
    const out = resizeCrop(box(3000, 1000, 3900, 2000), "bottom-right", 999999, 999999, 16 / 9, boundsW, boundsH, minPx);
    expectInBounds(out);
    expectRatio(16 / 9, out);
    expect(out.left).toBe(3000);
    expect(out.top).toBe(1000);
  });

  it("a tall lock against a short edge shrinks rather than clipping", () => {
    const out = resizeCrop(box(100, 2000, 500, 2900), "bottom-right", 3500, 999999, 9 / 16, boundsW, boundsH, minPx);
    expectInBounds(out);
    expectRatio(9 / 16, out);
  });
});

describe("locked edges", () => {
  it("a left-edge drag changes both axes", () => {
    const start = box(1000, 1000, 3000, 2500);
    const out = resizeCrop(start, "left", 2000, 0, 4 / 3, boundsW, boundsH, minPx);
    expect(out.right).toBe(3000);
    expectRatio(4 / 3, out);
    expect(boxHeight(out)).not.toBe(boxHeight(start));
  });

  it("a top-edge drag changes both axes", () => {
    const start = box(1000, 1000, 3000, 2500);
    const out = resizeCrop(start, "top", 0, 1800, 4 / 3, boundsW, boundsH, minPx);
    expect(out.bottom).toBe(2500);
    expectRatio(4 / 3, out);
    expect(boxWidth(out)).not.toBe(boxWidth(start));
  });

  it("keeps the untouched axis centred", () => {
    const start = box(1000, 1000, 3000, 2500);
    const before = Math.trunc((start.top + start.bottom) / 2);
    const out = resizeCrop(start, "left", 2200, 0, 1, boundsW, boundsH, minPx);
    expect(Math.trunc((out.top + out.bottom) / 2)).toBe(before);
  });

  it("slides off the bitmap edge instead of overflowing", () => {
    const out = resizeCrop(box(1000, 0, 3000, 200), "right", 3900, 0, 9 / 16, boundsW, boundsH, minPx);
    expectInBounds(out);
    expectRatio(9 / 16, out);
  });
});

describe("the minimum", () => {
  it("shrinking a lock to nothing still leaves both axes usable", () => {
    const out = resizeCrop(box(0, 0, 4000, 3000), "top-left", 4000, 3000, 4 / 3, boundsW, boundsH, minPx);
    expect(boxWidth(out)).toBeGreaterThanOrEqual(minPx);
    expect(boxHeight(out)).toBeGreaterThanOrEqual(minPx);
    expectRatio(4 / 3, out);
  });

  it("a tall lock at its minimum is not a sliver", () => {
    const out = resizeCrop(box(0, 0, 4000, 3000), "bottom-right", 0, 0, 9 / 16, boundsW, boundsH, minPx);
    expect(boxWidth(out)).toBeGreaterThanOrEqual(minPx);
    expect(boxHeight(out)).toBeGreaterThanOrEqual(minPx);
  });

  it("an image smaller than the minimum still yields a rect inside it", () => {
    const tiny = 20;
    const out = resizeCrop(box(0, 0, tiny, tiny), "bottom-right", 999, 999, 1, tiny, tiny, minPx);
    expect(out.right).toBeLessThanOrEqual(tiny);
    expect(out.bottom).toBeLessThanOrEqual(tiny);
    expect(boxWidth(out)).toBeGreaterThan(0);
    expect(boxHeight(out)).toBeGreaterThan(0);
  });
});

describe("inside translate", () => {
  it("preserves the size", () => {
    const start = box(100, 100, 1100, 850);
    const out = resizeCrop(start, "inside", 900, 700, 4 / 3, boundsW, boundsH, minPx, 50, 40);
    expect(boxWidth(out)).toBe(boxWidth(start));
    expect(boxHeight(out)).toBe(boxHeight(start));
    expect(out.left).toBe(850);
    expect(out.top).toBe(660);
  });

  it("clamps to the bitmap", () => {
    const start = box(100, 100, 1100, 850);
    const out = resizeCrop(start, "inside", 999999, 999999, 1, boundsW, boundsH, minPx, 0, 0);
    expectInBounds(out);
    expect(boxWidth(out)).toBe(boxWidth(start));
    expect(boxHeight(out)).toBe(boxHeight(start));
  });
});

describe("opposite anchors", () => {
  it("the right edge pins the left", () => {
    const out = resizeCrop(box(1000, 1000, 3000, 2500), "right", 2400, 0, 4 / 3, boundsW, boundsH, minPx);
    expect(out.left).toBe(1000);
    expectRatio(4 / 3, out);
  });

  it("the bottom edge pins the top", () => {
    const out = resizeCrop(box(1000, 1000, 3000, 2500), "bottom", 0, 2000, 4 / 3, boundsW, boundsH, minPx);
    expect(out.top).toBe(1000);
    expectRatio(4 / 3, out);
  });

  it("the top-right corner pins the bottom-left", () => {
    const out = resizeCrop(box(1000, 1000, 3000, 2500), "top-right", 2000, 2000, 1, boundsW, boundsH, minPx);
    expect(out.left).toBe(1000);
    expect(out.bottom).toBe(2500);
    expectRatio(1, out);
  });

  it("the bottom-left corner pins the top-right", () => {
    const out = resizeCrop(box(1000, 1000, 3000, 2500), "bottom-left", 2000, 2000, 1, boundsW, boundsH, minPx);
    expect(out.right).toBe(3000);
    expect(out.top).toBe(1000);
    expectRatio(1, out);
  });
});

/** The anchor a handle pivots on, and a finger placed well past it. */
function anchorAndBeyond(b: CropBox, handle: CropHandle): [[number, number], [number, number]] {
  const d = 900;
  switch (handle) {
    case "top-left":
      return [[b.right, b.bottom], [b.right + d, b.bottom + d]];
    case "top-right":
      return [[b.left, b.bottom], [b.left - d, b.bottom + d]];
    case "bottom-left":
      return [[b.right, b.top], [b.right + d, b.top - d]];
    case "bottom-right":
      return [[b.left, b.top], [b.left - d, b.top - d]];
    case "left":
      return [[b.right, 0], [b.right + d, 0]];
    case "right":
      return [[b.left, 0], [b.left - d, 0]];
    case "top":
      return [[0, b.bottom], [0, b.bottom + d]];
    case "bottom":
      return [[0, b.top], [0, b.top - d]];
    default:
      return [[0, 0], [0, 0]];
  }
}

describe("direction: a handle past its anchor collapses, never re-grows", () => {
  it("a locked corner past its anchor collapses instead of mirroring", () => {
    const out = resizeCrop(box(1000, 500, 2000, 1500), "top-left", 2500, 1800, 1, boundsW, boundsH, minPx);
    expect(out.right).toBe(2000);
    expect(out.bottom).toBe(1500);
    expect(boxWidth(out)).toBeLessThanOrEqual(minPx + 1);
  });

  it("dragging further past the anchor does not grow the crop", () => {
    const start = box(1000, 500, 2000, 1500);
    const justPast = resizeCrop(start, "top-left", 2100, 1600, 1, boundsW, boundsH, minPx);
    const farPast = resizeCrop(start, "top-left", 4000, 3000, 1, boundsW, boundsH, minPx);
    expect(justPast.right - justPast.left).toBe(farPast.right - farPast.left);
  });

  it("a locked left edge past its anchor collapses", () => {
    const out = resizeCrop(box(1000, 500, 2000, 1500), "left", 3000, 0, 1, boundsW, boundsH, minPx);
    expect(out.right).toBe(2000);
    expect(boxWidth(out)).toBeLessThanOrEqual(minPx + 1);
  });

  it("a locked bottom edge past its anchor collapses", () => {
    const out = resizeCrop(box(1000, 500, 2000, 1500), "bottom", 0, 100, 1, boundsW, boundsH, minPx);
    expect(out.top).toBe(500);
    expect(boxHeight(out)).toBeLessThanOrEqual(minPx + 1);
  });

  it("no locked handle grows once the finger is past its anchor", () => {
    const ratios = [1, 4 / 3, 3 / 4, 16 / 9, 9 / 16];
    const start = box(1200, 900, 2600, 2000);
    for (const ratio of ratios) {
      for (const handle of LOCKED_HANDLES) {
        const [at, beyond] = anchorAndBeyond(start, handle);
        const onAnchor = resizeCrop(start, handle, at[0], at[1], ratio, boundsW, boundsH, minPx);
        const pastIt = resizeCrop(start, handle, beyond[0], beyond[1], ratio, boundsW, boundsH, minPx);
        expect(pastIt).toEqual(onAnchor);
      }
    }
  });

  it("every locked handle respects the minimum on both axes", () => {
    const ratios = [1, 4 / 3, 3 / 4, 16 / 9, 9 / 16];
    const start = box(1200, 900, 2600, 2000);
    for (const ratio of ratios) {
      for (const handle of LOCKED_HANDLES) {
        const [at] = anchorAndBeyond(start, handle);
        const out = resizeCrop(start, handle, at[0], at[1], ratio, boundsW, boundsH, minPx);
        expect(boxWidth(out)).toBeGreaterThanOrEqual(minPx);
        expect(boxHeight(out)).toBeGreaterThanOrEqual(minPx);
      }
    }
  });
});

describe("the chip model", () => {
  it("free locks nothing and original locks the photo's own shape", () => {
    expect(lockRatio("free", 4032, 3024)).toBeNull();
    expect(lockRatio("original", 4032, 3024)!).toBeCloseTo(4 / 3, 4);
    expect(lockRatio("original", 3024, 4032)!).toBeCloseTo(3 / 4, 4);
    expect(lockRatio("1:1", 4032, 3024)!).toBeCloseTo(1, 4);
  });

  it("a quarter turn turns the locked shape with the photo", () => {
    expect(turned("4:3")).toBe("3:4");
    expect(turned("3:4")).toBe("4:3");
    expect(turned("16:9")).toBe("9:16");
    expect(turned("9:16")).toBe("16:9");
  });

  it("the symmetric shapes survive a turn unchanged", () => {
    expect(turned("free")).toBe("free");
    expect(turned("1:1")).toBe("1:1");
    expect(turned("original")).toBe("original");
    expect(lockRatio(turned("original"), 3024, 4032)!).toBeCloseTo(3 / 4, 4);
  });

  it("turning a shape twice returns it", () => {
    for (const aspect of CROP_ASPECTS) {
      expect(turned(turned(aspect))).toBe(aspect);
    }
  });

  it("a turned shape is the reciprocal ratio", () => {
    const w = 4000;
    const h = 2500;
    for (const aspect of CROP_ASPECTS.filter((a) => a !== "free")) {
      const before = lockRatio(aspect, w, h)!;
      const after = lockRatio(turned(aspect), h, w)!;
      expect(after).toBeCloseTo(1 / before, 4);
    }
  });
});

describe("the invariant across the whole space", () => {
  it("every locked handle and ratio stays in bounds and on ratio", () => {
    const ratios = [1, 4 / 3, 3 / 4, 16 / 9, 9 / 16, boundsW / boundsH];
    const starts = [
      box(0, 0, boundsW, boundsH),
      box(1000, 800, 3000, 2200),
      box(3800, 2800, 4000, 3000),
      box(0, 0, 60, 45),
    ];
    const fingers: [number, number][] = [
      [0, 0],
      [boundsW, boundsH],
      [2000, 1500],
      [40, 2900],
      [3990, 10],
      [-5000, -5000],
      [99999, 99999],
    ];
    for (const ratio of ratios) {
      for (const handle of LOCKED_HANDLES) {
        for (const start of starts) {
          for (const [fx, fy] of fingers) {
            const out = resizeCrop(start, handle, fx, fy, ratio, boundsW, boundsH, minPx);
            expect(out.left).toBeGreaterThanOrEqual(0);
            expect(out.top).toBeGreaterThanOrEqual(0);
            expect(out.right).toBeLessThanOrEqual(boundsW);
            expect(out.bottom).toBeLessThanOrEqual(boundsH);
            expect(boxWidth(out)).toBeGreaterThan(0);
            expect(boxHeight(out)).toBeGreaterThan(0);
            const tolerance = ratio / boxHeight(out) + 0.001;
            expect(Math.abs(ratio - boxWidth(out) / boxHeight(out))).toBeLessThanOrEqual(tolerance);
          }
        }
      }
    }
  });
});
