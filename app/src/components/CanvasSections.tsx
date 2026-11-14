/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { useT } from "../lib/i18n";
import { GRID_GAP, anchorAt, gridLayout, tileAt, TileRange, viewTopFor, type GridLayout } from "../lib/gridLayout";
import { CanvasTimeline, type TimelineData } from "../lib/canvasTimeline";
import { makeSprites, type Palette } from "../lib/tileArt";
import { registerDrawnGrid, type CellBox } from "../lib/gridRegistry";
import { bench, benchCount, benchSpan } from "../lib/benchProbe";
import type { VirtualSection } from "./VirtualSections";
import type { GridItem } from "./PhotoGrid";
import { CheckIcon, CloudIcon, HeartIcon, MotionPhotoIcon, OfflinePinIcon, PanoramaIcon, PlayArrowIcon, RawIcon } from "./icons";

/** How long the width must stay put before a resize's new tile size is drawn. */
const RESIZE_SETTLE_MS = 140;

/** The marks, at their badge sizes, for the canvas to draw (see tileArt). */
const spritesFor = (dpr: number, p: Palette) =>
  makeSprites(
    (px) => ({
      play: <PlayArrowIcon size={px(17)} />,
      offline: <OfflinePinIcon size={px(11)} filled />,
      cloud: <CloudIcon size={px(11)} filled />,
      heart: <HeartIcon size={px(11)} filled />,
      check: <CheckIcon size={px(11)} />,
      motionPhoto: <MotionPhotoIcon size={px(11)} />,
      panorama: <PanoramaIcon size={px(11)} />,
      raw: <RawIcon size={px(11)} />,
    }),
    dpr,
    p,
  );

const NOTHING: ReadonlySet<string> = new Set();

/**
 * The timeline's month sections, drawn on one canvas (see canvasTimeline): the same tiles,
 * badges and selection as `VirtualSections` with `PhotoGrid` in it, but no element per
 * tile. The page keeps what has to be real elements: the month headers near the screen,
 * and one tile-sized element over the tile under the pointer, which carries its select
 * dot and takes its clicks and right-clicks.
 *
 * Needs the thumbnail server; without one, the DOM grid is used.
 */
export function CanvasSections({
  scrollRef,
  sections,
  cellSize,
  header,
  base,
  selected = NOTHING as Set<string>,
  offlineUids,
  localUids,
  onToggle,
  onOpen,
  onContext,
  showBadges = true,
  covered = false,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  sections: VirtualSection<GridItem>[];
  cellSize: number;
  /** A month's header, rendered for every month near the screen; none for a plain grid. */
  header?: (section: VirtualSection<GridItem>) => ReactNode;
  /** The thumbnail server's base address. */
  base: string;
  selected?: Set<string>;
  offlineUids?: Set<string>;
  localUids?: Set<string>;
  onToggle?: (uid: string, e: MouseEvent) => void;
  onOpen?: (uid: string, e: MouseEvent) => void;
  onContext?: (uid: string, e: MouseEvent) => void;
  showBadges?: boolean;
  /**
   * A page of the app (Settings, Upload) lies over the grid. It is then not drawn at all:
   * WebKitGTK appears to put the canvas's own layer over such a page when the canvas comes into
   * being under it (the library finishing its load while Settings was open).
   */
  covered?: boolean;
}) {
  const t = useT();
  const benchFrom = bench.on ? performance.now() : 0;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<CanvasTimeline | null>(null);
  const [width, setWidth] = useState(0);
  // A resize under way keeps the tiles' size while the columns follow the window, as the
  // DOM grid does; the tiles stretch to fill once the drag stops.
  const [held, setHeld] = useState<number | null>(null);
  const [headerHeight, setHeaderHeight] = useState(50);
  const [span, setSpan] = useState({ from: 0, to: 0 });
  const [hover, setHover] = useState<{ s: number; k: number } | null>(null);
  /** Where the pointer last was over the list, so the tile under it is found again once a scroll stops. */
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const trackRef = useRef<(x: number, y: number) => void>(() => {});

  // The layout changes with the photos' counts, not with every new array of them.
  const shape = sections.map((s) => `${s.key}:${s.items.length}`).join("|");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const counts = useMemo(() => sections.map((s) => s.items.length), [shape]);
  const head = header ? headerHeight : 0;
  const layout = useMemo(() => gridLayout(counts, width, cellSize, head, held ?? undefined), [counts, width, cellSize, head, held]);
  const data: TimelineData | null =
    width > 0 ? { layout, sections, selected, offline: offlineUids, local: localUids, showBadges } : null;
  const latest = useRef({ layout, sections, onToggle, onOpen, onContext, data });
  latest.current = { layout, sections, onToggle, onOpen, onContext, data };

  // The width the tiles share.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let known = el.clientWidth;
    setWidth(known);
    let settle = 0;
    const ro = new ResizeObserver(() => {
      const next = el.clientWidth;
      if (next === known) return;
      if (known > 0) setHeld((h) => h ?? latest.current.layout.tile);
      known = next;
      setWidth(next);
      window.clearTimeout(settle);
      settle = window.setTimeout(() => setHeld(null), RESIZE_SETTLE_MS);
    });
    ro.observe(el);
    return () => {
      window.clearTimeout(settle);
      ro.disconnect();
    };
  }, []);

  // A zoom step or a new column count moves every tile with nothing scrolled: the row at
  // the top of the view stays at the top.
  const lastLayout = useRef<{ layout: GridLayout; shape: string } | null>(null);
  useLayoutEffect(() => {
    const was = lastLayout.current;
    lastLayout.current = { layout, shape };
    const wrap = wrapRef.current;
    const scroller = scrollerOf(scrollRef, wrap);
    // Nothing to keep before the first real layout (the first commit has no width), or
    // when the list changed rather than its layout.
    if (!was || !scroller || !wrap || was.shape !== shape || width === 0 || was.layout.width === 0) return;
    if (was.layout.columns === layout.columns && Math.abs(was.layout.tile - layout.tile) < 0.5 && was.layout.header === layout.header) return;
    const offset = wrap.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const top = scroller.scrollTop - offset;
    // The list's top is still on screen: what is above it stays where it is.
    if (top <= 0) return;
    const next = viewTopFor(layout, anchorAt(was.layout, top));
    if (Math.abs(next - top) >= 1) scroller.scrollTop += next - top;
  }, [layout, shape, width, scrollRef]);

  // The engine: once per thumbnail server (a lock takes the server, and every thumbnail with
  // it). Made before the paint, and before the effect below hands it what to draw.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const scroller = scrollerOf(scrollRef, wrap);
    if (!canvas || !scroller || !wrap) return;
    const engine = new CanvasTimeline(
      canvas,
      scroller,
      wrap,
      base,
      spritesFor,
      (from, to) => setSpan((s) => (s.from === from && s.to === to ? s : { from, to })),
      () => setHover(null),
      () => {
        const p = pointerRef.current;
        if (p) trackRef.current(p.x, p.y);
      },
    );
    engineRef.current = engine;
    const now = latest.current;
    if (now.data) engine.setData(now.data);
    const unregister = registerDrawnGrid(scroller, {
      cells(y1, y2): CellBox[] {
        const { layout: l, sections: secs } = latest.current;
        const box = wrap.getBoundingClientRect();
        // The list's top in the scroll area's content, as the rubber band counts it.
        const listTop = box.top + scroller.scrollTop;
        const r = new TileRange().fill(l, y1 - listTop, y2 - listTop);
        const out: CellBox[] = [];
        for (let i = 0; i < r.n; i++) {
          const p = r.tiles[i];
          out.push({
            uid: secs[p.s].items[p.k].uid,
            left: box.left + p.x,
            right: box.left + p.x + l.tile,
            top: listTop + p.y,
            bottom: listTop + p.y + l.rowH,
          });
        }
        return out;
      },
      onScreen: () => ({ ...engine.onScreen(), width: latest.current.layout.tile }),
      kind: () => `canvas, ${engine.where()}`,
    });
    return () => {
      unregister();
      engine.destroy();
      engineRef.current = null;
    };
  }, [base, scrollRef]);

  // Everything the canvas draws from.
  useLayoutEffect(() => {
    if (latest.current.data) engineRef.current?.setData(latest.current.data);
  }, [layout, sections, selected, offlineUids, localUids, showBadges, width]);

  useLayoutEffect(() => {
    engineRef.current?.setHover(hover ? layout.starts[hover.s] + hover.k : -1);
  }, [hover, layout]);

  useLayoutEffect(() => {
    if (bench.on && benchFrom) benchSpan("vs_ms", benchFrom);
  });

  /** The tile at a point of the window, or null over a gap, a header or nothing. */
  const tileUnder = (clientX: number, clientY: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    const box = wrap.getBoundingClientRect();
    const at = tileAt(latest.current.layout, clientX - box.left, clientY - box.top);
    const uid = at ? latest.current.sections[at.s]?.items[at.k]?.uid : undefined;
    return at && uid ? { ...at, uid } : null;
  };
  /** The tile under the pointer, from where the pointer is over the list. */
  const track = (clientX: number, clientY: number) => {
    pointerRef.current = { x: clientX, y: clientY };
    const at = tileUnder(clientX, clientY);
    setHover((h) => (at?.s === h?.s && at?.k === h?.k ? h : at ? { s: at.s, k: at.k } : null));
  };
  trackRef.current = track;

  // The month headers in the stretch the canvas covers.
  const headers: ReactNode[] = [];
  if (header) {
    for (let s = 0; s < sections.length; s++) {
      const top = layout.tops[s];
      if (top + layout.header < span.from || top > span.to) continue;
      headers.push(
        <div key={sections[s].key} className="g-canvasgrid-head" style={{ top }}>
          {header(sections[s])}
        </div>,
      );
    }
  }

  const item = hover ? sections[hover.s]?.items[hover.k] : undefined;
  const isSelected = !!item && selected.has(item.uid);
  const hoverAt = hover ? { x: (hover.k % layout.columns) * (layout.tile + GRID_GAP), y: layout.tops[hover.s] + layout.header + Math.floor(hover.k / layout.columns) * layout.pitch } : null;
  if (bench.on) benchCount("grids");

  return (
    <div
      ref={wrapRef}
      className="g-canvasgrid"
      // The browser's own scroll anchoring would move the scroll a second time on top of
      // the place kept above, so this list keeps it out.
      style={{ height: layout.height, overflowAnchor: "none", visibility: covered ? "hidden" : undefined }}
      onMouseMove={(e) => track(e.clientX, e.clientY)}
      onMouseLeave={() => {
        pointerRef.current = null;
        setHover(null);
      }}
      // Clicks are found by where they land, not by the element under the pointer, which
      // after a scroll may not have caught up with the tile now there.
      onClick={(e) => {
        const at = tileUnder(e.clientX, e.clientY);
        if (at) latest.current.onOpen?.(at.uid, e);
      }}
      onContextMenu={(e) => {
        const at = tileUnder(e.clientX, e.clientY);
        if (!at || !latest.current.onContext) return;
        e.preventDefault();
        // This photo's menu is the answer to this right-click, so the shell's document
        // listener must not also answer it with its own.
        e.stopPropagation();
        latest.current.onContext(at.uid, e);
      }}
    >
      <canvas ref={canvasRef} className="g-canvasgrid-canvas" aria-hidden />
      {headers}
      {header && sections.length > 0 && (
        <MeasuredHeader onHeight={setHeaderHeight}>{header(sections[0])}</MeasuredHeader>
      )}
      {item && hoverAt && (
        <div
          className={`g-hovercell${isSelected ? " sel" : ""}`}
          style={{ left: hoverAt.x, top: hoverAt.y, width: layout.tile, height: layout.rowH }}
        >
          {onToggle && (
            <span
              className="g-seldot"
              title={isSelected ? t("grid.deselect") : t("grid.select")}
              onClick={(e) => {
                e.stopPropagation();
                latest.current.onToggle?.(item.uid, e);
              }}
            >
              {isSelected ? <CheckIcon size={11} /> : null}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The scroll area the list is in. React attaches a parent element's ref only after its
 * children's layout effects have run, so when the scroll area and this list mount together
 * the ref is not set yet: the scroll area is then found by looking.
 */
function scrollerOf(ref: RefObject<HTMLElement | null>, wrap: HTMLElement | null): HTMLElement | null {
  return ref.current ?? wrap?.closest<HTMLElement>(".g-scroll") ?? null;
}

/** A month header laid out out of sight, to learn the height every header shares. */
function MeasuredHeader({ onHeight, children }: { onHeight: (height: number) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    if (h > 0) onHeight(h);
  });
  return (
    <div ref={ref} className="g-canvasgrid-measure" aria-hidden>
      {children}
    </div>
  );
}
