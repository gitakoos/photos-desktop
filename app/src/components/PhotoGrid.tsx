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
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { isVideo as classifyVideo, TAG } from "../lib/tags";
import { GRID_GAP, columnsFor } from "../lib/gridLayout";
import { badgeTier, tileBadges, type BadgeTier, type TypeMark } from "../lib/tileBadges";
import { cachedThumbnail, requestThumbnail, useThumbServerBase } from "../lib/thumbStore";
import { keepTileImage, takeTileImage } from "../lib/tileImages";
import { bench, benchCount, benchSpan } from "../lib/benchProbe";
import { thumbPxFor, thumbUrlFor } from "../lib/thumbSize";
import { cachedDuration, formatVideoTime, requestDuration } from "../lib/durations";
import { cachedMediaType, requestMediaType } from "../lib/mediaTypes";
import { useT } from "../lib/i18n";
import {
  CheckIcon,
  CloudIcon,
  HeartIcon,
  MotionPhotoIcon,
  OfflinePinIcon,
  PanoramaIcon,
  PlayArrowIcon,
  RawIcon,
} from "./icons";

export type GridItem = { uid: string; tags?: number[]; name?: string };

export { GRID_GAP };
export { badgeTier, type BadgeTier };

/**
 * What one tile ends up being, which is what the tier reads: the arithmetic
 * `repeat(auto-fill, minmax(cellSize, 1fr))` performs (see gridLayout). A tile is never
 * narrower than `cellSize` and is usually a little wider.
 */
export function tileWidth(gridWidth: number, cellSize: number): number {
  if (gridWidth <= 0) return cellSize;
  const columns = columnsFor(gridWidth, cellSize);
  return (gridWidth - GRID_GAP * (columns - 1)) / columns;
}

const gridStyle = (cellSize: number) => ({
  gridTemplateColumns: `repeat(auto-fill, minmax(${cellSize}px, 1fr))`,
});

/** The icon and the string for each photo-type mark (see tileBadges). */
const TYPE_MARKS: Record<TypeMark, { icon: ReactNode; key: string }> = {
  motionPhoto: { icon: <MotionPhotoIcon />, key: "badge.motionPhoto" },
  panorama: { icon: <PanoramaIcon />, key: "badge.panorama" },
  raw: { icon: <RawIcon />, key: "badge.raw" },
};

/**
 * One observer for every tile in a scroll area rather than one each: a library of
 * thousands built thousands of them whenever the grid came back in full, such as when a
 * filter was cleared, and that was a visible stall. The margin keeps about two screens
 * ahead, so a tile is usually filled before it scrolls in.
 *
 * The observer watches from the scroll area the tile is in, not from the window. A margin
 * only widens the box of the thing watched from, and a tile outside its scroll area's own
 * box is clipped by that area before the window's margin is ever looked at. Watched from
 * the window, the margin did nothing: a tile counted as near only once it was on screen,
 * and as gone the moment it left, so a tile that fetches its own thumbnail let it go and
 * asked for it again on every pass across the screen's edge.
 */
const nearScreen = new Map<Element, (visible: boolean) => void>();
const observers = new WeakMap<Element, IntersectionObserver>();
let windowObserver: IntersectionObserver | null = null;
/** The scroll area around a grid, by the grid: one look per grid, not one per tile. */
const scrollAreas = new WeakMap<Element, Element | null>();

function scrollAreaOf(el: Element): Element | null {
  const grid = el.parentElement;
  if (!grid) return null;
  const known = scrollAreas.get(grid);
  if (known !== undefined) return known;
  let area: Element | null = null;
  for (
    let at: Element | null = grid;
    at && at !== document.body && at !== document.documentElement;
    at = at.parentElement
  ) {
    const overflow = getComputedStyle(at).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") {
      area = at;
      break;
    }
  }
  scrollAreas.set(grid, area);
  return area;
}

function observerFor(area: Element | null): IntersectionObserver {
  const existing = area ? observers.get(area) : windowObserver;
  if (existing) return existing;
  const created = new IntersectionObserver(
    (entries) => {
      const t0 = bench.on ? performance.now() : 0;
      for (const entry of entries) nearScreen.get(entry.target)?.(entry.isIntersecting);
      if (bench.on) {
        benchCount("io", entries.length);
        benchSpan("io_ms", t0);
      }
    },
    { root: area, rootMargin: "1200px" },
  );
  if (area) observers.set(area, created);
  else windowObserver = created;
  return created;
}

function watchNearScreen(el: Element, onChange: (visible: boolean) => void): () => void {
  const observer = observerFor(scrollAreaOf(el));
  nearScreen.set(el, onChange);
  observer.observe(el);
  return () => {
    nearScreen.delete(el);
    observer.unobserve(el);
  };
}

/**
 * Shows a tile's picture now that it has loaded. One that arrives while its tile is on
 * screen fades in rather than popping over the empty tile; one that arrives ahead of the
 * screen, which is most of them during a scroll, is simply there. Fading those too ran
 * a transition for every thumbnail that loaded, some hundred a second with nobody to see
 * them, and the webview spent more of a scroll on that than on anything else.
 *
 * Done once a frame for everything that loaded in it: where each one is gets read first
 * and only then is anything changed, so the page is laid out once for all of them and not
 * once for each.
 */
const justLoaded: HTMLImageElement[] = [];
let showFrame = 0;

function showLoaded(img: HTMLImageElement): void {
  if (bench.on) benchCount("loads");
  if (img.dataset.ok) return;
  justLoaded.push(img);
  if (!showFrame) showFrame = requestAnimationFrame(showJustLoaded);
}

function showJustLoaded(): void {
  showFrame = 0;
  const t0 = bench.on ? performance.now() : 0;
  const batch = justLoaded.splice(0);
  const height = window.innerHeight;
  const onScreen = batch.map((img) => {
    if (!img.isConnected) return false;
    const box = img.getBoundingClientRect();
    return box.bottom > 0 && box.top < height;
  });
  batch.forEach((img, i) => {
    if (onScreen[i]) img.dataset.fade = "1";
    img.dataset.ok = "1";
  });
  if (bench.on) {
    benchCount("shown", batch.length);
    benchCount("fade", onScreen.filter(Boolean).length);
    benchSpan("show_ms", t0);
  }
}

type CellProps = {
  item: GridItem;
  /** Provided by eager callers; `undefined` means "lazy-load when visible". */
  thumb?: string | null;
  selected: boolean;
  /** True while anything at all is selected, which is what mutes the play icon. */
  selectionMode?: boolean;
  onToggle?: (uid: string, e: MouseEvent) => void;
  onOpen?: (uid: string, e: MouseEvent) => void;
  /** Right-click. Offered only by the views that have something to put in a menu. */
  onContext?: (uid: string, e: MouseEvent) => void;
  showBadges?: boolean;
  showName?: boolean;
  /** The app holds its own encrypted copy of this photo: the bottom-start pin. */
  offline?: boolean;
  /** Downloaded into the Proton Photos folder: the bottom-end cloud, in green. */
  local?: boolean;
  /** Badge density, from the tile's rendered width. */
  tier?: BadgeTier;
  /** The size to ask the thumbnail server for (see thumbSize); null for the full picture. */
  thumbPx?: number | null;
  renderOverlay?: (item: GridItem) => ReactNode;
};

/**
 * One photo tile: thumbnail, hover select dot, corner badges, optional name.
 *
 * Drawn again only when something of its own changed. The grid around it is drawn again
 * whenever rows come or go during a scroll, and without this every tile already on screen
 * was worked out again each time, for nothing.
 */
export const PhotoCell = memo(function PhotoCell({
  item,
  thumb,
  selected,
  selectionMode = false,
  onToggle,
  onOpen,
  onContext,
  showBadges = true,
  showName = false,
  offline = false,
  local = false,
  tier = "all",
  thumbPx = null,
  renderOverlay,
}: CellProps) {
  const t = useT();
  if (bench.on) benchCount("cells");
  // `thumb === undefined` -> lazy: fetch this cell's thumbnail only once it
  // scrolls near the viewport, from a bounded LRU, so a huge library never loads
  // every thumbnail into memory at once.
  const lazy = thumb === undefined;
  // With the thumbnail server up a lazy tile is just its URL, and the webview loads and
  // decodes it as it would on any web page. Only without one does the tile fetch its own.
  const serverBase = useThumbServerBase();
  // A served tile that failed asks again a few times, a little later each time: a fetch
  // that stalled or was refused for a moment comes good, and the tile must not stay
  // empty for the rest of its life. The server reads only the path, so the query is
  // only there to make the webview load it again.
  const [attempt, setAttempt] = useState(0);
  const served = lazy && serverBase ? thumbUrlFor(serverBase, item.uid, thumbPx, attempt) : null;
  const fetchesOwn = lazy && !served;
  // A served tile's picture is an image element of its own rather than one drawn here, so
  // that it can outlive the tile: handed over when the tile is taken down and taken back
  // when it is built again, already loaded (see `tileImages`). Before the first paint, so
  // a picture that is already there is in the tile's first frame.
  const picRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = picRef.current;
    if (!served || !slot) return;
    const img = takeTileImage(served);
    const onLoad = () => showLoaded(img);
    const onError = () => {
      if (bench.on) benchCount("err");
      img.remove();
      if (attempt < 3) {
        retryTimer.current = setTimeout(() => setAttempt(attempt + 1), 1500 * (attempt + 1));
      }
    };
    // One kept from before is shown as it was, with nothing left to fade.
    if (img.complete && img.naturalWidth > 0) img.dataset.ok = "1";
    img.addEventListener("load", onLoad);
    img.addEventListener("error", onError);
    slot.appendChild(img);
    return () => {
      clearTimeout(retryTimer.current);
      img.removeEventListener("load", onLoad);
      img.removeEventListener("error", onError);
      img.remove();
      delete img.dataset.fade;
      keepTileImage(served, img);
    };
    // `attempt` is part of `served`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [served]);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // A tile scrolled away lets go of its request, so the server is not left fetching it
  // ahead of the ones now on screen.
  useEffect(() => {
    if (bench.on) benchCount("mount");
    return () => {
      if (bench.on) benchCount("unmount");
      clearTimeout(retryTimer.current);
      const img = imgRef.current;
      if (img && !img.complete) img.removeAttribute("src");
    };
  }, []);
  const ref = useRef<HTMLDivElement>(null);
  const [self, setSelf] = useState<string | null | undefined>(() =>
    lazy ? cachedThumbnail(item.uid) : undefined,
  );
  const [loading, setLoading] = useState(false);

  // The tag settles it when it is there, and nothing needs asking. When it is not, the
  // media type does, because an absent tag is not evidence of a still: everything this
  // app uploaded before it started tagging is a video with no tag on it. Resolved the
  // same way the length is, once the cell is near the viewport.
  const taggedVideo = !!item.tags?.includes(TAG.Video);
  const [mediaType, setMediaType] = useState<string | null | undefined>(() =>
    cachedMediaType(item.uid),
  );
  // Unresolved reads as "not a video" here, because a tile has to draw something now.
  // It costs an icon that appears a moment later, never a wrong one that stays.
  const isVideo = classifyVideo(item.tags, mediaType) ?? false;
  const wantsMediaType = !taggedVideo && showBadges;

  // A length is not in the timeline, so it has to be asked for. Only ever for a video,
  // only where a pill could actually show, and only once the cell is near the viewport —
  // a library's worth of videos asking on mount is the one thing that would make this
  // expensive. The value arrives on its own and the pill appears with it.
  const wantsDuration = isVideo && showBadges && tier !== "minimal";
  const [durationMs, setDurationMs] = useState<number | null>(() =>
    wantsDuration ? cachedDuration(item.uid) ?? null : null,
  );

  useEffect(() => {
    if (!fetchesOwn && !wantsDuration && !wantsMediaType) return;
    const el = ref.current;
    if (!el) return;
    let unsubThumb: (() => void) | undefined;
    let unsubDuration: (() => void) | undefined;
    let unsubMediaType: (() => void) | undefined;
    const stopWatching = watchNearScreen(el, (visible) => {
      if (visible) {
        if (fetchesOwn) {
          const cached = cachedThumbnail(item.uid);
          if (cached !== undefined) {
            setSelf(cached);
            setLoading(false);
          } else {
            setLoading(true);
            unsubThumb = requestThumbnail(item.uid, (url) => {
              setSelf(url);
              setLoading(false);
            });
          }
        }
        if (wantsDuration && !unsubDuration) {
          unsubDuration = requestDuration(item.uid, setDurationMs);
        }
        if (wantsMediaType && !unsubMediaType) {
          unsubMediaType = requestMediaType(item.uid, setMediaType);
        }
      } else {
        // Scrolled far out of view: drop this cell's copy of the thumbnail so
        // a big library's per-cell strings cannot accumulate (the bounded LRU
        // still caches it for an instant re-entry). Keeps the JS heap tied to
        // what is on screen, not to the whole library.
        if (fetchesOwn) {
          unsubThumb?.();
          unsubThumb = undefined;
          setSelf(undefined);
          setLoading(false);
        }
        // The length itself is kept — it is one number, and letting go of it would
        // only mean asking for it again. This just stops a cell nobody is looking at
        // from holding up the queue.
        unsubDuration?.();
        unsubDuration = undefined;
        // Kept for the same reason as the length: it is one short string, and letting
        // go of it would only mean asking for it again.
        unsubMediaType?.();
        unsubMediaType = undefined;
      }
    });
    return () => {
      stopWatching();
      unsubThumb?.();
      unsubDuration?.();
      unsubMediaType?.();
    };
  }, [fetchesOwn, wantsDuration, wantsMediaType, item.uid]);

  const marks = tileBadges({ tags: item.tags, isVideo, durationMs, offline, local, tier, selectionMode, showBadges });
  const showOffline = marks.offline;
  const showDuration = marks.durationMs !== null;
  const typeBadge = marks.type ? TYPE_MARKS[marks.type] : null;
  const showType = !!typeBadge;
  const showFavorite = marks.favorite;

  const src = lazy ? self : thumb;
  // A thumbnail that will not decode shows the empty tile, not the browser's broken image.
  const [broken, setBroken] = useState<string | null>(null);
  return (
    <div
      className={`g-cell ${selected ? "sel" : ""}`}
      ref={ref}
      data-uid={item.uid}
      title={showName ? item.name : undefined}
      onClick={(e) => onOpen?.(item.uid, e)}
      onContextMenu={
        onContext &&
        ((e) => {
          e.preventDefault();
          // This photo's menu is the answer to this right-click, so the shell's
          // document listener must not also answer it with its own.
          e.stopPropagation();
          onContext(item.uid, e);
        })
      }
    >
      {served ? (
        <div className="g-cell-pic" ref={picRef} />
      ) : src && broken !== src ? (
        // Eager: the list only builds the rows near the screen, so the browser's own lazy
        // loading only added a wait. A picture already decoded shows at once; one still
        // arriving fades in rather than popping over the empty tile (see `showLoaded`).
        <img
          src={src}
          decoding="async"
          alt=""
          draggable={false}
          ref={(img) => {
            imgRef.current = img;
            if (img && img.complete && img.naturalWidth > 0) img.dataset.ok = "1";
          }}
          onLoad={(e) => showLoaded(e.currentTarget)}
          onError={() => setBroken(src)}
        />
      ) : (
        <div className={`g-cell-ph${loading ? " g-cell-loading" : ""}`} />
      )}

      {onToggle && (
        <span
          className="g-seldot"
          title={selected ? t("grid.deselect") : t("grid.select")}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(item.uid, e);
          }}
        >
          {selected ? <CheckIcon size={11} /> : null}
        </span>
      )}

      {marks.play && (
        <div className="g-play">
          <PlayArrowIcon size={17} />
        </div>
      )}

      {/* Bottom-start: the offline pin and the duration sit in one row, so they read
          side by side instead of over each other, and the row clears the bottom-end
          corner entirely. */}
      {(showOffline || showDuration) && (
        <div className="g-badgerow">
          {showOffline && (
            <span className="g-tilebadge" title={t("photos.offline")}>
              <OfflinePinIcon size={11} filled />
            </span>
          )}
          {showDuration && (
            <span className="g-tilebadge g-duration">{formatVideoTime(marks.durationMs!)}</span>
          )}
        </div>
      )}

      {/* Bottom-end: the cloud, and the type mark just inside it. */}
      {local && (
        <span className="g-tilebadge g-cloud" title={t("photos.downloaded")}>
          <CloudIcon size={11} filled />
        </span>
      )}
      {(showType || showFavorite) && (
        <div className={`g-tilebadge g-typepill ${local ? "beside-cloud" : ""}`}>
          {showFavorite && (
            <span title={t("badge.favorite")}>
              <HeartIcon size={11} filled />
            </span>
          )}
          {showType && <span title={t(typeBadge!.key)}>{typeBadge!.icon}</span>}
        </div>
      )}

      {renderOverlay?.(item)}
      {showName && item.name && <div className="g-cell-name">{item.name}</div>}
    </div>
  );
});

type GridProps = Omit<CellProps, "item" | "thumb" | "selected" | "tier" | "selectionMode" | "thumbPx"> & {
  items: GridItem[];
  /** Eager thumbnails; omit to let each cell lazy-load its own (large timeline). */
  thumbs?: Record<string, string | null>;
  cellSize: number;
  selected?: Set<string>;
  /** Photos the app keeps its own encrypted copy of. */
  offlineUids?: Set<string>;
  /** Photos downloaded into the Proton Photos folder. */
  localUids?: Set<string>;
};

/** The one photo grid, shared by Photos, Albums and Shared. */
export function PhotoGrid({
  items,
  thumbs,
  cellSize,
  selected,
  offlineUids,
  localUids,
  ...cell
}: GridProps) {
  const ref = useRef<HTMLDivElement>(null);
  // The tier follows the tile a photo actually gets rather than the narrowest one the
  // grid would accept, so it stays right if the sizes or the gap ever move. It starts
  // from `cellSize` alone, which is the floor a tile can never go under, and settles on
  // the measured width once there is one — and only re-renders if that changed the
  // tier at all, so the timeline's month sections do not each pay for a second pass.
  const [tier, setTier] = useState<BadgeTier>(() => badgeTier(cellSize));
  // The size each tile asks the thumbnail server for, from the same measured tile: a
  // picture the size it is shown rather than Proton's 512 px one (see thumbSize).
  const [thumbPx, setThumbPx] = useState<number | null>(() => thumbPxFor(cellSize, window.devicePixelRatio));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (w: number) => {
      const tile = tileWidth(w, cellSize);
      const next = badgeTier(tile);
      setTier((prev) => (prev === next ? prev : next));
      const px = thumbPxFor(tile, window.devicePixelRatio);
      setThumbPx((prev) => (prev === px ? prev : px));
    };
    apply(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = entries[entries.length - 1]?.contentRect.width;
      if (w) apply(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [cellSize]);
  const selectionMode = (selected?.size ?? 0) > 0;
  if (bench.on) benchCount("grids");

  // The callers' handlers are new functions on each of their renders, which would have
  // every tile drawn again with them. Each tile gets one that never changes and calls the
  // latest; whether there is one at all still follows the caller, since that is what puts
  // the select dot and the menu on a tile.
  const { onToggle, onOpen, onContext, ...rest } = cell;
  const latest = useRef({ onToggle, onOpen, onContext });
  latest.current = { onToggle, onOpen, onContext };
  const toggle = useCallback((uid: string, e: MouseEvent) => latest.current.onToggle?.(uid, e), []);
  const open = useCallback((uid: string, e: MouseEvent) => latest.current.onOpen?.(uid, e), []);
  const context = useCallback((uid: string, e: MouseEvent) => latest.current.onContext?.(uid, e), []);

  return (
    <div className="g-grid" style={gridStyle(cellSize)} ref={ref}>
      {items.map((item) => (
        <PhotoCell
          key={item.uid}
          item={item}
          thumb={thumbs ? (thumbs[item.uid] ?? null) : undefined}
          selected={!!selected?.has(item.uid)}
          selectionMode={selectionMode}
          offline={!!offlineUids?.has(item.uid)}
          local={!!localUids?.has(item.uid)}
          tier={tier}
          onToggle={onToggle && toggle}
          onOpen={onOpen && open}
          onContext={onContext && context}
          thumbPx={thumbPx}
          {...rest}
        />
      ))}
    </div>
  );
}

export function PhotoGridSkeleton({ count, cellSize }: { count: number; cellSize: number }) {
  return (
    <div className="g-grid" style={gridStyle(cellSize)}>
      {Array.from({ length: count }).map((_, i) => (
        <div className="g-cell g-skel" key={i} />
      ))}
    </div>
  );
}
