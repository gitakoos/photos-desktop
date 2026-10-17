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
 * Media types, loaded the way the duration pills are: a cell asks when it scrolls into
 * view, the asks are batched, and the answers are kept.
 *
 * This is what makes a video a video here. The Videos tag says so when it is present, but
 * its absence says nothing at all: a file uploaded by a client that set no tag carries
 * none, and reading video-ness off the tag alone showed those as still photos that would
 * not play. The media type is the file's own account of itself, so it is right for
 * everything already in the library, whoever put it there and whenever.
 *
 * The timeline does not carry it. The server's listing returns capture time, hashes and
 * tags, and nothing more, so it costs a node lookup somewhere. Which is why nothing asks
 * for the whole library: cells ask for themselves as they come into view, the asks are
 * coalesced into one call per batch, and the sidecar answers most of them from its own
 * encrypted cache, which the search index, the Explorer mount and the duration resolver
 * all fill with the same entries.
 *
 * Cached without a bound, like the durations: a short string per photo is a rounding
 * error against a single decoded thumbnail.
 */
const cache = new Map<string, string | null>();
const subs = new Map<string, Set<(mediaType: string | null) => void>>();
const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let flushing = false;

/** A media type already known for this photo, without asking for it. */
export function cachedMediaType(uid: string): string | null | undefined {
  return cache.get(uid);
}

async function flush(): Promise<void> {
  timer = undefined;
  if (flushing) return; // one drain at a time; it re-reads `pending` each batch
  flushing = true;
  // The same batch size the durations use, and for the same reason: these are short
  // strings rather than decrypted images, and most of a batch costs the sidecar nothing.
  const BATCH = 24;
  while (pending.size > 0) {
    // Stand aside while a photo is open. It needs the one channel for its full-res load,
    // and a play icon on a cell behind it can wait.
    while (isLightboxOpen()) {
      await new Promise((r) => setTimeout(r, 150));
    }
    // Newest first, so the rows just scrolled to resolve before ones queued earlier, and
    // drop any cell that scrolled back out of view before its turn came.
    const ordered = [...pending].reverse().filter((uid) => subs.has(uid));
    if (ordered.length === 0) {
      pending.clear();
      break;
    }
    const chunk = ordered.slice(0, BATCH);
    for (const uid of chunk) pending.delete(uid);
    try {
      const res = await rpc<{ uid: string; mediaType: string | null }[]>("getMediaTypes", {
        uids: chunk,
      });
      const found = new Map(res.map((r) => [r.uid, r.mediaType]));
      for (const uid of chunk) {
        // Absent from the answer means the node could not be resolved at all. Recording
        // that as a null is what stops the cell asking again on every scroll past.
        const mediaType = found.get(uid) ?? null;
        cache.set(uid, mediaType);
        const set = subs.get(uid);
        if (set) for (const cb of set) cb(mediaType);
      }
    } catch {
      /* one bad batch must not stop the rest; these uids are simply asked again later */
    }
  }
  flushing = false;
}

/** Ask for a now-visible photo's media type. Returns an unsubscribe. */
export function requestMediaType(
  uid: string,
  cb: (mediaType: string | null) => void,
): () => void {
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
