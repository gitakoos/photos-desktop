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

import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import type { Album } from "../views/Albums";
import type { SharedItem } from "../views/Shared";
import type { TrashItem } from "../views/Trash";

/**
 * A first paint for the three views the shell does not keep mounted.
 *
 * The timeline gets this for free: the shell holds its items, so they survive a
 * trip to another tab and back. Albums, Shared and the trash live only while they
 * are on screen, so without this every visit starts from nothing and shows a
 * shimmer while its one fetch goes out. This reads them once the timeline has settled and
 * hands each view something to paint on arrival.
 *
 * What it hands over is a first paint and nothing more. Every view still re-reads
 * on arrival, unconditionally, and reports the answer back here, so a snapshot is
 * never older than the last thing the server said and is never the last word. That
 * matters: the album list takes the endpoint route precisely so its counts and
 * covers cannot go stale (see the sidecar's albums module), and a snapshot allowed
 * to outlive a rename would hand that back. `reloadKey` drops all of it, so an
 * upload or a restore re-reads from scratch.
 *
 * Reading waits for `ready` and for the timeline to be the view on screen, so this
 * never competes with the grid the user is actually looking at.
 */
export type WarmViews = {
  albums: Album[] | null;
  shared: SharedItem[] | null;
  trash: TrashItem[] | null;
  /** A view's own fresh read, so the snapshot keeps up with it. */
  putAlbums: (rows: Album[]) => void;
  putShared: (rows: SharedItem[]) => void;
  putTrash: (rows: TrashItem[]) => void;
};

export function useWarmViews(ready: boolean, onTimeline: boolean, reloadKey: number): WarmViews {
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [shared, setShared] = useState<SharedItem[] | null>(null);
  const [trash, setTrash] = useState<TrashItem[] | null>(null);

  // What the shell has reloaded past. Anything read before it is thrown away
  // rather than shown, so a slow warm cannot land on top of newer data.
  const generation = useRef(reloadKey);
  useEffect(() => {
    generation.current = reloadKey;
    setAlbums(null);
    setShared(null);
    setTrash(null);
  }, [reloadKey]);

  useEffect(() => {
    if (!ready || !onTimeline) return;
    let cancelled = false;
    const mine = reloadKey;
    /** Keep an answer only if nothing has moved on since it was asked for. */
    const fresh = () => !cancelled && generation.current === mine;

    (async () => {
      // One at a time, in the order they are most likely to be opened. The sidecar
      // serves one request anyway, and the pauses keep the timeline's own warmer
      // and any on-screen thumbnail ahead of this.
      try {
        const rows = await rpc<Album[]>("getAlbums");
        if (fresh()) setAlbums(rows);
      } catch {
        /* the view falls back to its own fetch and its shimmer */
      }
      await new Promise((r) => setTimeout(r, 400));
      if (!fresh()) return;
      try {
        const rows = await rpc<TrashItem[]>("listTrashed");
        if (fresh()) setTrash(rows);
      } catch {
        /* as above */
      }
      await new Promise((r) => setTimeout(r, 400));
      if (!fresh()) return;
      try {
        // Only the tab Shared opens on; the other one is a click away and reads
        // itself, and warming both would spend two round trips on a maybe.
        const rows = await rpc<SharedItem[]>("getShared", { withMe: false });
        if (fresh()) setShared(rows);
      } catch {
        /* as above */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, onTimeline, reloadKey]);

  return {
    albums,
    shared,
    trash,
    putAlbums: useCallback((rows: Album[]) => setAlbums(rows), []),
    putShared: useCallback((rows: SharedItem[]) => setShared(rows), []),
    putTrash: useCallback((rows: TrashItem[]) => setTrash(rows), []),
  };
}
