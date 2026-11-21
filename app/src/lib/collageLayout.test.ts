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
  COLLAGE_RATIO_IDS,
  canSelectForCollage,
  cellAt,
  clampZoom,
  collageCells,
  collageFileName,
  collageSize,
  collageTemplates,
  cornerRadiusPx,
  coverPlacement,
  freshCell,
  panAfterDrag,
  photoEdgeFor,
  replaceCell,
  spacingPx,
  swapCells,
  zoomAfterWheel,
  type UnitRect,
} from "./collageLayout";

const area = (r: UnitRect) => (r.x1 - r.x0) * (r.y1 - r.y0);

describe("the templates", () => {
  it("offer several layouts for every count from 2 to 9, none outside it", () => {
    for (let n = 2; n <= 9; n++) expect(collageTemplates(n).length).toBeGreaterThanOrEqual(5);
    expect(collageTemplates(1)).toEqual([]);
    expect(collageTemplates(10)).toEqual([]);
  });

  it("hold exactly one cell per photo, with unique ids", () => {
    for (let n = 2; n <= 9; n++) {
      const list = collageTemplates(n);
      for (const t of list) expect(t.cells).toHaveLength(n);
      expect(new Set(list.map((t) => t.id)).size).toBe(list.length);
    }
  });

  it("tile the whole canvas without gaps or overlaps", () => {
    for (let n = 2; n <= 9; n++) {
      for (const t of collageTemplates(n)) {
        const total = t.cells.reduce((s, c) => s + area(c), 0);
        expect(total).toBeCloseTo(1, 9);
        for (const c of t.cells) {
          expect(c.x0).toBeGreaterThanOrEqual(0);
          expect(c.y0).toBeGreaterThanOrEqual(0);
          expect(c.x1).toBeLessThanOrEqual(1 + 1e-9);
          expect(c.y1).toBeLessThanOrEqual(1 + 1e-9);
          expect(area(c)).toBeGreaterThan(0.02);
        }
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            const a = t.cells[i];
            const b = t.cells[j];
            const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
            const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
            expect(ox > 1e-9 && oy > 1e-9).toBe(false);
          }
        }
      }
    }
  });

  it("make the hero layout's first cell the large one", () => {
    const hero = collageTemplates(4).find((t) => t.id === "hero-left");
    expect(hero?.cells[0].x1).toBeCloseTo(0.6);
    expect(hero?.cells.slice(1).every((c) => c.x0 >= 0.6 - 1e-9)).toBe(true);
  });

  it("split a long stack into two columns", () => {
    const hero = collageTemplates(9).find((t) => t.id === "hero-left");
    expect(hero?.cells).toHaveLength(9);
    const widths = hero!.cells.slice(1).map((c) => c.x1 - c.x0);
    expect(Math.min(...widths)).toBeGreaterThan(0.15);
  });
});

describe("the canvas size", () => {
  it("puts the long side on the export edge for every ratio", () => {
    for (const r of COLLAGE_RATIO_IDS) {
      const s = collageSize(r, 3000);
      expect(Math.max(s.w, s.h)).toBe(3000);
    }
    expect(collageSize("1:1", 3000)).toEqual({ w: 3000, h: 3000 });
    expect(collageSize("4:5", 3000)).toEqual({ w: 2400, h: 3000 });
    expect(collageSize("16:9", 3000)).toEqual({ w: 3000, h: 1688 });
    expect(collageSize("9:16", 3000)).toEqual({ w: 1688, h: 3000 });
  });
});

describe("spacing and corners", () => {
  it("scale with the canvas, so preview and export agree", () => {
    expect(spacingPx(0, 1000, 800)).toBe(0);
    expect(spacingPx(20, 1000, 800)).toBeCloseTo(16);
    expect(spacingPx(20, 3000, 2400) / 3000).toBeCloseTo(spacingPx(20, 1000, 800) / 1000);
    expect(spacingPx(999, 1000, 1000)).toBe(40);
  });

  it("keep the corner radius within half the cell", () => {
    expect(cornerRadiusPx(0, 1000, 1000, 400, 400)).toBe(0);
    expect(cornerRadiusPx(40, 1000, 1000, 400, 400)).toBeCloseTo(100);
    expect(cornerRadiusPx(50, 1000, 1000, 60, 400)).toBe(30);
  });

  it("leave the whole gap outside and between the cells", () => {
    const t = collageTemplates(2).find((x) => x.id === "cols-1-1")!;
    const [a, b] = collageCells(t.cells, 1000, 500, 20);
    expect(a.x).toBe(20);
    expect(a.y).toBe(20);
    expect(a.h).toBe(460);
    expect(b.x - (a.x + a.w)).toBeCloseTo(20);
    expect(b.x + b.w).toBeCloseTo(980);
  });

  it("fill the canvas edge to edge with no gap", () => {
    const t = collageTemplates(4).find((x) => x.id === "rows-2-2")!;
    const cells = collageCells(t.cells, 800, 600, 0);
    expect(cells[0]).toEqual({ x: 0, y: 0, w: 400, h: 300 });
    expect(cells[3]).toEqual({ x: 400, y: 300, w: 400, h: 300 });
  });

  it("never return an empty cell", () => {
    const t = collageTemplates(9)[0];
    for (const c of collageCells(t.cells, 90, 90, 40)) {
      expect(c.w).toBeGreaterThanOrEqual(1);
      expect(c.h).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("a photo in its cell", () => {
  it("covers the cell, centred, at zoom 1", () => {
    const p = coverPlacement(4000, 3000, 300, 300, 1, 0, 0);
    expect(p.h).toBeCloseTo(300);
    expect(p.w).toBeCloseTo(400);
    expect(p.x).toBeCloseTo(-50);
    expect(p.y).toBeCloseTo(0);
  });

  it("shows either end of the overflow at a full pan", () => {
    const left = coverPlacement(4000, 3000, 300, 300, 1, 1, 0);
    expect(left.x).toBeCloseTo(0);
    const right = coverPlacement(4000, 3000, 300, 300, 1, -1, 0);
    expect(right.x + right.w).toBeCloseTo(300);
  });

  it("never leaves the cell uncovered, whatever the zoom and pan", () => {
    for (const zoom of [1, 1.7, 5, 99]) {
      for (const pan of [-3, -1, 0, 0.4, 1, 3]) {
        const p = coverPlacement(1200, 4000, 500, 300, zoom, pan, pan);
        expect(p.x).toBeLessThanOrEqual(1e-9);
        expect(p.y).toBeLessThanOrEqual(1e-9);
        expect(p.x + p.w).toBeGreaterThanOrEqual(500 - 1e-9);
        expect(p.y + p.h).toBeGreaterThanOrEqual(300 - 1e-9);
      }
    }
  });

  it("zooms larger and clamps to its range", () => {
    expect(coverPlacement(1000, 1000, 100, 100, 2, 0, 0).w).toBeCloseTo(200);
    expect(clampZoom(0.2)).toBe(1);
    expect(clampZoom(40)).toBe(5);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it("drags the photo with the pointer, one cell pixel for one pixel", () => {
    const before = coverPlacement(4000, 3000, 300, 300, 1, 0, 0);
    const overflow = before.w - 300;
    const pan = panAfterDrag(0, 20, overflow);
    const after = coverPlacement(4000, 3000, 300, 300, 1, pan, 0);
    expect(after.x - before.x).toBeCloseTo(20);
  });

  it("stops a drag at the edge and ignores one with nothing to move", () => {
    expect(panAfterDrag(0.9, 500, 100)).toBe(1);
    expect(panAfterDrag(-0.9, -500, 100)).toBe(-1);
    expect(panAfterDrag(0.5, 30, 0)).toBe(0);
  });

  it("zooms in on a wheel push up and out on one down", () => {
    expect(zoomAfterWheel(1, -100)).toBeGreaterThan(1);
    expect(zoomAfterWheel(2, 100)).toBeLessThan(2);
    expect(zoomAfterWheel(1, 500)).toBe(1);
    expect(zoomAfterWheel(4.9, -2000)).toBe(5);
  });
});

describe("the cells", () => {
  const cells = [
    { uid: "a", zoom: 2, panX: 0.5, panY: 0 },
    { uid: "b", zoom: 1, panX: 0, panY: -1 },
    freshCell("c"),
  ];

  it("swaps two photos with their framing and leaves the input alone", () => {
    const out = swapCells(cells, 0, 2);
    expect(out.map((c) => c.uid)).toEqual(["c", "b", "a"]);
    expect(out[2].zoom).toBe(2);
    expect(cells.map((c) => c.uid)).toEqual(["a", "b", "c"]);
  });

  it("ignores a swap with itself or outside the list", () => {
    expect(swapCells(cells, 1, 1)).toBe(cells);
    expect(swapCells(cells, 0, 7)).toBe(cells);
  });

  it("replaces a photo and frames the new one fresh", () => {
    const out = replaceCell(cells, 0, "z");
    expect(out[0]).toEqual({ uid: "z", zoom: 1, panX: 0, panY: 0 });
    expect(out[1]).toBe(cells[1]);
    expect(replaceCell(cells, 5, "z")).toBe(cells);
  });

  it("finds the cell under a point", () => {
    const rects = [
      { x: 0, y: 0, w: 50, h: 100 },
      { x: 50, y: 0, w: 50, h: 100 },
    ];
    expect(cellAt(rects, 10, 10)).toBe(0);
    expect(cellAt(rects, 75, 99)).toBe(1);
    expect(cellAt(rects, 120, 10)).toBe(-1);
  });
});

describe("the selection size", () => {
  it("accepts 2 to 9 photos", () => {
    expect([1, 2, 5, 9, 10].map(canSelectForCollage)).toEqual([false, true, true, true, false]);
  });
});

describe("the file name", () => {
  it("carries the date and the extension", () => {
    expect(collageFileName(new Date(2026, 10, 4), "jpg")).toBe("Collage-2026-11-04.jpg");
  });
});

describe("the in-memory photo size", () => {
  it("shrinks as the collage holds more photos, never below a usable size", () => {
    const edges = [2, 3, 4, 5, 6, 7, 8, 9].map(photoEdgeFor);
    for (let i = 1; i < edges.length; i++) expect(edges[i]).toBeLessThanOrEqual(edges[i - 1]);
    expect(Math.min(...edges)).toBeGreaterThanOrEqual(1500);
  });
});
