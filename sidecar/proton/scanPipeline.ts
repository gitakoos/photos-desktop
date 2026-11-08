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

// How fast the scan of the library goes, and the parts it is made of: how many photos are read at
// once and how many downloads run ahead of them, chosen in Settings or from the machine, and held
// to the gentlest while the computer runs on its battery or a metered connection. Photos are worked
// on side by side, but what is found is written down in the order the photos came, so the faces,
// their numbers and the people they form come out as they do one photo at a time.

import { availableParallelism, totalmem } from "node:os";

import { hostCall } from "./hostCall.ts";

export type ScanSpeed = "gentle" | "balanced" | "fast";

export const SCAN_SPEEDS: readonly ScanSpeed[] = ["gentle", "balanced", "fast"];

export type SpeedLevel = {
  /** Photos worked on at once. */
  photos: number;
  /** Originals downloading ahead of them. */
  downloads: number;
  /** Whether the next few photos start downloading while the last of the current few are read. */
  prefetch: boolean;
  /** A rest before each photo, so the computer stays quiet. */
  pauseMs: number;
};

export const SPEED_LEVELS: Record<ScanSpeed, SpeedLevel> = {
  gentle: { photos: 1, downloads: 2, prefetch: false, pauseMs: 150 },
  balanced: { photos: 2, downloads: 4, prefetch: true, pauseMs: 0 },
  fast: { photos: 4, downloads: 8, prefetch: true, pauseMs: 0 },
};

export function isScanSpeed(value: unknown): value is ScanSpeed {
  return typeof value === "string" && (SCAN_SPEEDS as readonly string[]).includes(value);
}

export type Machine = { cores: number; memoryGiB: number; gpu: boolean | null };

export function thisMachine(gpu: boolean | null): Machine {
  return { cores: availableParallelism(), memoryGiB: totalmem() / 1024 ** 3, gpu };
}

/**
 * The speed a machine starts at: Fast on one with many cores, plenty of memory and the graphics
 * card in use, Gentle on a small one, Balanced otherwise and while the card is not known yet.
 */
export function defaultSpeed(m: Machine): ScanSpeed {
  if (m.cores <= 2 || m.memoryGiB < 6) return "gentle";
  if (m.gpu === true && m.cores >= 8 && m.memoryGiB >= 15) return "fast";
  return "balanced";
}

export type PowerState = { saving: boolean; metered: boolean };

/** The speed the scan runs at: the one chosen, or Gentle while saving power or on a metered connection. */
export function effectiveSpeed(chosen: ScanSpeed, power: PowerState): ScanSpeed {
  return power.saving || power.metered ? "gentle" : chosen;
}

/** How often the power and network state is asked of the host while the scan runs. */
const POWER_FRESH_MS = 30_000;

/**
 * The host's view of the battery, Battery Saver and the connection's cost, asked again while it is
 * older than `POWER_FRESH_MS`. An answer that does not come counts as mains and unmetered, as it
 * does for a desktop, and the last good one is kept meanwhile.
 */
export class PowerWatch {
  private last: PowerState = { saving: false, metered: false };
  private readAt = Number.NEGATIVE_INFINITY;
  private asking: Promise<void> | null = null;

  constructor(
    private readonly ask: () => Promise<unknown> = () => hostCall("powerState", {}),
    private readonly now: () => number = Date.now,
  ) {}

  /** The state as last read; starts a read when it is stale. */
  current(): PowerState {
    void this.refresh();
    return this.last;
  }

  /** The state as last read, asking nothing. */
  peek(): PowerState {
    return this.last;
  }

  /** Reads the state again when it is stale; resolves once read. */
  refresh(): Promise<void> {
    if (this.asking) return this.asking;
    if (this.now() - this.readAt < POWER_FRESH_MS) return Promise.resolve();
    this.readAt = this.now();
    this.asking = this.ask()
      .then((answer: any) => {
        this.last = { saving: answer?.saving === true, metered: answer?.metered === true };
      })
      .catch(() => {})
      .finally(() => {
        this.asking = null;
      });
    return this.asking;
  }
}

/** Time spent in each part of the scan, in milliseconds, and how many photos and faces it covers. */
export type StageTimes = {
  /** Waiting for the next photo's bytes. */
  wait: number;
  decode: number;
  /** The detector's input made ready. */
  detectPrep: number;
  detect: number;
  /** Each face turned upright, its sharpness weighed and its input made ready. */
  facePrep: number;
  embed: number;
  clipPrep: number;
  clip: number;
  /** What was found written down. */
  store: number;
  photos: number;
  faces: number;
};

export function newStageTimes(): StageTimes {
  return { wait: 0, decode: 0, detectPrep: 0, detect: 0, facePrep: 0, embed: 0, clipPrep: 0, clip: 0, store: 0, photos: 0, faces: 0 };
}

export type Stage = Exclude<keyof StageTimes, "photos" | "faces">;

/** Adds the time `run` takes to `stage`, when there is anything to add it to. */
export async function timed<T>(times: StageTimes | undefined, stage: Stage, run: () => Promise<T> | T): Promise<T> {
  if (!times) return run();
  const started = performance.now();
  try {
    return await run();
  } finally {
    times[stage] += performance.now() - started;
  }
}

export function timedSync<T>(times: StageTimes | undefined, stage: Stage, run: () => T): T {
  if (!times) return run();
  const started = performance.now();
  try {
    return run();
  } finally {
    times[stage] += performance.now() - started;
  }
}

/** The times as log fields: whole milliseconds, and the counts. */
export function stageFields(t: StageTimes): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(t)) out[k] = Math.round(v);
  return out;
}

/**
 * Works on the `items` as they come, up to `width()` at once, and hands each result to `commit` in
 * the order the items came, never two commits at once. With a width of one, each item is worked on
 * and committed before the next is taken, exactly one after another. `live` is asked before each
 * item is taken; once it answers false, the work under way is let finish, nothing more is
 * committed, and `stopped()` is thrown. An error thrown by `work` or `commit` is thrown in turn,
 * once the work under way has finished, and nothing after it is committed. Only the items `counts`
 * answers true for take up the width; the others, markers with nothing to work on, pass in order.
 */
export async function runInOrder<I, R>(
  items: AsyncIterable<I>,
  width: () => number,
  work: (item: I) => Promise<R>,
  commit: (item: I, result: R) => Promise<void> | void,
  live: () => boolean,
  stopped: () => Error,
  counts: (item: I) => boolean = () => true,
): Promise<void> {
  type Slot = { item: I; counted: boolean; done: Promise<{ ok: true; value: R } | { ok: false; error: unknown }> };
  const queue: Slot[] = [];
  let busy = 0;
  const settleAll = async () => {
    await Promise.all(queue.map((s) => s.done));
    queue.length = 0;
  };
  const commitHead = async () => {
    const slot = queue.shift()!;
    if (slot.counted) busy--;
    const out = await slot.done;
    if (!out.ok) throw out.error;
    await commit(slot.item, out.value);
  };
  try {
    for await (const item of items) {
      if (!live()) throw stopped();
      const counted = counts(item);
      if (counted) busy++;
      queue.push({
        item,
        counted,
        done: work(item).then(
          (value) => ({ ok: true as const, value }),
          (error) => ({ ok: false as const, error }),
        ),
      });
      while (busy >= Math.max(1, width()) || (queue.length > 0 && !counted && busy === 0)) {
        await commitHead();
        if (!live()) throw stopped();
      }
    }
    while (queue.length > 0) {
      await commitHead();
      if (queue.length > 0 && !live()) throw stopped();
    }
  } finally {
    // Whatever was under way finishes before the caller lets go of what it works with.
    await settleAll();
  }
}

/**
 * The pictures of each batch, one batch after another, as one stream, with `end(batch)` after the
 * last of each. With `prefetch()` true, the next batch is asked for as soon as the current one
 * starts, so its first downloads are under way by the time the current one runs out.
 */
export async function* batchStream<P>(
  batches: string[][],
  open: (uids: string[]) => AsyncIterable<P>,
  prefetch: () => boolean,
): AsyncGenerator<{ kind: "picture"; picture: P; batch: number } | { kind: "end"; batch: number }> {
  type Opened = { it: AsyncIterator<P>; first: Promise<IteratorResult<P>> | null };
  const start = (i: number, early: boolean): Opened => {
    const it = open(batches[i])[Symbol.asyncIterator]();
    const first = early ? it.next() : null;
    // Not left unhandled when the stream ends before it is read; read below, it throws there.
    first?.catch(() => {});
    return { it, first };
  };
  let next: Opened | null = null;
  try {
    for (let i = 0; i < batches.length; i++) {
      const current: Opened = next ?? start(i, false);
      next = null;
      if (i + 1 < batches.length && prefetch()) next = start(i + 1, true);
      try {
        let step = current.first ? await current.first : await current.it.next();
        while (!step.done) {
          yield { kind: "picture", picture: step.value, batch: i };
          step = await current.it.next();
        }
      } finally {
        await current.it.return?.();
      }
      yield { kind: "end", batch: i };
    }
  } finally {
    if (next) {
      const left: Opened = next;
      // The prefetched batch is let go once its first answer is in; a read under way cannot be cut.
      void (left.first ?? Promise.resolve())
        .catch(() => {})
        .then(() => left.it.return?.())
        .catch(() => {});
    }
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
