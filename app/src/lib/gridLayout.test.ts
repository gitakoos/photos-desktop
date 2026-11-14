/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { describe, it, expect } from "vitest";
import { GRID_GAP, TileRange, anchorAt, gridLayout, sectionOfIndex, tileAt, tileXY, viewTopFor } from "./gridLayout";

// 3 sections of 10, 3 and 7 photos, 4 columns at 100 px over 418 px: tiles 100 wide, 117.6 tall.
const l = gridLayout([10, 3, 7], 418, 100, 50);

describe("the grid's layout", () => {
  it("fits the columns and stretches the tiles as the stylesheet does", () => {
    expect(l.columns).toBe(4);
    expect(l.tile).toBeCloseTo(100);
    expect(l.rowH).toBeCloseTo(100 / 0.85);
    expect(gridLayout([1], 430, 100, 0).tile).toBeCloseTo((430 - 3 * GRID_GAP) / 4);
  });

  it("puts each section under the last, a header and its rows", () => {
    expect(l.tops[0]).toBe(0);
    expect(l.tops[1]).toBeCloseTo(50 + 3 * l.rowH + 2 * GRID_GAP);
    expect(l.starts).toEqual([0, 10, 13]);
    expect(l.height).toBeCloseTo(l.tops[2] + 50 + 2 * l.rowH + GRID_GAP);
  });

  it("keeps a held tile size while the columns follow the width", () => {
    const held = gridLayout([10], 700, 100, 0, 110);
    expect(held.tile).toBe(110);
    expect(held.columns).toBe(Math.floor((700 + GRID_GAP) / (110 + GRID_GAP)));
  });
});

describe("finding tiles", () => {
  it("finds the tile under a point, and none over a gap or a header", () => {
    const { x, y } = tileXY(l, 0, 5);
    expect(tileAt(l, x + 1, y + 1)).toEqual({ s: 0, k: 5 });
    expect(tileAt(l, x + l.tile + 2, y + 1)).toBeNull();
    expect(tileAt(l, 10, l.tops[1] + 10)).toBeNull();
    // Past the last photo of a short row.
    const last = tileXY(l, 1, 2);
    expect(tileAt(l, last.x + l.tile + GRID_GAP + 5, last.y + 5)).toBeNull();
  });

  it("lists the tiles and headers in a stretch, in order, reusing its objects", () => {
    const r = new TileRange().fill(l, l.tops[1] - 5, l.tops[1] + 60);
    expect(r.hn).toBe(1);
    expect(r.heads[0].s).toBe(1);
    const indexes = r.tiles.slice(0, r.n).map((t) => t.index);
    expect(indexes).toEqual([8, 9, 10, 11, 12]);
    const first = r.tiles[0];
    r.fill(l, 0, 10);
    expect(r.tiles[0]).toBe(first);
    expect(r.n).toBe(0);
  });

  it("finds an item's section", () => {
    expect(sectionOfIndex(l, 0)).toBe(0);
    expect(sectionOfIndex(l, 10)).toBe(1);
    expect(sectionOfIndex(l, 19)).toBe(2);
  });
});

describe("the reader's place", () => {
  it("keeps the row at the top where it was when the columns change", () => {
    const at = tileXY(l, 2, 4).y + 20;
    const anchor = anchorAt(l, at)!;
    expect(anchor).toEqual({ s: 2, k: 4, offset: -20 });
    const wide = gridLayout([10, 3, 7], 900, 100, 50);
    const top = viewTopFor(wide, anchor);
    expect(top).toBeCloseTo(tileXY(wide, 2, Math.floor(4 / wide.columns) * wide.columns).y + 20);
  });

  it("has no place to keep at the very top", () => {
    expect(anchorAt(l, 0)).toBeNull();
    expect(viewTopFor(l, null)).toBe(0);
  });
});
