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

/*
 * The import review's tile pictures where the system makes none for a file on disk (Linux):
 * the sidecar draws them from the export, a screenful at a time, newest asks first, and
 * a tile that scrolled away before its turn is not drawn at all.
 */

const MAX_CACHED = 600;
const BATCH = 16;

const cache = new Map<string, string | null>();
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
  if (draining) return;
  draining = true;
  while (pending.size > 0) {
    const ordered = [...pending].reverse().filter((path) => subs.has(path));
    if (ordered.length === 0) {
      pending.clear();
      break;
    }
    const chunk = ordered.slice(0, BATCH);
    for (const path of chunk) pending.delete(path);
    let urls: (string | null)[];
    try {
      urls = await rpc<(string | null)[]>("importThumbnails", { paths: chunk });
    } catch {
      // Not remembered as no picture: the tile asks again when it next comes into view.
      for (const path of chunk) {
        const set = subs.get(path);
        if (set) for (const cb of set) cb(null);
      }
      continue;
    }
    chunk.forEach((path, i) => {
      const url = urls[i] ?? null;
      keep(path, url);
      const set = subs.get(path);
      if (set) for (const cb of set) cb(url);
    });
  }
  draining = false;
}

/** Asks for one export file's picture. Returns an unsubscribe. */
export function requestImportThumbnail(path: string, cb: (url: string | null) => void): () => void {
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
  if (timer === undefined) timer = setTimeout(() => void drain(), 40);
  return () => {
    const live = subs.get(path);
    if (live) {
      live.delete(cb);
      if (live.size === 0) subs.delete(path);
    }
  };
}

/** Forgets the pictures of an export no longer under review. */
export function clearImportThumbnails(): void {
  cache.clear();
  pending.clear();
}
