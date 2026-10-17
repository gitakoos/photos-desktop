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

import { useEffect, useMemo, useState } from "react";
import { rpc } from "../lib/rpc";
import { isLightboxOpen } from "../lib/lightboxSignal";
import { cachedThumbnail, putThumbnail, useThumbServerBase } from "../lib/thumbStore";

/**
 * Streams decrypted thumbnails for a set of nodes, in batches, so the grid can paint as
 * they arrive.
 *
 * Cache-aware: it seeds from and writes back to the shared thumbnail store, so a view
 * revisited after a tab switch paints its already-decoded thumbnails on the first frame
 * instead of re-fetching them and popping in late. Only the misses ever reach the sidecar.
 */
export function useThumbnails(uids: string[]): Record<string, string | null> {
  const [thumbs, setThumbs] = useState<Record<string, string | null>>(() => {
    const seed: Record<string, string | null> = {};
    for (const uid of uids) {
      const hit = cachedThumbnail(uid);
      if (hit !== undefined) seed[uid] = hit;
    }
    return seed;
  });
  const key = uids.join(",");
  // With the thumbnail server up, each thumbnail is simply its URL: the webview fetches
  // it when the image is drawn, and nothing is carried through the channel.
  const base = useThumbServerBase();
  const served = useMemo(() => {
    if (!base) return null;
    const out: Record<string, string | null> = {};
    for (const uid of uids) out[uid] = base + encodeURIComponent(uid);
    return out;
    // `key` stands for `uids`, which is a fresh array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, key]);

  useEffect(() => {
    if (served) return;
    // An empty list leaves the record alone: that is a view standing down rather than
    // one showing nothing (Albums blanks its cover list while an album is open, and
    // wants those covers back on the way out).
    if (uids.length === 0) return;

    // Split the list into what the shared cache already holds and what has to be fetched.
    const missing: string[] = [];
    const seeded: Record<string, string | null> = {};
    for (const uid of uids) {
      const hit = cachedThumbnail(uid);
      if (hit === undefined) missing.push(uid);
      else seeded[uid] = hit;
    }

    // Prune the record to the current list and paint the cache hits at once, without
    // blinking tiles that are already right. Pruning rather than emptying keeps a large
    // browse from holding every decoded thumbnail it has ever shown.
    setThumbs((prev) => {
      const next: Record<string, string | null> = {};
      let changed = false;
      for (const uid of uids) {
        if (uid in prev) next[uid] = prev[uid];
        else if (uid in seeded) {
          next[uid] = seeded[uid];
          changed = true;
        }
      }
      if (!changed && Object.keys(next).length === Object.keys(prev).length) return prev;
      return next;
    });

    let cancelled = false;

    (async () => {
      // Small chunks so an interactive request never waits behind a big eager fill on the
      // single channel; the API itself caps at 30 ids.
      const BATCH = 8;
      for (let i = 0; i < missing.length && !cancelled; i += BATCH) {
        // Stand aside while the viewer is open, so opening a photo here does not queue
        // behind this fill. Resumes when the viewer closes.
        while (!cancelled && isLightboxOpen()) {
          await new Promise((r) => setTimeout(r, 150));
        }
        if (cancelled) return;
        const chunk = missing.slice(i, i + BATCH);
        try {
          const res = await rpc<{ uid: string; dataUrl: string | null }[]>("getThumbnails", {
            uids: chunk,
          });
          if (cancelled) return;
          // Warm the shared store first, so the lazy grid and covers elsewhere reuse these.
          for (const r of res) putThumbnail(r.uid, r.dataUrl);
          setThumbs((prev) => {
            const next = { ...prev };
            for (const r of res) next[r.uid] = r.dataUrl;
            return next;
          });
        } catch {
          /* one bad batch must not stop the rest */
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, served]);

  return served ?? thumbs;
}
