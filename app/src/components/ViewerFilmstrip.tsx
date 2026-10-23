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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatBytes } from "../lib/format";
import { CloseIcon, PlayArrowIcon } from "./icons";
import { useT } from "../lib/i18n";
import type { ViewerList } from "./ViewerShell";

/**
 * The two ways out of the photo on screen and into one of its neighbours: a strip of
 * them along the bottom, and the whole list in a panel.
 *
 * Both draw from the same `ViewerList`, and both draw only what is on screen. A folder
 * of fifty thousand photos is fifty thousand positions in a scrollbar and about fifteen
 * elements in the document, and a thumbnail is asked for when its tile appears and
 * dropped when it leaves, so nothing is fetched for a row nobody has scrolled to.
 */

// The strip's geometry, in CSS pixels, carried here rather than in the stylesheet
// because the windowing arithmetic below has to agree with it exactly.
const TILE = 54;
const GAP = 5;
const PAD = 16;
const STEP = TILE + GAP;
/** Tiles drawn beyond each edge, so a fast scroll does not show empty space. */
const OVERSCAN = 4;

const ROW = 60;
const ROW_OVERSCAN = 6;

/** Which indices a scroller of `viewport` px at `scroll` px is showing, plus the overscan. */
function windowOf(
  scroll: number,
  viewport: number,
  step: number,
  count: number,
  overscan: number,
): { first: number; last: number } {
  if (count === 0 || viewport === 0) return { first: 0, last: -1 };
  const first = Math.max(0, Math.floor(scroll / step) - overscan);
  const last = Math.min(count - 1, Math.ceil((scroll + viewport) / step) + overscan);
  return { first, last };
}

/** The element's own size, kept current as the window is resized. */
function useViewport(ref: React.RefObject<HTMLElement | null>, vertical = false): number {
  const [size, setSize] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize(vertical ? el.clientHeight : el.clientWidth);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, vertical]);
  return size;
}

/** The live scroll offset of an element, sampled once per frame rather than per event. */
function useScrollOffset(ref: React.RefObject<HTMLElement | null>, vertical = false): number {
  const [offset, setOffset] = useState(0);
  const queued = useRef(false);
  const onScroll = useCallback(() => {
    if (queued.current) return;
    queued.current = true;
    requestAnimationFrame(() => {
      queued.current = false;
      const el = ref.current;
      if (el) setOffset(vertical ? el.scrollTop : el.scrollLeft);
    });
  }, [ref, vertical]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [ref, onScroll]);
  return offset;
}

/**
 * One item's picture, asked for when this appears and dropped when it goes.
 *
 * `list.thumb` has to be stable across renders, or every frame would unsubscribe and
 * resubscribe; both callers hand in a memoised one.
 */
function ViewerThumb({ index, list }: { index: number; list: ViewerList }) {
  const item = list.at(index);
  const key = item?.key;
  const thumb = list.thumb;
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    setUrl(null);
    if (!key) return;
    return thumb(key, setUrl);
  }, [key, thumb]);

  // No spinner and no broken-image state: an empty tile is the backing colour, and the
  // picture appears over it when it lands.
  return url ? <img className="lbx-strip-img" src={url} alt="" draggable={false} /> : null;
}

type StripProps = {
  list: ViewerList;
  /** Reports what is on screen, so the source can fetch the pages behind it. */
  onRange?: (from: number, to: number) => void;
};

/**
 * The neighbours of the photo on screen, along the bottom.
 *
 * Ported from the Android viewer, which it matches in geometry and in behaviour: the
 * whole list rather than a window of it, the current item ringed in white at full
 * opacity while the rest sit at 45%, and the selection kept centred as it moves. The
 * one departure is that a video tile is marked as one, because this viewer has no
 * scrubber to widen the tile into the way the phone does.
 */
export function ViewerFilmstrip({ list, onRange }: StripProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const viewport = useViewport(ref);
  const scroll = useScrollOffset(ref);
  const { count, index } = list;

  const { first, last } = windowOf(scroll, viewport, STEP, count, OVERSCAN);

  useEffect(() => {
    if (last >= first) onRange?.(first, last);
  }, [first, last, onRange]);

  // The selection stays centred, as it does on the phone. Scrolling the reel by hand is
  // deliberately not suppressed here the way Android suppresses it mid-drag: this runs
  // only when the selection itself moves, and everything that moves it (an arrow, a tile,
  // a video ending) is somebody asking to be taken there.
  useEffect(() => {
    const el = ref.current;
    if (!el || viewport === 0) return;
    el.scrollTo({ left: Math.max(0, PAD + index * STEP + TILE / 2 - viewport / 2), behavior: "smooth" });
  }, [index, viewport, count]);

  if (count <= 1) return null;

  const tiles = [];
  for (let i = first; i <= last; i++) {
    const item = list.at(i);
    tiles.push(
      <button
        key={i}
        className={`lbx-strip-tile ${i === index ? "cur" : ""}`}
        style={{ left: PAD + i * STEP }}
        title={item?.name}
        aria-label={item?.name ?? String(i + 1)}
        aria-current={i === index || undefined}
        onClick={(e) => {
          e.stopPropagation();
          list.go(i);
        }}
      >
        <ViewerThumb index={i} list={list} />
        {item?.video && (
          <span className="lbx-strip-play">
            <PlayArrowIcon size={13} />
          </span>
        )}
      </button>,
    );
  }

  // The wheel scrolls the strip sideways, the way a row of photos is read. Bound natively,
  // since a passive React listener could not keep the wheel from the picture.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (!el) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!delta) return;
      e.preventDefault();
      el.scrollBy({ left: delta, behavior: "auto" });
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div
      className="lbx-strip"
      ref={ref}
      role="group"
      aria-label={t("viewer.filmstrip")}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="lbx-strip-rail" style={{ width: PAD * 2 + count * STEP - GAP }}>
        {tiles}
      </div>
    </div>
  );
}

type ContentsProps = StripProps & { closing?: boolean; onClose: () => void };

/**
 * Everything the viewer can open, as a list: a picture, a name and a size for each.
 *
 * The same windowing as the strip, for the same reason. A name or a size the source has
 * not resolved yet is simply absent rather than guessed at, and fills in when it lands.
 */
export function ViewerContents({ list, onRange, closing, onClose }: ContentsProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const viewport = useViewport(ref, true);
  const scroll = useScrollOffset(ref, true);
  const { count, index } = list;

  const { first, last } = windowOf(scroll, viewport, ROW, count, ROW_OVERSCAN);

  useEffect(() => {
    if (last >= first) onRange?.(first, last);
  }, [first, last, onRange]);

  // Opens where the reader already is, rather than at the top of a list of thousands.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = Math.max(0, index * ROW - el.clientHeight / 2 + ROW / 2);
    // Once, on open: following the selection afterwards would fight the reader's scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = [];
  for (let i = first; i <= last; i++) {
    const item = list.at(i);
    rows.push(
      <button
        key={i}
        className={`lbx-contents-row ${i === index ? "cur" : ""}`}
        style={{ top: i * ROW }}
        aria-current={i === index || undefined}
        onClick={() => list.go(i)}
      >
        {/* The badge sits over the picture rather than beside the name, so a row with a
            video in it keeps the same columns as a row without one. */}
        <span className="lbx-contents-thumb">
          <ViewerThumb index={i} list={list} />
          {item?.video && (
            <span className="lbx-contents-play">
              <PlayArrowIcon size={11} />
            </span>
          )}
        </span>
        <span className="lbx-contents-name">{item?.name ?? "…"}</span>
        <span className="lbx-contents-size">
          {item && item.size !== undefined && item.size !== null ? formatBytes(item.size) : ""}
        </span>
      </button>,
    );
  }

  return (
    // Docked beside the picture like the details, and kept open while the reader moves
    // through the list. Stopped: the whole viewer closes on a click.
    <aside
      className={`lbx-aside lbx-contents ${closing ? "closing" : ""}`}
      aria-label={t("viewer.contents")}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="lbx-details-head">
        <h3>{t("viewer.contents")}</h3>
        <span className="lbx-contents-count">{t("viewer.position", { n: index + 1, total: count })}</span>
        <button className="lbx-ibtn" onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>
          <CloseIcon size={14} />
        </button>
      </div>
      <div className="lbx-contents-scroll" ref={ref}>
          <div className="lbx-contents-rail" style={{ height: count * ROW }}>
            {rows}
          </div>
      </div>
    </aside>
  );
}
