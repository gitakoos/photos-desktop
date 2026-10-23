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

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { isVideo as classifyVideo, TAG } from "../lib/tags";
import { cachedThumbnail, requestThumbnail, useThumbServerBase } from "../lib/thumbStore";
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

/** The gap between tiles, matching `.g-grid` in the stylesheet. */
export const GRID_GAP = 6;

/**
 * Android drops the lower-priority corner badges as tiles shrink, so a dense grid does
 * not crowd. It picks the tier from the grid's column count; this grid is sized rather
 * than counted, so the tier comes from what that column count stood for — how wide a
 * tile actually ends up.
 *
 * The thresholds are Android's own tile widths at its tier boundaries, on the 360dp
 * screen its grid is laid out for (20dp side insets, 6dp between columns):
 *
 *   3 columns -> (360 - 40 - 12) / 3 = 102.7dp   every badge
 *   4 columns -> (360 - 40 - 18) / 4 =  75.5dp   one secondary badge beside the cloud
 *   5 columns -> (360 - 40 - 24) / 5 =  59.2dp   the cloud badge alone
 *
 * A dp and a CSS pixel are one and the same here — the badges themselves are ported at
 * 1:1, an 18dp box as an 18px box — so those widths carry over unchanged.
 */
const TIER_ALL_PX = 103;
const TIER_COMPACT_PX = 76;

export type BadgeTier = "all" | "compact" | "minimal";

export function badgeTier(tileWidth: number): BadgeTier {
  if (tileWidth >= TIER_ALL_PX) return "all";
  if (tileWidth >= TIER_COMPACT_PX) return "compact";
  return "minimal";
}

/**
 * What one tile ends up being, which is what the tier reads. This is the arithmetic
 * `repeat(auto-fill, minmax(cellSize, 1fr))` performs: fit as many whole columns as the
 * width allows once the gaps are taken out, then share the remainder between them. So a
 * tile is never narrower than `cellSize` and is usually a little wider.
 */
export function tileWidth(gridWidth: number, cellSize: number): number {
  if (gridWidth <= 0) return cellSize;
  const columns = Math.max(1, Math.floor((gridWidth + GRID_GAP) / (cellSize + GRID_GAP)));
  return (gridWidth - GRID_GAP * (columns - 1)) / columns;
}

const gridStyle = (cellSize: number) => ({
  gridTemplateColumns: `repeat(auto-fill, minmax(${cellSize}px, 1fr))`,
});

/**
 * The one photo-type mark a tile can carry, and the string that names it. Videos are
 * left out on purpose: the play icon in the middle of the tile already marks those, so
 * a second video badge in the corner would say it twice. Same three types as Android,
 * resolved in the same order.
 */
function typeBadgeOf(tags: number[] | undefined): { icon: ReactNode; key: string } | null {
  if (!tags) return null;
  if (tags.includes(TAG.MotionPhoto)) return { icon: <MotionPhotoIcon />, key: "badge.motionPhoto" };
  if (tags.includes(TAG.Panorama)) return { icon: <PanoramaIcon />, key: "badge.panorama" };
  if (tags.includes(TAG.Raw)) return { icon: <RawIcon />, key: "badge.raw" };
  return null;
}

/**
 * One observer for every tile on screen rather than one each: a library of thousands
 * built thousands of them whenever the grid came back in full, such as when a filter was
 * cleared, and that was a visible stall. The margin keeps about two screens ahead, so a
 * tile is usually filled before it scrolls in.
 */
const nearScreen = new Map<Element, (visible: boolean) => void>();
let nearScreenObserver: IntersectionObserver | null = null;

function watchNearScreen(el: Element, onChange: (visible: boolean) => void): () => void {
  if (!nearScreenObserver) {
    nearScreenObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) nearScreen.get(entry.target)?.(entry.isIntersecting);
      },
      { rootMargin: "1200px" },
    );
  }
  nearScreen.set(el, onChange);
  nearScreenObserver.observe(el);
  return () => {
    nearScreen.delete(el);
    nearScreenObserver?.unobserve(el);
  };
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
  renderOverlay?: (item: GridItem) => ReactNode;
};

/** One photo tile: thumbnail, hover select dot, corner badges, optional name. */
export function PhotoCell({
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
  renderOverlay,
}: CellProps) {
  const t = useT();
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
  const served =
    lazy && serverBase
      ? serverBase + encodeURIComponent(item.uid) + (attempt ? `?a=${attempt}` : "")
      : null;
  const fetchesOwn = lazy && !served;
  const imgRef = useRef<HTMLImageElement | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // A tile scrolled away lets go of its request, so the server is not left fetching it
  // ahead of the ones now on screen.
  useEffect(
    () => () => {
      clearTimeout(retryTimer.current);
      const img = imgRef.current;
      if (img && !img.complete) img.removeAttribute("src");
    },
    [],
  );
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

  // Android's ladder, unchanged: at the compact tier the cloud badge keeps its corner and
  // exactly one secondary joins it, picked in this order. At the smallest tier the cloud
  // badge is alone. The play icon is not a badge and stays on every video either way.
  const hasDuration = isVideo && durationMs !== null && durationMs > 0;
  const typeBadge = showBadges ? typeBadgeOf(item.tags) : null;
  const isFavorite = showBadges && !!item.tags?.includes(TAG.Favorite);
  const secondary = hasDuration
    ? "duration"
    : offline
      ? "offline"
      : typeBadge
        ? "type"
        : isFavorite
          ? "favorite"
          : "none";
  const allow = (which: string) =>
    tier === "all" ? true : tier === "compact" ? secondary === which : false;

  const showOffline = offline && allow("offline");
  // The length goes away while a selection is being made, alongside the play icon —
  // what matters then is which photos are picked. The pin stays: that one is about the
  // photo rather than about playing it. It still takes the compact tier's one slot
  // either way, as it does on the phone.
  const showDuration = hasDuration && !selectionMode && allow("duration");
  const showType = !!typeBadge && allow("type");
  const showFavorite = isFavorite && allow("favorite");

  const src = served ?? (lazy ? self : thumb);
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
      {src && broken !== src ? (
        // Eager: the list only builds the rows near the screen, so the browser's own lazy
        // loading only added a wait. A picture already decoded shows at once; one still
        // arriving fades in rather than popping over the empty tile.
        <img
          src={src}
          decoding="async"
          alt=""
          draggable={false}
          ref={(img) => {
            imgRef.current = img;
            if (img && img.complete && img.naturalWidth > 0) img.dataset.ok = "1";
          }}
          onLoad={(e) => {
            e.currentTarget.dataset.ok = "1";
          }}
          onError={() => {
            if (src === served && attempt < 3) {
              retryTimer.current = setTimeout(() => setAttempt(attempt + 1), 1500 * (attempt + 1));
            }
            setBroken(src);
          }}
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

      {showBadges && isVideo && !selectionMode && (
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
            <span className="g-tilebadge g-duration">{formatVideoTime(durationMs!)}</span>
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
}

type GridProps = Omit<CellProps, "item" | "thumb" | "selected" | "tier" | "selectionMode"> & {
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
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (w: number) => {
      const next = badgeTier(tileWidth(w, cellSize));
      setTier((prev) => (prev === next ? prev : next));
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
          {...cell}
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
