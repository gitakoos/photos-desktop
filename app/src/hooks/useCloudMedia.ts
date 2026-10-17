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

import { useCallback, useEffect, useMemo, useState } from "react";
import { rpc } from "../lib/rpc";
import { cachedThumbnail, thumbUrl } from "../lib/thumbStore";
import type { ViewerItem, ViewerList } from "../components/ViewerShell";

/**
 * The neighbours of a photo in Proton, for the viewer's filmstrip and contents list.
 *
 * The list itself is the caller's: a grid already holds its timeline, so nothing here
 * fetches one. What it does fetch is the two things a timeline entry does not carry, the
 * picture and the name, and only for the entries on screen, batched, once each.
 *
 * The grid's own thumbnail cache is read first, so opening a photo from a grid gives a
 * strip that is already populated for everything the reader had just scrolled past.
 */

/** As little as a caller has to know about its own list for the strip to work. */
export type CloudItem = {
  uid: string;
  name?: string;
  size?: number | null;
  video?: boolean;
};

// ---- Pictures ----
//
// A loader of its own rather than the grid's, which deliberately stands aside while a
// viewer is open so a photo-open owns the single channel. These tiles are inside that
// viewer: they are what the reader is looking at, not work behind it, so standing aside
// for the viewer would mean standing aside for themselves.

const pictures = new Map<string, string | null>();
const MAX_CACHED = 400;
const subs = new Map<string, Set<(url: string | null) => void>>();
const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
let draining = false;

function keep(uid: string, url: string | null): void {
  pictures.delete(uid);
  pictures.set(uid, url);
  while (pictures.size > MAX_CACHED) {
    const oldest = pictures.keys().next().value;
    if (oldest === undefined) break;
    pictures.delete(oldest);
  }
}

async function drain(): Promise<void> {
  timer = undefined;
  if (draining) return;
  draining = true;
  // Small: the open photo's own preview is already ahead of these in the channel, and a
  // short batch is what keeps it there.
  const BATCH = 8;
  while (pending.size > 0) {
    // Newest first, and never for a tile that has scrolled back out of view.
    const ordered = [...pending].reverse().filter((uid) => subs.has(uid));
    if (ordered.length === 0) {
      pending.clear();
      break;
    }
    const chunk = ordered.slice(0, BATCH);
    for (const uid of chunk) pending.delete(uid);
    try {
      const rows = await rpc<{ uid: string; dataUrl: string | null }[]>("getThumbnails", {
        uids: chunk,
      });
      for (const row of rows) {
        keep(row.uid, row.dataUrl);
        const set = subs.get(row.uid);
        if (set) for (const cb of set) cb(row.dataUrl);
      }
    } catch {
      // An empty tile, not an error: one bad batch must not stop the rest.
      for (const uid of chunk) keep(uid, null);
    }
  }
  draining = false;
}

function requestPicture(uid: string, cb: (url: string | null) => void): () => void {
  // The grid decrypted this one already for the cell the reader opened from.
  const shared = cachedThumbnail(uid);
  if (shared !== undefined) {
    cb(shared);
    return () => {};
  }
  // The thumbnail server's URL, when there is one: the webview loads it like the grid's.
  const served = thumbUrl(uid);
  if (served) {
    cb(served);
    return () => {};
  }
  const mine = pictures.get(uid);
  if (mine !== undefined) {
    keep(uid, mine);
    cb(mine);
    return () => {};
  }
  let set = subs.get(uid);
  if (!set) {
    set = new Set();
    subs.set(uid, set);
  }
  set.add(cb);
  pending.add(uid);
  if (timer === undefined) timer = setTimeout(drain, 40);
  return () => {
    const live = subs.get(uid);
    if (live) {
      live.delete(cb);
      if (live.size === 0) subs.delete(uid);
    }
  };
}

// ---- Names ----
//
// A timeline entry is a uid, a capture time and its tags; the name is not in it. This is
// the same batched lookup the search index uses, so a library that has been searched once
// answers from the sidecar's own cache rather than decrypting anything again.

type NodeMeta = {
  uid: string;
  name: string;
  mediaType: string | null;
  /** Present only if the sidecar reports it. The size lives on the revision it already
   *  holds while resolving the name, so this costs nothing when it is there at all. */
  size?: number | null;
};

const names = new Map<string, { name: string; size?: number | null }>();
const asked = new Set<string>();

async function resolveNames(uids: string[], done: () => void): Promise<void> {
  const missing = uids.filter((uid) => !asked.has(uid));
  if (missing.length === 0) return;
  for (const uid of missing) asked.add(uid);
  try {
    const rows = await rpc<NodeMeta[]>("getMetadata", { uids: missing });
    for (const row of rows) names.set(row.uid, { name: row.name, size: row.size ?? undefined });
    done();
  } catch {
    // Asked again the next time the reader scrolls back over them.
    for (const uid of missing) asked.delete(uid);
  }
}

export type CloudMedia = {
  list: ViewerList | null;
  onRange: (from: number, to: number) => void;
};

/**
 * `items` is the caller's own list, `index` the one on screen, and `onPick` is handed the
 * index to move to. Nothing here changes the caller's list or asks for it again.
 */
export function useCloudMedia(
  items: CloudItem[] | undefined,
  index: number,
  onPick: ((i: number) => void) | undefined,
): CloudMedia {
  const [resolved, setResolved] = useState(0);

  // Drop the run's own record when the list changes, so a name is looked up again for a
  // library that has been re-read rather than being served from a previous account's.
  useEffect(() => {
    setResolved(0);
  }, [items]);

  const at = useCallback(
    (i: number): ViewerItem | undefined => {
      const item = items?.[i];
      if (!item) return undefined;
      const known = names.get(item.uid);
      return {
        key: item.uid,
        name: item.name ?? known?.name,
        size: item.size ?? known?.size,
        video: item.video,
      };
    },
    // `resolved` is not read and is the dependency on purpose: it changes when a batch of
    // names lands, which is exactly when the same index starts having one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, resolved],
  );

  const onRange = useCallback(
    (from: number, to: number) => {
      if (!items) return;
      const wanted: string[] = [];
      for (let i = Math.max(0, from); i <= Math.min(items.length - 1, to); i++) {
        const item = items[i];
        if (item && !item.name && !names.has(item.uid)) wanted.push(item.uid);
      }
      if (wanted.length > 0) void resolveNames(wanted, () => setResolved((n) => n + 1));
    },
    [items],
  );

  const go = useCallback((i: number) => onPick?.(i), [onPick]);

  const list = useMemo<ViewerList | null>(
    () =>
      items && items.length > 1 && onPick
        ? { count: items.length, index, at, thumb: requestPicture, go }
        : null,
    [items, index, at, go, onPick],
  );

  return { list, onRange };
}
