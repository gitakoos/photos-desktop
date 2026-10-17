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

// A stall guard for the SDK's async generators.
//
// `sidecar/proton/api.ts` bounds each HTTP ATTEMPT with `AbortSignal.timeout`, but
// nothing bounds a whole SDK call across the retries the SDK makes internally. A
// production trace caught the consequence: one `getThumbnails` -- a batch of EIGHT
// images, where the slowest healthy one in the same run took 216ms -- entered
// `iterateThumbnails` and never came back. It was ended 300 seconds later by the
// host's own `deadline_for` REPLY deadline, which recovers by killing the sidecar
// and respawning it. For those five minutes the Gate's single in-flight channel was
// held, so nothing else reached the sidecar at all.
//
// The three deadlines in this stack were in the wrong order. The frontend gives up
// at 3 minutes (app/src/lib/rpc.ts), the host at 5 (and takes the sidecar down with
// it), and the sidecar -- the layer closest to the work, and the only one that can
// fail gracefully -- had no bound whatsoever. This is that missing innermost bound,
// and being innermost is what lets it return partial results instead of destroying a
// working session.
//
// It bounds the GAP BETWEEN items, not the total run. A whole-library walk is
// legitimately long and must not be killed for being big; a walk that has produced
// nothing at all for this long is not working. Total-time budgets cannot tell those
// apart, which is why this one does not use one.

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The idle budget for the SDK's enumeration walks (nodes, albums, trash).
 *
 * Deliberately looser than the thumbnail one: these decrypt a node per item on a cold
 * run, so a single pull is doing real work, and being killed for being slow is the
 * failure mode the comment on `deadline_for` in lib.rs warns about. Still five times
 * tighter than the host's own 300s, and unlike that one it fails WITHOUT taking the
 * sidecar (and the unlocked session) down -- `handle` in server.ts turns a thrown
 * handler error into an ordinary `{ok:false}` reply, which the host does not treat as
 * a transport failure.
 */
export const SDK_STALL_MS = 60_000;

/** Raised when a guarded iterator produces nothing for its whole idle budget. */
export class StallError extends Error {
  /** Survives structured cloning and cross-realm checks that `instanceof` does not. */
  readonly stalled = true;
  constructor(what: string, idleMs: number) {
    super(`${what} produced nothing for ${idleMs}ms`);
    this.name = "StallError";
  }
}

/** Whether an error is this module's stall, rather than a real failure to report. */
export function isStall(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as any).stalled === true;
}

/**
 * Wrap an async iterable so one stalled pull cannot hold the channel forever.
 *
 * Throws `StallError` when a single `next()` takes longer than `idleMs`; every item
 * received resets the budget. The caller decides what a stall means -- `getThumbnails`
 * keeps what it already has, which is exactly what a batch that failed outright
 * already did.
 *
 * The underlying iterator is always released on the way out (`return()`), including
 * on the stall path, so the SDK can drop whatever it was holding rather than being
 * left mid-iteration.
 */
export async function* withStallGuard<T>(
  src: AsyncIterable<T>,
  idleMs: number,
  what: string,
): AsyncGenerator<T> {
  const it = src[Symbol.asyncIterator]();
  let exhausted = false;
  try {
    for (;;) {
      const pull = it.next();
      // The race abandons this promise when the timer wins, and an abandoned
      // rejection would surface as an unhandledRejection with no owner. Attaching a
      // sink marks it handled WITHOUT consuming it: the race still sees the real
      // rejection through `pull` itself.
      pull.catch(() => {});

      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StallError(what, idleMs)), idleMs);
      });

      let step: IteratorResult<T>;
      try {
        step = await Promise.race([pull, stalled]);
      } finally {
        // Cleared on every path, so a long walk cannot accumulate one live timer per
        // item and keep the event loop busy after it finishes.
        clearTimeout(timer);
      }

      if (step.done) {
        exhausted = true;
        return;
      }
      yield step.value;
    }
  } finally {
    // An exhausted iterator has already cleaned itself up; calling return() again is
    // pointless. Anything else -- a stall, a throw, or a caller that stopped early --
    // is still mid-iteration and needs releasing. Best-effort: a generator that
    // objects to being closed must not mask why we are closing it.
    if (!exhausted) {
      try {
        await it.return?.(undefined as any);
      } catch {
        /* releasing is best-effort */
      }
    }
  }
}
