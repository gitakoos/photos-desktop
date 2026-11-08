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

type HiddenState = { photos: string[]; albums: string[]; albumPhotos: string[]; version: number };

/** How often the window asks whether the list changed, also by another device's copy. */
const LOOK_EVERY_MS = 10_000;

/** The Drive link id of a uid, `volume~link`. */
const linkOf = (uid: string) => uid.slice(uid.lastIndexOf("~") + 1);

export type Hidden = {
  loaded: boolean;
  version: number;
  /** How many photos are hidden on their own, and how many albums. */
  photoCount: number;
  albumCount: number;
  /** Whether a photo is hidden, on its own or by a hidden album it is in. */
  isPhoto: (uid: string) => boolean;
  isAlbum: (uid: string) => boolean;
  /** The photos hidden on their own (link ids), and the hidden albums (uids). */
  photos: Set<string>;
  albums: Set<string>;
  set: (kind: "photos" | "albums", uids: string[], hidden: boolean) => Promise<void>;
};

/**
 * The photos and albums hidden on this computer, as the phone hides them. Read once signed in,
 * with each hidden album's photos read again in the background, so one added to it since is
 * hidden too.
 */
export function useHidden(enabled: boolean): Hidden {
  const [state, setState] = useState<HiddenState>({ photos: [], albums: [], albumPhotos: [], version: -1 });

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let timer = 0;
    let seen = -1;
    void (async () => {
      const first = await rpc<HiddenState>("hiddenState").catch(() => null);
      if (live && first) {
        seen = first.version;
        setState(first);
      }
      if (first && first.albums.length > 0) {
        const fresh = await rpc<HiddenState>("hiddenRefresh").catch(() => null);
        if (live && fresh) {
          seen = fresh.version;
          setState(fresh);
        }
      }
      // Another device's list, taken in from Drive, can change it at any time.
      const look = async () => {
        const now = await rpc<HiddenState>("hiddenState").catch(() => null);
        if (live && now && now.version !== seen) {
          seen = now.version;
          setState(now);
        }
        if (live) timer = window.setTimeout(look, LOOK_EVERY_MS);
      };
      if (live) timer = window.setTimeout(look, LOOK_EVERY_MS);
    })();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [enabled]);

  const set = useCallback(async (kind: "photos" | "albums", uids: string[], hidden: boolean) => {
    if (uids.length === 0) return;
    setState(await rpc<HiddenState>("hiddenSet", { kind, uids, hidden }));
  }, []);

  return useMemo(() => {
    const photos = new Set(state.photos);
    const albums = new Set(state.albums);
    const inAlbums = new Set(state.albumPhotos);
    const albumLinks = new Set(state.albums.map(linkOf));
    return {
      loaded: state.version >= 0,
      version: state.version,
      photoCount: photos.size,
      albumCount: albums.size,
      isPhoto: (uid: string) => photos.has(linkOf(uid)) || inAlbums.has(uid),
      isAlbum: (uid: string) => albumLinks.has(linkOf(uid)),
      photos,
      albums,
      set,
    };
  }, [state, set]);
}
