/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

/**
 * The size a grid tile asks the thumbnail server for, in device pixels on the picture's
 * shorter side: the tile's height (it is taller than wide, and the picture is cut to fill
 * it), times the screen's pixel ratio, rounded up to one of the sizes the server cuts to.
 * Null when the tile is larger than the largest of them: it takes the full thumbnail.
 *
 * Proton's thumbnail is 512 px; a tile of 120 px decoded and painted sixteen times the
 * pixels it shows, a thousand times over on a wide window.
 */
export const THUMB_WIDTHS = [128, 192, 256, 320, 384] as const;

/** A tile's width over its height, as `.g-cell` draws it (VirtualSections' CELL_ASPECT). */
const TILE_ASPECT = 0.85;

export function thumbPxFor(tileWidth: number, pixelRatio: number): number | null {
  const px = Math.ceil((tileWidth / TILE_ASPECT) * (pixelRatio > 0 ? pixelRatio : 1));
  if (!Number.isFinite(px) || px <= 0) return null;
  for (const w of THUMB_WIDTHS) if (px <= w) return w;
  return null;
}

/** A thumbnail's URL on the server: cut to `px` when given, `attempt` to load it anew. */
export function thumbUrlFor(base: string, uid: string, px: number | null, attempt: number): string {
  const query = new URLSearchParams();
  if (px) query.set("w", String(px));
  if (attempt) query.set("a", String(attempt));
  const q = query.toString();
  return base + encodeURIComponent(uid) + (q ? `?${q}` : "");
}
