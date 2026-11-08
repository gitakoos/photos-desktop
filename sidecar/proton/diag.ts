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

// The diagnostics a user can copy or save and send: what each part of the app did lately, how
// long its calls took, and whether any work stopped moving. Kept in memory, a few hundred lines
// a part, and written to the log as it happens.
//
// Privacy: a line carries counts, durations, sizes, states and error types, never a file or
// person name, an id, an address or a path. Text values are let through only when they look like
// a code word (`downloading`, `TypeError`); anything else is replaced, so a careless caller
// cannot leak a name through here.

/** The parts of the app a line belongs to. */
export type DiagArea =
  | "app"
  | "session"
  | "backup"
  | "upload"
  | "import"
  | "myfiles"
  | "faces"
  | "search"
  | "labels"
  | "duplicates"
  | "ocr"
  | "hidden"
  | "drive"
  | "rpc"
  | "perf"
  | "stall";

export type DiagValue = number | boolean | string | null | undefined;

/** Lines kept per part. */
const RING = 200;
/** A call slower than this is written down even without detailed logging. */
export const SLOW_MS = 3_000;
/** A job whose progress has not moved for this long is reported as stalled. */
export const STALL_MS = 3 * 60_000;

const CODE_WORD = /^[A-Za-z0-9_.:+-]{1,40}$/;

/** A value as it may appear in a line: numbers rounded, text only when it is a code word. */
export function safeValue(value: DiagValue): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    return Number.isInteger(value) ? String(value) : value.toFixed(Math.abs(value) < 10 ? 2 : 0);
  }
  return CODE_WORD.test(value) ? value : "[x]";
}

/** One line: the time, the part, what happened, and the numbers that go with it. */
export function formatLine(at: number, area: DiagArea, event: string, fields: Record<string, DiagValue> = {}): string {
  const d = new Date(at);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  const parts = Object.entries(fields).map(([k, v]) => `${CODE_WORD.test(k) ? k : "[x]"}=${safeValue(v)}`);
  return [time, area, CODE_WORD.test(event) ? event : "[x]", ...parts].join(" ");
}

type Stat = { count: number; failed: number; slow: number; totalMs: number; maxMs: number };

/** A job the watchdog looks at: whether it is working, and a number that grows while it does. */
export type Watched = { active: () => boolean; progress: () => number };

export class Diagnostics {
  private rings = new Map<DiagArea, string[]>();
  private stats = new Map<string, Stat>();
  private watched = new Map<string, Watched & { last: number; since: number; flagged: boolean }>();
  private detailed = false;
  readonly startedAt: number;

  constructor(
    private readonly sink: (line: string) => void = (line) => process.stderr.write(`[diag] ${line}\n`),
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  /** Records what happened in one part of the app. */
  log(area: DiagArea, event: string, fields?: Record<string, DiagValue>): void {
    const line = formatLine(this.now(), area, event, fields);
    let ring = this.rings.get(area);
    if (!ring) this.rings.set(area, (ring = []));
    ring.push(line);
    if (ring.length > RING) ring.splice(0, ring.length - RING);
    this.sink(line);
  }

  /**
   * Keeps a line another module already wrote to the log, as it was written: those lines carry
   * counts only by the same rule. Not written to the log a second time.
   */
  capture(area: DiagArea, text: string): void {
    let ring = this.rings.get(area);
    if (!ring) this.rings.set(area, (ring = []));
    const d = new Date(this.now());
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    ring.push(`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)} ${area} ${text.trim()}`);
    if (ring.length > RING) ring.splice(0, ring.length - RING);
  }

  /** Whether every timed step is written down, not only the slow ones. */
  setDetailed(on: boolean): void {
    if (on !== this.detailed) this.log("app", "detailed_logging", { on });
    this.detailed = on;
  }

  isDetailed(): boolean {
    return this.detailed;
  }

  /** Counts one finished call of `op` in `area`: how long it took and whether it failed. */
  record(area: DiagArea, op: string, ms: number, ok = true, fields?: Record<string, DiagValue>): void {
    const key = `${area}:${CODE_WORD.test(op) ? op : "[x]"}`;
    let stat = this.stats.get(key);
    if (!stat) this.stats.set(key, (stat = { count: 0, failed: 0, slow: 0, totalMs: 0, maxMs: 0 }));
    stat.count++;
    stat.totalMs += ms;
    stat.maxMs = Math.max(stat.maxMs, ms);
    if (!ok) stat.failed++;
    const slow = ms >= SLOW_MS;
    if (slow) stat.slow++;
    // The window's calls are many and quick: with detailed logging on they are still only counted.
    const detailed = this.detailed && area !== "rpc";
    if (slow || !ok || detailed) this.log(area, ok ? (slow ? `slow_${op}` : op) : `failed_${op}`, { ms: Math.round(ms), ...fields });
  }

  /** Times an awaited step and records it, failed when it throws. */
  async time<T>(area: DiagArea, op: string, run: () => Promise<T>, fields?: Record<string, DiagValue>): Promise<T> {
    const started = this.now();
    try {
      const out = await run();
      this.record(area, op, this.now() - started, true, fields);
      return out;
    } catch (e) {
      this.record(area, op, this.now() - started, false, { ...fields, error: (e as Error)?.name ?? "error" });
      throw e;
    }
  }

  /** Puts a job under the watchdog. */
  watch(name: string, job: Watched): void {
    this.watched.set(name, { ...job, last: Number.NaN, since: this.now(), flagged: false });
  }

  /**
   * One look at every watched job: a job working whose progress has not moved for `STALL_MS`
   * is reported once, and again when it moves on.
   */
  checkStalls(): void {
    const now = this.now();
    for (const [name, job] of this.watched) {
      let active = false;
      let progress = 0;
      try {
        active = job.active();
        progress = job.progress();
      } catch {
        continue;
      }
      if (!active || progress !== job.last) {
        if (job.flagged) this.log("stall", "moving_again", { job: name, after_s: Math.round((now - job.since) / 1000) });
        job.last = progress;
        job.since = now;
        job.flagged = false;
        continue;
      }
      if (!job.flagged && now - job.since >= STALL_MS) {
        job.flagged = true;
        this.log("stall", "not_moving", { job: name, for_s: Math.round((now - job.since) / 1000), at: progress });
      }
    }
  }

  /** Jobs reported as not moving right now. */
  stalled(): string[] {
    return [...this.watched].filter(([, j]) => j.flagged).map(([name]) => name);
  }

  /** The text a user copies or saves: `header` lines first, then every part's lines and the timings. */
  report(header: string[], logTail: string[] = []): string {
    const out: string[] = ["Photos for Proton diagnostics", ...header, ""];
    const stalled = this.stalled();
    out.push(`== Not moving now: ${stalled.length ? stalled.join(", ") : "none"}`, "");
    out.push("== Timings (count, failed, slow, average ms, max ms)");
    for (const [key, s] of [...this.stats].sort((a, b) => b[1].totalMs - a[1].totalMs)) {
      out.push(`${key} ${s.count} ${s.failed} ${s.slow} ${Math.round(s.totalMs / s.count)} ${Math.round(s.maxMs)}`);
    }
    out.push("");
    for (const [area, ring] of this.rings) {
      out.push(`== ${area}`, ...ring, "");
    }
    if (logTail.length) out.push("== Log (last lines)", ...logTail, "");
    return out.join("\n");
  }
}

export const diag = new Diagnostics();
