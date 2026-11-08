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

// Which original each lighter copy uploaded from here was made from. A photo's copy comes out
// the same every time and is found in the library by its own bytes, but a video's need not:
// Windows' hardware encoders do not promise the same bytes twice, so the same video uploaded
// again would go up a second time. Kept by the original's SHA-1, newest last, and capped.

import { join } from "node:path";

import { COMPRESSED_UPLOADS_FILE, readSealedOrDiscard, storeDir, writeSealedAtomic } from "./store.ts";

/** Copies remembered at most; the oldest go first. */
export const MAX_REMEMBERED = 50_000;

let loaded: Map<string, string> | null = null;

function path(): string {
  return join(storeDir(), COMPRESSED_UPLOADS_FILE);
}

function load(): Map<string, string> {
  if (loaded) return loaded;
  const map = new Map<string, string>();
  try {
    const raw = readSealedOrDiscard(path());
    const entries = raw ? JSON.parse(raw.toString("utf8")) : [];
    if (Array.isArray(entries)) {
      for (const e of entries) if (Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string") map.set(e[0], e[1]);
    }
  } catch {
    /* an unreadable record is started again */
  }
  loaded = map;
  return map;
}

/** The photo a lighter copy of the original with `sourceSha1` went up as, if one did from here. */
export function compressedUploadOf(sourceSha1: string): string | null {
  return load().get(sourceSha1) ?? null;
}

/** Notes that the original with `sourceSha1` went up as the photo `uid`, as a lighter copy. */
export function rememberCompressedUpload(sourceSha1: string, uid: string): void {
  const map = load();
  map.delete(sourceSha1);
  map.set(sourceSha1, uid);
  while (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value as string);
  try {
    writeSealedAtomic(path(), Buffer.from(JSON.stringify([...map]), "utf8"));
  } catch {
    /* best-effort: the library's own check still runs */
  }
}

/** Forgets what was read, for a store that was wiped or changed under it. */
export function forgetCompressedUploads(): void {
  loaded = null;
}
