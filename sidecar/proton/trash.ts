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

// Trash: what was trashed, putting it back, and the one action the app cannot
// undo.
//
// Every call here is scoped to the photos volume, because the SDK resolves the
// volume from the client's own root share: `emptyTrash` on the Photos client
// reaches the photos trash and cannot touch My files.
//
// Restore and delete report per node the way `trashNodes` does, so one node's
// failure never sinks the batch. The SDK owns the batching (100 uids a request)
// and pages the listing itself, so neither is this module's job.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { collectResults, nodeName, toMillis, type NodeOpResult } from "./nodes.ts";
import { SDK_STALL_MS, withStallGuard } from "./stallGuard.ts";

/**
 * A trashed node, shaped like the timeline's items so the grid renders it with
 * no special case. The name is what carries the view when a thumbnail cannot be
 * fetched, so it is always resolved.
 */
export type TrashItem = {
  uid: string;
  name: string;
  type: string;
  mediaType: string | null;
  captureTime: number;
  tags: number[];
};

export type TrashResult = NodeOpResult;

/**
 * Everything in the photos trash, newest first.
 *
 * The listing yields uids alone, so names and capture times need a second pass
 * over `iterateNodes` (the same batched lookup the search index uses). Albums
 * land in the trash beside photos and restore just as well, so both are listed:
 * hiding one would leave `emptyTrash` a victim the view never showed.
 */
export async function listTrashed(photos: any): Promise<TrashItem[]> {
  const uids: string[] = [];
  for await (const uid of withStallGuard(
    photos.iterateTrashedNodeUids(),
    SDK_STALL_MS,
    "iterateTrashedNodeUids",
  )) {
    uids.push(uid as string);
  }
  if (uids.length === 0) return [];

  const out: TrashItem[] = [];
  for await (const node of withStallGuard(photos.iterateNodes(uids), SDK_STALL_MS, "iterateNodes")) {
    const n = node as any;
    if (n.missingUid) continue; // vanished server-side between the two passes
    out.push({
      uid: n.uid,
      name: nodeName(n),
      type: n.type,
      mediaType: n.mediaType ?? null,
      // An album has no capture time of its own; its creation time orders it.
      captureTime: toMillis(n.photo?.captureTime) || toMillis(n.creationTime),
      tags: (n.photo?.tags ?? []) as number[],
    });
  }
  // The API promises no order, so impose the timeline's.
  out.sort((a, b) => b.captureTime - a.captureTime);
  return out;
}

/** Puts trashed nodes back where they were trashed from. */
export async function restorePhotos(photos: any, uids: string[]): Promise<TrashResult[]> {
  return collectResults(photos.restoreNodes(uids));
}

/**
 * Destroys trashed nodes. Nothing in the app or on the server can bring these
 * back afterwards. Only a node's owner may delete it, so one shared in fails
 * with its own result rather than quietly doing nothing.
 */
export async function deletePhotosForever(photos: any, uids: string[]): Promise<TrashResult[]> {
  return collectResults(photos.deleteNodes(uids));
}

/** Destroys the whole photos trash. Same finality, whole volume at once. */
export async function emptyTrash(photos: any): Promise<{ emptied: boolean }> {
  await photos.emptyTrash();
  return { emptied: true };
}
