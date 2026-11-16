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

import { useEffect, useRef, useState } from "react";

import { rpc } from "../lib/rpc";

type Answer = { scanning: boolean; version: number; stacks?: string[][] };

/** How often the bursts are asked for again: soon while the finder is still working them out. */
const WHILE_WORKING_MS = 15_000;
const SETTLED_MS = 60_000;
/** Before the first settled answer: the groups land a moment after the scan, not 15 s later. */
const FIRST_MS = 2_000;

/**
 * The last bursts read, kept outside the timeline: going to another view and back starts
 * stacked, not spread out until the next answer.
 */
let kept: { version: number; stacks: string[][]; key: string; settled: boolean } = {
  version: -1,
  stacks: [],
  key: "",
  settled: false,
};

/**
 * The library's bursts, each oldest first, asked for while `enabled` and the window is in
 * view; `count` is how many photos the timeline holds, so a library that has grown is scanned
 * again. The answer changes only when the bursts do.
 */
export function useBurstStacks(enabled: boolean, count: number | undefined): { stacks: string[][]; settled: boolean } {
  const [stacks, setStacks] = useState<string[][]>(kept.stacks);
  /** Whether the finder has once said its bursts are worked out: before, "none" is "not yet". */
  const [settled, setSettled] = useState(kept.settled);
  const countNow = useRef(count);
  countNow.current = count;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ask = async () => {
      let next = WHILE_WORKING_MS;
      if (!document.hidden) {
        const got = await rpc<Answer>("burstStacks", { since: kept.version, count: countNow.current }).catch(() => null);
        if (!live) return;
        if (got?.stacks) {
          const key = got.stacks.map((s) => s.join(",")).join("|");
          if (key !== kept.key) {
            kept = { ...kept, version: got.version, stacks: got.stacks, key };
            setStacks(got.stacks);
          } else kept = { ...kept, version: got.version };
        }
        if (got && !got.scanning) {
          next = SETTLED_MS;
          if (!kept.settled) {
            kept = { ...kept, settled: true };
            setSettled(true);
          }
        } else if (!kept.settled) next = FIRST_MS;
      }
      timer = setTimeout(() => void ask(), next);
    };
    void ask();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
    // `count` is read when asking, not followed: a new count waits for the next round.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return { stacks, settled };
}

/** The fewest shots a burst is stacked for in the timeline. */
export const STACK_MIN = 4;

/** Forgets the bursts read: at sign-out and lock. */
export function forgetBurstStacks(): void {
  kept = { version: -1, stacks: [], key: "", settled: false };
}

/**
 * From the bursts (each oldest first): `shotsOf` the shots of each stack by its tile, oldest
 * first; `counts` the number of shots by tile; `under` the other shots, which the timeline
 * leaves out, and `coverOf` their tile. The tile is the shot the timeline shows first, so a
 * stack spread out again has its shots after it and whatever is open in the viewer stays put.
 * A stack whose oldest shot is in `open` is not stacked; one with fewer than STACK_MIN
 * shots in `present` is none.
 */
export function stacksFrom(
  stacks: string[][],
  open: ReadonlySet<string>,
  newestFirst: boolean,
  present?: ReadonlySet<string>,
) {
  const shotsOf = new Map<string, string[]>();
  const counts = new Map<string, number>();
  const under = new Set<string>();
  const coverOf = new Map<string, string>();
  /** Each tile's burst by its oldest shot, what opening it goes by. */
  const oldestOf = new Map<string, string>();
  for (const all of stacks) {
    // Only the shots the timeline holds: one hidden, trashed or filed away is no part of it.
    const oldestFirst = present ? all.filter((u) => present.has(u)) : all;
    // Opened by its oldest shot, which stays the same whichever way the timeline runs. A pair or
    // three shots are left as they are: a stack is worth it for a run of them.
    if (oldestFirst.length < STACK_MIN || open.has(all[0])) continue;
    const uids = newestFirst ? [...oldestFirst].reverse() : oldestFirst;
    // Played in the order they were taken, whichever way the timeline runs.
    shotsOf.set(uids[0], oldestFirst);
    oldestOf.set(uids[0], all[0]);
    counts.set(uids[0], uids.length);
    for (const u of uids.slice(1)) {
      under.add(u);
      coverOf.set(u, uids[0]);
    }
  }
  return { shotsOf, counts, under, coverOf, oldestOf };
}
