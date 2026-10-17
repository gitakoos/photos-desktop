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

import { rpc } from "./rpc";
import { isLightboxOpen } from "./lightboxSignal";

/**
 * Video lengths for the grid's duration pill, loaded the way thumbnails are: a cell
 * asks when it scrolls into view, the asks are batched, and the answers are kept.
 *
 * A length is not in the timeline — it lives in the node's encrypted attributes — so
 * every one costs a node decrypt somewhere. Fetching per tile is what that would
 * become if each cell called on its own, so requests are coalesced into one call per
 * batch, and the sidecar answers most of them from its own encrypted cache anyway
 * (the Explorer mount and the search index fill the same entries). The pill simply
 * appears once the number arrives, so nothing waits on it.
 *
 * Cached without a bound, unlike thumbnails: a length is a small number rather than a
 * decoded image, so a whole library's worth is a rounding error against one thumbnail.
 */
const cache = new Map<string, number | null>();
const subs = new Map<string, Set<(ms: number | null) => void>>();
const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let flushing = false;

/**
 * `m:ss`, matching the Android client's own formatter exactly so a video reads the
 * same length on both. Note there is no rollover into hours: Android shows a two-hour
 * video as `123:45`, and diverging here would make the two clients disagree.
 *
 * Truncates rather than rounds, again as Android does — a 7.5 second clip is `0:07`.
 */
export function formatVideoTime(ms: number): string {
  const total = Math.max(0, Math.trunc(ms / 1000));
  const m = Math.trunc(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** A length already known for this photo, without asking for it. */
export function cachedDuration(uid: string): number | null | undefined {
  return cache.get(uid);
}

async function flush(): Promise<void> {
  timer = undefined;
  if (flushing) return; // one drain at a time; it re-reads `pending` each batch
  flushing = true;
  // Larger than the thumbnail batch: these are numbers rather than decrypted images,
  // and most of a batch is answered from the sidecar's cache with no work at all.
  const BATCH = 24;
  while (pending.size > 0) {
    // Stand aside while a photo is open. It needs the one channel for its full-res
    // load, and a pill on a cell behind it can wait.
    while (isLightboxOpen()) {
      await new Promise((r) => setTimeout(r, 150));
    }
    // Newest first, so the rows just scrolled to resolve before ones queued earlier,
    // and drop any cell that scrolled back out of view before its turn came.
    const ordered = [...pending].reverse().filter((uid) => subs.has(uid));
    if (ordered.length === 0) {
      pending.clear();
      break;
    }
    const chunk = ordered.slice(0, BATCH);
    for (const uid of chunk) pending.delete(uid);
    try {
      const res = await rpc<{ uid: string; durationMs: number }[]>("getDurations", {
        uids: chunk,
      });
      const found = new Map(res.map((r) => [r.uid, r.durationMs]));
      for (const uid of chunk) {
        // Absent from the answer means there is no length to show for it. Recording
        // that as a null is what stops the cell asking again on every scroll past.
        const ms = found.get(uid) ?? null;
        cache.set(uid, ms);
        const set = subs.get(uid);
        if (set) for (const cb of set) cb(ms);
      }
    } catch {
      /* one bad batch must not stop the rest; these uids are simply asked again later */
    }
  }
  flushing = false;
}

/** Ask for a now-visible video's length. Returns an unsubscribe. */
export function requestDuration(uid: string, cb: (ms: number | null) => void): () => void {
  const hit = cache.get(uid);
  if (hit !== undefined) {
    cb(hit);
    return () => {};
  }
  let set = subs.get(uid);
  if (!set) {
    set = new Set();
    subs.set(uid, set);
  }
  set.add(cb);
  pending.add(uid);
  if (timer === undefined) timer = setTimeout(flush, 60);
  return () => {
    const s = subs.get(uid);
    if (s) {
      s.delete(cb);
      if (s.size === 0) subs.delete(uid);
    }
  };
}
