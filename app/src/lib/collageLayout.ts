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

// The collage's geometry, kept free of the canvas so it can be tested: the layout
// templates for a count of photos, the spacing and corner maths, and how a photo covers
// its cell under a pan and a zoom. Preview and export both call these with their own
// canvas size, so what is on screen is what is saved.

export const COLLAGE_MIN = 2;
export const COLLAGE_MAX = 9;

/** The long side of the saved collage, in pixels. */
export const COLLAGE_EXPORT_EDGE = 3000;

export const COLLAGE_RATIOS = {
  "1:1": 1,
  "4:5": 4 / 5,
  "3:4": 3 / 4,
  "16:9": 16 / 9,
  "9:16": 9 / 16,
} as const;
export type CollageRatio = keyof typeof COLLAGE_RATIOS;
export const COLLAGE_RATIO_IDS = Object.keys(COLLAGE_RATIOS) as CollageRatio[];

export const SPACING_MAX = 40;
export const CORNER_MAX = 50;
export const ZOOM_MAX = 5;

/** A cell in the unit square: left, top, right, bottom, each 0..1. */
export type UnitRect = { x0: number; y0: number; x1: number; y1: number };
/** A cell in pixels. */
export type PixelRect = { x: number; y: number; w: number; h: number };
export type CollageTemplate = { id: string; cells: UnitRect[] };

/** What one cell holds: the photo, and how it is panned and zoomed inside the cell. */
export type CollageCell = { uid: string; zoom: number; panX: number; panY: number };

/**
 * The longest side a photo is kept at in memory while the collage is open. Nine decoded
 * photos at the editor's full size would not fit comfortably, and a cell never shows more
 * than the canvas has pixels for.
 */
export function photoEdgeFor(count: number): number {
  return count <= 2 ? 3000 : count <= 4 ? 2600 : count <= 6 ? 2200 : 1800;
}

export function canSelectForCollage(count: number): boolean {
  return count >= COLLAGE_MIN && count <= COLLAGE_MAX;
}

/** The canvas for a ratio, its longer side `longSide` pixels. */
export function collageSize(ratio: CollageRatio, longSide: number): { w: number; h: number } {
  const r = COLLAGE_RATIOS[ratio];
  return r >= 1
    ? { w: longSide, h: Math.max(1, Math.round(longSide / r)) }
    : { w: Math.max(1, Math.round(longSide * r)), h: longSide };
}

// ---- Templates ------------------------------------------------------------

const FULL: UnitRect = { x0: 0, y0: 0, x1: 1, y1: 1 };
const HERO_SHARE = 0.6;

/** `weights` cut `lo..hi` into consecutive spans in that proportion. */
function spans(lo: number, hi: number, weights: number[]): [number, number][] {
  const total = weights.reduce((a, b) => a + b, 0);
  let at = lo;
  return weights.map((w, i) => {
    const start = at;
    at = i === weights.length - 1 ? hi : at + ((hi - lo) * w) / total;
    return [start, at];
  });
}

const ones = (n: number) => Array.from({ length: n }, () => 1);

/** Rows stacked top to bottom, `counts[i]` equal cells in row i; `heights` weights the rows. */
function rowsIn(area: UnitRect, counts: number[], heights: number[] = ones(counts.length)): UnitRect[] {
  const out: UnitRect[] = [];
  spans(area.y0, area.y1, heights).forEach(([y0, y1], r) => {
    for (const [x0, x1] of spans(area.x0, area.x1, ones(counts[r]))) out.push({ x0, y0, x1, y1 });
  });
  return out;
}

/** Columns side by side, `counts[i]` equal cells in column i; `widths` weights the columns. */
function colsIn(area: UnitRect, counts: number[], widths: number[] = ones(counts.length)): UnitRect[] {
  const out: UnitRect[] = [];
  spans(area.x0, area.x1, widths).forEach(([x0, x1], c) => {
    for (const [y0, y1] of spans(area.y0, area.y1, ones(counts[c]))) out.push({ x0, y0, x1, y1 });
  });
  return out;
}

/** `n` cells split over at most two rows, the first row the longer. */
function twoRows(n: number): number[] {
  return n <= 4 ? [n] : [Math.ceil(n / 2), Math.floor(n / 2)];
}

/** One large photo on a side, the rest beside or under it. */
function hero(n: number, side: "left" | "right" | "top"): UnitRect[] {
  const k = n - 1;
  if (side === "top") {
    const big = { x0: 0, y0: 0, x1: 1, y1: HERO_SHARE };
    return [big, ...rowsIn({ x0: 0, y0: HERO_SHARE, x1: 1, y1: 1 }, twoRows(k))];
  }
  // A tall stack of more than four would be slivers, so it takes two columns.
  const counts = k <= 4 ? ones(k) : Array.from({ length: Math.ceil(k / 2) }, (_, i) => (i * 2 + 1 < k ? 2 : 1));
  if (side === "left") {
    const big = { x0: 0, y0: 0, x1: HERO_SHARE, y1: 1 };
    return [big, ...rowsIn({ x0: HERO_SHARE, y0: 0, x1: 1, y1: 1 }, counts)];
  }
  const big = { x0: 1 - HERO_SHARE, y0: 0, x1: 1, y1: 1 };
  return [big, ...rowsIn({ x0: 0, y0: 0, x1: 1 - HERO_SHARE, y1: 1 }, counts)];
}

const rows = (id: string, counts: number[], heights?: number[]): CollageTemplate => ({
  id,
  cells: rowsIn(FULL, counts, heights),
});
const cols = (id: string, counts: number[], widths?: number[]): CollageTemplate => ({
  id,
  cells: colsIn(FULL, counts, widths),
});
const heroT = (n: number, side: "left" | "right" | "top"): CollageTemplate => ({
  id: `hero-${side}`,
  cells: hero(n, side),
});

/** The layouts offered for `count` photos (2 to 9), grids first, then mixed sizes. */
export function collageTemplates(count: number): CollageTemplate[] {
  switch (count) {
    case 2:
      return [
        cols("cols-1-1", [1, 1]),
        rows("rows-1-1", [1, 1]),
        cols("cols-2to1", [1, 1], [2, 1]),
        cols("cols-1to2", [1, 1], [1, 2]),
        rows("rows-2to1", [1, 1], [2, 1]),
      ];
    case 3:
      return [
        rows("rows-1-1-1", [1, 1, 1]),
        cols("cols-1-1-1", [1, 1, 1]),
        heroT(3, "left"),
        heroT(3, "right"),
        heroT(3, "top"),
        rows("rows-1-2", [1, 2]),
        rows("rows-2-1", [2, 1]),
      ];
    case 4:
      return [
        rows("rows-2-2", [2, 2]),
        rows("rows-1-1-1-1", [1, 1, 1, 1]),
        cols("cols-1-1-1-1", [1, 1, 1, 1]),
        heroT(4, "left"),
        heroT(4, "top"),
        rows("rows-1-3", [1, 3]),
        cols("cols-1-3", [1, 3]),
      ];
    case 5:
      return [
        rows("rows-2-3", [2, 3]),
        rows("rows-3-2", [3, 2]),
        cols("cols-2-3", [2, 3]),
        heroT(5, "left"),
        heroT(5, "top"),
        rows("rows-1-2-2", [1, 2, 2]),
      ];
    case 6:
      return [
        rows("rows-3-3", [3, 3]),
        rows("rows-2-2-2", [2, 2, 2]),
        cols("cols-2-2-2", [2, 2, 2]),
        rows("rows-2-4", [2, 4]),
        heroT(6, "left"),
        heroT(6, "top"),
        rows("rows-1-2-3", [1, 2, 3]),
      ];
    case 7:
      return [
        rows("rows-3-4", [3, 4]),
        rows("rows-2-3-2", [2, 3, 2]),
        rows("rows-1-3-3", [1, 3, 3]),
        cols("cols-3-4", [3, 4]),
        heroT(7, "left"),
        heroT(7, "top"),
      ];
    case 8:
      return [
        rows("rows-4-4", [4, 4]),
        rows("rows-2-2-2-2", [2, 2, 2, 2]),
        rows("rows-3-2-3", [3, 2, 3]),
        rows("rows-1-3-4", [1, 3, 4]),
        heroT(8, "left"),
        heroT(8, "top"),
      ];
    case 9:
      return [
        rows("rows-3-3-3", [3, 3, 3]),
        rows("rows-4-5", [4, 5]),
        rows("rows-2-3-4", [2, 3, 4]),
        rows("rows-2-2-2-3", [2, 2, 2, 3]),
        heroT(9, "left"),
        heroT(9, "top"),
      ];
    default:
      return [];
  }
}

// ---- Spacing and corners --------------------------------------------------

/** The gap in pixels for a slider level: thousandths of the canvas's short side. */
export function spacingPx(level: number, w: number, h: number): number {
  const l = Math.min(SPACING_MAX, Math.max(0, level));
  return (l / 1000) * Math.min(w, h);
}

/** The corner radius for a slider level, at most half of the cell's short side. */
export function cornerRadiusPx(level: number, w: number, h: number, cellW: number, cellH: number): number {
  const l = Math.min(CORNER_MAX, Math.max(0, level));
  return Math.min((l / 400) * Math.min(w, h), Math.min(cellW, cellH) / 2);
}

const EDGE = 1e-6;

/**
 * The template's cells in pixels on a `w` x `h` canvas. The outer margin is the whole
 * `gap` and the space between two cells is the whole `gap`, so each inner edge gives
 * back half of it.
 */
export function collageCells(cells: UnitRect[], w: number, h: number, gap: number): PixelRect[] {
  return cells.map((c) => {
    const left = c.x0 < EDGE ? gap : c.x0 * w + gap / 2;
    const top = c.y0 < EDGE ? gap : c.y0 * h + gap / 2;
    const right = c.x1 > 1 - EDGE ? w - gap : c.x1 * w - gap / 2;
    const bottom = c.y1 > 1 - EDGE ? h - gap : c.y1 * h - gap / 2;
    return { x: left, y: top, w: Math.max(1, right - left), h: Math.max(1, bottom - top) };
  });
}

// ---- Photo inside its cell ------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export const clampZoom = (zoom: number) => clamp(Number.isFinite(zoom) ? zoom : 1, 1, ZOOM_MAX);
export const clampPan = (pan: number) => clamp(Number.isFinite(pan) ? pan : 0, -1, 1);

/**
 * Where the photo is drawn inside its cell, in the cell's own pixels: scaled to cover
 * the cell, times `zoom`. A pan of 0 centres the photo; 1 and -1 push it to the edge
 * of what overflows, showing the photo's left (or top) and right (or bottom) end.
 */
export function coverPlacement(
  imgW: number,
  imgH: number,
  cellW: number,
  cellH: number,
  zoom: number,
  panX: number,
  panY: number,
): PixelRect {
  const k = Math.max(cellW / imgW, cellH / imgH) * clampZoom(zoom);
  const w = imgW * k;
  const h = imgH * k;
  return {
    x: ((cellW - w) / 2) * (1 - clampPan(panX)),
    y: ((cellH - h) / 2) * (1 - clampPan(panY)),
    w,
    h,
  };
}

/** The pan after the photo is dragged `deltaPx` along one axis, where `overflowPx` spills over the cell. */
export function panAfterDrag(pan: number, deltaPx: number, overflowPx: number): number {
  if (overflowPx <= 0) return 0;
  return clampPan(pan + (2 * deltaPx) / overflowPx);
}

/** The zoom after a wheel notch (`deltaY` as the wheel event reports it; up zooms in). */
export function zoomAfterWheel(zoom: number, deltaY: number): number {
  return clampZoom(zoom * Math.exp(-deltaY * 0.0015));
}

// ---- Cells ----------------------------------------------------------------

export function freshCell(uid: string): CollageCell {
  return { uid, zoom: 1, panX: 0, panY: 0 };
}

/** The cell under a point, or -1. The last of overlapping cells wins. */
export function cellAt(rects: PixelRect[], x: number, y: number): number {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i];
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return i;
  }
  return -1;
}

/** Two cells traded: each photo keeps its own pan and zoom. */
export function swapCells(cells: CollageCell[], a: number, b: number): CollageCell[] {
  if (a === b || a < 0 || b < 0 || a >= cells.length || b >= cells.length) return cells;
  const next = cells.slice();
  next[a] = cells[b];
  next[b] = cells[a];
  return next;
}

/** One cell given another photo, framed from scratch. */
export function replaceCell(cells: CollageCell[], index: number, uid: string): CollageCell[] {
  if (index < 0 || index >= cells.length) return cells;
  const next = cells.slice();
  next[index] = freshCell(uid);
  return next;
}

/** The save-to-computer file name: `Collage-2026-11-14` plus the extension. */
export function collageFileName(when: Date, ext: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Collage-${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}.${ext}`;
}
