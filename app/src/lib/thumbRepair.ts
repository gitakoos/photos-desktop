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

// Thumbnails for the videos Proton holds none for: they went up from a computer that could
// not draw one (an import on Linux whose decoder did not know the format, say). The sidecar
// notes each one Proton answers "no image preview" for as the grid and the duplicate finder
// ask; the host draws a picture of it from the app's own loopback stream, and the sidecar
// keeps that as its thumbnail on this computer, where the grid, the duplicate finder and the
// stacks read it from then on. Proton's copy is left as it is.

import { invoke } from "@tauri-apps/api/core";

import { isLightboxOpen } from "./lightboxSignal";
import { isWindows } from "./platform";
import { rpc } from "./rpc";
import { videoFrameUrl } from "./thumbStore";

/** Videos drawn per round, three at a time by the host: each read only as far as a picture needs. */
const BATCH = 6;
/** The pause between rounds, and the longer one when there is nothing to draw or it must wait. */
const BETWEEN_MS = 250;
const IDLE_MS = 10_000;
/** Videos in a row this computer's decoders could not draw: past this, it cannot decode them. */
const GIVE_UP_AFTER = 8;

const listeners = new Set<(uids: string[]) => void>();
let running = false;
let epoch = 0;
let failedInRow = 0;

/** Calls `listener` with the uids that have a thumbnail now. */
export function onThumbsMade(listener: (uids: string[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Starts drawing thumbnails for the videos the sidecar found with none, while the window shows
 * the library: one round at a time, held while a photo is open (its video goes first) or the
 * window is out of sight. Stops at lock (`forgetThumbRepairs`).
 */
export function startThumbRepairs(): void {
  // Windows draws frames from files through the shell, which cannot read a stream.
  if (running || isWindows) return;
  running = true;
  const mine = epoch;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  void (async () => {
    while (mine === epoch && failedInRow < GIVE_UP_AFTER) {
      if (document.hidden || isLightboxOpen()) {
        await sleep(IDLE_MS);
        continue;
      }
      const got = await rpc<{ uids: string[] }>("thumblessVideos", { limit: BATCH }).catch(() => null);
      if (mine !== epoch) break;
      const uids = got?.uids ?? [];
      if (uids.length === 0) {
        await sleep(IDLE_MS);
        continue;
      }
      const items = uids.flatMap((uid) => {
        const url = videoFrameUrl(uid);
        return url ? [{ uid, url }] : [];
      });
      const drawn = await invoke<{ frames: Record<string, string>; failed: Record<string, string> }>("thumb_frames", {
        items,
      }).catch(() => null);
      const frames = drawn?.frames ?? {};
      // Only what the decoders could not draw is left alone; anything else is asked again.
      const undrawable = uids.filter((uid) => drawn?.failed[uid] === "decode");
      const letGo = uids.filter((uid) => !frames[uid] && !undrawable.includes(uid));
      if (Object.keys(frames).length > 0) failedInRow = 0;
      else failedInRow += undrawable.length;
      // Handed back even after a lock began, so the staged frames are deleted.
      const made = await rpc<{ stored: string[] }>("putLocalThumbnails", {
        frames,
        undrawable,
        letGo,
        roundOver: mine === epoch,
      }).catch(() => null);
      if (mine !== epoch) break;
      if (made?.stored.length) for (const listener of listeners) listener(made.stored);
      await sleep(BETWEEN_MS);
    }
    if (mine === epoch) running = false;
  })();
}

/** Stops at lock; what is under way is let go, and nothing is written for the next session. */
export function forgetThumbRepairs(): void {
  epoch++;
  running = false;
  failedInRow = 0;
}
