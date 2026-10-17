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

import { convertFileSrc } from "@tauri-apps/api/core";
import { rpc } from "./rpc";

/**
 * The viewer's last step: the photo's own full-resolution bytes.
 *
 * The preview above this one is a thumbnail — Proton's larger one, but still a
 * downscaled copy — so it is the ceiling on what the viewer can show. This fetches the
 * real file instead.
 *
 * The bytes arrive by one of two routes, chosen by the sidecar on size.
 *
 * An ordinary photo is held decrypted in the sidecar's memory and served through our
 * own `pfpview` scheme, so nothing decrypted is written to disk. It costs one pass over
 * the JSON-RPC channel, which is why the sidecar caps what may take it: measured at
 * 5.5 ms per MB here, a 16 MiB ceiling keeps that hold under the budget the host's
 * priority gate exists to defend. The URL names an unguessable token for the one photo
 * the viewer is on, and the sidecar drops the bytes the moment it steps away.
 *
 * A photo past that ceiling is streamed to a file in a staging folder instead and read
 * over Tauri's asset protocol. That protocol's reach is one glob in `tauri.conf.json`:
 * `$TEMP/pfp-view/*`. It is a single folder, non-recursive (Tauri's scope globs do not
 * cross a separator), nothing but our own staged files is ever written there, and the
 * sidecar deletes each one as soon as the viewer moves off it.
 *
 * The CSP grant for both is on `img-src` only: the webview may draw them, and may not
 * fetch, script, frame or style from them. No other filesystem access is opened
 * anywhere in the app.
 */
type OriginalStatus =
  | { state: "loading" }
  | { state: "ready"; via: "memory"; token: string; size: number; mime: string }
  | { state: "ready"; via: "file"; path: string; size: number }
  | { state: "unsupported" }
  | { state: "error" };

/** Must match `VIEW_SCHEME` in the host. */
const VIEW_SCHEME = "pfpview";

// The transfer runs inside the sidecar, off the channel, so its progress is polled the
// way a save-to-folder run is. It starts brisk, so a small photo upgrades almost at
// once, then eases off: a 50 MB original would otherwise ask a hundred-odd times on the
// one channel to learn what it already knows, and the answer will not come any sooner.
const POLL_MS = 200;
const POLL_MAX_MS = 1000;

// A ceiling on the wait, so a transfer that somehow never settles cannot leave the
// poll running for the life of the session. The preview stays on screen either way.
const POLL_TIMEOUT_MS = 180_000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The photo this side has actually asked the sidecar for an original of, or null when
 * it has asked for none.
 *
 * This mirrors what can possibly be staged over there, and it can, because the sidecar
 * holds exactly one original at a time and `getOriginal` is the only thing that ever
 * sets it. So a photo that was never asked for provably has nothing on disk, and the
 * release for it is a call the sidecar answers by doing nothing, once it has queued
 * behind everything else on the one channel. Stepping through fifty photos would send
 * fifty of those.
 *
 * Skipping the release for a photo this no longer names cannot strand a staged file
 * either: whatever displaced it here is a `getOriginal` for a different photo, and the
 * sidecar's own first act on one of those is to drop the previous original and delete
 * its file.
 */
let asked: string | null = null;

/**
 * Fetch one photo's original and return a URL the webview can draw, or `null` when
 * there is nothing better to show than the preview.
 *
 * `null` is an ordinary outcome, not an error: it is what a format the engine cannot
 * decode (HEIC, RAW, most TIFF) reports, and what a failed or abandoned transfer
 * reports. Every caller treats it the same way — keep the preview, say nothing.
 *
 * A photo kept offline settles on the very first call: its bytes are already in the
 * sealed store, so there is nothing to transfer and nothing to poll for.
 *
 * `cancelled` is polled between round-trips so stepping to another photo drops this
 * one promptly rather than after the current transfer finishes.
 */
export async function fetchOriginal(uid: string, cancelled: () => boolean): Promise<string | null> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let every = POLL_MS;
  while (!cancelled()) {
    let status: OriginalStatus;
    try {
      // Recorded before the call rather than after it, and left standing even when the
      // call fails: from here on the sidecar may be holding this photo, and the release
      // has to go out on the strength of that alone. Erring towards a release that turns
      // out to be unnecessary is the safe direction; the other one leaves a decrypted
      // file behind.
      asked = uid;
      // The first call starts the transfer and every later one reads it back, so this
      // one method both kicks off and polls.
      status = await rpc<OriginalStatus>("getOriginal", { uid });
    } catch {
      return null;
    }
    if (status.state === "ready") {
      // Tauri builds the scheme's URL for the platform, so neither route has to know
      // whether it is `http://<scheme>.localhost/x` or `<scheme>://localhost/x`.
      return status.via === "memory"
        ? convertFileSrc(status.token, VIEW_SCHEME)
        : convertFileSrc(status.path);
    }
    // `unsupported` and `error` are both settled: nothing more is coming.
    if (status.state !== "loading") return null;
    if (Date.now() > deadline) return null;
    await delay(every);
    every = Math.min(Math.round(every * 1.5), POLL_MAX_MS);
  }
  return null;
}

/**
 * Drop a photo's original: the sidecar's in-memory copy, or the staged file when it
 * took that route. Either way it is a decrypted photo, so this goes out as soon as the
 * viewer steps away or closes rather than waiting for the next one to displace it.
 * Naming the photo means a release that races a step to the next one cannot take the
 * new photo's copy with it.
 *
 * Sent only for a photo whose original was actually asked for. A viewer being stepped
 * through leaves most photos behind before their turn to ask ever comes, and a release
 * for one of those has nothing to drop: it is pure traffic on the one channel, in front
 * of the photo the reader is waiting on.
 *
 * Fire-and-forget: a failed cleanup is caught by the sidecar's own retry and, failing
 * that, by the sweep the host runs at startup.
 */
export function releaseOriginal(uid: string): void {
  if (asked !== uid) return;
  asked = null;
  void rpc("releaseOriginal", { uid }).catch(() => {});
}
