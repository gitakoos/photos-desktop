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

// The search index of photo names, kept by photo rather than by place in the timeline: a photo that
// arrives at the top, one that leaves and a timeline in another order all leave the rest indexed,
// and only the photos not yet asked about are asked for.

export type IndexedName = { uid: string; name: string; mediaType: string | null };

/** The uids of `items` the index has not settled yet, once each, in the timeline's order. */
export function unsettledUids(items: readonly { uid: string }[], settled: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (settled.has(it.uid) || seen.has(it.uid)) continue;
    seen.add(it.uid);
    out.push(it.uid);
  }
  return out;
}

/**
 * Asks for the names of `uids` a batch at a time and hands each answer to `take`. A batch counts as
 * settled once answered, the photos it did not name included, and also when it failed, so a photo
 * Drive cannot name is not asked about again on every change; a reload settles everything anew. A
 * batch whose answer comes after `cancelled` turned true is dropped and stays unsettled.
 */
export async function indexNames(
  uids: readonly string[],
  settled: Set<string>,
  fetch: (batch: string[]) => Promise<IndexedName[]>,
  take: (answer: IndexedName[]) => void,
  cancelled: () => boolean,
  batchSize = 150,
): Promise<void> {
  for (let i = 0; i < uids.length && !cancelled(); i += batchSize) {
    const batch = uids.slice(i, i + batchSize);
    let answer: IndexedName[] = [];
    try {
      answer = await fetch(batch);
    } catch {
      /* one bad batch must not stop the rest */
    }
    if (cancelled()) return;
    if (answer.length > 0) take(answer);
    for (const u of batch) settled.add(u);
  }
}
