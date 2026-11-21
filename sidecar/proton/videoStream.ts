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

import type { OpenedDownloader } from "./downloadSlots.ts";
import { diag } from "./diag.ts";

/**
 * A video played the way a web page plays one: the window's player asks the loopback
 * thumbnail server for byte ranges, and each is answered as soon as its bytes are here.
 *
 * Otherwise the whole file is downloaded into the sidecar, sent through the request channel
 * as base64 (holding the window's lane for seconds), decoded back in the window and played
 * from a blob, which WebKitGTK's player reads poorly: nothing plays until the whole file is
 * in, and playback comes in jerks.
 *
 * The video is still downloaded once, whole, in order and verified, into memory, through the
 * SDK's own download, which hands its download slot back however it ends. What changes is
 * that a range is served the moment the bytes it covers have arrived, and a seek back is
 * answered at once. A seek ahead waits for the download to get there. Closing a video stops
 * its download and lets its memory go.
 *
 * Nothing waits for ever: a video whose first bytes are not here within VIDEO_START_MS is
 * answered with an error, and so is a read whose next bytes stall that long, so the viewer
 * falls back to the whole file. A video that can never be streamed is remembered for a while
 * and refused at once, so the viewer goes to the whole file without trying again.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The largest video streamed: downloaded whole into the sidecar's memory while it plays, its
 * signature checked. A larger one plays as before. It is also the most the videos kept open
 * hold together, besides the one playing.
 */
export const MAX_STREAMED_VIDEO = 300 * 1024 * 1024;

/** How long a video's lookup and first bytes are waited for. */
export const VIDEO_START_MS = 30_000;
/** How long a read waits for the next bytes of a download that has stopped moving. */
export const VIDEO_STALL_MS = 30_000;

/** How long a video that can never be streamed is refused without being looked up again. */
const NOT_STREAMABLE_MS = 10 * 60_000;

/**
 * The answer for a video that can never be streamed: too large, Proton does not say how large
 * it is, it is not a video, it is kept offline over the size held in memory, or its signature
 * did not check out. The viewer plays it the older way, or says why it cannot.
 */
export const NOT_STREAMABLE = "not-streamable";

/** A video to stream, one that can never be, or null when it cannot be had just now. */
export type VideoAnswer = VideoSource | typeof NOT_STREAMABLE | null;

/** One video, ready to be read a range at a time. */
export type VideoSource = {
  size: number;
  mime: string;
  /**
   * The bytes from `start` to `end` inclusive, in pieces, until done or `gone` fires.
   * Throws if the video turns out shorter than `size` before `end` is reached.
   */
  read(start: number, end: number, gone: AbortSignal): AsyncGenerator<Uint8Array>;
  /** Stops anything still fetching for it and lets its memory go. */
  close?(): void;
  /** True once it can serve nothing more (its download failed): opened afresh on the next ask. */
  broken?(): boolean;
  /** True once it must never be played (its signature did not check out). */
  refused?(): boolean;
};

/** How much is handed to the server's response at once. */
const PIECE = 256 * 1024;

/**
 * The range a `Range` header asks for, within a file of `size` bytes: `null` for the whole
 * file (no header, or one this server does not read, which HTTP says to ignore), or
 * "unsatisfiable" for one that starts past the end. Only the first of several ranges is
 * served, which every player is content with.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)(?:,.*)?$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    // The last n bytes.
    const n = Number(m[2]);
    if (n === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (start >= size) return "unsatisfiable";
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (end < start) return null;
  return { start, end };
}

/** A video kept on this computer: its bytes are already here, so a range is a slice. */
export function videoFromBytes(bytes: Buffer, mime: string): VideoSource {
  return {
    size: bytes.length,
    mime,
    async *read(start, end, gone) {
      for (let at = start; at <= end && !gone.aborted; at += PIECE) {
        yield bytes.subarray(at, Math.min(end + 1, at + PIECE));
      }
    },
  };
}

/**
 * A video whose bytes are still arriving, in order, kept as the pieces the download hands
 * over, so it holds what has arrived and never more. A read is answered from what is here
 * and waits for the rest; one that needs bytes past where the download ended (it failed, was
 * closed, or the file is shorter than stated) throws, so the server can cut the answer short
 * and the player falls back.
 */
export class ArrivingVideo implements VideoSource {
  private chunks: Uint8Array[] = [];
  /** Where each of `chunks` starts in the file. */
  private starts: number[] = [];
  private have = 0;
  private ended: "done" | "failed" | "unverified" | null = null;
  private wake = new Set<() => void>();

  constructor(
    readonly size: number,
    readonly mime: string,
    private onClose: () => void = () => {},
    private stallMs = VIDEO_STALL_MS,
  ) {}

  /** The next bytes of the download. Past the stated size they are dropped. */
  append(chunk: Uint8Array): void {
    if (this.ended) return;
    const take = Math.min(this.size - this.have, chunk.length);
    if (take > 0) {
      this.starts.push(this.have);
      this.chunks.push(take === chunk.length ? chunk : chunk.subarray(0, take));
      this.have += take;
    }
    this.notify();
  }

  /** The download is over: `ok` when it finished, false when it failed or was stopped. */
  end(ok: boolean): void {
    if (this.ended) return;
    this.ended = ok ? "done" : "failed";
    this.notify();
  }

  /** How much has arrived (for tests). */
  arrived(): number {
    return this.have;
  }

  /**
   * Its signature did not check out: nothing more of it is served, and a read under way
   * stops with an error.
   */
  reject(): void {
    if (this.ended === "unverified") return;
    this.ended = "unverified";
    this.close();
  }

  /** Its download failed or stopped: the next ask opens the video afresh. */
  broken(): boolean {
    return this.ended === "failed" || this.ended === "unverified";
  }

  refused(): boolean {
    return this.ended === "unverified";
  }

  /** Resolves once the first bytes are here, the download is over, or `signal` fires. */
  async started(signal: AbortSignal): Promise<void> {
    while (this.have === 0 && !this.ended && !signal.aborted) await this.changed(signal);
  }

  close(): void {
    if (!this.ended) this.end(false);
    this.onClose();
    // Nothing is served from it any more, and its memory can go: a read under way stops
    // with an error rather than writing out bytes that are no longer kept.
    this.have = 0;
    this.chunks = [];
    this.starts = [];
    this.notify();
  }

  async *read(start: number, end: number, gone: AbortSignal): AsyncGenerator<Uint8Array> {
    let at = start;
    while (at <= end && !gone.aborted) {
      if (at < this.have) {
        const i = this.chunkAt(at);
        const from = at - this.starts[i];
        const upTo = Math.min(end + 1, this.starts[i] + this.chunks[i].length, at + PIECE);
        yield this.chunks[i].subarray(from, from + upTo - at);
        at = upTo;
        continue;
      }
      if (this.ended === "unverified") throw new Error("video signature not verified");
      if (this.ended) throw new Error(this.ended === "done" ? "video shorter than stated" : "video download stopped");
      if (!(await this.changed(gone, this.stallMs))) {
        // Nothing arrived for the whole wait: the download is stopped, which gives its slot
        // back, and the answer is cut so the player gives up.
        this.close();
        throw new Error("video download stalled");
      }
    }
  }

  /** The piece that holds byte `at`, which has arrived. */
  private chunkAt(at: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** True when something changed or `gone` fired, false once `timeoutMs` passed first. */
  private changed(gone: AbortSignal, timeoutMs?: number): Promise<boolean> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (moved: boolean) => {
        clearTimeout(timer);
        this.wake.delete(done);
        gone.removeEventListener("abort", done);
        resolve(moved);
      };
      const done = () => finish(true);
      this.wake.add(done);
      gone.addEventListener("abort", done, { once: true });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => finish(false), timeoutMs);
        timer.unref?.();
      }
    });
  }

  private notify(): void {
    for (const wake of [...this.wake]) wake();
  }
}

/**
 * Downloads a video into an `ArrivingVideo`, through the SDK's whole-file download: verified,
 * one block at a time in order, and handing back the SDK's download slot however it ends
 * (finished, failed, or stopped by `close`).
 */
export function downloadVideo(
  opened: OpenedDownloader,
  size: number,
  mime: string,
  stallMs = VIDEO_STALL_MS,
): ArrivingVideo {
  let closed = false;
  const video = new ArrivingVideo(
    size,
    mime,
    () => {
      closed = true;
      opened.stop();
    },
    stallMs,
  );
  const sink = new WritableStream<Uint8Array>({
    write(chunk) {
      if (closed) throw new Error("video closed");
      video.append(chunk);
    },
  });
  let controller: any;
  try {
    controller = opened.downloader.downloadToStream(sink);
  } catch {
    video.end(false);
    return video;
  }
  void Promise.resolve(controller.completion()).then(
    () => video.end(true),
    // A signature that did not check out fails the video, as the whole-file route fails
    // it: nothing more of it is played, and the viewer's fallback refuses it as well.
    () => (controller.isDownloadCompleteWithSignatureIssues?.() ? video.reject() : video.end(false)),
  );
  return video;
}

/**
 * Downloads a video to play and waits for its first bytes, so the answer's headers go out
 * only for one that is coming. Null when the download failed first or `signal` fired (its
 * slot is given back either way); NOT_STREAMABLE when its signature did not check out.
 */
export async function startVideo(
  opened: OpenedDownloader,
  size: number,
  mime: string,
  signal: AbortSignal,
  stallMs = VIDEO_STALL_MS,
): Promise<VideoAnswer> {
  const video = downloadVideo(opened, size, mime, stallMs);
  await video.started(signal);
  if (video.refused()) return NOT_STREAMABLE;
  if (signal.aborted || video.broken()) {
    video.close();
    return null;
  }
  return video;
}

/** How many videos are kept open: the one playing and the one stepped back from. */
const OPEN_KEPT = 2;

/** A video nobody has read from, and with no answer open, for this long is closed. */
const IDLE_MS = 90_000;

type OpenEntry = { video: Promise<VideoSource | null>; used: number; reading: number; opened?: VideoSource };

/** The waits and the memory of the videos kept open (tests shorten them). */
export type OpenLimits = { startMs?: number; keptBytes?: number; refusedMs?: number };

/**
 * The videos opened lately, by uid. A player asks for many ranges of one video (the start,
 * the index at the end, then on as it plays and seeks): it is opened once for all of them.
 * One that falls out (more than OPEN_KEPT, more than MAX_STREAMED_VIDEO held together, idle
 * for IDLE_MS, or at lock) is closed: its download stops and its memory goes.
 */
export class OpenVideos {
  private open = new Map<string, OpenEntry>();
  /** Videos that can never be streamed, by uid, with when that is forgotten. */
  private refusals = new Map<string, number>();
  private sweep: ReturnType<typeof setInterval> | null = null;
  private startMs: number;
  private keptBytes: number;
  private refusedMs: number;

  constructor(
    private load: (uid: string, signal: AbortSignal) => Promise<VideoAnswer>,
    private now: () => number = Date.now,
    private idleMs = IDLE_MS,
    limits: OpenLimits = {},
  ) {
    this.startMs = limits.startMs ?? VIDEO_START_MS;
    this.keptBytes = limits.keptBytes ?? MAX_STREAMED_VIDEO;
    this.refusedMs = limits.refusedMs ?? NOT_STREAMABLE_MS;
  }

  get(uid: string): Promise<VideoAnswer> {
    let known = this.open.get(uid);
    // One found unplayable while open is let go and not opened again for a while.
    if (known?.opened?.refused?.()) {
      this.refuse(uid);
      known = undefined;
    }
    if (this.refused(uid)) return Promise.resolve(NOT_STREAMABLE);
    // One whose download failed is let go and opened afresh.
    if (known?.opened?.broken?.()) {
      this.drop(uid);
      known = undefined;
    }
    if (known) {
      this.open.delete(uid);
      known.used = this.now();
      this.open.set(uid, known);
      this.keepWithinBytes();
      return this.answer(uid, known);
    }
    const entry: OpenEntry = { video: Promise.resolve(null), used: this.now(), reading: 0 };
    entry.video = this.loadWithin(uid).then((v) => {
      if (v === NOT_STREAMABLE) {
        if (this.open.get(uid) === entry) this.refuse(uid);
        return null;
      }
      entry.opened = v ?? undefined;
      return v ? this.keptInUse(v, entry) : null;
    });
    this.open.set(uid, entry);
    // A video that could not be opened is not kept: the next ask tries again.
    void entry.video.then((v) => {
      if (!v && this.open.get(uid) === entry) this.open.delete(uid);
      if (v) this.keepWithinBytes();
    });
    while (this.open.size > OPEN_KEPT) {
      const oldest = this.open.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    this.startSweep();
    return this.answer(uid, entry);
  }

  /**
   * True for a video that can never be streamed, refused lately or found unplayable while
   * open: the viewer asks, after a stream fails, whether to try it again or play it the
   * older way at once.
   */
  notStreamable(uid: string): boolean {
    return this.refused(uid) || !!this.open.get(uid)?.opened?.refused?.();
  }

  private answer(uid: string, entry: OpenEntry): Promise<VideoAnswer> {
    return entry.video.then((v) => v ?? (this.refused(uid) ? NOT_STREAMABLE : null));
  }

  /**
   * The video for `uid`, or null when its lookup and first bytes are not in within startMs:
   * the wait is given up (which stops the lookup, or gives back a download slot it waits
   * for) and the answer goes out as an error, so the viewer is not left without one.
   */
  private loadWithin(uid: string): Promise<VideoAnswer> {
    const stop = new AbortController();
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        stop.abort();
        diag.log("drive", "video_slow_start", { ms: this.startMs });
        resolve(null);
      }, this.startMs);
      timer.unref?.();
      this.load(uid, stop.signal).then(
        (v) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve(v);
          } else if (v && v !== NOT_STREAMABLE) {
            // In after the wait was given up: nobody is waiting for it.
            v.close?.();
          }
        },
        () => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve(null);
          }
        },
      );
    });
  }

  /**
   * Every piece written out counts as use, and so does an answer still open: a paused
   * player keeps its connection and reads nothing, and closing its video then would have it
   * downloaded again from the start when play resumes.
   */
  private keptInUse(v: VideoSource, entry: OpenEntry): VideoSource {
    const now = this.now;
    const settle = () => this.keepWithinBytes();
    return {
      size: v.size,
      mime: v.mime,
      close: () => v.close?.(),
      broken: () => v.broken?.() ?? false,
      refused: () => v.refused?.() ?? false,
      async *read(start, end, gone) {
        entry.reading++;
        try {
          for await (const piece of v.read(start, end, gone)) {
            entry.used = now();
            yield piece;
          }
        } finally {
          entry.reading--;
          entry.used = now();
          settle();
        }
      },
    };
  }

  /**
   * Keeps the videos open within keptBytes together, each counted at its full size, which
   * its download reaches soon enough: the oldest go first, never the one asked for last (the
   * one playing) nor one still being read.
   */
  private keepWithinBytes(): void {
    const entries = [...this.open];
    const newest = entries[entries.length - 1]?.[0];
    let total = 0;
    for (const [, e] of entries) total += e.opened?.size ?? 0;
    for (const [uid, e] of entries) {
      if (total <= this.keptBytes) break;
      if (uid === newest || e.reading > 0 || !e.opened) continue;
      total -= e.opened.size;
      this.drop(uid);
    }
  }

  /** Closes videos left idle. Called on a timer; public for tests. */
  closeIdle(): void {
    const now = this.now();
    for (const [uid, entry] of [...this.open]) {
      if (entry.reading === 0 && now - entry.used >= this.idleMs) this.drop(uid);
    }
    if (this.open.size === 0) this.stopSweep();
  }

  /** Close every video and forget every refusal: at lock and sign-out. */
  clear(): void {
    for (const uid of [...this.open.keys()]) this.drop(uid);
    this.refusals.clear();
    this.stopSweep();
  }

  /** How many videos are open (for tests). */
  size(): number {
    return this.open.size;
  }

  private refused(uid: string): boolean {
    const until = this.refusals.get(uid);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.refusals.delete(uid);
    return false;
  }

  /** Remembers `uid` as never streamable for refusedMs, and lets go of it if open. */
  private refuse(uid: string): void {
    const now = this.now();
    for (const [old, until] of this.refusals) if (now >= until) this.refusals.delete(old);
    this.refusals.set(uid, now + this.refusedMs);
    this.drop(uid);
  }

  private drop(uid: string): void {
    const entry = this.open.get(uid);
    if (!entry) return;
    this.open.delete(uid);
    void entry.video.then((v) => v?.close?.());
  }

  private startSweep(): void {
    if (this.sweep) return;
    this.sweep = setInterval(() => this.closeIdle(), Math.max(1000, Math.floor(this.idleMs / 3)));
    this.sweep.unref?.();
  }

  private stopSweep(): void {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
  }
}
