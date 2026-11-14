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
/** The least room around a face, as a multiple of its longer side, a zoom in near an edge keeps: in a circle, the face box's corners need about this much. */
export const FACE_ZOOM_OUT_MIN = 1.2;

/** The side of a cut cover, in pixels: sharp on a large card on a HiDPI screen. */
export const COVER_SIZE = 320;

/** Cut covers kept in memory: at some 20 KB each, a few MB for a long page of people. */
const KEPT = 400;

/** How many covers are cut from previews at once. Each fetches one, so kept low. */
const AT_ONCE = 2;

/**
 * A cover is cut from the grid thumbnail, already here or fetched with others in one go,
 * when the face's square in it has at least this share of the pixels the cover is shown
 * at; only a face too small in it waits for the HD preview.
 */
const THUMB_ENOUGH = 0.8;

/** How many covers are cut from thumbnails at once: each is quick, but a page asks for hundreds. */
const THUMB_AT_ONCE = 3;

/** Where cut covers are kept between runs (sealed, as the thumbnails are). */
export type CoverDisk = { get(key: string): Buffer | null; put(key: string, cut: Buffer): void };

/**
 * The square cut out of a `width` x `height` picture for `box`, shown in a circle: FACE_ZOOM_OUT
 * times the face's longer side, centred on the face. A face near an edge is zoomed in on (down
 * to FACE_ZOOM_OUT_MIN times it) rather than moved off centre; only past that is the square
 * moved to stay inside the picture. Moving it first, as before, put a face near an edge at the
 * circle's side.
 */
export function faceSquare(box: FaceBox, width: number, height: number): { left: number; top: number; size: number } {
  const [l, t, r, b] = box;
  const face = Math.max((r - l) * width, (b - t) * height);
  const cx = ((l + r) / 2) * width;
  const cy = ((t + b) / 2) * height;
  // As large as fits around the centre, between FACE_ZOOM_OUT_MIN and FACE_ZOOM_OUT times the face.
  const room = 2 * Math.min(cx, width - cx, cy, height - cy);
  const wanted = Math.max(face * FACE_ZOOM_OUT_MIN, Math.min(face * FACE_ZOOM_OUT, room));
  const size = Math.max(1, Math.round(Math.min(wanted, width, height)));
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

  constructor(
    private picture: CoverPicture,
    private more: {
      /** The grid thumbnail, for a cover small enough to be cut from it. */
      thumbnail?: (uid: string, gone: AbortSignal) => Promise<Buffer | null>;
      disk?: CoverDisk;
    } = {},
  ) {}

  /**
   * The cover of `box` in `uid`, `want` pixels a side at most (COVER_SIZE when not said): a
   * small circle needs no HD preview.
   */
  async get(uid: string, box: FaceBox, gone: AbortSignal, want = COVER_SIZE): Promise<Buffer | null> {
    const side = Math.max(1, Math.min(COVER_SIZE, Math.round(want)));
    const key = `${uid}|${box.join(",")}|${side}`;
    const hit = this.kept.get(key);
    if (hit) {
      this.kept.delete(key);
      this.kept.set(key, hit);
      return hit;
    }
    const stored = this.more.disk?.get(key);
    if (stored) {
      this.keep(key, stored);
      return stored;
    }
    if (gone.aborted) return null;
    // A cut everyone left while it waited in line is on its way out with nothing, so it is
    // not joined; one already being made will still answer, so it is.
    const under = this.running.get(key);
    const run = under && (under.started || !under.stop.signal.aborted) ? under : this.start(uid, box, key, side);
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

  /**
   * Begins one cut: from the grid thumbnail at once when it is enough, else in line behind
   * the cuts from previews already being made.
   */
  private start(uid: string, box: FaceBox, key: string, side: number) {
    const stop = new AbortController();
    const epoch = this.epoch;
    const run = { made: Promise.resolve<Buffer | null>(null), askers: 0, stop, started: false };
    const kept = (cut: Buffer) => {
      if (epoch !== this.epoch) return;
      this.keep(key, cut);
      this.more.disk?.put(key, cut);
    };
    const fromPreview = (go: boolean) => {
      if (!go) return Promise.resolve(null);
      run.started = true;
      return (async () => {
        try {
          const picture = await this.picture(uid);
          const cut = picture ? await cutFace(picture.bytes, box, side) : null;
          if (cut && picture?.keep) kept(cut);
          return cut;
        } catch {
          return null;
        } finally {
          this.release();
        }
      })();
    };
    run.made = this.more.thumbnail
      ? this.fromThumbnail(uid, box, side, stop.signal)
          .catch(() => null)
          .then((small) => {
            // Left while the thumbnail was tried: no preview is fetched for nobody.
            if (!small) return stop.signal.aborted ? null : this.turn(stop.signal).then(fromPreview);
            kept(small);
            return small;
          })
      : // In line at once, as asked.
        this.turn(stop.signal).then(fromPreview);
    this.running.set(key, run);
    void run.made.finally(() => {
      if (this.running.get(key) === run) this.running.delete(key);
    });
    return run;
  }

  /** The cover cut from the grid thumbnail, when the face has pixels enough in it. */
  private async fromThumbnail(uid: string, box: FaceBox, side: number, gone: AbortSignal): Promise<Buffer | null> {
    // The largest cover (a big card, or no size asked) is cut from the HD preview, as before.
    if (!this.more.thumbnail || side >= COVER_SIZE) return null;
    const bytes = await this.more.thumbnail(uid, gone);
    if (!bytes || gone.aborted) return null;
    // A few at a time, in order, so a page of faces does not take every core at once.
    if (!(await this.thumbSlot(gone))) return null;
    try {
      const meta = await sharp(bytes, { failOn: "none" }).metadata();
      if (!meta.width || !meta.height) return null;
      const turned = (meta.orientation ?? 1) >= 5;
      const { size } = faceSquare(box, turned ? meta.height : meta.width, turned ? meta.width : meta.height);
      if (size < side * THUMB_ENOUGH) return null;
      return await cutFace(bytes, box, side);
    } finally {
      this.thumbFree();
    }
  }

  /** A turn at cutting from a thumbnail: false if the ask is given up while it waits. */
  private thumbSlot(gone: AbortSignal): Promise<boolean> {
    if (gone.aborted) return Promise.resolve(false);
    if (this.thumbBusy < THUMB_AT_ONCE) {
      this.thumbBusy++;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiter = { resolve };
      this.thumbLine.push(waiter);
      gone.addEventListener(
        "abort",
        () => {
          const at = this.thumbLine.indexOf(waiter);
          if (at < 0) return;
          this.thumbLine.splice(at, 1);
          resolve(false);
        },
        { once: true },
      );
    });
  }

  /** Hands the turn straight to the next in line, or frees it. */
  private thumbFree(): void {
    const next = this.thumbLine.shift();
    if (next) next.resolve(true);
    else this.thumbBusy--;
  }
  private thumbBusy = 0;
  private thumbLine: { resolve: (go: boolean) => void }[] = [];

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
    if (gone.aborted) return Promise.resolve(false);
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
