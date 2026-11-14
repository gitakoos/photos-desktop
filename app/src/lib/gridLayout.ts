/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

/**
 * Where every tile of a sectioned photo grid goes, worked out rather than measured: the
 * same arithmetic the grid stylesheet does (`repeat(auto-fill, minmax(cellSize, 1fr))`, a
 * 6 px gap, tiles 0.85 as wide as tall), a month header's height above each section.
 *
 * The canvas timeline draws from this alone, so it has to answer every question the DOM
 * used to: which tiles are in a stretch of the list, which tile is under the pointer, where
 * a given photo is, and where the reader's place goes when a zoom or a resize moves it.
 */

/** The gap between tiles, as `.g-grid` has it. */
export const GRID_GAP = 6;

/** A tile's width over its height, as `.g-cell` draws it. */
export const CELL_ASPECT = 0.85;

export type GridLayout = {
  /** The width the tiles share. */
  width: number;
  columns: number;
  /** A tile's width and height, and a row's height plus the gap under it. */
  tile: number;
  rowH: number;
  pitch: number;
  /** A month header's height; 0 for a grid with none. */
  header: number;
  /** Each section's item count, its top in the list, and the index of its first item overall. */
  counts: number[];
  tops: number[];
  starts: number[];
  /** The whole list's height. */
  height: number;
};

/** As many columns as fit at `cellSize`, stretched to fill: a tile is never narrower. */
export function columnsFor(width: number, cellSize: number): number {
  return width > 0 ? Math.max(1, Math.floor((width + GRID_GAP) / (cellSize + GRID_GAP))) : 1;
}

/**
 * The layout of sections of `counts` items over `width`. `tile`, when given, is held (a
 * resize under way keeps the tiles' size while the columns follow the window).
 */
export function gridLayout(counts: number[], width: number, cellSize: number, header: number, held?: number): GridLayout {
  const columns = held ? columnsFor(width, held) : columnsFor(width, cellSize);
  const tile = held ?? (width > 0 ? (width - GRID_GAP * (columns - 1)) / columns : cellSize);
  const rowH = tile / CELL_ASPECT;
  const pitch = rowH + GRID_GAP;
  const tops: number[] = [];
  const starts: number[] = [];
  let y = 0;
  let start = 0;
  for (const count of counts) {
    tops.push(y);
    starts.push(start);
    const rows = Math.ceil(count / columns);
    y += header + (rows > 0 ? rows * rowH + (rows - 1) * GRID_GAP : 0);
    start += count;
  }
  return { width, columns, tile, rowH, pitch, header, counts, tops, starts, height: y };
}

/** The section whose span holds `y` (the last one at or above it). */
export function sectionAt(l: GridLayout, y: number): number {
  let lo = 0;
  let hi = l.tops.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (l.tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The section holding item `index` of the whole list. */
export function sectionOfIndex(l: GridLayout, index: number): number {
  let lo = 0;
  let hi = l.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (l.starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Where item `k` of section `s` is: its left within the grid and its top within the list. */
export function tileXY(l: GridLayout, s: number, k: number): { x: number; y: number } {
  const row = Math.floor(k / l.columns);
  return { x: (k % l.columns) * (l.tile + GRID_GAP), y: l.tops[s] + l.header + row * l.pitch };
}

/** The tile under a point of the list (x within the grid, y within the list), or null over a gap, a header or nothing. */
export function tileAt(l: GridLayout, x: number, y: number): { s: number; k: number } | null {
  if (x < 0 || x >= l.width || y < 0 || y >= l.height) return null;
  const s = sectionAt(l, y);
  if (s < 0) return null;
  const inGrid = y - l.tops[s] - l.header;
  if (inGrid < 0) return null;
  const row = Math.floor(inGrid / l.pitch);
  if (inGrid - row * l.pitch >= l.rowH) return null;
  const col = Math.floor(x / (l.tile + GRID_GAP));
  if (col >= l.columns || x - col * (l.tile + GRID_GAP) >= l.tile) return null;
  const k = row * l.columns + col;
  return k < l.counts[s] ? { s, k } : null;
}

/** One tile placed: its section, its index in the section and overall, and where it is. */
export type Placed = { s: number; k: number; index: number; x: number; y: number };
/** One header placed. */
export type PlacedHeader = { s: number; y: number };

/**
 * What is in a stretch of the list. Its objects are reused from one call to the next (only
 * the first `n` and `hn` are current), so working it out on every scroll step makes no
 * garbage. Items are in list order, so their overall indexes rise.
 */
export class TileRange {
  tiles: Placed[] = [];
  n = 0;
  heads: PlacedHeader[] = [];
  hn = 0;

  /** Every tile and header with any part between `from` and `to`. */
  fill(l: GridLayout, from: number, to: number): this {
    this.n = 0;
    this.hn = 0;
    if (l.tops.length === 0 || to <= from) return this;
    for (let s = Math.max(0, sectionAt(l, from)); s < l.tops.length && l.tops[s] < to; s++) {
      const top = l.tops[s];
      const count = l.counts[s];
      const rows = Math.ceil(count / l.columns);
      const bottom = top + l.header + (rows > 0 ? rows * l.rowH + (rows - 1) * GRID_GAP : 0);
      if (bottom <= from) continue;
      if (l.header > 0 && top + l.header > from) this.head(s, top);
      const gridTop = top + l.header;
      const r0 = Math.max(0, Math.floor((from - gridTop) / l.pitch));
      const r1 = Math.min(rows, Math.ceil((to - gridTop) / l.pitch));
      for (let r = r0; r < r1; r++) {
        const y = gridTop + r * l.pitch;
        for (let c = 0; c < l.columns; c++) {
          const k = r * l.columns + c;
          if (k >= count) break;
          this.tile(s, k, l.starts[s] + k, c * (l.tile + GRID_GAP), y);
        }
      }
    }
    return this;
  }

  private tile(s: number, k: number, index: number, x: number, y: number): void {
    const t = this.tiles[this.n];
    if (t) {
      t.s = s;
      t.k = k;
      t.index = index;
      t.x = x;
      t.y = y;
    } else this.tiles.push({ s, k, index, x, y });
    this.n++;
  }

  private head(s: number, y: number): void {
    const h = this.heads[this.hn];
    if (h) {
      h.s = s;
      h.y = y;
    } else this.heads.push({ s, y });
    this.hn++;
  }
}

/** The reader's place: the first row at the top of the view, and how far above the view's top it starts. */
export type Anchor = { s: number; k: number; offset: number };

/** The row at the top of the view at `viewTop`, to keep in place across a layout change. */
export function anchorAt(l: GridLayout, viewTop: number): Anchor | null {
  if (viewTop <= 0 || l.tops.length === 0) return null;
  const s = sectionAt(l, viewTop);
  const rows = Math.ceil(l.counts[s] / l.columns);
  const row = Math.min(Math.max(0, rows - 1), Math.max(0, Math.floor((viewTop - l.tops[s] - l.header) / l.pitch)));
  const y = l.tops[s] + l.header + row * l.pitch;
  return { s, k: row * l.columns, offset: y - viewTop };
}

/** Where the view's top goes in layout `l` so the anchored row is where it was on screen. */
export function viewTopFor(l: GridLayout, a: Anchor | null): number {
  if (!a || a.s >= l.tops.length) return 0;
  const y = l.tops[a.s] + l.header + Math.floor(a.k / l.columns) * l.pitch;
  return Math.max(0, y - a.offset);
}
