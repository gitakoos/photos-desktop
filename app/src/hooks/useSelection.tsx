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

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  CloseIcon,
  DeleteForeverIcon,
  DownloadIcon,
  ImageIcon,
  LibraryAddIcon,
  LibraryRemoveIcon,
  MoreHorizIcon,
  OfflinePinIcon,
  RefreshIcon,
  SweepIcon,
  TrashIcon,
} from "../components/icons";
import { ContextMenu, type MenuAction } from "../components/ContextMenu";
import { useT } from "../lib/i18n";

export type MarqueeRect = { x1: number; y1: number; x2: number; y2: number };

const DRAG_THRESHOLD_PX = 5;

/** Any open dialog or panel, which owns the keyboard while it is up. */
const DIALOG_SELECTOR =
  ".cf-backdrop, .up-page, .st-backdrop, .lbx, .ap-veil";

/** Auto-scroll speed, in px per frame, from the moment the pointer clears the edge
 *  to the point where pulling further adds nothing. */
const AUTOSCROLL_MIN_PX = 4;
const AUTOSCROLL_MAX_PX = 28;
/** How far past the edge the pointer has to go for the scroll to reach full speed. */
const AUTOSCROLL_RAMP_PX = 120;

/** How fast to scroll for a pointer `over` px past the edge. */
function autoScrollSpeed(over: number): number {
  const ramp = Math.min(over / AUTOSCROLL_RAMP_PX, 1);
  return AUTOSCROLL_MIN_PX + (AUTOSCROLL_MAX_PX - AUTOSCROLL_MIN_PX) * ramp;
}

/**
 * The nearest thing that actually scrolls: the container itself, or an ancestor.
 * Photos binds this hook to the scroll area; Albums and the trash bind it to a
 * plain div inside that area, so the scroller has to be looked up rather than
 * assumed to be the element the hook was handed.
 */
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}

type Drag = {
  /** The press point, in client space. Only the threshold and the band's x use it. */
  x: number;
  y: number;
  /**
   * The press point pinned to the content rather than to the window, so a band
   * that scrolls keeps growing from the photo it started on instead of dragging
   * its own origin along. Client-space y is this minus the live `scrollTop`.
   */
  contentY: number;
  active: boolean;
  base: Set<string>;
  scroller: HTMLElement | null;
  /**
   * Every cell's box, measured once when the band starts and pinned to the
   * content the same way `contentY` is. Measuring them per frame instead meant a
   * layout read for every photo in the library on every mouse move and every
   * auto-scrolled frame, which is what made a band over a large library crawl.
   */
  cells: { uid: string; left: number; right: number; top: number; bottom: number }[] | null;
  /** How many tiles were in the document when `cells` was last brought up to date. */
  seen: number;
};

/**
 * Rubber-band selection over anything in `containerRef` carrying `data-uid`.
 *
 * Sweeping a cell flips it against the selection the drag started from, so
 * dragging back across an already selected photo clears it, as on Android. A
 * press that never moves stays a plain click, so cells can still be opened.
 *
 * Dragging past the top or bottom edge scrolls the view and keeps extending the
 * band, the way File Explorer does, faster the further past the edge the pointer
 * goes. The move and release are watched on the window, so the drag survives the
 * pointer leaving the grid. Ending it there would stop the band at the edge.
 *
 * Shift+click selects every photo between the last one picked and this one, and Ctrl+A
 * selects them all, the way File Explorer does. Both read the photos in the order they
 * are on screen from `order`, which the view fills; an empty one turns both off, which
 * is how a view that is mounted but not showing stays out of the way.
 *
 * Shared by every grid in the app: Photos, Albums, Shared.
 */
export function useSelection(containerRef: RefObject<HTMLElement | null>, escEnabled = true) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const draggedRef = useRef(false);
  /** The last pointer position, so a frame with a still pointer can re-test the band. */
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  // A drag is armed here rather than tracked in a ref, so React's own cleanup is
  // what detaches the window listeners and cancels the frame. Unmounting mid-drag
  // then cannot leave either behind.
  const [dragging, setDragging] = useState(false);

  /** The view's photos in screen order, for Shift+click ranges and Ctrl+A. */
  const order = useRef<string[]>([]);
  /** The photo a Shift+click range starts from: the last one picked. */
  const anchorRef = useRef<string | null>(null);

  const clear = useCallback(() => setSelected(new Set()), []);

  const toggle = useCallback((uid: string, e?: { shiftKey?: boolean }) => {
    const list = order.current;
    const from = e?.shiftKey && anchorRef.current ? list.indexOf(anchorRef.current) : -1;
    const to = list.indexOf(uid);
    anchorRef.current = uid;
    if (from >= 0 && to >= 0) {
      const [lo, hi] = from < to ? [from, to] : [to, from];
      setSelected((prev) => {
        const next = new Set(prev);
        for (let i = lo; i <= hi; i++) next.add(list[i]);
        return next;
      });
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }, []);

  // Ctrl+A selects every photo in the view, unless a field or a dialog has the keyboard.
  useEffect(() => {
    if (!escEnabled) return;
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "a" || e.altKey) return;
      if (order.current.length === 0) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true]")) return;
      if (document.querySelector(DIALOG_SELECTOR)) return;
      e.preventDefault();
      setSelected(new Set(order.current));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [escEnabled]);

  // Escape abandons the selection. Disable this while a lightbox or dialog owns
  // the key, so it does not fire twice.
  useEffect(() => {
    if (!escEnabled || selected.size === 0) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") clear();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [escEnabled, selected.size, clear]);

  /** Redraw the band and re-flip what it covers. Runs on a move and on every
   *  auto-scrolled frame, because scrolling moves the photos under a still pointer. */
  const applyDrag = useCallback(() => {
    const drag = dragRef.current;
    const p = pointerRef.current;
    if (!drag?.active || !p) return;

    const scrollTop = drag.scroller?.scrollTop ?? 0;
    const anchorY = drag.contentY - scrollTop;
    const rect: MarqueeRect = {
      x1: Math.min(drag.x, p.x),
      y1: Math.min(anchorY, p.y),
      x2: Math.max(drag.x, p.x),
      y2: Math.max(anchorY, p.y),
    };
    setMarquee(rect);

    // Measured on the first frame of the band rather than at the press, so a
    // press that turns out to be a plain click pays nothing. The timeline builds only the
    // months near the screen, so tiles keep appearing as the band scrolls: any not yet
    // measured are added as they come, and the ones already left behind keep their place.
    const nodes = containerRef.current?.querySelectorAll<HTMLElement>("[data-uid]");
    if (!drag.cells || (nodes && nodes.length !== drag.seen)) {
      const cells = drag.cells ?? [];
      const known = new Set(cells.map((c) => c.uid));
      nodes?.forEach((el) => {
        const uid = el.dataset.uid;
        if (!uid || known.has(uid)) return;
        const r = el.getBoundingClientRect();
        cells.push({
          uid,
          left: r.left,
          right: r.right,
          top: r.top + scrollTop,
          bottom: r.bottom + scrollTop,
        });
      });
      drag.cells = cells;
      drag.seen = nodes?.length ?? 0;
    }

    // Both sides in content space, so a band that auto-scrolls still lines up
    // with boxes measured before the scroll happened.
    const y1 = Math.min(drag.contentY, p.y + scrollTop);
    const y2 = Math.max(drag.contentY, p.y + scrollTop);
    const next = new Set(drag.base);
    for (const c of drag.cells) {
      if (!(c.left < rect.x2 && c.right > rect.x1 && c.top < y2 && c.bottom > y1)) continue;
      if (drag.base.has(c.uid)) next.delete(c.uid);
      else next.add(c.uid);
    }
    setSelected(next);
  }, [containerRef]);

  function onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".g-seldot")) return; // the dot handles itself
    const scroller = scrollerOf(containerRef.current);
    dragRef.current = {
      x: e.clientX,
      y: e.clientY,
      contentY: e.clientY + (scroller?.scrollTop ?? 0),
      active: false,
      base: new Set(selected),
      scroller,
      cells: null,
      seen: 0,
    };
    pointerRef.current = { x: e.clientX, y: e.clientY };
    draggedRef.current = false;
    setDragging(true);
  }

  useEffect(() => {
    if (!dragging) return;

    /** Scroll one step and re-test, for as long as the pointer stays past an edge. */
    function tick() {
      const drag = dragRef.current;
      const p = pointerRef.current;
      const el = drag?.scroller;
      if (!drag?.active || !p || !el) {
        rafRef.current = null;
        return;
      }
      const r = el.getBoundingClientRect();
      const above = r.top - p.y;
      const below = p.y - r.bottom;
      const dy = above > 0 ? -autoScrollSpeed(above) : below > 0 ? autoScrollSpeed(below) : 0;
      if (dy === 0) {
        rafRef.current = null; // back inside: a later move starts it again
        return;
      }
      const before = el.scrollTop;
      el.scrollTop = before + dy;
      // At either end there is nothing left to scroll, so the band has not moved
      // and there is nothing to re-test; the frames keep coming so that letting go
      // is what stops this, not running out of photos.
      if (el.scrollTop !== before) applyDrag();
      rafRef.current = requestAnimationFrame(tick);
    }

    function onMove(e: globalThis.MouseEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      if (!drag.active) {
        if (
          Math.abs(e.clientX - drag.x) < DRAG_THRESHOLD_PX &&
          Math.abs(e.clientY - drag.y) < DRAG_THRESHOLD_PX
        ) {
          return;
        }
        drag.active = true;
        draggedRef.current = true;
      }
      pointerRef.current = { x: e.clientX, y: e.clientY };
      applyDrag();
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(tick);
    }

    function onUp() {
      dragRef.current = null;
      pointerRef.current = null;
      setMarquee(null);
      setDragging(false);
      // Swallow the click a drag emits, then re-arm for the next real click.
      if (draggedRef.current) setTimeout(() => (draggedRef.current = false), 0);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    // Releasing over another window never reaches us, so losing focus ends it too.
    window.addEventListener("blur", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onUp);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [dragging, applyDrag]);

  return {
    selected,
    setSelected,
    toggle,
    clear,
    order,
    marquee,
    wasDragging: () => draggedRef.current,
    containerProps: { onMouseDown },
  };
}

export function Marquee({ rect }: { rect: MarqueeRect | null }) {
  if (!rect) return null;
  return (
    <div
      className="g-marquee"
      style={{
        left: rect.x1,
        top: rect.y1,
        width: rect.x2 - rect.x1,
        height: rect.y2 - rect.y1,
      }}
    />
  );
}

/**
 * The selection bar every grid shares. Each action is opt-in, so a view offers
 * only what it can actually do: the timeline and albums trash, while the trash
 * restores. Deleting for good is the one action with no way back, so it sits
 * last, past a divider, well clear of where restore is about to be clicked.
 *
 * While one action is running the rest stand down with it. A large selection shows
 * nothing at all until its toast arrives, which reads as a click that missed and
 * invites a second one: the same photos downloaded twice, or trashed twice. Cancelling
 * the selection stays live throughout, because backing out is never the wrong answer.
 */
/** One action on the bar, in the one shape the row, the menu and the measuring share. */
type BarAction = {
  key: string;
  labelKey: string;
  icon: ReactNode;
  onSelect: () => void;
  tone?: "primary" | "danger";
  /** Sits past a divider, apart from everything that can be taken back. */
  apart?: boolean;
};

/**
 * How much of the bar is on the row: labels and all, icons only, and how many of the
 * actions made it before the rest went behind the overflow button.
 */
type Fit = { tier: "full" | "icons"; shown: number };

export function SelectionBar({
  count,
  busy,
  onCancel,
  onTrash,
  onDownload,
  onFreeUp,
  onOfflineAdd,
  onOfflineRemove,
  onRestore,
  onDeleteForever,
  onAddToAlbum,
  onRemoveFromAlbum,
  onSetCover,
}: {
  count: number;
  /** True while one of the actions below is still working. */
  busy?: boolean;
  onCancel: () => void;
  onTrash?: () => void;
  onDownload?: () => void;
  onFreeUp?: () => void;
  /**
   * Keep the selection inside the app for offline use. A different place from
   * Download, which writes to the Explorer folder or to one the user picks, so the
   * two sit apart in the bar rather than reading as a pair.
   */
  onOfflineAdd?: () => void;
  onOfflineRemove?: () => void;
  onRestore?: () => void;
  onDeleteForever?: () => void;
  onAddToAlbum?: () => void;
  onRemoveFromAlbum?: () => void;
  /** A cover is one photo, so the caller passes this only when one is selected. */
  onSetCover?: () => void;
}) {
  const t = useT();
  const barRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);

  const actions = useMemo(() => {
    const list: BarAction[] = [];
    const add = (
      on: (() => void) | undefined,
      key: string,
      icon: ReactNode,
      tone?: BarAction["tone"],
      apart?: boolean,
    ) => {
      if (on) list.push({ key, labelKey: `selection.${key}`, icon, onSelect: on, tone, apart });
    };
    add(onRestore, "restore", <RefreshIcon size={18} />, "primary");
    add(onAddToAlbum, "addToAlbum", <LibraryAddIcon size={18} />);
    add(onSetCover, "setCover", <ImageIcon size={18} />);
    add(onDownload, "download", <DownloadIcon size={18} />);
    add(onFreeUp, "freeUp", <SweepIcon size={18} />);
    add(onOfflineAdd, "offlineAdd", <OfflinePinIcon size={18} />);
    add(onOfflineRemove, "offlineRemove", <OfflinePinIcon size={18} />);
    add(onRemoveFromAlbum, "removeFromAlbum", <LibraryRemoveIcon size={18} />);
    add(onTrash, "trash", <TrashIcon size={18} />, "danger");
    add(onDeleteForever, "deleteForever", <DeleteForeverIcon size={18} />, "danger", true);
    return list;
  }, [
    onRestore,
    onAddToAlbum,
    onSetCover,
    onDownload,
    onFreeUp,
    onOfflineAdd,
    onOfflineRemove,
    onRemoveFromAlbum,
    onTrash,
    onDeleteForever,
  ]);

  const [fit, setFit] = useState<Fit>({ tier: "full", shown: actions.length });

  // Which actions are on offer, not just how many: keeping a selection offline and
  // taking it back swap for each other at equal length, and their labels are not the
  // same width. `t` changes only with the language, and a language change is exactly
  // when every label on the row is a different size.
  const offered = actions.map((a) => a.key).join(",");

  // Start over whenever what has to fit, or the room it has to fit in, changes.
  // Stepping down is one-way, so without a reset the bar could only ever shrink,
  // and a window pulled wide again would keep the narrow layout it settled on.
  useEffect(() => {
    const reset = () => setFit({ tier: "full", shown: actions.length });
    reset();
    window.addEventListener("resize", reset);
    return () => window.removeEventListener("resize", reset);
    // `offered` stands in for `actions`, which is a fresh array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offered, t]);

  // Measured rather than guessed from a breakpoint: the same seven actions are far
  // wider in German than in English, and a threshold picked for one would cut the
  // other short. Each pass drops one step and re-measures, so it settles on the most
  // it can actually show. Strictly downward and bounded, so it always terminates.
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    if (el.scrollWidth <= el.clientWidth + 1) return;
    if (fit.tier === "full") setFit({ tier: "icons", shown: actions.length });
    else if (fit.shown > 1) setFit({ tier: "icons", shown: fit.shown - 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit, offered, count, busy]);

  if (count === 0) return null;

  const shown = actions.slice(0, fit.shown);
  const hidden = actions.slice(fit.shown);
  const menuActions: MenuAction[] = hidden.map((a) => ({
    key: a.key,
    label: t(a.labelKey),
    icon: a.icon,
    danger: a.tone === "danger",
    disabled: busy,
    onSelect: a.onSelect,
  }));

  return (
    <>
      <div className="g-selbar" data-tier={fit.tier} ref={barRef}>
        <button className="g-selx" title={t("selection.cancel")} onClick={onCancel}>
          <CloseIcon size={13} />
        </button>
        <span className="g-selcount">
          {t(count === 1 ? "selection.count.one" : "selection.count.other", { count })}
        </span>
        {shown.map((a) => (
          <span className="g-selslot" key={a.key}>
            {a.apart && <span className="g-selsep" />}
            {/* The label can be gone, so the name the tooltip and the screen reader
                use is set here rather than left to the text inside. */}
            <button
              className={`g-selbtn${a.tone ? ` ${a.tone}` : ""}`}
              disabled={busy}
              onClick={a.onSelect}
              title={t(a.labelKey)}
              aria-label={t(a.labelKey)}
            >
              <span className="g-selicon">{a.icon}</span>
              <span className="g-sellabel">{t(a.labelKey)}</span>
            </button>
          </span>
        ))}
        {hidden.length > 0 && (
          <button
            className="g-selbtn"
            ref={moreRef}
            disabled={busy}
            title={t("selection.more")}
            aria-label={t("selection.more")}
            onClick={() => {
              const r = moreRef.current?.getBoundingClientRect();
              if (r) setMenuAt({ x: r.left, y: r.top });
            }}
          >
            <span className="g-selicon">
              <MoreHorizIcon size={18} />
            </span>
            <span className="g-sellabel">{t("selection.more")}</span>
          </button>
        )}
      </div>

      {menuAt && (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          actions={menuActions}
          onClose={() => setMenuAt(null)}
        />
      )}
    </>
  );
}
