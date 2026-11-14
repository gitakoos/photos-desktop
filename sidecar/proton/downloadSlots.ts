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
 * The SDK's download slots, taken and given back so none is lost.
 *
 * The SDK lets five downloads run at once. `getFileDownloader` takes a slot as it makes the
 * downloader, and the slot comes back only when a download of it ends (in that download's
 * `finally`, however it ends). A downloader made and then not used (the viewer stepped on
 * while it was set up, a file over a size cap, a pin taken back) kept its slot for good;
 * after five of those every download in the app waited for ever: a video stuck on its
 * loading note, and, because the viewer's calls queue on one lane, search and everything
 * else behind it.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** How long to wait for a free slot before giving up with an error rather than hanging. */
export const SLOT_WAIT_MS = 60_000;

/** How many downloads the SDK lets run at once. */
export const SDK_SLOTS = 5;

/**
 * Slots lent out: those of a playing video's extra read lanes. Any other download that finds
 * every slot taken has the newest given back, so a video never keeps a save, an export or an
 * offline copy waiting.
 */
const lent: Array<() => void> = [];
/** Downloaders being made now: they take a slot before they are counted in `holding`. */
let opening = 0;
/** How often a download still waiting for a slot takes back one more lent slot. */
const RECLAIM_EVERY_MS = 500;
/** How long a download may take to be made before lent slots are taken back regardless. */
const RECLAIM_AFTER_MS = 1_500;

/** Lends a slot, given back by `giveBack` when another download needs it. Returns how to
 * take it off the list (when it is let go some other way). */
export function lendSlot(giveBack: () => void): () => void {
  lent.push(giveBack);
  return () => {
    const at = lent.indexOf(giveBack);
    if (at >= 0) lent.splice(at, 1);
  };
}

export type OpenedDownloader = {
  downloader: any;
  /** Gives the slot back without downloading. For a downloader that will not be used. */
  unused(): void;
  /** Fired to stop a download of it under way, which then ends and gives the slot back. */
  stop: AbortController;
  /**
   * For a downloader read some other way than a whole download (the seekable stream, whose
   * slot the SDK gives back when `stop` fires): tells the slot log it is let go.
   */
  released(): void;
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

/** "[HH:MM:SS]" in UTC, as the host stamps its own lines in the same log. */
function stamp(now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `[${two(now.getUTCHours())}:${two(now.getUTCMinutes())}:${two(now.getUTCSeconds())}]`;
}

/**
 * Every few seconds while any slot is held, one line in the app's log saying how many and
 * for how long the oldest: a slot lost, or a download that never ends, shows as a count that
 * does not come down, rather than as a hang nobody can see.
 */
function watchSlots(): void {
  if (slotLog) return;
  slotLog = setInterval(() => {
    const { count, oldestMs } = slotsInUse();
    if (count > 0 || lastLogged > 0) {
      process.stderr.write(`${stamp()} [sidecar] [slots] in_use=${count} oldest=${oldestMs}\n`);
    }
    lastLogged = count;
    if (count === 0 && slotLog) {
      clearInterval(slotLog);
      slotLog = null;
    }
  }, SLOT_LOG_EVERY_MS);
  slotLog.unref?.();
}

/**
 * Follows a downloader's slot: held from now, and let go when a download of it ends, which
 * is when the SDK gives the slot back.
 */
function follow(downloader: any): number {
  const id = nextHolder++;
  holding.set(id, Date.now());
  watchSlots();
  const start = downloader.downloadToStream?.bind(downloader);
  if (!start) return id;
  downloader.downloadToStream = (...args: unknown[]) => {
    const controller = start(...args);
    void Promise.resolve()
      .then(() => controller.completion())
      .catch(() => {})
      .finally(() => holding.delete(id));
    return controller;
  };
  return id;
}

/**
 * A downloader for `uid`, with the way to give its slot back unused. Waiting for a free
 * slot gives up after `waitMs`, so a slot lost some other way shows as an error, not a hang.
 */
export async function openDownloader(
  client: any,
  uid: string,
  waitMs = SLOT_WAIT_MS,
  { borrow = false }: { borrow?: boolean } = {},
): Promise<OpenedDownloader> {
  // A slot lent to a video's read lane comes back for any download but another lane: at once
  // when every slot is counted taken, and one more every so often while this still waits
  // (some downloads take slots this does not count).
  if (!borrow && holding.size + opening >= SDK_SLOTS) lent.pop()?.();
  const since = Date.now();
  const reclaim = borrow
    ? undefined
    : setInterval(() => {
        if (holding.size + opening >= SDK_SLOTS || Date.now() - since >= RECLAIM_AFTER_MS) lent.pop()?.();
      }, RECLAIM_EVERY_MS);
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), waitMs);
  let downloader: any;
  opening++;
  try {
    downloader = await client.getFileDownloader(uid, stop.signal);
  } finally {
    opening--;
    clearTimeout(timer);
    clearInterval(reclaim);
  }
  // Made just as the wait ran out: the SDK holds its slot, and a stream of it would never see
  // the signal fire. It is given back now, and the caller is told there was no slot in time.
  if (stop.signal.aborted) {
    releaseUnusedDownloader(downloader, stop);
    throw new Error("no download slot in time");
  }
  const held = follow(downloader);
  let done = false;
  return {
    downloader,
    stop,
    released() {
      holding.delete(held);
    },
    unused() {
      if (done) return;
      done = true;
      releaseUnusedDownloader(downloader, stop);
    },
  };
}

/**
 * Hands back the slot of a downloader that will not be used. The SDK gives a slot back
 * only when a download ends, so one is started with `stop` already fired: it ends at once,
 * and its end gives the slot back.
 */
export function releaseUnusedDownloader(downloader: any, stop: AbortController): void {
  stop.abort();
  try {
    void Promise.resolve(
      downloader.downloadToStream(new WritableStream<Uint8Array>({ write() {} })).completion(),
    ).catch(() => {});
  } catch {
    /* a downloader that will not even start has nothing to give back */
  }
}
