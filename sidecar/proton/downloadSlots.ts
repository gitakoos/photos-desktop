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

/**
 * The SDK's download slots, given back when a downloader is not used.
 *
 * The SDK lets five downloads run at once. `getFileDownloader` takes a slot as it makes the
 * downloader, and the slot comes back only when a download of it ends (in that download's
 * `finally`, however it ends). A downloader made and then not used (the viewer stepped on
 * while it was set up, a file over a size cap, a pin taken back) kept its slot for good;
 * after five of those every download in the app waited for ever.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { diag, logStamp } from "./diag.ts";

export type OpenedDownloader = {
  downloader: any;
  /** Gives the slot back when no download of it has started. Does nothing once one has. */
  unused(): void;
  /** Stops a download of it under way, whose end gives the slot back; or gives it back unused. */
  stop(): void;
};

/** Downloaders holding a slot, by when each took it: what the slot log reports. */
const holding = new Map<number, number>();
let nextHolder = 0;

/** How many slots this app holds, and for how long the oldest has been held. */
export function slotsInUse(now = Date.now()): { count: number; oldestMs: number } {
  let oldest = now;
  for (const since of holding.values()) oldest = Math.min(oldest, since);
  return { count: holding.size, oldestMs: now - oldest };
}

/** How often the slot log looks. */
const SLOT_LOG_EVERY_MS = 5_000;
let slotLog: ReturnType<typeof setInterval> | null = null;
let lastLogged = 0;

/**
 * With Detailed logging on, every few seconds while any slot is held, one line in the app's
 * log saying how many and for how long the oldest:
 *   [HH:MM:SS] [sidecar] [slots] in_use=<n> oldest=<ms>
 * A slot lost, or a download that never ends, shows as a count that does not come down,
 * rather than as a hang nobody can see. Counts and ages only.
 */
function watchSlots(): void {
  if (slotLog || !diag.isDetailed()) return;
  slotLog = setInterval(() => slotLogTick(), SLOT_LOG_EVERY_MS);
  slotLog.unref?.();
}

/** One look of the slot log; stops it once nothing is held or Detailed logging is off. */
export function slotLogTick(write: (line: string) => void = (line) => process.stderr.write(line)): void {
  const { count, oldestMs } = slotsInUse();
  const on = diag.isDetailed();
  if (on && (count > 0 || lastLogged > 0)) write(`${logStamp()} [sidecar] [slots] in_use=${count} oldest=${oldestMs}\n`);
  lastLogged = on ? count : 0;
  if ((count === 0 || !on) && slotLog) {
    clearInterval(slotLog);
    slotLog = null;
  }
}

/** Counts a slot as held from now; the returned function lets it go, once. */
function holdSlot(): () => void {
  const id = nextHolder++;
  holding.set(id, Date.now());
  watchSlots();
  return () => holding.delete(id);
}

/** Lets the slot go in the log once the download whose end gives it back has ended. */
function letGoAfter(controller: any, letGo: () => void): void {
  void Promise.resolve()
    .then(() => controller?.completion())
    .catch(() => {})
    .finally(letGo);
}

/**
 * A downloader for `uid`, with the way to give its slot back unused. Waits for a free slot
 * as long as the SDK makes it wait, or until `signal` fires.
 */
export async function openDownloader(client: any, uid: string, signal?: AbortSignal): Promise<OpenedDownloader> {
  const stop = new AbortController();
  const downloader = await client.getFileDownloader(uid, signal ? AbortSignal.any([signal, stop.signal]) : stop.signal);
  const letGo = holdSlot();
  let started = false;
  const start = downloader.downloadToStream?.bind(downloader);
  if (start) {
    downloader.downloadToStream = (...args: unknown[]) => {
      started = true;
      const controller = start(...args);
      letGoAfter(controller, letGo);
      return controller;
    };
  } else {
    letGo();
  }
  const unused = () => {
    if (started) return;
    started = true;
    releaseUnusedDownloader(start, stop, letGo);
  };
  return {
    downloader,
    unused,
    stop() {
      if (started) stop.abort();
      else unused();
    },
  };
}

/**
 * Hands back the slot of a downloader that will not be used. The SDK gives a slot back
 * only when a download ends, so one is started with `stop` already fired: it ends at once,
 * and its end gives the slot back.
 */
function releaseUnusedDownloader(
  start: ((...args: unknown[]) => any) | undefined,
  stop: AbortController,
  letGo: () => void,
): void {
  stop.abort();
  try {
    letGoAfter(start?.(new WritableStream<Uint8Array>({ write() {} })), letGo);
  } catch {
    /* a downloader that will not even start has nothing to give back */
    letGo();
  }
}
