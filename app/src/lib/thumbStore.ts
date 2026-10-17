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

import { useSyncExternalStore } from "react";
import { rpc } from "./rpc";
import { isLightboxOpen } from "./lightboxSignal";

// ---- The sidecar's loopback thumbnail server ----
//
// Where the window fetches grid thumbnails as plain image URLs, the way a web page does:
// several at once, decoded off the main thread, never queued on the host channel. The
// base carries a token minted at unlock; until it is known, or if it cannot be had, the
// grid takes the older route below through the channel.

let serverBase: string | null = null;
const serverListeners = new Set<() => void>();

function setServerBase(base: string | null): void {
  serverBase = base;
  for (const listener of serverListeners) listener();
}

/** Asks the sidecar for the server; called once the account is unlocked. */
export async function connectThumbServer(): Promise<void> {
  try {
    setServerBase((await rpc<{ base: string }>("thumbServer")).base);
  } catch {
    setServerBase(null);
  }
}

/** Forgets the server's address, as the sidecar forgets its token at lock. */
export function disconnectThumbServer(): void {
  setServerBase(null);
}

/** A grid thumbnail's URL on the server, or null while there is no server to ask. */
export function thumbUrl(uid: string): string | null {
  return serverBase ? serverBase + encodeURIComponent(uid) : null;
}

/** The server's base for a component, which redraws when it arrives or goes. */
export function useThumbServerBase(): string | null {
  return useSyncExternalStore(
    (listener) => {
      serverListeners.add(listener);
      return () => serverListeners.delete(listener);
    },
    () => serverBase,
  );
}

/**
 * Lazy, bounded thumbnail loader for the grid. Cells subscribe when they scroll
 * into view; requests are batched in small chunks and the decrypted data-URLs are
 * held in a small LRU, so total retained bytes stay bounded no matter how large
 * the library is. The sidecar serves repeats from its encrypted on-disk cache, so
 * re-entering a view is cheap.
 */
const cache = new Map<string, string | null>();
// Bounded by size, not by count: thumbnails run from a couple of KB to some 85 KB as a
// data URL, so a count either wastes room on small ones or overspends on large ones.
// The old 500-entry cap held too few to scroll back through a large library, and every
// tile came back one round trip late. Characters, which are bytes for a data URL.
const MAX_CHARS = 48 * 1024 * 1024;
let cachedChars = 0;
const subs = new Map<string, Set<(url: string | null) => void>>();
const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let flushing = false;

function touch(uid: string, url: string | null): void {
  const previous = cache.get(uid);
  if (previous !== undefined) cachedChars -= previous?.length ?? 0;
  cache.delete(uid);
  cache.set(uid, url);
  cachedChars += url?.length ?? 0;
  while (cachedChars > MAX_CHARS && cache.size > 1) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cachedChars -= cache.get(oldest)?.length ?? 0;
    cache.delete(oldest);
  }
}

export function cachedThumbnail(uid: string): string | null | undefined {
  const hit = cache.get(uid);
  if (hit !== undefined) touch(uid, hit);
  return hit;
}

/**
 * Store a thumbnail resolved by an eager batch loader (`useThumbnails`) in the shared
 * cache, so the covers, the lazy grid and the lightbox fallback all draw from one warm
 * store. Without this, an eager view re-fetched every thumbnail on each revisit and they
 * popped in late even though they had just been on screen.
 */
export function putThumbnail(uid: string, url: string | null): void {
  touch(uid, url);
}

/** How many decrypted thumbnails are currently retained (for the debug HUD). */
export function thumbCacheSize(): number {
  return cache.size;
}

async function flush(): Promise<void> {
  timer = undefined;
  if (flushing) return; // one drain loop at a time; it re-reads `pending` each batch
  flushing = true;
  // A screen's worth: the sidecar answers every cached one at once and fetches only a
  // few uncached ones per call, so a photo-open still waits at most one short fetch.
  // The API itself caps at 30 ids.
  const BATCH = 30;
  while (pending.size > 0) {
    // Stand aside while the viewer is open: a photo-open needs the channel now, and
    // these thumbnails are for cells hidden behind it. Resumes the drain on close.
    while (isLightboxOpen()) {
      await new Promise((r) => setTimeout(r, 150));
    }
    // Newest-requested first, so the page you just scrolled to decrypts before the
    // rows queued earlier; and skip any that scrolled back out of view (no
    // subscribers), so no decrypt is spent on off-screen cells. New requests that
    // arrive mid-drain (you keep scrolling) are picked up on the next batch.
    const ordered = [...pending].reverse().filter((uid) => subs.has(uid));
    if (ordered.length === 0) {
      pending.clear();
      break;
    }
    const chunk = ordered.slice(0, BATCH);
    for (const uid of chunk) pending.delete(uid);
    try {
      const res = await rpc<{ uid: string; dataUrl: string | null }[]>("getThumbnails", {
        uids: chunk,
      });
      const answered = new Set<string>();
      for (const r of res) {
        answered.add(r.uid);
        touch(r.uid, r.dataUrl);
        const set = subs.get(r.uid);
        if (set) for (const cb of set) cb(r.dataUrl);
      }
      // Left for a later call by the sidecar's per-call fetch limit: still wanted, so
      // still queued. A call that answered nothing at all is a stall, not a limit, and
      // asking again at once would only spin.
      if (answered.size > 0) {
        for (const uid of chunk) if (!answered.has(uid) && subs.has(uid)) pending.add(uid);
      }
    } catch {
      /* one bad batch must not stop the rest */
    }
  }
  flushing = false;
}

/** Request a thumbnail for a now-visible cell. Returns an unsubscribe. */
export function requestThumbnail(uid: string, cb: (url: string | null) => void): () => void {
  const hit = cache.get(uid);
  if (hit !== undefined) {
    touch(uid, hit);
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
  if (timer === undefined) timer = setTimeout(flush, 40);
  return () => {
    const s = subs.get(uid);
    if (s) {
      s.delete(cb);
      if (s.size === 0) subs.delete(uid);
    }
  };
}
