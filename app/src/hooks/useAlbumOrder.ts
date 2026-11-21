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

import { useCallback, useEffect, useState } from "react";
import { rpc } from "../lib/rpc";
import type { AlbumPhotoOrder } from "../lib/albumView";

type View = { mode: AlbumPhotoOrder | null; order: string[]; version: number };

/** How often an open album asks whether its order changed, also by another device's copy. */
const LOOK_EVERY_MS = 10_000;
const NONE: string[] = [];

export type AlbumOrder = {
  /** Whether the open album's order has been read; until then its photos wait. */
  ready: boolean;
  /** The album's own mode, null when it follows the default. */
  mode: AlbumPhotoOrder | null;
  /** Its hand-made order, photo link ids, empty when it has none. */
  order: string[];
  setMode: (mode: AlbumPhotoOrder) => Promise<void>;
  /** Saves a hand-made order (photo link ids) and switches the album to it. */
  save: (order: string[]) => Promise<void>;
};

/** The photo order of the open album, kept by the sidecar and shared with the other devices. */
export function useAlbumOrder(albumUid: string | null): AlbumOrder {
  const [view, setView] = useState<(View & { uid: string }) | null>(null);

  useEffect(() => {
    if (!albumUid) {
      setView(null);
      return;
    }
    let live = true;
    let timer = 0;
    let seen = Number.NaN;
    const look = async () => {
      const now = await rpc<View>("albumOrderGet", { uid: albumUid }).catch(() => null);
      if (live && now && now.version !== seen) {
        seen = now.version;
        setView({ ...now, uid: albumUid });
      } else if (live && !now) {
        setView((prev) => (prev?.uid === albumUid ? prev : { mode: null, order: NONE, version: -1, uid: albumUid }));
      }
      if (live) timer = window.setTimeout(look, LOOK_EVERY_MS);
    };
    void look();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [albumUid]);

  const setMode = useCallback(
    async (mode: AlbumPhotoOrder) => {
      if (!albumUid) return;
      const next = await rpc<View>("albumOrderSetMode", { uid: albumUid, mode });
      setView({ ...next, uid: albumUid });
    },
    [albumUid],
  );

  const save = useCallback(
    async (order: string[]) => {
      if (!albumUid) return;
      const next = await rpc<View>("albumOrderSave", { uid: albumUid, order });
      setView({ ...next, uid: albumUid });
    },
    [albumUid],
  );

  const current = view && view.uid === albumUid ? view : null;
  return { ready: !!current, mode: current?.mode ?? null, order: current?.order ?? NONE, setMode, save };
}
