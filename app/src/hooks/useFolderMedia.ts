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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ViewerItem, ViewerList } from "../components/ViewerShell";

/**
 * The other photos and videos in the folder of the file the viewer has open, which is
 * what gives a window opened from Explorer somewhere to step to.
 *
 * Nothing here holds the whole folder. The host keeps the ordered listing and answers a
 * page at a time; this keeps the pages the strip and the contents list have actually
 * scrolled to, and asks for one when a range comes into view that it has no entries for.
 * Fifty thousand files is a scrollbar and a few hundred objects, never fifty thousand.
 */

type FolderEntry = { name: string; size: number; video: boolean };

type FolderPage = {
  dir: string;
  total: number;
  anchorIndex: number;
  offset: number;
  entries: FolderEntry[];
};

/** How many entries one request brings back. Also the granularity of what is kept. */
const PAGE = 200;

// ---- Thumbnails ----
//
// The same shape as the grid's own loader and for the same reasons: cells subscribe when
// they appear, requests are batched, and the decoded pictures sit in a small LRU so what
// is retained stays flat however far the strip is scrolled. What differs is where they
// come from: the Windows shell through the host rather than the sidecar, so nothing here
// needs a session, which is the whole point of this viewer.

const cache = new Map<string, string | null>();
const MAX_CACHED = 300;
const subs = new Map<string, Set<(url: string | null) => void>>();
const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let draining = false;

function keep(path: string, url: string | null): void {
  cache.delete(path);
  cache.set(path, url);
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function drain(): Promise<void> {
  timer = undefined;
  if (draining) return; // one loop at a time; it re-reads `pending` each batch
  draining = true;
  // Matches the host's worker count, so a batch is one round of extraction rather than
  // one thread waiting on the next.
  const BATCH = 8;
  while (pending.size > 0) {
    // Newest first, and never for a tile that has scrolled back out of view: what the
    // reader is looking at now outranks what they scrolled past on the way.
    const ordered = [...pending].reverse().filter((path) => subs.has(path));
    if (ordered.length === 0) {
      pending.clear();
      break;
    }
    const chunk = ordered.slice(0, BATCH);
    for (const path of chunk) pending.delete(path);
    try {
      const urls = await invoke<(string | null)[]>("local_thumbnails", { paths: chunk });
      chunk.forEach((path, i) => {
        const url = urls[i] ?? null;
        keep(path, url);
        const set = subs.get(path);
        if (set) for (const cb of set) cb(url);
      });
    } catch {
      // One bad batch must not stop the rest, and a tile with no picture is a tile with
      // no picture rather than an error anybody can act on.
      for (const path of chunk) keep(path, null);
    }
  }
  draining = false;
}

/** Ask for one file's picture. Returns an unsubscribe. */
export function requestThumbnail(path: string, cb: (url: string | null) => void): () => void {
  const hit = cache.get(path);
  if (hit !== undefined) {
    keep(path, hit);
    cb(hit);
    return () => {};
  }
  let set = subs.get(path);
  if (!set) {
    set = new Set();
    subs.set(path, set);
  }
  set.add(cb);
  pending.add(path);
  if (timer === undefined) timer = setTimeout(drain, 40);
  return () => {
    const live = subs.get(path);
    if (live) {
      live.delete(cb);
      if (live.size === 0) subs.delete(path);
    }
  };
}

/** Windows does not distinguish two paths by case, so neither may this. */
const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export type FolderMedia = {
  /** Absent until the first listing lands, and for a folder holding only this file. */
  list: ViewerList | null;
  onRange: (from: number, to: number) => void;
  hasPrev: boolean;
  hasNext: boolean;
  prev: () => void;
  next: () => void;
};

/**
 * `anchor` is the file on screen; `onPick` is handed the one to move to. Stepping is
 * driven from here rather than from the path, so an arrow press is an index change and
 * a page lookup, and never another listing.
 */
export function useFolderMedia(anchor: string, onPick: (path: string) => void): FolderMedia {
  const [dir, setDir] = useState("");
  const [total, setTotal] = useState(0);
  const [index, setIndex] = useState(-1);
  // Sparse, keyed by the index in the whole folder. A ref rather than state because a
  // page landing has to be visible to the next render without being a render itself.
  const entries = useRef(new Map<number, FolderEntry>());
  const requested = useRef(new Set<number>());
  const [filled, setFilled] = useState(0);

  const pathAt = useCallback(
    (i: number): string | null => {
      const entry = entries.current.get(i);
      return entry && dir ? `${dir}\\${entry.name}` : null;
    },
    [dir],
  );

  const currentPath = pathAt(index);

  // Re-list only when the file on screen is not the one this hook moved to: a rename, or
  // a second file arriving from Explorer. Stepping never comes back through here.
  useEffect(() => {
    if (currentPath && samePath(currentPath, anchor)) return;
    let cancelled = false;
    (async () => {
      try {
        const page = await invoke<FolderPage>("list_media_folder", {
          anchor,
          offset: null,
          limit: PAGE,
        });
        if (cancelled) return;
        entries.current = new Map();
        requested.current = new Set();
        page.entries.forEach((e, i) => entries.current.set(page.offset + i, e));
        requested.current.add(Math.floor(page.offset / PAGE));
        setDir(page.dir);
        setTotal(page.total);
        setIndex(page.anchorIndex);
        setFilled((n) => n + 1);
      } catch {
        // A folder that cannot be listed simply has no neighbours, and the viewer shows
        // the one file it was opened for exactly as it did before.
        if (!cancelled) {
          setTotal(0);
          setIndex(-1);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [anchor, currentPath]);

  /** Fetch whatever pages a visible range needs and does not have. */
  const onRange = useCallback(
    (from: number, to: number) => {
      if (!dir || total === 0) return;
      const firstPage = Math.floor(Math.max(0, from) / PAGE);
      const lastPage = Math.floor(Math.min(total - 1, to) / PAGE);
      for (let p = firstPage; p <= lastPage; p++) {
        if (requested.current.has(p)) continue;
        requested.current.add(p);
        void invoke<FolderPage>("list_media_folder", {
          anchor,
          offset: p * PAGE,
          limit: PAGE,
        })
          .then((page) => {
            page.entries.forEach((e, i) => entries.current.set(page.offset + i, e));
            setFilled((n) => n + 1);
          })
          .catch(() => {
            // Allowed to be asked for again when the reader scrolls back past it.
            requested.current.delete(p);
          });
      }
    },
    [anchor, dir, total],
  );

  const go = useCallback(
    (i: number) => {
      const path = pathAt(i);
      if (!path) return;
      setIndex(i);
      onPick(path);
    },
    [pathAt, onPick],
  );

  const at = useCallback(
    (i: number): ViewerItem | undefined => {
      const entry = entries.current.get(i);
      if (!entry || !dir) return undefined;
      return { key: `${dir}\\${entry.name}`, name: entry.name, size: entry.size, video: entry.video };
    },
    // `filled` is not read, and is the dependency on purpose: it changes when a page
    // lands, which is exactly when the same index starts having an answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dir, filled],
  );

  const list = useMemo<ViewerList | null>(
    () => (total > 1 ? { count: total, index, at, thumb: requestThumbnail, go } : null),
    [total, index, at, go],
  );

  return {
    list,
    onRange,
    hasPrev: index > 0,
    hasNext: index >= 0 && index < total - 1,
    prev: () => go(index - 1),
    next: () => go(index + 1),
  };
}
