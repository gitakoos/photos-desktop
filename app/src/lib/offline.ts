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
// This is the app's own copy, sealed in its own directory with the account's key. It
// is NOT the Explorer mount: nothing here ever appears under "Proton Photos" in File
// Explorer, and the two can be used together or apart. `download.ts` owns that other
// meaning of Download; keeping them in separate modules is what keeps them from being
// mistaken for one another.
//
// The sidecar owns the state, so this is a thin client over it plus one shared
// subscription: several views badge the same photos, and polling once for all of them
// keeps a single reader on the host's one RPC channel.

import { rpc } from "./rpc";

/** What the sidecar reports: what is marked, how much has landed, what it costs. */
export type OfflineStatus = {
  pinned: string[];
  ready: number;
  bytes: number;
  running: boolean;
  done: number;
  total: number;
  failed: number;
};

const EMPTY: OfflineStatus = {
  pinned: [],
  ready: 0,
  bytes: 0,
  running: false,
  done: 0,
  total: 0,
  failed: 0,
};

// Idle photos change only when the user marks or unmarks one, which we already know
// about; the fast interval is for watching a batch land.
const IDLE_POLL_MS = 5000;
const BUSY_POLL_MS = 700;

// `null` until the first reading lands, which is not the same as "nothing is kept":
// a panel that showed a confident zero before it had asked would be lying.
let latest: OfflineStatus | null = null;
const listeners = new Set<(s: OfflineStatus) => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

function publish(status: OfflineStatus): void {
  latest = status;
  for (const listener of listeners) listener(status);
}

async function poll(): Promise<void> {
  timer = undefined;
  if (listeners.size === 0) return; // nobody is watching; the next subscribe restarts it
  try {
    publish(await rpc<OfflineStatus>("offlineStatus"));
  } catch {
    // Locked, signed out, or a sidecar restart. Report nothing rather than a stale
    // set: a badge on a photo that is no longer stored is worse than no badge.
    publish(EMPTY);
  }
  schedule(latest?.running ? BUSY_POLL_MS : IDLE_POLL_MS);
}

function schedule(ms: number): void {
  if (timer !== undefined || listeners.size === 0) return;
  timer = setTimeout(() => void poll(), ms);
}

/**
 * Watch the offline set. Every view that badges photos shares this one poll, and the
 * callback fires immediately with the last reading, so a remount does not blink. A
 * subscriber that arrives before any reading simply hears nothing until the first.
 */
export function watchOffline(listener: (status: OfflineStatus) => void): () => void {
  listeners.add(listener);
  if (latest) listener(latest);
  if (listeners.size === 1) void poll();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}

/** Read the state once, without subscribing. */
export async function offlineStatus(): Promise<OfflineStatus> {
  try {
    const status = await rpc<OfflineStatus>("offlineStatus");
    publish(status);
    return status;
  } catch {
    return EMPTY;
  }
}

/**
 * Mark photos as available offline. The fetch runs in the sidecar, so this returns as
 * soon as the marks are recorded and the watchers show the count climbing.
 */
export async function pinOffline(uids: string[]): Promise<number> {
  const before = new Set(latest?.pinned ?? []);
  const added = uids.filter((uid) => !before.has(uid)).length;
  publish(await rpc<OfflineStatus>("pinOffline", { uids }));
  // Watchers are on the idle interval until the sidecar reports the batch running;
  // ask again shortly so the first photos show up without a five-second wait.
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  schedule(BUSY_POLL_MS);
  return added;
}

/** Unmark photos and reclaim the space their originals held. */
export async function unpinOffline(uids: string[]): Promise<number> {
  const before = new Set(latest?.pinned ?? []);
  const removed = uids.filter((uid) => before.has(uid)).length;
  publish(await rpc<OfflineStatus>("unpinOffline", { uids }));
  return removed;
}

/** The Settings panel's reclaim-everything. Returns how many photos it dropped. */
export async function unpinAllOffline(): Promise<number> {
  const before = latest?.pinned.length ?? 0;
  publish(await rpc<OfflineStatus>("unpinAllOffline"));
  return before;
}
