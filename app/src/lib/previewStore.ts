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

/**
 * Shared HD-preview cache and prefetcher.
 *
 * The SDK only exposes the fetch (`iterateThumbnails` with the HD type); there is
 * no prefetch or index, so we own it. The sidecar already keeps decrypted
 * thumbnails in its encrypted on-disk cache, so a warmed neighbour is a local
 * read rather than a download.
 *
 * In-flight requests are deduplicated: opening a photo the prefetcher is already
 * loading joins that request rather than issuing a second one.
 */
const cache = new Map<string, string | null>();

/**
 * A request that has gone out and not yet answered, with the handle that lets go of it.
 *
 * Held per photo rather than as one running generation, because warming a neighbour is
 * exactly a request for a photo nobody has opened yet: the one the reader steps to next
 * is very often already in here, and dropping it on the step would throw away the warm
 * at the moment it finally pays off.
 */
type Live = { request: Promise<string | null>; controller: AbortController };
const inFlight = new Map<string, Live>();

// Bound the HD-preview cache: without a cap, stepping through the lightbox keeps
// every 1920px data-URL in memory until reload. Map preserves insertion order,
// so `touch` (delete + re-set, evict oldest over the cap) gives a simple LRU.
const MAX_PREVIEWS = 48;

function touch(uid: string, url: string | null): void {
  cache.delete(uid);
  cache.set(uid, url);
  while (cache.size > MAX_PREVIEWS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function cachedPreview(uid: string): string | null | undefined {
  const hit = cache.get(uid);
  if (hit !== undefined) touch(uid, hit); // mark most-recently-used
  return hit;
}

/** How many HD previews are currently retained (for the debug HUD). */
export function previewCacheSize(): number {
  return cache.size;
}

export function loadPreview(uid: string): Promise<string | null> {
  const hit = cache.get(uid);
  if (hit !== undefined) {
    touch(uid, hit);
    return Promise.resolve(hit);
  }

  const existing = inFlight.get(uid);
  if (existing) return existing.request;

  const controller = new AbortController();
  // Only while this is still the live request for the photo. One that was let go of may
  // already have been replaced by a fresh request for the same photo, and clearing the
  // entry blindly would take that successor down with it.
  const settle = () => {
    if (inFlight.get(uid)?.controller === controller) inFlight.delete(uid);
  };

  const request = rpc<string | null>("getPreview", { uid }, { signal: controller.signal })
    .then((url) => {
      touch(uid, url);
      settle();
      return url;
    })
    .catch(() => {
      settle();
      return null; // a failed or abandoned preview falls back to the grid thumbnail
    });

  inFlight.set(uid, { request, controller });
  return request;
}

/**
 * Let go of every request in flight for a photo outside `keep`.
 *
 * The viewer's cost per photo is one preview, and the sidecar answers one call at a
 * time, so a quick run through fifty photos would leave fifty of them queued and the
 * photo the reader stopped on waiting behind the lot. Nothing wants those answers any
 * more by then, and this is where that is said out loud: the host drops a call it has
 * not started, so a superseded preview stops costing the channel anything at all.
 *
 * Dropped from the in-flight map as well as aborted, so opening one of those photos
 * later asks again rather than joining a request that is never coming back.
 */
function abandonPreviewsOutside(keep: Iterable<string>): void {
  const wanted = new Set(keep);
  for (const [uid, live] of inFlight) {
    if (wanted.has(uid)) continue;
    inFlight.delete(uid);
    live.controller.abort();
  }
}

/** Warm neighbours so stepping through the lightbox is instant. */
export function prefetchPreviews(uids: string[]): void {
  for (const uid of uids) {
    if (cache.has(uid) || inFlight.has(uid)) continue;
    void loadPreview(uid);
  }
}

/**
 * Warm the neighbours, but only once the photo now on screen has resolved, so the
 * prefetch never competes with the preview the user is actually waiting for. The
 * current request is deduplicated, so awaiting it here joins the viewer's own load
 * rather than issuing a second one. Returns a canceller: stepping away before the
 * current resolves drops the now-stale warm.
 */
export function prefetchAfter(currentUid: string, neighbourUids: string[]): () => void {
  // Anything still in flight for a photo that is neither the one on screen nor one of
  // its neighbours belongs to a photo the reader has already gone past. Every caller
  // runs this on each step, so letting go here is what keeps a run through the viewer
  // from burying the photo it ends on under its own wake.
  abandonPreviewsOutside([currentUid, ...neighbourUids]);
  let cancelled = false;
  void loadPreview(currentUid).then(() => {
    if (!cancelled) prefetchPreviews(neighbourUids);
  });
  return () => {
    cancelled = true;
  };
}

/** Called after a rename or trash so a stale entry cannot be served. */
export function dropPreview(uid: string): void {
  cache.delete(uid);
  const live = inFlight.get(uid);
  if (live) {
    inFlight.delete(uid);
    live.controller.abort();
  }
}
