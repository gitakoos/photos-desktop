/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { bench, benchCount } from "./benchProbe";

/**
 * The canvas grid's thumbnails, decoded and ready to draw, by photo.
 *
 * Fetched in a worker (see tileWorker) and decoded on the page off its main thread, then
 * cut to the tile's size in device pixels, so drawing one is a plain copy. A few at a time: the grid asks
 * for the tiles it wants most first and calls off the ones that scrolled far away, which
 * aborts their fetch. Kept up to a memory budget, oldest first out, and every bitmap let go
 * of is closed so its memory goes at once, not at the next collection.
 *
 * If the worker cannot reach the server at all (it cannot be made, or the server does not
 * let its origin read), the page does it instead: an <img>, decoded off the main thread with
 * `decode()`, cut the same way. That is decided by the first answers, not by a test up
 * front, so a slow first thumbnail holds nothing up.
 */

/** Fetches at once: the six connections the engine holds per host, and two in line. */
export const IN_FLIGHT = 8;

/** Decoded thumbnails kept, in bytes: some 1,600 tiles of 126 x 148 device pixels. */
const BUDGET = 120 * 1024 * 1024;

/** A thumbnail that would not load is asked again this many times, a little later each time. */
const RETRIES = 3;
const RETRY_MS = 1500;

export type Cut = { w: number; h: number; r: number };

type Entry = { bitmap: ImageBitmap; w: number; h: number; bytes: number };

export class TileLoader {
  private kept = new Map<string, Entry>();
  private bytes = 0;
  /** The fetches under way, and the address each was asked from. */
  private asked = new Map<string, string>();
  private failed = new Map<string, { tries: number; until: number }>();
  private size: Cut = { w: 1, h: 1, r: 0 };
  private worker: Worker | null = null;
  private mode: "worker" | "page" = "worker";
  /** Whether the worker has brought a thumbnail yet: until it has, failing to reach the server means it never will. */
  private workerProven = false;
  private page = new Map<string, HTMLImageElement>();
  private closed = false;
  /** How the thumbnails are made: for the log and the measurement. */
  where = "fetched by a worker, decoded on the page";

  constructor(
    /** A thumbnail is ready to draw (or will not come: then `bitmap` returns nothing). */
    private onArrive: (key: string) => void,
    size: Cut,
  ) {
    this.size = size;
    try {
      this.worker = new Worker(new URL("./tileWorker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e) => this.fromWorker(e.data);
      this.worker.onerror = () => this.toPage("page (the worker failed)");
    } catch {
      this.toPage("page (no worker)");
    }
  }

  /** The tile size in device pixels: thumbnails cut to another size are asked for again. */
  setSize(size: Cut): void {
    this.size = size;
  }

  /** A thumbnail to draw for `key`, of any size (one of another size is drawn scaled until its replacement comes). */
  bitmap(key: string): ImageBitmap | undefined {
    return this.kept.get(key)?.bitmap;
  }

  /** Whether `key` has nothing to draw, or only a picture cut for another size. */
  needs(key: string): boolean {
    const e = this.kept.get(key);
    return !e || e.w !== this.size.w || e.h !== this.size.h;
  }

  /** How many more fetches may start now. */
  room(): number {
    return Math.max(0, IN_FLIGHT - this.asked.size);
  }

  /** The keys being fetched: the grid calls off those that scrolled far away. */
  inFlight(): Iterable<string> {
    return this.asked.keys();
  }

  /**
   * Asks for `key` if it is needed, not already coming, and not failing; `url` is only
   * worked out then. False if not asked.
   */
  want(key: string, url: () => string): boolean {
    if (this.closed || this.asked.has(key) || !this.needs(key)) return false;
    const f = this.failed.get(key);
    if (f && (f.tries >= RETRIES || performance.now() < f.until)) return false;
    this.start(key, url());
    return true;
  }

  /** Calls off a fetch, or a decode, under way. */
  cancel(key: string): void {
    if (!this.asked.delete(key)) return;
    const img = this.page.get(key);
    if (img) {
      this.page.delete(key);
      img.removeAttribute("src");
    } else if (this.mode === "worker") this.worker?.postMessage({ kind: "cancel", key });
  }

  /** Whether the budget is spent. */
  overBudget(): boolean {
    return this.bytes > BUDGET;
  }

  /**
   * Keeps the budget by letting go of the oldest thumbnails, but none `keep` says is still
   * near the screen.
   */
  trim(keep: (key: string) => boolean): void {
    if (this.bytes <= BUDGET) return;
    for (const [key, e] of this.kept) {
      if (this.bytes <= BUDGET) break;
      if (keep(key)) continue;
      this.drop(key, e);
    }
  }

  /** Lets every thumbnail go and stops: at lock, or when the grid goes. */
  close(): void {
    this.closed = true;
    for (const [key, e] of this.kept) this.drop(key, e);
    for (const key of [...this.asked.keys()]) this.cancel(key);
    this.worker?.terminate();
    this.worker = null;
  }

  private start(key: string, url: string): void {
    this.asked.set(key, url);
    if (bench.on) benchCount("fresh");
    if (this.mode === "worker") this.worker!.postMessage({ kind: "load", key, url });
    else this.decode(key, url, false);
  }

  private drop(key: string, e: Entry): void {
    this.kept.delete(key);
    this.bytes -= e.bytes;
    e.bitmap.close();
  }

  private keep(key: string, bitmap: ImageBitmap, w: number, h: number): void {
    const old = this.kept.get(key);
    if (old) this.drop(key, old);
    const bytes = bitmap.width * bitmap.height * 4;
    this.kept.set(key, { bitmap, w, h, bytes });
    this.bytes += bytes;
    this.failed.delete(key);
  }

  private arrived(key: string, made: { bitmap: ImageBitmap; w: number; h: number } | null): void {
    if (!this.asked.delete(key) || this.closed) {
      made?.bitmap.close();
      return;
    }
    if (made) {
      this.keep(key, made.bitmap, made.w, made.h);
      if (bench.on) benchCount("loads");
    } else {
      const f = this.failed.get(key) ?? { tries: 0, until: 0 };
      f.tries++;
      f.until = performance.now() + RETRY_MS * f.tries;
      this.failed.set(key, f);
      if (bench.on) benchCount("err");
    }
    this.onArrive(key);
  }

  private fromWorker(m: { kind: string; key?: string; bytes?: ArrayBuffer; type?: string; unreachable?: boolean }): void {
    if (this.mode !== "worker") return;
    if (m.kind === "done") {
      this.workerProven = true;
      const key = m.key!;
      // Called off while its bytes were on their way.
      if (!this.asked.has(key)) return;
      this.decode(key, URL.createObjectURL(new Blob([m.bytes!], { type: m.type || "image/jpeg" })), true);
    } else if (m.kind === "failed") {
      if (m.unreachable && !this.workerProven) this.toPage("page (the worker could not reach the server)");
      else this.arrived(m.key!, null);
    }
  }

  /** Carries on without the worker: everything it was fetching is asked again on the page. */
  private toPage(where: string): void {
    if (this.mode === "page") return;
    this.mode = "page";
    this.where = where;
    this.worker?.terminate();
    this.worker = null;
    if (this.closed) return;
    for (const [key, url] of [...this.asked]) {
      this.asked.delete(key);
      this.start(key, url);
    }
  }

  /**
   * Decodes a thumbnail on the page: an <img>, decoded off the main thread by `decode()`,
   * then cut to the tile's size. `url` is the bytes the worker fetched (a blob address,
   * let go of here) or, without the worker, the thumbnail's own address.
   */
  private decode(key: string, url: string, blob: boolean): void {
    const img = new Image();
    img.decoding = "async";
    this.page.set(key, img);
    const size = this.size;
    img.src = url;
    const mine = () => this.page.get(key) === img;
    void (async () => {
      let bitmap: ImageBitmap | null = null;
      try {
        await img.decode();
        const nw = img.naturalWidth;
        const nh = img.naturalHeight;
        if (mine() && nw > 0 && nh > 0) {
          // The middle of the picture with the tile's shape, never less than a pixel either way.
          const k = Math.max(size.w / nw, size.h / nh);
          const sw = Math.max(1, Math.min(nw, size.w / k));
          const sh = Math.max(1, Math.min(nh, size.h / k));
          bitmap = await createImageBitmap(img, (nw - sw) / 2, (nh - sh) / 2, sw, sh, {
            resizeWidth: size.w,
            resizeHeight: size.h,
            resizeQuality: "medium",
          });
        }
      } catch {
        bitmap = null;
      } finally {
        if (blob) URL.revokeObjectURL(url);
        // The tile has its own copy now: the element's decoded picture goes at once rather
        // than whenever the element is collected.
        img.removeAttribute("src");
      }
      // Called off meanwhile: whatever was made goes.
      if (!mine()) {
        bitmap?.close();
        return;
      }
      this.page.delete(key);
      this.arrived(key, bitmap ? { bitmap, w: size.w, h: size.h } : null);
    })();
  }
}
