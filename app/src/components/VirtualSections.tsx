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

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { GRID_GAP } from "./PhotoGrid";

/** A tile's width over its height, as `.g-cell` draws it. */
const CELL_ASPECT = 0.85;

/** How long the width must stay put before a resize's new layout is drawn. */
const RESIZE_SETTLE_MS = 140;

/** How long a tile takes to glide to where a zoom step or a new column count puts it. */
const GLIDE_MS = 240;
const GLIDE_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/** One commit's layout: what a change is measured from, to keep the reader's place and
 *  to start each tile where it was. */
type Layout = {
  /** The sections' keys and sizes: a change in either is new content, not a new layout. */
  shape: string;
  columns: number;
  tile: number;
  pitch: number;
  headerHeight: number;
  cellSize: number;
  /** Each section's top, by key. */
  tops: Map<string, number>;
  /** Where the scroll area's window sat over the list. */
  viewTop: number;
};

/** What a layout change does once it is on screen: the scroll that keeps the reader's place,
 *  and the layout the tiles glide from. */
type Change = { from: Layout; viewTop: number; glide: boolean };

export type VirtualSection<T> = { key: string; items: T[] };

/**
 * The timeline's month sections with only the rows near the screen built, and every
 * other row an empty block of its exact height, so the scroll bar and the position stay
 * true.
 *
 * Rows, not months: one month can hold thousands of photos, and a whole month built
 * because one of its rows was in view is what kept the window freezing on every zoom
 * step and filter change. The layout is worked out rather than measured, from the
 * width, the tile size and the grid's own rules (`auto-fill`, a 6 px gap, tiles 0.85
 * as wide as tall), so nothing jumps as rows come and go. Only a month header's height
 * is measured, once, since every header is the same.
 */
export function VirtualSections<T>({
  scrollRef,
  scroller: scrollerSelector = ".g-scroll",
  sections,
  cellSize,
  header,
  grid,
  className,
}: {
  /** The scroll area; when absent, the nearest one around the list (`scroller`). */
  scrollRef?: RefObject<HTMLElement | null>;
  /** Selector for the scroll area to look for around the list, without `scrollRef`. */
  scroller?: string;
  sections: VirtualSection<T>[];
  cellSize: number;
  /** A month's header, rendered for every month near the screen; none for a plain grid. */
  header?: (section: VirtualSection<T>) => ReactNode;
  /** A run of a month's tiles, already in rows. */
  grid: (section: VirtualSection<T>, items: T[]) => ReactNode;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // The tile size held while the list is being resized. The page answers a window drag in
  // time, but the webview's frames reach the screen a frame or two behind the window's
  // edge, so tiles stretched on every step stood somewhere new in every frame and the late
  // frames showed them back where they were: the flicker. With the size held, the columns
  // still follow the window live, a tile moves only when a column comes or goes, in one
  // jump, and the tiles stretch to fill the row once the drag stops.
  const [held, setHeld] = useState<{ tile: number; cellSize: number } | null>(null);
  const liveLayout = useRef({ width: 0, columns: 1, tile: 0, cellSize: 0 });
  const [view, setView] = useState({ top: 0, height: 0 });
  const [measuredHeader, setHeaderHeight] = useState(50);
  const headerHeight = header ? measuredHeader : 0;
  const readView = useRef<() => void>(() => {});
  const scrollerRef = useRef<HTMLElement | null>(null);
  const lastLayout = useRef<Layout | null>(null);
  const change = useRef<Change | null>(null);
  /** The first item of each section that is built, by key, for working out a tile's index. */
  const builtFrom = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    let settle = 0;
    // Answered before the frame is painted, so no frame shows the tiles at a width the
    // rows and the scroll were not worked out for.
    const ro = new ResizeObserver(() => {
      const next = el.clientWidth;
      const now = liveLayout.current;
      if (next === now.width) return;
      flushSync(() => {
        if (now.width > 0) {
          setHeld((h) => h ?? { tile: now.tile, cellSize: now.cellSize });
        }
        setWidth(next);
      });
      window.clearTimeout(settle);
      settle = window.setTimeout(() => setHeld(null), RESIZE_SETTLE_MS);
    });
    ro.observe(el);
    return () => {
      window.clearTimeout(settle);
      ro.disconnect();
    };
  }, []);

  // Where the scroll area's window sits over this list, read once per frame at most.
  useEffect(() => {
    const wrap = wrapRef.current;
    const scroller = scrollRef?.current ?? wrap?.closest<HTMLElement>(scrollerSelector) ?? null;
    scrollerRef.current = scroller;
    if (!scroller || !wrap) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const top = scroller.getBoundingClientRect().top - wrap.getBoundingClientRect().top;
      setView((prev) =>
        Math.abs(prev.top - top) < 1 && prev.height === scroller.clientHeight
          ? prev
          : { top, height: scroller.clientHeight },
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    readView.current = schedule;
    scroller.addEventListener("scroll", schedule, { passive: true });
    const sized = new ResizeObserver(schedule);
    sized.observe(scroller);
    return () => {
      cancelAnimationFrame(frame);
      readView.current = () => {};
      scroller.removeEventListener("scroll", schedule);
      sized.disconnect();
    };
  }, [scrollRef, scrollerSelector]);

  // A filter, a zoom step or new photos change the layout with no scroll to say so, and
  // the browser may move the scroll position to fit; look again after each.
  useEffect(() => {
    readView.current();
  }, [sections, cellSize, width]);

  // The grid's own arithmetic: as many columns as fit at the tile size, stretched to fill.
  const liveColumns = width > 0 ? Math.max(1, Math.floor((width + GRID_GAP) / (cellSize + GRID_GAP))) : 1;
  const liveTile = width > 0 ? (width - GRID_GAP * (liveColumns - 1)) / liveColumns : cellSize;
  // A zoom step during a resize is drawn at once rather than held.
  const holding = held !== null && held.cellSize === cellSize;
  const columns = holding
    ? Math.max(1, Math.floor((width + GRID_GAP) / (held.tile + GRID_GAP)))
    : liveColumns;
  const tile = holding ? held.tile : liveTile;
  if (!holding) liveLayout.current = { width, columns, tile, cellSize };
  else liveLayout.current = { ...liveLayout.current, width };
  const rowHeight = tile / CELL_ASPECT;
  const pitch = rowHeight + GRID_GAP;
  const sectionHeight = (count: number, cols: number, rowH: number, head: number) => {
    const rows = Math.ceil(count / cols);
    return head + (rows > 0 ? rows * rowH + (rows - 1) * GRID_GAP : 0);
  };
  const shape = sections.map((section) => `${section.key}:${section.items.length}`).join("|");
  const tops = new Map<string, number>();
  {
    let y = 0;
    for (const section of sections) {
      tops.set(section.key, y);
      y += sectionHeight(section.items.length, columns, rowHeight, headerHeight);
    }
  }

  // A zoom step or a resize changes every tile's place with nothing scrolled. The reader's
  // place is kept: the photo at the top of the window stays at the top, and the window is
  // worked out where it will be, so the right rows are built at once.
  let viewTop = view.top;
  const prev = lastLayout.current;
  if (
    prev &&
    width > 0 &&
    prev.shape === shape &&
    (prev.columns !== columns || Math.abs(prev.tile - tile) > 0.5)
  ) {
    let anchor: { key: string; index: number; offset: number } | null = null;
    if (prev.viewTop > 0) {
      const prevRowHeight = prev.pitch - GRID_GAP;
      for (const section of sections) {
        const top = prev.tops.get(section.key) ?? 0;
        const height = sectionHeight(section.items.length, prev.columns, prevRowHeight, prev.headerHeight);
        if (prev.viewTop < top + height) {
          const row = Math.max(0, Math.floor((prev.viewTop - top - prev.headerHeight) / prev.pitch));
          const y = top + prev.headerHeight + row * prev.pitch;
          anchor = { key: section.key, index: row * prev.columns, offset: y - prev.viewTop };
          break;
        }
      }
    }
    if (anchor) {
      const top = tops.get(anchor.key) ?? 0;
      const y = top + headerHeight + Math.floor(anchor.index / columns) * pitch;
      viewTop = Math.max(0, y - anchor.offset);
    }
    change.current = {
      from: prev,
      viewTop,
      // Only a zoom step glides. A resize changes the layout on every frame of the drag, and
      // a glide started on each one, from places the tiles had not reached yet, made them
      // flicker between the old places and the new.
      glide: prev.cellSize !== cellSize,
    };
  }

  // Built: what is on screen and about a screen and a half either side, which the
  // thumbnails' own look-ahead fits inside.
  const screen = Math.max(view.height, 600);
  const from = viewTop - screen * 1.5;
  const to = viewTop + screen * 2.5;

  let at = 0;
  const out: ReactNode[] = [];
  for (const section of sections) {
    const rows = Math.ceil(section.items.length / columns);
    const gridHeight = rows > 0 ? rows * rowHeight + (rows - 1) * GRID_GAP : 0;
    const height = headerHeight + gridHeight;
    const top = at;
    at += height;
    if (top >= to || top + height <= from) {
      out.push(<div key={section.key} style={{ height }} aria-hidden />);
      continue;
    }
    const gridTop = top + headerHeight;
    const firstRow = Math.max(0, Math.floor((from - gridTop) / pitch));
    const lastRow = Math.min(rows, Math.ceil((to - gridTop) / pitch));
    const before = firstRow * pitch;
    const after = (rows - lastRow) * pitch;
    builtFrom.current.set(section.key, firstRow * columns);
    out.push(
      <section className="g-section live" key={section.key} data-vs={section.key}>
        {header && <MeasuredHeader onHeight={setHeaderHeight}>{header(section)}</MeasuredHeader>}
        {before > 0 && <div style={{ height: before }} aria-hidden />}
        {lastRow > firstRow && grid(section, section.items.slice(firstRow * columns, lastRow * columns))}
        {after > 0 && <div style={{ height: after }} aria-hidden />}
      </section>,
    );
  }

  // Once the new layout is on screen: the scroll that keeps the reader's place, then every
  // built tile set back where it was and let go, so it glides to its new place. Worked out
  // from the two layouts rather than measured, so the whole move costs one style write a
  // tile and a single layout.
  useLayoutEffect(() => {
    const pending = change.current;
    change.current = null;
    const wrap = wrapRef.current;
    const scroller = scrollerRef.current;
    if (pending && wrap && scroller) {
      // A glide still under way ends where it is going before the layout moves again.
      settleGlide();
      const delta = pending.viewTop - pending.from.viewTop;
      if (Math.abs(delta) >= 1) scroller.scrollTop += delta;
      setView((v) => (Math.abs(v.top - pending.viewTop) < 1 ? v : { top: pending.viewTop, height: v.height }));
      if (pending.glide && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        glide(wrap, pending, {
          columns,
          tile,
          pitch,
          headerHeight,
          tops,
          builtFrom: builtFrom.current,
          viewTop: pending.viewTop,
          viewHeight: scroller.clientHeight,
        });
      }
    }
    lastLayout.current = {
      shape,
      columns,
      tile,
      pitch,
      headerHeight,
      cellSize,
      tops,
      viewTop: pending ? pending.viewTop : view.top,
    };
  });

  return (
    // The browser's own scroll anchoring would move the scroll a second time on top of the
    // place kept above, so this list keeps it out.
    <div
      ref={wrapRef}
      className={`${className ?? ""}${holding ? " vs-held" : ""}`}
      style={
        {
          overflowAnchor: "none",
          ...(holding ? { "--vs-cols": columns, "--vs-tile": `${tile}px` } : null),
        } as CSSProperties
      }
    >
      {out}
    </div>
  );
}

/**
 * Sets every built tile at its place in the old layout and releases it to its new one
 * (FLIP), so a zoom step or a new column count moves the photos instead of swapping them.
 * A tile that was far off screen before comes in with a short fade instead of flying in
 * from there.
 */
function glide(
  wrap: HTMLElement,
  change: Change,
  now: {
    columns: number;
    tile: number;
    pitch: number;
    headerHeight: number;
    tops: Map<string, number>;
    builtFrom: Map<string, number>;
    viewTop: number;
    viewHeight: number;
  },
) {
  const was = change.from;
  const scale = was.tile / now.tile;
  const moved: HTMLElement[] = [];
  for (const section of wrap.querySelectorAll<HTMLElement>("section[data-vs]")) {
    const key = section.dataset.vs!;
    const first = now.builtFrom.get(key) ?? 0;
    const wasTop = was.tops.get(key);
    const nowTop = now.tops.get(key);
    if (wasTop === undefined || nowTop === undefined) continue;
    const cells = section.querySelectorAll<HTMLElement>("[data-uid]");
    cells.forEach((cell, i) => {
      const index = first + i;
      const wasX = (index % was.columns) * (was.tile + GRID_GAP);
      const wasY = wasTop + was.headerHeight + Math.floor(index / was.columns) * was.pitch - was.viewTop;
      const nowX = (index % now.columns) * (now.tile + GRID_GAP);
      const nowY = nowTop + now.headerHeight + Math.floor(index / now.columns) * now.pitch - now.viewTop;
      const dx = wasX - nowX;
      const dy = wasY - nowY;
      // Only tiles that end up on screen are worth moving.
      if (nowY > now.viewHeight || nowY + now.pitch < 0) return;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(scale - 1) < 0.01) return;
      cell.style.transition = "none";
      cell.style.transformOrigin = "0 0";
      if (wasY > now.viewHeight * 1.5 || wasY < -now.viewHeight * 0.5) {
        cell.style.opacity = "0";
      } else {
        cell.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
      }
      moved.push(cell);
    });
  }
  if (moved.length === 0) return;
  void wrap.offsetWidth;
  for (const cell of moved) {
    cell.style.transition = `transform ${GLIDE_MS}ms ${GLIDE_EASE}, opacity ${GLIDE_MS}ms ease`;
    cell.style.transform = "";
    cell.style.opacity = "";
  }
  gliding = { cells: moved, timer: window.setTimeout(settleGlide, GLIDE_MS + 40) };
}

/** The tiles of the glide under way, and the timer that tidies them up after it. */
let gliding: { cells: HTMLElement[]; timer: number } | null = null;

/** Ends the glide under way at once: every tile at its own place, with no motion left. */
function settleGlide() {
  if (!gliding) return;
  window.clearTimeout(gliding.timer);
  for (const cell of gliding.cells) {
    cell.style.transition = "";
    cell.style.transform = "";
    cell.style.opacity = "";
    cell.style.transformOrigin = "";
  }
  gliding = null;
}

/** Wraps a month header and reports its height, which every header shares. */
function MeasuredHeader({ onHeight, children }: { onHeight: (height: number) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    if (h > 0) onHeight(h);
  });
  return <div ref={ref}>{children}</div>;
}
