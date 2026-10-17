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

// Photos kept available offline.
//
// Marking a photo keeps its full-resolution original inside the app's own directory,
// sealed with the vault key like every other blob the store holds. Nothing is written
// to the Explorer sync root: this is the app's own copy, and the mount is a separate
// feature the user opts into on its own.
//
// Two pieces of state, both sealed and both belonging to exactly one account:
//   - the list of pinned uids (`offline.enc`), so a pin survives a restart, and
//   - one blob per photo under `originals/`, keyed by the uid's hash.
// `wipeCache` drops both, so sign-out and a password change take them with everything
// else. Nothing here is readable, or even loadable, while the vault is locked.
//
// The downloads run off the JSON-RPC channel the way a save-to-folder run does: `pin`
// returns at once and the UI polls `offlineStatus`, so a large batch never holds the
// single channel that the rest of the app is waiting on.
/* eslint-disable @typescript-eslint/no-explicit-any */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WritableStream } from "node:stream/web";

import { nodeName } from "./nodes.ts";
import {
  OFFLINE_LIST_FILE,
  OriginalSealer,
  isReady,
  metaPut,
  originalDelete,
  originalDeleteAll,
  originalHas,
  originalUsage,
  storeDir,
  unseal,
  writeSealedAtomic,
} from "./store.ts";

/** What the UI polls while a batch runs, and reads to size the Settings panel. */
export type OfflineStatus = {
  /** Every uid the user has marked, whether or not its bytes have landed yet. */
  pinned: string[];
  /** How many of those have their original stored. */
  ready: number;
  /** The plaintext bytes those stored originals account for. */
  bytes: number;
  running: boolean;
  /** Progress of the batch in flight: photos settled out of photos queued. */
  done: number;
  total: number;
  failed: number;
};

type OfflineList = { v: 1; uids: string[] };

// The pinned set, loaded from the sealed list on first use and dropped when the
// account locks. `null` means "not loaded yet", which is not the same as "empty".
let pinned: Set<string> | null = null;

const progress = { running: false, done: 0, total: 0, failed: 0 };

function listPath(): string {
  return join(storeDir(), OFFLINE_LIST_FILE);
}

/** The pinned set, read through the seal once per unlock. Empty while locked. */
function pins(): Set<string> {
  if (pinned) return pinned;
  if (!isReady()) return new Set();
  try {
    const path = listPath();
    if (existsSync(path)) {
      const parsed = JSON.parse(unseal(readFileSync(path)).toString("utf8")) as OfflineList;
      pinned = new Set(Array.isArray(parsed?.uids) ? parsed.uids : []);
    } else {
      pinned = new Set();
    }
  } catch {
    // Tampered, or written under a previous key: start clean rather than fail. The
    // blobs it named are unreadable under the current key anyway.
    pinned = new Set();
  }
  return pinned;
}

function savePins(): void {
  if (!isReady() || !pinned) return;
  try {
    const blob: OfflineList = { v: 1, uids: [...pinned] };
    // Written aside and renamed: this is rewritten on every pin, and a write torn by
    // a crash reads back as an empty list, which silently drops the user's choices.
    writeSealedAtomic(listPath(), Buffer.from(JSON.stringify(blob)));
  } catch {
    /* a list that failed to persist still holds for this session */
  }
}

/**
 * Forget the in-memory pin set and stop any batch in flight. Called when the account
 * locks: the list is sealed, so it cannot be read again until the next unlock, and the
 * blobs on disk stay exactly where they are for that account to come back to.
 */
export function resetOfflineState(): void {
  pinned = null;
  progress.running = false;
  progress.done = 0;
  progress.total = 0;
  progress.failed = 0;
}

/** Whether this photo's original is stored and ready to serve without a network. */
export function isOfflineReady(uid: string): boolean {
  return pins().has(uid) && originalHas(uid);
}

export function offlineStatus(): OfflineStatus {
  const usage = originalUsage();
  return {
    pinned: [...pins()],
    ready: usage.count,
    bytes: usage.bytes,
    running: progress.running,
    done: progress.done,
    total: progress.total,
    failed: progress.failed,
  };
}

/**
 * Fetch one original into the sealed store. Never throws: a single failure leaves the
 * photo pinned but not yet stored, so the next pass retries it rather than silently
 * dropping the user's choice.
 *
 * Unpinning mid-transfer is what cancels it — every chunk re-checks the pin, so a photo
 * the user changed their mind about stops paying for bytes at once and leaves no blob.
 */
async function fetchOne(photos: any, uid: string): Promise<boolean> {
  if (originalHas(uid)) return true;
  let sealer: OriginalSealer | null = null;
  try {
    const node = await photos.getNode(uid);
    // Recorded now so opening this photo later needs no node lookup, which is what
    // makes it work with no network at all.
    const revision = node?.activeRevision?.ok ? node.activeRevision.value : null;
    const size = Number(revision?.claimedSize ?? 0);
    metaPut(uid, {
      name: nodeName(node) || uid,
      mediaType: node?.mediaType ?? null,
      ...(size > 0 ? { size } : {}),
    });

    const downloader = await photos.getFileDownloader(uid);
    if (!pins().has(uid)) return false;
    sealer = new OriginalSealer(uid);
    const writer = sealer;
    const stream = new WritableStream<Uint8Array>({
      write(chunk) {
        if (!pins().has(uid)) throw new Error("UNPINNED");
        return writer.write(chunk);
      },
      abort() {
        void writer.abort();
      },
    });
    await downloader.downloadToStream(stream as any).completion();
    if (!pins().has(uid)) {
      await sealer.abort();
      return false;
    }
    await sealer.finish();
    return true;
  } catch {
    if (sealer) await sealer.abort();
    return false;
  }
}

/**
 * Work the queue of pinned-but-not-yet-stored photos, one at a time. Sequential on
 * purpose: it keeps the sidecar's memory flat and leaves the account's bandwidth to
 * whatever the user is actually looking at.
 */
async function drain(photos: any): Promise<void> {
  if (progress.running) return;
  progress.running = true;
  try {
    for (;;) {
      const queue = [...pins()].filter((uid) => !originalHas(uid));
      if (queue.length === 0) break;
      progress.total = progress.done + queue.length;
      let stalled = true;
      for (const uid of queue) {
        if (!pins().has(uid)) continue; // unpinned while we queued
        if (await fetchOne(photos, uid)) {
          stalled = false;
        } else {
          progress.failed++;
        }
        progress.done++;
      }
      // Every remaining photo failed this pass, so another one would only fail the
      // same way. New pins arriving mid-run are picked up by the loop above.
      if (stalled) break;
    }
  } finally {
    progress.running = false;
    // Counts only, never which photos: the outcome is what a log is for.
    process.stderr.write(
      `[offline] batch done: ${progress.done - progress.failed}/${progress.done} stored\n`,
    );
    progress.done = 0;
    progress.total = 0;
    progress.failed = 0;
  }
}

/**
 * Mark photos as available offline and start fetching whatever is not stored yet.
 * Returns at once with the resulting state; the UI polls `offlineStatus` for progress.
 */
export function pinOffline(photos: any, uids: string[]): OfflineStatus {
  const set = pins();
  let added = 0;
  for (const uid of uids) {
    if (!set.has(uid)) {
      set.add(uid);
      added++;
    }
  }
  if (added > 0) savePins();
  process.stderr.write(`[offline] pinned ${added} of ${uids.length} requested\n`);
  void drain(photos);
  return offlineStatus();
}

/**
 * Unmark photos and reclaim their bytes. A photo still being fetched notices on its
 * next chunk and abandons the partial blob, so this reclaims the space either way.
 */
export function unpinOffline(uids: string[]): OfflineStatus {
  const set = pins();
  let removed = 0;
  for (const uid of uids) {
    if (set.delete(uid)) removed++;
    originalDelete(uid);
  }
  if (removed > 0) savePins();
  process.stderr.write(`[offline] unpinned ${removed} of ${uids.length} requested\n`);
  return offlineStatus();
}

/**
 * The Settings panel's "free up": every stored original, in one go.
 *
 * Sweeps the directory rather than walking the pin list, because those two can disagree
 * and only one of them is the truth about disk. A list that was torn, or written under a
 * previous key, reads back empty while the blobs it named are still there, and those are
 * precisely the bytes nothing else will ever come back for, since every other path
 * reaches an original through its uid. Settings sizes itself from the same directory
 * walk, so this is also what makes the button free what the panel says is there.
 */
export function unpinAllOffline(): OfflineStatus {
  const set = pins();
  const listed = set.size;
  set.clear();
  savePins();
  const freed = originalDeleteAll();
  process.stderr.write(`[offline] freed ${freed} stored originals (${listed} listed)\n`);
  return offlineStatus();
}
