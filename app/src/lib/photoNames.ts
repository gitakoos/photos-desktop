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
 * Photo names the viewer can show at once. Stepping to a photo cleared its title to "…"
 * until its details came back, a few hundred milliseconds to seconds later, so the title
 * flickered on every step. The names of the photo and its neighbours are asked for ahead,
 * from the sidecar's own cache (nothing is fetched or decrypted for them), and kept here.
 */
const MAX_NAMES = 2000;
const names = new Map<string, string>();
const asking = new Set<string>();

/** The name known for `uid`, if any. */
export function knownName(uid: string): string | undefined {
  return names.get(uid);
}

/** Keeps a name learned elsewhere (the details, a rename). */
export function rememberName(uid: string, name: string): void {
  names.delete(uid);
  names.set(uid, name);
  while (names.size > MAX_NAMES) {
    const oldest = names.keys().next().value;
    if (oldest === undefined) break;
    names.delete(oldest);
  }
}

/**
 * Asks the sidecar's cache for the names not known yet among `uids`, and calls `onLearned`
 * once they are in (only when one was learned). Let go of with `signal`.
 */
export async function learnNames(uids: string[], signal?: AbortSignal, onLearned?: () => void): Promise<void> {
  const unknown = uids.filter((uid) => !names.has(uid) && !asking.has(uid));
  if (unknown.length === 0) return;
  for (const uid of unknown) asking.add(uid);
  try {
    const found = await rpc<Record<string, string>>("cachedNames", { uids: unknown }, { signal });
    let learned = false;
    for (const [uid, name] of Object.entries(found ?? {})) {
      if (typeof name === "string" && name) {
        rememberName(uid, name);
        learned = true;
      }
    }
    if (learned) onLearned?.();
  } catch {
    /* no names from the cache: the title waits for the details, as before */
  } finally {
    for (const uid of unknown) asking.delete(uid);
  }
}

/** Forgets every name: at lock, with the rest of what was shown. */
export function forgetNames(): void {
  names.clear();
}
