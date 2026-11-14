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
 * Grid thumbnails the size the grid shows them.
 *
 * Proton's grid thumbnail is 512 px. A tile on the timeline is some 120-200 px, so the
 * window decoded each one at sixteen times the pixels it showed and scaled it down again on
 * every paint; on a wide window that is a thousand such pictures, and the measurement found
 * the window's thread busy with the browser's own work for four fifths of every scroll. The
 * window now says how large it shows a tile, and the server hands it a picture that size,
 * cut down here once and kept a while.
 */

import sharp from "sharp";

/** The sizes a thumbnail is cut to, in pixels on its shorter side. A request is rounded up. */
export const THUMB_WIDTHS = [128, 192, 256, 320, 384] as const;

/**
 * The size to cut a thumbnail to for a tile `px` device pixels on its longer side, or null
 * for the full thumbnail (a tile as large as it, or a size that is not a number).
 */
export function thumbWidthFor(px: number): number | null {
  if (!Number.isFinite(px) || px <= 0) return null;
  for (const w of THUMB_WIDTHS) if (px <= w) return w;
  return null;
}

/**
 * Cuts `full` down so its shorter side is `width` (never enlarging it), as a JPEG: the
 * shorter side is what a tile cut to fill its frame needs whole.
 */
export async function shrinkThumb(full: Buffer, width: number): Promise<Buffer> {
  return sharp(full, { failOn: "none" })
    .rotate()
    .resize(width, width, { fit: "outside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
}

/** Bytes of cut-down thumbnails kept: at some 10 KB each, several thousand. */
const KEEP_BYTES = 48 * 1024 * 1024;

/**
 * Cut-down thumbnails, kept by uid and size up to KEEP_BYTES, oldest out first, and made
 * once for any number of asks at the same moment. Forgotten at lock.
 */
export class SmallThumbs {
  private kept = new Map<string, Buffer>();
  private keptBytes = 0;
  private making = new Map<string, Promise<Buffer | null>>();
  /** Bumped by `clear`, so a cut finishing after a lock is not kept. */
  private epoch = 0;

  constructor(
    private keepBytes = KEEP_BYTES,
    /**
     * Where cut thumbnails are kept between runs (sealed beside the thumbnails): each photo
     * is cut once for a size, not again at every start and every scroll back.
     */
    private disk?: { get(key: string): Buffer | null; put(key: string, small: Buffer): void },
  ) {}

  /** The thumbnail of `uid` cut to `width`, made from `full()` if it is not kept. */
  async get(uid: string, width: number, full: () => Promise<Buffer | null>): Promise<Buffer | null> {
    const key = `${uid}|${width}`;
    const hit = this.kept.get(key);
    if (hit) {
      this.kept.delete(key);
      this.kept.set(key, hit);
      return hit;
    }
    const same = this.making.get(key);
    if (same) return same;
    const stored = this.disk?.get(key);
    if (stored) {
      this.keep(key, stored);
      return stored;
    }
    const epoch = this.epoch;
    const made = (async () => {
      const bytes = await full();
      if (!bytes) return null;
      try {
        const small = await shrinkThumb(bytes, width);
        if (epoch === this.epoch) {
          this.keep(key, small);
          this.disk?.put(key, small);
        }
        return small;
      } catch {
        // A picture sharp cannot read is handed over as it came, as before.
        return bytes;
      }
    })();
    this.making.set(key, made);
    try {
      return await made;
    } finally {
      if (this.making.get(key) === made) this.making.delete(key);
    }
  }

  /** Forget every cut thumbnail: at lock. */
  clear(): void {
    this.epoch++;
    this.kept.clear();
    this.keptBytes = 0;
  }

  /** Bytes kept (for tests). */
  bytes(): number {
    return this.keptBytes;
  }

  private keep(key: string, small: Buffer): void {
    this.kept.set(key, small);
    this.keptBytes += small.length;
    while (this.keptBytes > this.keepBytes) {
      const oldest = this.kept.keys().next().value;
      if (oldest === undefined) break;
      this.keptBytes -= this.kept.get(oldest)!.length;
      this.kept.delete(oldest);
    }
  }
}
