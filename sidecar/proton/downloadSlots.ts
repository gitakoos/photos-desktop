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

export type OpenedDownloader = {
  downloader: any;
  /** Gives the slot back when no download of it has started. Does nothing once one has. */
  unused(): void;
  /** Stops a download of it under way, whose end gives the slot back; or gives it back unused. */
  stop(): void;
};

/**
 * A downloader for `uid`, with the way to give its slot back unused. Waits for a free slot
 * as long as the SDK makes it wait, or until `signal` fires.
 */
export async function openDownloader(client: any, uid: string, signal?: AbortSignal): Promise<OpenedDownloader> {
  const stop = new AbortController();
  const downloader = await client.getFileDownloader(uid, signal ? AbortSignal.any([signal, stop.signal]) : stop.signal);
  let started = false;
  const start = downloader.downloadToStream?.bind(downloader);
  if (start) {
    downloader.downloadToStream = (...args: unknown[]) => {
      started = true;
      return start(...args);
    };
  }
  const unused = () => {
    if (started) return;
    started = true;
    releaseUnusedDownloader(start, stop);
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
function releaseUnusedDownloader(start: ((...args: unknown[]) => any) | undefined, stop: AbortController): void {
  stop.abort();
  try {
    void Promise.resolve(start?.(new WritableStream<Uint8Array>({ write() {} }))?.completion()).catch(() => {});
  } catch {
    /* a downloader that will not even start has nothing to give back */
  }
}
