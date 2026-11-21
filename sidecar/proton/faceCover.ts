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
 * A person's cover, cut to their face here rather than in the window.
 *
 * The window used to show a cover by laying the whole HD preview (a 1920 px data URL that
 * crossed the request channel) out at many times the card's size and clipping it to the
 * face. A page of people asked for hundreds of those at once: the channel queued behind
 * them, and the window decoded and scaled them on its main thread. Here the face square is
 * cut from the preview once, made card-sized, and served over the loopback thumbnail
 * server like any grid thumbnail, so the window only ever decodes a small JPEG.
 */

import sharp from "sharp";

/** A face as left, top, right, bottom, each a share (0..1) of the photo's width or height. */
export type FaceBox = [number, number, number, number];

/** The square around a face, as a multiple of the face's longer side (the Android app's). */
export const FACE_ZOOM_OUT = 1.4;

/** The side of a cut cover, in pixels: sharp on a large card on a HiDPI screen. */
export const COVER_SIZE = 320;

/** Cut covers kept in memory: at some 20 KB each, a few MB for a long page of people. */
const KEPT = 400;

/** How many covers are cut at once. Each may fetch a preview, so kept low. */
const AT_ONCE = 2;

/**
 * The square cut out of a `width` x `height` picture for `box`: FACE_ZOOM_OUT times the
 * face's longer side, centred on the face and moved (never shrunk below the picture's
 * shorter side) to stay inside the picture. The same square the window used to show.
 */
export function faceSquare(box: FaceBox, width: number, height: number): { left: number; top: number; size: number } {
  const [l, t, r, b] = box;
  const wanted = Math.max((r - l) * width, (b - t) * height) * FACE_ZOOM_OUT;
  const size = Math.max(1, Math.round(Math.min(wanted, width, height)));
  const cx = ((l + r) / 2) * width;
  const cy = ((t + b) / 2) * height;
  const left = Math.round(Math.min(Math.max(cx - size / 2, 0), width - size));
  const top = Math.round(Math.min(Math.max(cy - size / 2, 0), height - size));
  return { left, top, size };
}

/** Reads `l,t,r,b` from a URL: four shares in 0..1 with some area, or null. */
export function parseFaceBox(text: string): FaceBox | null {
  const parts = text.split(",");
  if (parts.length !== 4) return null;
  const n = parts.map((p) => (/^\d*\.?\d+$/.test(p) ? Number(p) : NaN));
  if (n.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) return null;
  const [l, t, r, b] = n;
  if (r <= l || b <= t) return null;
  return [l, t, r, b];
}

/**
 * Cuts the face square out of a photo's bytes, upright as the window shows it (EXIF
 * orientation applied, as the face scan reads it), as a COVER_SIZE JPEG.
 */
export async function cutFace(bytes: Buffer, box: FaceBox, out = COVER_SIZE): Promise<Buffer | null> {
  const meta = await sharp(bytes, { failOn: "none" }).metadata();
  if (!meta.width || !meta.height) return null;
  // Orientations 5 to 8 turn the picture on its side: width and height trade places.
  const turned = (meta.orientation ?? 1) >= 5;
  const width = turned ? meta.height : meta.width;
  const height = turned ? meta.width : meta.height;
  const { left, top, size } = faceSquare(box, width, height);
  return sharp(bytes, { failOn: "none" })
    .rotate()
    .extract({ left, top, width: size, height: size })
    .resize(Math.min(out, Math.max(size, 1)), Math.min(out, Math.max(size, 1)))
    .jpeg({ quality: 82 })
    .toBuffer();
}

/**
 * The picture a cover is cut from, and whether it is the one to keep a cut of: the HD
 * preview is; the grid thumbnail standing in for a preview that could not be had this time
 * is not, so the next ask tries the preview again rather than keeping a blurry cover.
 */
export type CoverPicture = (uid: string) => Promise<{ bytes: Buffer; keep: boolean } | null>;

/**
 * Cut covers, cached and made a few at a time. A request the window has stopped waiting
 * for (its card scrolled away, or the page closed) leaves the line without fetching
 * anything, so a long page of people only ever costs what is on screen.
 */
export class FaceCovers {
  private kept = new Map<string, Buffer>();
  /**
   * Cuts under way, each with how many requests still wait on it. A cut is given up only
   * when the last of them leaves: a card scrolled away and straight back asks again while
   * the first ask is still in line, and that second ask must not inherit the first one's
   * cancel.
   */
  private running = new Map<
    string,
    { made: Promise<Buffer | null>; askers: number; stop: AbortController; started: boolean }
  >();
  private line: { run: () => void; gone: AbortSignal }[] = [];
  private busy = 0;
  /** Bumped by `clear`, so a cut finishing after a lock is not kept. */
  private epoch = 0;

  constructor(private picture: CoverPicture) {}

  async get(uid: string, box: FaceBox, gone: AbortSignal): Promise<Buffer | null> {
    const key = `${uid}|${box.join(",")}`;
    const hit = this.kept.get(key);
    if (hit) {
      this.kept.delete(key);
      this.kept.set(key, hit);
      return hit;
    }
    if (gone.aborted) return null;
    // A cut everyone left while it waited in line is on its way out with nothing, so it is
    // not joined; one already being made will still answer, so it is.
    const under = this.running.get(key);
    const run = under && (under.started || !under.stop.signal.aborted) ? under : this.start(uid, box, key);
    run.askers++;
    gone.addEventListener(
      "abort",
      () => {
        if (--run.askers === 0) run.stop.abort();
      },
      { once: true },
    );
    return run.made;
  }

  /** Begins one cut, in line behind those already being made. */
  private start(uid: string, box: FaceBox, key: string) {
    const stop = new AbortController();
    const epoch = this.epoch;
    const run = { made: Promise.resolve<Buffer | null>(null), askers: 0, stop, started: false };
    run.made = this.turn(stop.signal).then(async (go) => {
      if (!go) return null;
      run.started = true;
      try {
        const picture = await this.picture(uid);
        const cut = picture ? await cutFace(picture.bytes, box) : null;
        if (cut && picture?.keep && epoch === this.epoch) this.keep(key, cut);
        return cut;
      } catch {
        return null;
      } finally {
        this.release();
      }
    });
    this.running.set(key, run);
    void run.made.finally(() => {
      if (this.running.get(key) === run) this.running.delete(key);
    });
    return run;
  }

  /** Forget every cut cover: at lock, so nothing decrypted outlives the session. */
  clear(): void {
    this.epoch++;
    this.kept.clear();
  }

  /** How many cut covers are kept (for tests). */
  size(): number {
    return this.kept.size;
  }

  private keep(key: string, cut: Buffer): void {
    this.kept.set(key, cut);
    while (this.kept.size > KEPT) {
      const oldest = this.kept.keys().next().value;
      if (oldest === undefined) break;
      this.kept.delete(oldest);
    }
  }

  /** Resolves true once this request may run, or false if it was given up first. */
  private turn(gone: AbortSignal): Promise<boolean> {
    if (this.busy < AT_ONCE) {
      this.busy++;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const entry = { run: () => resolve(true), gone };
      this.line.push(entry);
      gone.addEventListener(
        "abort",
        () => {
          const at = this.line.indexOf(entry);
          if (at < 0) return;
          this.line.splice(at, 1);
          resolve(false);
        },
        { once: true },
      );
    });
  }

  private release(): void {
    // Handed straight on, so `busy` stays counted for the next one in line.
    for (let next = this.line.shift(); next; next = this.line.shift()) {
      if (next.gone.aborted) continue;
      next.run();
      return;
    }
    this.busy--;
  }
}
