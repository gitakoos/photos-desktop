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

/** How the album list is ordered. "custom" is the reader's own arrangement. */
export type AlbumSort = "activity" | "name" | "newest" | "count" | "custom";
/** How the album list is drawn. */
export type AlbumLayout = "grid" | "list";
/** The order of the photos inside one album; "custom" follows the order arranged by hand. */
export type AlbumPhotoOrder = "newest" | "oldest" | "custom";

export const ALBUM_SORT_KEYS: readonly AlbumSort[] = ["activity", "name", "newest", "count", "custom"];

type Sortable = { uid: string; name: string; photoCount: number; lastActivityTime: number };

/** A stored sort, or the default for anything unknown. */
export function readAlbumSort(v: unknown): AlbumSort {
  return ALBUM_SORT_KEYS.includes(v as AlbumSort) ? (v as AlbumSort) : "activity";
}

export function readAlbumLayout(v: unknown): AlbumLayout {
  return v === "list" ? "list" : "grid";
}

/** The Drive link id of a uid, `volume~link`; a bare link id stays as it is. */
export const linkOf = (uid: string): string => uid.slice(uid.lastIndexOf("~") + 1);

/**
 * The stored album arrangement as album link ids, each once: the id every device of the account
 * shares. An arrangement kept from before holds whole uids, read here as their link ids.
 */
export function readAlbumOrder(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string" && x !== "").map(linkOf))];
}

/** The per-album photo orders that are stored: only "oldest" is kept, newest is the default. */
export function readPhotoOrders(v: unknown): Record<string, AlbumPhotoOrder> {
  const out: Record<string, AlbumPhotoOrder> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [uid, order] of Object.entries(v as Record<string, unknown>)) {
      if (order === "oldest") out[uid] = "oldest";
    }
  }
  return out;
}

/**
 * The albums in the chosen order. Every mode ends on the uid, so two albums that agree keep a fixed
 * place. `newest` maps an album to the capture time of its newest photo; albums not read yet follow
 * the ones that are, by last activity. In "custom", an album the arrangement does not name stands
 * first, latest activity first, and the named ones follow in their order.
 */
export function sortAlbums<T extends Sortable>(
  albums: T[],
  sort: AlbumSort,
  order: string[] = [],
  newest: ReadonlyMap<string, number> = new Map(),
): T[] {
  const byUid = (a: T, b: T) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);
  const byActivity = (a: T, b: T) => b.lastActivityTime - a.lastActivityTime || byUid(a, b);
  if (sort === "name") {
    return [...albums].sort(
      (a, b) => (a.name || "").localeCompare(b.name || "", undefined, { numeric: true }) || byUid(a, b),
    );
  }
  if (sort === "count") return [...albums].sort((a, b) => b.photoCount - a.photoCount || byActivity(a, b));
  if (sort === "newest") {
    return [...albums].sort((a, b) => {
      const x = newest.get(a.uid);
      const y = newest.get(b.uid);
      if (x !== undefined && y !== undefined) return y - x || byActivity(a, b);
      if (x !== undefined) return -1;
      if (y !== undefined) return 1;
      return byActivity(a, b);
    });
  }
  if (sort === "custom") {
    const rank = new Map<string, number>();
    order.forEach((id, i) => {
      if (!rank.has(linkOf(id))) rank.set(linkOf(id), i);
    });
    const at = (a: T) => rank.get(linkOf(a.uid));
    const fresh = albums.filter((a) => at(a) === undefined).sort(byActivity);
    const placed = albums.filter((a) => at(a) !== undefined).sort((a, b) => at(a)! - at(b)!);
    return [...fresh, ...placed];
  }
  return [...albums].sort(byActivity);
}

/** `uid` moved onto the place `target` holds: before it when coming from after, after it when coming from before. The same list when either is missing or they are one. */
export function moveOnto(order: string[], uid: string, target: string): string[] {
  if (uid === target || !order.includes(uid) || !order.includes(target)) return order;
  const to = order.indexOf(target);
  const rest = order.filter((u) => u !== uid);
  rest.splice(to, 0, uid);
  return rest;
}

/** `uid` moved one place earlier (-1) or later (1). */
export function nudge(order: string[], uid: string, by: -1 | 1): string[] {
  const i = order.indexOf(uid);
  const j = i + by;
  if (i < 0 || j < 0 || j >= order.length) return order;
  const next = [...order];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** An album's photos in the chosen order; "custom" follows `arrangement` (photo link ids). */
export function orderPhotos<T extends { captureTime: number; uid?: string }>(
  photos: T[],
  order: AlbumPhotoOrder,
  arrangement: readonly string[] = [],
): T[] {
  if (order === "custom") return arrangePhotos(photos, arrangement);
  return [...photos].sort((a, b) => (order === "oldest" ? a.captureTime - b.captureTime : b.captureTime - a.captureTime));
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The phone's rule for a hand-made order: first every photo the arrangement places, in its order,
 * then the ones it does not know (added since the last save, or on a device that never saw them)
 * by Drive capture time ascending, ties on the link id. A link id no photo has (removed, hidden or
 * not listed yet) is skipped and keeps its slot for the day it comes back.
 */
export function arrangePhotos<T extends { captureTime: number; uid?: string }>(photos: T[], arrangement: readonly string[]): T[] {
  const rank = new Map<string, number>();
  arrangement.forEach((k, i) => {
    if (!rank.has(k)) rank.set(k, i);
  });
  const placed: [number, T][] = [];
  const fresh: T[] = [];
  for (const p of photos) {
    const at = rank.get(linkOf(p.uid ?? ""));
    if (at !== undefined) placed.push([at, p]);
    else fresh.push(p);
  }
  placed.sort((a, b) => a[0] - b[0]);
  fresh.sort((a, b) => a.captureTime - b.captureTime || byCodeUnit(linkOf(a.uid ?? ""), linkOf(b.uid ?? "")));
  return [...placed.map(([, p]) => p), ...fresh];
}

/** `order` with the `moving` keys taken out and put first, keeping their order among themselves. */
export function moveToStart(order: string[], moving: ReadonlySet<string>): string[] {
  if (moving.size === 0) return order;
  return [...order.filter((k) => moving.has(k)), ...order.filter((k) => !moving.has(k))];
}

/** `order` with the `moving` keys taken out and put last, keeping their order among themselves. */
export function moveToEnd(order: string[], moving: ReadonlySet<string>): string[] {
  if (moving.size === 0) return order;
  return [...order.filter((k) => !moving.has(k)), ...order.filter((k) => moving.has(k))];
}

function insertAround(order: string[], moving: ReadonlySet<string>, target: string, after: boolean): string[] {
  if (moving.size === 0 || moving.has(target) || !order.includes(target)) return order;
  const block = order.filter((k) => moving.has(k));
  if (block.length === 0) return order;
  const out: string[] = [];
  for (const k of order) {
    if (moving.has(k)) continue;
    if (k === target) out.push(...(after ? [k, ...block] : [...block, k]));
    else out.push(k);
  }
  return out;
}

/** `order` with the `moving` keys put right before `target`; a target that moves itself changes nothing. */
export function moveBefore(order: string[], moving: ReadonlySet<string>, target: string): string[] {
  return insertAround(order, moving, target, false);
}

/** `order` with the `moving` keys put right after `target`; a target that moves itself changes nothing. */
export function moveAfter(order: string[], moving: ReadonlySet<string>, target: string): string[] {
  return insertAround(order, moving, target, true);
}

/**
 * The `moving` keys gathered into one block where `anchor`, the photo held, stands, so a drag
 * carries a scattered selection as one run, in the keys' order among themselves.
 */
export function gather(order: string[], moving: ReadonlySet<string>, anchor: string): string[] {
  if (moving.size < 2 || !moving.has(anchor)) return order;
  const block = order.filter((k) => moving.has(k));
  const out: string[] = [];
  for (const k of order) {
    if (k === anchor) out.push(...block);
    else if (!moving.has(k)) out.push(k);
  }
  return out;
}

/**
 * Where a dragged block lands when dropped on `target`: before it when the target stands before
 * the block, after it otherwise. On the block itself, or on a key the order does not hold, nothing changes.
 */
export function dragTo(order: string[], moving: ReadonlySet<string>, target: string): string[] {
  if (moving.has(target) || moving.size === 0) return order;
  const targetAt = order.indexOf(target);
  const blockAt = order.findIndex((k) => moving.has(k));
  if (targetAt < 0 || blockAt < 0) return order;
  return insertAround(order, moving, target, targetAt > blockAt);
}

/** The `moving` keys, gathered at the first of them, one place earlier (-1) or later (1). */
export function nudgeBlock(order: string[], moving: ReadonlySet<string>, by: -1 | 1): string[] {
  const first = order.find((k) => moving.has(k));
  if (first === undefined) return order;
  const gathered = gather(order, moving, first);
  const start = gathered.indexOf(first);
  const end = start + order.filter((k) => moving.has(k)).length - 1;
  if (by < 0 ? start === 0 : end === gathered.length - 1) return gathered;
  return by < 0 ? moveBefore(gathered, moving, gathered[start - 1]) : moveAfter(gathered, moving, gathered[end + 1]);
}

/**
 * The whole arrangement to store once a session ends with Done. `stored` is the arrangement held
 * before and `arranged` the photos the session showed, as left. A stored key the session did not
 * show (a hidden photo, or one this computer has not listed) keeps its slot, the shown photos take
 * the slots the shown ones held in their new order, and a shown photo the stored list never had
 * joins in its place. With `members` given, a key that is neither a member nor shown is dropped.
 */
export function forSave(stored: readonly string[], arranged: readonly string[], members?: ReadonlySet<string>): string[] {
  const shown = [...new Set(arranged)];
  const shownSet = new Set(shown);
  const kept = [...new Set(stored)].filter((k) => !members || members.has(k) || shownSet.has(k));
  const keptSet = new Set(kept);
  const merged = [...kept, ...shown.filter((k) => !keptSet.has(k))];
  let next = 0;
  return merged.map((k) => (shownSet.has(k) ? shown[next++] : k));
}

/** The capture time of an album's newest photo, or null for an empty album. */
export function newestOf(photos: { captureTime: number }[]): number | null {
  let best: number | null = null;
  for (const p of photos) if (best === null || p.captureTime > best) best = p.captureTime;
  return best;
}

/**
 * Where an open viewer goes once the photo it showed has left a list that is now
 * `remaining` long: the photo that took its place, the new last one past the end, or
 * closed when nothing is left.
 */
export function viewerIndexAfterRemoval(index: number | null, remaining: number): number | null {
  if (index === null || remaining <= 0) return null;
  return Math.min(index, remaining - 1);
}
