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
 * What the scroll measurement counts, and the sums it logs.
 *
 * The grid's own code marks what it does here (a tile drawn, a thumbnail loaded, the time
 * a handler took), and `scrollBench` reads the marks once a frame. With no measurement
 * running, which is every ordinary run, `bench.on` is false and a mark is one test of it:
 * nothing is counted, timed or kept. This file imports nothing, so anything may mark.
 *
 * Only counts and times go through here, and only they reach the log: never a photo's
 * id, its name or an address.
 */

/** True only while a measurement runs (the app was started with PFP_SCROLL_BENCH). */
export const bench = { on: false };

/** What is counted, each a sum over one second of the run. */
export const COUNTERS = [
  /** `Photos` drawn again (the whole view), and the time from its render to its commit. */
  "photos",
  "photos_ms",
  /** `VirtualSections` drawn again, and the time from its render to its commit. */
  "vs",
  "vs_ms",
  /** The time `VirtualSections` took reading where the scroll is. */
  "read_ms",
  /** `PhotoGrid`s and `PhotoCell`s drawn. */
  "grids",
  "cells",
  /** Tiles built and taken down. */
  "mount",
  "unmount",
  /** Thumbnails that finished loading, were shown, and of those faded in; and the time showing took. */
  "loads",
  "shown",
  "fade",
  "show_ms",
  /** Thumbnails that failed to load. */
  "err",
  /** Tile pictures taken back already loaded, against ones asked of the server anew. */
  "kept",
  "fresh",
  /** Tiles the near-screen observer reported, and the time its callback took. */
  "io",
  "io_ms",
  /** Time in every animation-frame callback of the page (the reads above are among them). */
  "raf_ms",
  /** Calls made to the sidecar. */
  "rpc",
] as const;
export type Counter = (typeof COUNTERS)[number];

let counts: Record<string, number> = {};
/** The measured stretches of the frame under way, as start and end times in pairs. */
let spans: number[] = [];
/** Thumbnails asked of the server and not yet answered. */
const pending = new Set<object>();
/** The rows built by the last draw of the list. */
let rows = 0;

export function benchCount(name: Counter, n = 1): void {
  counts[name] = (counts[name] ?? 0) + n;
}

/** Adds the time since `t0` to `name`, and to the frame's measured time. */
export function benchSpan(name: Counter, t0: number): void {
  const t1 = performance.now();
  counts[name] = (counts[name] ?? 0) + (t1 - t0);
  spans.push(t0, t1);
}

export function benchRows(n: number): void {
  rows = n;
}

/** Follows one thumbnail from being asked for to its answer, whichever it is. */
export function benchPending(img: { addEventListener(type: string, cb: () => void, opts?: object): void }): void {
  pending.add(img);
  const done = () => pending.delete(img);
  img.addEventListener("load", done, { once: true });
  img.addEventListener("error", done, { once: true });
}

/** A thumbnail let go of before its answer came. */
export function benchSettled(img: object): void {
  pending.delete(img);
}

/** The counts since the last take, which starts them again. */
export function takeCounts(): Record<string, number> {
  const taken = counts;
  counts = {};
  return taken;
}

/** The measured time of the frame since the last take, with overlaps counted once. */
export function takeFrameJs(): number {
  const taken = spans;
  spans = [];
  return unionMs(taken);
}

export function pendingNow(): number {
  return pending.size;
}

export function rowsNow(): number {
  return rows;
}

/** Forgets everything: at the start and the end of a measurement. */
export function benchReset(): void {
  counts = {};
  spans = [];
  pending.clear();
  rows = 0;
}

// ---- The sums ----

/** The total length covered by stretches given as start and end times in pairs, overlaps once. */
export function unionMs(pairs: number[]): number {
  const list: [number, number][] = [];
  for (let i = 0; i + 1 < pairs.length; i += 2) list.push([pairs[i], pairs[i + 1]]);
  list.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -Infinity;
  for (const [from, to] of list) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total;
}

export type FrameStats = { fr: number; p50: number; p95: number; max: number; over50: number };

/** What a stretch of frames was like, from the time each took. */
export function frameStats(times: number[]): FrameStats {
  if (times.length === 0) return { fr: 0, p50: 0, p95: 0, max: 0, over50: 0 };
  const sorted = [...times].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    fr: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
    over50: sorted.filter((t) => t > 50).length,
  };
}

/** One second of the run, or several added up. */
export type Stretch = {
  /** How long it lasted, in ms. */
  ms: number;
  /** The time each frame took. */
  frames: number[];
  /** Measured time in the app's own code, overlaps counted once. */
  js: number;
  /** Time spent in frames that came late (longer than `LATE_FRAME_MS`). */
  late: number;
  /** The app's own measured code within those late frames. */
  lateJs: number;
  /** Time the measurement itself took. */
  self: number;
  counts: Record<string, number>;
};

export function emptyStretch(): Stretch {
  return { ms: 0, frames: [], js: 0, late: 0, lateJs: 0, self: 0, counts: {} };
}

export function addStretch(into: Stretch, more: Stretch): void {
  into.ms += more.ms;
  into.frames.push(...more.frames);
  into.js += more.js;
  into.late += more.late;
  into.lateJs += more.lateJs;
  into.self += more.self;
  for (const [name, n] of Object.entries(more.counts)) into.counts[name] = (into.counts[name] ?? 0) + n;
}

/** A frame longer than this came late: at 60 a second one takes under 17 ms. */
export const LATE_FRAME_MS = 25;

/** Adds one frame, and the app's own measured time within it, to a stretch. */
export function addFrame(into: Stretch, frameMs: number, jsMs: number): void {
  into.frames.push(frameMs);
  into.js += jsMs;
  if (frameMs > LATE_FRAME_MS) {
    into.late += frameMs;
    into.lateJs += Math.min(jsMs, frameMs);
  }
}

/**
 * A stretch as the numbers a log line carries. `js_ms` is the app's own measured code.
 * `late_ms` is the time that went into late frames, and `other_ms` the part of it the
 * measured code does not account for: in a late frame the thread had no time to spare, so
 * that part is the browser's (layout, painting, decoding, compositing) or code nothing
 * here measures. How busy the thread was in all is not something a page can tell; the
 * profiler reads that from outside and sets it beside these.
 */
export function stretchFields(s: Stretch): Record<string, number> {
  const f = frameStats(s.frames);
  const out: Record<string, number> = {
    ms: s.ms,
    fr: f.fr,
    p50: f.p50,
    p95: f.p95,
    max: f.max,
    over50: f.over50,
    late_pct: s.ms > 0 ? (100 * s.late) / s.ms : 0,
    js_pct: s.ms > 0 ? (100 * s.js) / s.ms : 0,
    late_ms: s.late,
    js_ms: s.js,
    other_ms: Math.max(0, s.late - s.lateJs),
    self_ms: s.self,
  };
  for (const name of COUNTERS) out[name] = s.counts[name] ?? 0;
  return out;
}

/** The fields of a line with the counts that are nought left out: the reader takes a missing one as nought. */
export function compact(fields: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(fields)) {
    if ((COUNTERS as readonly string[]).includes(name) && Math.round(value) === 0) continue;
    out[name] = value;
  }
  return out;
}

/** Longer than this and the host does not take the line. */
export const LINE_MAX = 600;

/**
 * One line for the log: a word, then `name=number` for each field, whole numbers only.
 * Lowercase letters, digits and `_ = -` are all it can hold, which is also all the host
 * lets through, so nothing but counts and times can be written by this.
 */
export function benchLine(kind: string, fields: Record<string, number | string>): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const parts = [clean(kind)];
  for (const [name, value] of Object.entries(fields)) {
    const shown = typeof value === "number" ? String(Number.isFinite(value) ? Math.round(value) : 0) : clean(value);
    parts.push(`${clean(name)}=${shown}`);
  }
  return parts.join(" ").slice(0, LINE_MAX);
}

// ---- The scroll itself ----

/** The run: the same for every measurement, so two runs can be compared. Speeds in px a second. */
export const PLAN = [
  { phase: "down", ms: 30_000, speed: 1500 },
  { phase: "up", ms: 20_000, speed: -1500 },
  { phase: "fling", ms: 3_000, speed: 12_000 },
  { phase: "settle", ms: 5_000, speed: 0 },
] as const;

/**
 * Where the scroll is after `dt` ms at `speed`, in a list `max` px long: a library too short
 * for the run turns round at either end and carries on, so the work goes on for the whole
 * of it. `dir` is 1 until a turn makes it -1, and back.
 */
export function stepScroll(
  pos: number,
  dir: number,
  speed: number,
  dt: number,
  max: number,
): { pos: number; dir: number } {
  if (max <= 0 || speed === 0) return { pos: Math.max(0, Math.min(pos, Math.max(0, max))), dir };
  let next = pos + (dir * speed * dt) / 1000;
  let turned = dir;
  // One turn a step is enough: a step is a frame, far shorter than the list.
  if (next > max) {
    next = Math.max(0, max - (next - max));
    turned = -dir;
  } else if (next < 0) {
    next = Math.min(max, -next);
    turned = -dir;
  }
  return { pos: next, dir: turned };
}
