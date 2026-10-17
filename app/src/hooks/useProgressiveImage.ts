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

import { useEffect, useRef, useState } from "react";

/**
 * Show the best available view of one photo, upgrading in place.
 *
 * The viewer has up to three views of the same photo, each sharper and slower to arrive
 * than the last: the grid thumbnail it already holds, the preview, and the photo's own
 * full-resolution bytes. `sources` lists them worst first; a source that has not
 * arrived yet is null.
 *
 * Two things make the upgrade invisible:
 *
 *  - Assigning a new URL to an <img> blanks it until the new bytes decode, which reads
 *    as a flash on every step up. So an upgrade is decoded off-screen first and only
 *    becomes the displayed source once it is ready to paint — the swap is then a single
 *    frame with no gap.
 *  - A candidate that cannot be decoded is dropped and whatever is on screen stays. That
 *    is also the honest answer for a format the engine cannot draw: no broken image, no
 *    message, the photo simply stays at the quality that did work.
 *
 * The FIRST source for a photo is shown straight away without waiting for a decode.
 * There is nothing to flash away from at that point, and the whole value of the cached
 * thumbnail is that it is instant.
 *
 * Downgrades are ignored: once a better source is showing, a worse one arriving late
 * (or a candidate reverting to null) cannot pull the quality back down.
 */
export function useProgressiveImage(
  key: string,
  sources: (string | null | undefined)[],
): string | undefined {
  const [shown, setShown] = useState<{ key: string; url: string; rank: number } | null>(null);

  // Read through a ref inside the effect: `shown` is what the effect writes, so having
  // it in the dependency list would re-run the effect on its own result.
  const shownRef = useRef(shown);
  shownRef.current = shown;

  // The best candidate that has actually arrived. Later entries outrank earlier ones.
  let best: string | null = null;
  let bestRank = -1;
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    if (source) {
      best = source;
      bestRank = i;
    }
  }

  useEffect(() => {
    if (!best) return;
    const current = shownRef.current;
    // Anything held for a different photo is stale the moment the key changes.
    const live = current && current.key === key ? current : null;
    if (live && live.rank >= bestRank) return;

    if (!live) {
      setShown({ key, url: best, rank: bestRank });
      return;
    }

    let cancelled = false;
    let settled = false;
    const url = best;
    const probe = new Image();

    const promote = () => {
      if (settled || cancelled) return;
      settled = true;
      setShown({ key, url, rank: bestRank });
    };
    // The engine cannot draw this one. Nothing is said and nothing changes: the view
    // that did work stays, which is how an upgrade to a format the webview has no
    // decoder for (HEIC, RAW, most TIFF) ends up invisible rather than broken.
    const abandon = () => {
      settled = true;
    };

    probe.addEventListener("load", promote, { once: true });
    probe.addEventListener("error", abandon, { once: true });
    probe.src = url;
    // `decode()` is the stronger signal — it settles only once the bitmap is ready to
    // paint, which is precisely what makes the swap seamless. It cannot be the gate,
    // though: in a document that is hidden (minimised, or the window suspended while
    // the app sits in the tray) it never settles at all, even for an image that has
    // fully loaded, and the viewer would sit on the thumbnail for ever. So the load /
    // error pair decides, and this only ever gets there sooner.
    void probe.decode().then(promote).catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [key, best, bestRank]);

  // Between a key change and the effect that follows it, `shown` still describes the
  // previous photo — fall through to the new one's own best source so the viewer never
  // shows one photo under another's name.
  const live = shown && shown.key === key ? shown : null;
  return live?.url ?? best ?? undefined;
}
