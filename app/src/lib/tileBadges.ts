/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { TAG } from "./tags";

/**
 * Which marks a grid tile carries. One answer for the DOM tile and the canvas grid alike,
 * so the two can never disagree on what a photo shows.
 *
 * Android drops the lower-priority corner badges as tiles shrink, so a dense grid does
 * not crowd. Its tier comes from the grid's column count; here from what that column count
 * stood for, how wide a tile ends up. The thresholds are Android's own tile widths at its
 * tier boundaries, on the 360dp screen its grid is laid out for (20dp side insets, 6dp
 * between columns), and a dp is a CSS pixel here:
 *
 *   3 columns -> (360 - 40 - 12) / 3 = 102.7dp   every badge
 *   4 columns -> (360 - 40 - 18) / 4 =  75.5dp   one secondary badge beside the cloud
 *   5 columns -> (360 - 40 - 24) / 5 =  59.2dp   the cloud badge alone
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
 * The one photo-type mark a tile can carry. Videos are left out on purpose: the play icon
 * in the middle already marks those. Same three types as Android, in the same order.
 */
export type TypeMark = "motionPhoto" | "panorama" | "raw";

export function typeMarkOf(tags: number[] | undefined): TypeMark | null {
  if (!tags) return null;
  if (tags.includes(TAG.MotionPhoto)) return "motionPhoto";
  if (tags.includes(TAG.Panorama)) return "panorama";
  if (tags.includes(TAG.Raw)) return "raw";
  return null;
}

export type TileBadges = {
  /** The play icon in the middle. */
  play: boolean;
  /** Bottom-start: the offline pin, then the length. */
  offline: boolean;
  /** The length to show, or null. */
  durationMs: number | null;
  /** Bottom-end: the green cloud. */
  local: boolean;
  /** Just inside the cloud: the heart and the type mark, in one pill. */
  favorite: boolean;
  type: TypeMark | null;
};

export function tileBadges(input: {
  tags: number[] | undefined;
  isVideo: boolean;
  durationMs: number | null | undefined;
  offline: boolean;
  local: boolean;
  tier: BadgeTier;
  /** True while anything at all is selected: the play icon and the length step aside. */
  selectionMode: boolean;
  showBadges: boolean;
}): TileBadges {
  const { tags, isVideo, offline, local, tier, selectionMode, showBadges } = input;
  const hasDuration = isVideo && input.durationMs != null && input.durationMs > 0;
  const type = showBadges ? typeMarkOf(tags) : null;
  const isFavorite = showBadges && !!tags?.includes(TAG.Favorite);
  // Android's ladder: at the compact tier the cloud keeps its corner and exactly one
  // secondary joins it, picked in this order. At the smallest tier the cloud is alone.
  const secondary = hasDuration ? "duration" : offline ? "offline" : type ? "type" : isFavorite ? "favorite" : "none";
  const allow = (which: string) => (tier === "all" ? true : tier === "compact" ? secondary === which : false);
  return {
    play: showBadges && isVideo && !selectionMode,
    offline: offline && allow("offline"),
    // The length goes away while a selection is being made, alongside the play icon; the
    // pin stays, being about the photo rather than about playing it.
    durationMs: hasDuration && !selectionMode && allow("duration") ? input.durationMs! : null,
    local,
    favorite: isFavorite && allow("favorite"),
    type: type && allow("type") ? type : null,
  };
}
