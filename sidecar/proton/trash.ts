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
import { trashItemsGet, trashItemsPut } from "./store.ts";

/** An item as kept from an earlier read, with when it was read. */
type KeptItem = TrashItem & { readAt: number };

/** How long a kept item stands before it is read again: what another device changed shows within it. */
const TRASH_ITEM_KEPT_MS = 7 * 24 * 3600 * 1000;

function isKeptItem(v: unknown, now: number): v is KeptItem {
  const t = v as KeptItem | undefined;
  return (
    !!t &&
    typeof t.uid === "string" &&
    typeof t.name === "string" &&
    typeof t.type === "string" &&
    typeof t.captureTime === "number" &&
    Array.isArray(t.tags) &&
    typeof t.readAt === "number" &&
    now - t.readAt < TRASH_ITEM_KEPT_MS
  );
}

/**
 * Forgets what was kept of these items (all of them with none given): an item restored here
 * may be edited before it is trashed again, so it is read afresh then.
 */
export function forgetTrashItems(uids?: string[]): void {
  const kept = trashItemsGet();
  if (!kept) return;
  if (!uids) {
    trashItemsPut({});
    return;
  }
  let changed = false;
  for (const uid of uids) if (uid in kept) changed = delete kept[uid];
  if (changed) trashItemsPut(kept);
}

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
  // What was read of each item before is kept (sealed): an item cannot change while it is in
  // the trash, and one that leaves it is dropped, so one trashed again is read afresh. Only
  // the items new to the trash are decrypted, where every one was at each start.
  const now = Date.now();
  const kept = (trashItemsGet() ?? {}) as Record<string, KeptItem>;
  const present = new Set(uids);
  const known: Record<string, KeptItem> = {};
  for (const uid of uids) if (isKeptItem(kept[uid], now)) known[uid] = kept[uid];
  const missing = uids.filter((uid) => !known[uid]);
  /** What this read found that is not kept yet: an item whose name would not decrypt is shown, not kept. */
  const shown: Record<string, TrashItem> = {};
  let added = 0;
  try {
    if (missing.length > 0) {
      for await (const node of withStallGuard(photos.iterateNodes(missing), SDK_STALL_MS, "iterateNodes")) {
        const n = node as any;
        if (n.missingUid) continue; // vanished server-side between the two passes
        const item: TrashItem = {
          uid: n.uid,
          name: nodeName(n),
          type: n.type,
          mediaType: n.mediaType ?? null,
          // An album has no capture time of its own; its creation time orders it.
          captureTime: toMillis(n.photo?.captureTime) || toMillis(n.creationTime),
          tags: (n.photo?.tags ?? []) as number[],
        };
        if (n.name?.ok === false || typeof item.type !== "string") shown[n.uid] = item;
        else {
          known[n.uid] = { ...item, readAt: now };
          added++;
        }
      }
    }
  } finally {
    // Kept as far as it got, so a read cut short does not start from nothing next time.
    const left = Object.keys(kept).some((uid) => !present.has(uid) || !known[uid]);
    if (added > 0 || left) trashItemsPut(known);
  }
  const out = uids
    .map((uid): TrashItem | undefined => {
      const k = known[uid];
      if (!k) return shown[uid];
      const { readAt: _readAt, ...item } = k;
      return item;
    })
    .filter((item): item is TrashItem => !!item);
  // The API promises no order, so impose the timeline's.
  out.sort((a, b) => b.captureTime - a.captureTime);
  return out;
}

/** Puts trashed nodes back where they were trashed from. */
export async function restorePhotos(photos: any, uids: string[]): Promise<TrashResult[]> {
  forgetTrashItems(uids);
  return collectResults(photos.restoreNodes(uids));
}

/**
 * Destroys trashed nodes. Nothing in the app or on the server can bring these
 * back afterwards. Only a node's owner may delete it, so one shared in fails
 * with its own result rather than quietly doing nothing.
 */
export async function deletePhotosForever(photos: any, uids: string[]): Promise<TrashResult[]> {
  forgetTrashItems(uids);
  return collectResults(photos.deleteNodes(uids));
}

/** Destroys the whole photos trash. Same finality, whole volume at once. */
export async function emptyTrash(photos: any): Promise<{ emptied: boolean }> {
  forgetTrashItems();
  await photos.emptyTrash();
  return { emptied: true };
}

/** How long a read of the trash stands for the next one. */
const TRASH_FRESH_MS = 20_000;

/**
 * The trash, read once for everyone who asks at about the same time.
 *
 * Two readers want it together: the window warming its Trash view, and the file
 * manager's drive listing what is in the trash beside the library. Each read lists every
 * trashed uid and then decrypts every node, which on a large trash runs to tens of
 * seconds, and the window's own calls queued behind it. Now a read under way is joined
 * rather than started again, and a finished one stands for a short while, until the app
 * itself changes the trash.
 */
export class TrashListing {
  private read: { rows: Promise<TrashItem[]>; generation: number; at: number | null } | null = null;
  private generation = 0;

  constructor(
    private freshMs = TRASH_FRESH_MS,
    private now: () => number = Date.now,
  ) {}

  /**
   * The trash: a read under way is joined, and a finished one is taken while it is fresh,
   * unless `joinOnly`, for a caller that promises the trash as it is now (the Trash view on
   * arrival): it shares a read still running but never takes a finished one.
   */
  get(load: () => Promise<TrashItem[]>, joinOnly = false): Promise<TrashItem[]> {
    const read = this.read;
    const usable =
      read &&
      read.generation === this.generation &&
      (read.at === null || (!joinOnly && this.now() - read.at < this.freshMs));
    if (usable) {
      return read.rows;
    }
    const mine: { rows: Promise<TrashItem[]>; generation: number; at: number | null } = {
      rows: Promise.resolve([]),
      generation: this.generation,
      at: null,
    };
    mine.rows = load().then(
      (rows) => {
        mine.at = this.now();
        return rows;
      },
      (e) => {
        // A failed read is not kept: the next caller tries again.
        if (this.read === mine) this.read = null;
        throw e;
      },
    );
    this.read = mine;
    return mine.rows;
  }

  /**
   * The trash has changed (a photo trashed, restored or deleted, the trash emptied) or the
   * session is going: no read from before this stands for any caller after it.
   */
  changed(): void {
    this.generation++;
    this.read = null;
  }
}
