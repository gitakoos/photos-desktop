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

// Whether a file from an export is already in the library, by its bytes. Proton's own check finds
// a photo only by its exact name and bytes, and an export (Ente's, a Takeout) renames clashes:
// those went up a second time. The timeline listing hands out every photo's content hash (its
// SHA-1 keyed with the photo root's hash key), and a Live Photo's video's beside it, so a file's
// own SHA-1 finds the same file under any name. Nothing that is not the same bytes is matched.

import { createHmac } from "node:crypto";

/**
 * The photo root's hash key, which Proton keys names and content hashes with. The SDK keeps it
 * to itself (its own duplicate check uses it the same way), so it is read from there; null if
 * that ever changes, and the import then falls back to Proton's name-and-bytes check.
 */
export async function photoRootHashKey(client: any): Promise<Uint8Array | null> {
  try {
    const timeline = client?.photos?.timeline;
    const { volumeId, rootNodeId } = await timeline.photoShares.getRootIDs();
    const keys = await timeline.nodesService.getNodeKeys(`${volumeId}~${rootNodeId}`);
    return keys?.hashKey instanceof Uint8Array ? keys.hashKey : null;
  } catch {
    return null;
  }
}

/** Proton's content hash for a file: its SHA-1 (hex), keyed with the photo root's hash key. */
export function contentHashOf(sha1: string, hashKey: Uint8Array): string {
  return createHmac("sha256", hashKey).update(sha1, "utf8").digest("hex");
}

export class LibraryIndex {
  private readonly byContent = new Map<string, string>();
  private readonly complete: boolean;
  private readonly empty: boolean;

  /**
   * `uids`: every photo in the library now. `contentHashes`: each photo's own hash first, then
   * its Live video's. `listed`: every photo the listing that gave the hashes went through, with
   * a hash or without.
   */
  constructor(
    uids: string[],
    contentHashes: Iterable<[string, string]>,
    listed: ReadonlySet<string>,
    private readonly hashKey: Uint8Array | null,
    private readonly isHidden: (uid: string) => boolean = () => false,
  ) {
    const library = new Set(uids);
    this.complete = uids.every((u) => listed.has(u));
    this.empty = uids.length === 0;
    for (const [uid, hash] of contentHashes) {
      // Only photos still in the library: a hash of one since trashed means nothing now. Of a
      // hidden and a shown copy, the shown one, which the import may put in an album.
      if (!library.has(uid)) continue;
      const held = this.byContent.get(hash);
      if (!held || (this.isHidden(held) && !this.isHidden(uid))) this.byContent.set(hash, uid);
    }
  }

  /**
   * Whether a file can be looked up by its content: the key is here, and the listing the hashes
   * came from went through every photo in the library. A listing that missed some would call
   * their copies new. An empty library holds nothing to find.
   */
  canMatchContent(): boolean {
    return this.empty || (this.hashKey !== null && this.complete);
  }

  /** The library photo with exactly these bytes, under any name. */
  sameFile(sha1: string): string | null {
    if (!this.hashKey) return null;
    return this.byContent.get(contentHashOf(sha1, this.hashKey)) ?? null;
  }

  hidden(uid: string): boolean {
    return this.isHidden(uid);
  }
}
