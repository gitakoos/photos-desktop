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

/**
 * The pictures of grid tiles that scrolled out of the built rows, kept for when they
 * scroll back.
 *
 * The thumbnail server answers `no-store`, so the webview keeps nothing of a thumbnail
 * once its image element is gone: a tile built again asked the server again, was empty
 * until the answer came and faded in a second time, which read as photos disappearing
 * and loading again on the way back up. An image element that has loaded still holds its
 * picture, though, in memory and nowhere else. So a tile hands its element over here when
 * it is taken down and takes it back when it is built again, and the picture is there in
 * the same frame with nothing asked of the server.
 *
 * Bounded by count, the least recently kept dropped first, and emptied when the server's
 * address goes, which is a lock or a sign-out. Nothing here reaches the disk: `no-store`
 * still holds for every response.
 */

import { bench, benchCount, benchPending, benchSettled } from "./benchProbe";

/** A bounded store that hands each thing back once, and drops the oldest when full. */
export type Keep<T> = {
  /** Takes the thing kept under `key` out of the store, if there is one. */
  take(key: string): T | undefined;
  /** Keeps `value` under `key`, in place of anything already there. */
  put(key: string, value: T): void;
  /** Drops everything. */
  clear(): void;
  readonly size: number;
};

export function createKeep<T>(max: number, onDrop: (value: T) => void): Keep<T> {
  const kept = new Map<string, T>();
  return {
    take(key) {
      const value = kept.get(key);
      if (value !== undefined) kept.delete(key);
      return value;
    },
    put(key, value) {
      const previous = kept.get(key);
      if (previous !== undefined) {
        kept.delete(key);
        if (previous !== value) onDrop(previous);
      }
      kept.set(key, value);
      while (kept.size > max) {
        const oldest = kept.keys().next().value;
        if (oldest === undefined) break;
        const dropped = kept.get(oldest)!;
        kept.delete(oldest);
        onDrop(dropped);
      }
    },
    clear() {
      const all = [...kept.values()];
      kept.clear();
      for (const value of all) onDrop(value);
    },
    get size() {
      return kept.size;
    },
  };
}

/**
 * How many are kept. A thumbnail is some tens of KB as it arrives, so this is a few tens
 * of MB at most whatever the library's size, and several screens' worth at any zoom.
 */
const MAX_KEPT = 1200;

/** Lets go of an element's picture, and of its request if it is still waiting on one. */
function release(img: HTMLImageElement): void {
  img.removeAttribute("src");
}

const kept = createKeep<HTMLImageElement>(MAX_KEPT, release);

/**
 * The image element for a tile's thumbnail at `url`: the one kept from the last time the
 * tile was built, already loaded, or a new one that starts loading now. A loaded one
 * carries `data-ok`, which is what the stylesheet shows a picture by.
 */
export function takeTileImage(url: string): HTMLImageElement {
  const had = kept.take(url);
  if (had) {
    if (bench.on) benchCount("kept");
    return had;
  }
  const img = new Image();
  if (bench.on) {
    benchCount("fresh");
    benchPending(img);
  }
  img.decoding = "async";
  img.alt = "";
  img.draggable = false;
  img.src = url;
  return img;
}

/**
 * Takes back a tile's element as the tile is taken down. A loaded one is kept; one still
 * loading lets go of its request, so the server is not left fetching for a tile scrolled
 * away ahead of the ones now on screen.
 */
export function keepTileImage(url: string, img: HTMLImageElement): void {
  if (img.complete && img.naturalWidth > 0) kept.put(url, img);
  else {
    if (bench.on) benchSettled(img);
    release(img);
  }
}

/** Drops every kept picture: the server's address is gone, and with it the session. */
export function dropTileImages(): void {
  kept.clear();
}

/** How many pictures are kept (for the debug HUD and tests). */
export function keptTileImages(): number {
  return kept.size;
}
