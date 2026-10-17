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

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { GRID_GAP } from "./PhotoGrid";

/** A tile's width over its height, as `.g-cell` draws it. */
const CELL_ASPECT = 0.85;

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
  const [view, setView] = useState({ top: 0, height: 0 });
  const [measuredHeader, setHeaderHeight] = useState(50);
  const headerHeight = header ? measuredHeader : 0;
  const readView = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Where the scroll area's window sits over this list, read once per frame at most.
  useEffect(() => {
    const wrap = wrapRef.current;
    const scroller = scrollRef?.current ?? wrap?.closest<HTMLElement>(scrollerSelector) ?? null;
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
  const columns = width > 0 ? Math.max(1, Math.floor((width + GRID_GAP) / (cellSize + GRID_GAP))) : 1;
  const tile = width > 0 ? (width - GRID_GAP * (columns - 1)) / columns : cellSize;
  const rowHeight = tile / CELL_ASPECT;
  const pitch = rowHeight + GRID_GAP;

  // Built: what is on screen and about a screen and a half either side, which the
  // thumbnails' own look-ahead fits inside.
  const screen = Math.max(view.height, 600);
  const from = view.top - screen * 1.5;
  const to = view.top + screen * 2.5;

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
    out.push(
      <section className="g-section live" key={section.key}>
        {header && <MeasuredHeader onHeight={setHeaderHeight}>{header(section)}</MeasuredHeader>}
        {before > 0 && <div style={{ height: before }} aria-hidden />}
        {lastRow > firstRow && grid(section, section.items.slice(firstRow * columns, lastRow * columns))}
        {after > 0 && <div style={{ height: after }} aria-hidden />}
      </section>,
    );
  }

  return (
    <div ref={wrapRef} className={className}>
      {out}
    </div>
  );
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
