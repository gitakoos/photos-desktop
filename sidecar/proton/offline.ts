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

import { activeRevisionOf, nodeName, toMillis } from "./nodes.ts";
import {
  OFFLINE_LIST_FILE,
  OriginalSealer,
  isReady,
  metaPut,
  originalDelete,
  originalDeleteAll,
  originalHas,
  originalStoredAt,
  originalUsage,
  storeDir,
  unseal,
  writeSealedAtomic,
} from "./store.ts";
import { openDownloader } from "./downloadSlots.ts";

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

/** The photos kept one by one, each album kept offline with the photos it held when last read, and
 *  when each kept photo was taken, so the app can list them with no network. */
type OfflineList = { v: 1; uids: string[]; albums?: Record<string, string[]>; times?: Record<string, number> };

// The pinned set, loaded from the sealed list on first use and dropped when the
// account locks. `null` means "not loaded yet", which is not the same as "empty".
let pinned: Set<string> | null = null;
// The albums kept offline, each with its photos; loaded and dropped with `pinned`.
let albumPins = new Map<string, Set<string>>();
// When each kept photo was taken, in ms; loaded and dropped with `pinned`.
let captureTimes = new Map<string, number>();

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
      albumPins = new Map(
        Object.entries(parsed?.albums ?? {})
          .filter(([, uids]) => Array.isArray(uids))
          .map(([album, uids]) => [album, new Set(uids)]),
      );
      captureTimes = new Map(
        Object.entries(parsed?.times ?? {}).filter(([, t]) => typeof t === "number" && Number.isFinite(t)),
      );
    } else {
      pinned = new Set();
      albumPins = new Map();
      captureTimes = new Map();
    }
  } catch {
    // Tampered, or written under a previous key: start clean rather than fail. The
    // blobs it named are unreadable under the current key anyway.
    pinned = new Set();
    albumPins = new Map();
    captureTimes = new Map();
  }
  return pinned;
}

/** Every photo kept offline: one by one, or by an album kept offline. */
function wanted(): Set<string> {
  const all = new Set(pins());
  for (const uids of albumPins.values()) for (const uid of uids) all.add(uid);
  return all;
}

/** Whether anything still keeps this photo offline. */
function held(uid: string): boolean {
  if (pins().has(uid)) return true;
  for (const uids of albumPins.values()) if (uids.has(uid)) return true;
  return false;
}

function savePins(): void {
  if (!isReady() || !pinned) return;
  try {
    const albums = Object.fromEntries([...albumPins].map(([album, uids]) => [album, [...uids]]));
    // Only the photos still kept: a time outlives nothing it was written for.
    const keep = wanted();
    const times = Object.fromEntries([...captureTimes].filter(([uid]) => keep.has(uid)));
    const blob: OfflineList = { v: 1, uids: [...pinned], albums, times };
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
  albumPins = new Map();
  captureTimes = new Map();
  progress.running = false;
  progress.done = 0;
  progress.total = 0;
  progress.failed = 0;
}

/** Whether this photo's original is stored and ready to serve without a network. */
export function isOfflineReady(uid: string): boolean {
  return held(uid) && originalHas(uid);
}

export function offlineStatus(): OfflineStatus {
  const usage = originalUsage();
  return {
    pinned: [...wanted()],
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
    const revision = activeRevisionOf(node);
    const size = Number(revision?.claimedSize ?? 0);
    const taken = toMillis(node?.photo?.captureTime) || toMillis(node?.creationTime);
    if (taken > 0 && captureTimes.get(uid) !== taken) {
      captureTimes.set(uid, taken);
      savePins();
    }
    metaPut(uid, {
      name: nodeName(node) || uid,
      mediaType: node?.mediaType ?? null,
      ...(size > 0 ? { size } : {}),
    });

    const { downloader, unused } = await openDownloader(photos, uid);
    if (!held(uid)) {
      unused(); // unpinned while it was set up: its download slot goes back
      return false;
    }
    sealer = new OriginalSealer(uid);
    const writer = sealer;
    const stream = new WritableStream<Uint8Array>({
      write(chunk) {
        if (!held(uid)) throw new Error("UNPINNED");
        return writer.write(chunk);
      },
      abort() {
        void writer.abort();
      },
    });
    await downloader.downloadToStream(stream as any).completion();
    if (!held(uid)) {
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
      const queue = [...wanted()].filter((uid) => !originalHas(uid));
      if (queue.length === 0) break;
      progress.total = progress.done + queue.length;
      let stalled = true;
      for (const uid of queue) {
        if (!held(uid)) continue; // unpinned while we queued
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

/** Whether the user asked for this photo to be kept offline. */
export function isPinned(uid: string): boolean {
  return pins().has(uid);
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
    // A photo an album kept offline holds still keeps its copy.
    if (!held(uid)) originalDelete(uid);
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
  albumPins.clear();
  savePins();
  const freed = originalDeleteAll();
  process.stderr.write(`[offline] freed ${freed} stored originals (${listed} listed)\n`);
  return offlineStatus();
}

/** The albums kept offline. */
export function offlineAlbums(): string[] {
  pins();
  return [...albumPins.keys()];
}

/**
 * Keeps an album offline with these photos (`uids`), or stops keeping it (`null`). The album's
 * photos are fetched as one-by-one photos are; a photo it no longer holds, and nothing else keeps,
 * gives its copy back, a download in flight included. Returns at once, as `pinOffline` does.
 */
export function setAlbumOffline(photos: any, albumUid: string, uids: string[] | null): OfflineStatus {
  pins();
  const before = albumPins.get(albumUid) ?? new Set<string>();
  if (uids) albumPins.set(albumUid, new Set(uids));
  else albumPins.delete(albumUid);
  const kept = albumPins.get(albumUid) ?? new Set<string>();
  let dropped = 0;
  for (const uid of before) {
    if (kept.has(uid) || held(uid)) continue;
    originalDelete(uid);
    dropped++;
  }
  savePins();
  process.stderr.write(`[offline] album ${uids ? `kept, ${kept.size} photos` : "no longer kept"}, ${dropped} copies given back\n`);
  if (uids) void drain(photos);
  return offlineStatus();
}

/** Photos just put into an album kept offline join it at once. */
export function addToOfflineAlbum(photos: any, albumUid: string, uids: string[]): void {
  pins();
  const album = albumPins.get(albumUid);
  if (!album || uids.length === 0) return;
  for (const uid of uids) album.add(uid);
  savePins();
  void drain(photos);
}

/**
 * Notes when the kept photos among `items` were taken, from a timeline just read, so a copy
 * kept before these times were recorded lists in its place on the next start with no network.
 */
export function noteOfflineTimes(items: { uid: string; captureTime: number }[]): void {
  pins();
  if (!pinned) return;
  let changed = false;
  for (const { uid, captureTime } of items) {
    if (!(captureTime > 0) || captureTimes.get(uid) === captureTime || !held(uid)) continue;
    captureTimes.set(uid, captureTime);
    changed = true;
  }
  if (changed) savePins();
}

/**
 * The photos whose copies are here, newest first: the library the app opens when Proton
 * cannot be reached. A photo with no recorded time sorts by when its copy was saved.
 */
export function offlineLibrary(): { uid: string; captureTime: number; tags: number[] }[] {
  const out: { uid: string; captureTime: number; tags: number[] }[] = [];
  for (const uid of wanted()) {
    if (!originalHas(uid)) continue;
    const captureTime = captureTimes.get(uid) ?? originalStoredAt(uid) ?? 0;
    out.push({ uid, captureTime, tags: [] });
  }
  return out.sort((a, b) => b.captureTime - a.captureTime);
}
