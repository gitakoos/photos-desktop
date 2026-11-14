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

import { drawnGridIn } from "./gridRegistry";
import { invoke } from "@tauri-apps/api/core";
import {
  addFrame,
  addStretch,
  bench,
  benchLine,
  benchReset,
  benchSpan,
  compact,
  emptyStretch,
  pendingNow,
  PLAN,
  rowsNow,
  stepScroll,
  stretchFields,
  takeCounts,
  takeFrameJs,
} from "./benchProbe";

/**
 * The scroll measurement: the app scrolls its own timeline, the same way every time, and
 * writes to its log what each second of that cost.
 *
 * Only when the app was started for it (`PFP_SCROLL_BENCH=1`, which the host answers for,
 * since a window cannot read the environment). Scrolling was the one thing in every
 * profile that kept the window's one thread busy nearly all the time, and nothing run
 * outside the app showed why; a measurement taken from outside sees that the thread is
 * busy, not with what. This one is taken from inside:
 *
 *   - how long each frame took (p50, p95, the longest, how many over 50 ms), and how
 *     much of the time went into frames that came late;
 *   - how much of the time was the app's own code, by what: the whole view drawn again,
 *     the list drawn again, tiles drawn, built and taken down, thumbnails loaded and
 *     shown, the scroll read, the near-screen observer, calls to the sidecar;
 *   - and so how much of the late frames was not: layout, painting, decoding and
 *     compositing, which is the browser's, or code nothing here measures.
 *
 * How busy the thread was in all, a page cannot tell; `tools/pfp_profile.py --bench` reads
 * that from outside during the same run and sets the two side by side.
 *
 * One line a second and a sum for each part of the run, as `[bench] ...` in the log.
 * Counts and times only.
 */

/** How long to wait for the first screen of thumbnails before starting regardless. */
const READY_WAIT_MS = 20_000;
let started = false;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function say(kind: string, fields: Record<string, number | string>): void {
  void invoke("bench_note", { line: benchLine(kind, fields) }).catch(() => {});
}

/** Tiles on screen in the scroll area, and how many of them show their picture. */
function onScreen(scroller: HTMLElement): { tiles: number; shown: number } {
  const drawn = drawnGridIn(scroller);
  if (drawn) return drawn.onScreen();
  const box = scroller.getBoundingClientRect();
  let tiles = 0;
  let shown = 0;
  for (const cell of scroller.querySelectorAll<HTMLElement>(".g-cell")) {
    const at = cell.getBoundingClientRect();
    if (at.bottom <= box.top || at.top >= box.bottom) continue;
    tiles++;
    if (cell.querySelector("img[data-ok]")) shown++;
  }
  return { tiles, shown };
}

/**
 * Runs the measurement once, if this run of the app was started for one. `getScroller`
 * gives the timeline's scroll area once it is there.
 */
export async function maybeRunScrollBench(getScroller: () => HTMLElement | null): Promise<void> {
  if (started) return;
  started = true;
  let asked = false;
  try {
    asked = await invoke<boolean>("scroll_bench");
  } catch {
    /* an older host, or none: no measurement */
  }
  if (!asked) return;

  benchReset();
  bench.on = true;

  // Every animation-frame callback of the page is timed from here on: the list's read of
  // the scroll and the showing of loaded thumbnails are among them, and so is anything
  // else that turns out to run once a frame.
  const nativeFrame = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) =>
    nativeFrame((time) => {
      const t0 = performance.now();
      try {
        callback(time);
      } finally {
        benchSpan("raf_ms", t0);
      }
    });
  const frame = () => new Promise<number>((resolve) => nativeFrame(resolve));

  try {
    // The first screen of thumbnails, or twenty seconds, whichever comes first.
    const waitFrom = performance.now();
    let scroller: HTMLElement | null = null;
    let ready = 0;
    while (performance.now() - waitFrom < READY_WAIT_MS) {
      scroller = getScroller();
      if (scroller) {
        const { tiles, shown } = onScreen(scroller);
        if (tiles > 0 && shown === tiles) {
          ready = 1;
          break;
        }
      }
      await sleep(250);
    }
    scroller = getScroller();
    if (!scroller || (scroller.querySelector(".g-cell") === null && !drawnGridIn(scroller))) {
      say("skip", { reason: "no_grid", waited: performance.now() - waitFrom });
      return;
    }
    const area = scroller;
    const first = area.querySelector<HTMLElement>(".g-cell");
    say("start", {
      grid: drawnGridIn(area)?.kind() ?? "dom",
      ready,
      waited: performance.now() - waitFrom,
      w: window.innerWidth,
      h: window.innerHeight,
      dpr100: window.devicePixelRatio * 100,
      view_h: area.clientHeight,
      list_h: area.scrollHeight,
      tile_w: first?.offsetWidth ?? drawnGridIn(area)?.onScreen().width ?? 0,
      // A canvas grid builds no tiles: those it has on screen.
      tiles: drawnGridIn(area)?.onScreen().tiles ?? area.querySelectorAll(".g-cell").length,
      imgs: area.querySelectorAll(".g-cell img").length,
    });

    // Whatever happened while waiting is not part of the run.
    takeCounts();
    takeFrameJs();

    const whole = emptyStretch();
    let second = 0;
    for (const part of PLAN) {
      const sum = emptyStretch();
      let now = emptyStretch();
      let dir = part.speed < 0 ? -1 : 1;
      const partFrom = performance.now();
      let last = partFrom;
      let secondFrom = partFrom;
      while (last - partFrom < part.ms) {
        const t = await frame();
        const selfFrom = performance.now();
        const dt = t - last;
        last = t;
        addFrame(now, dt, takeFrameJs());
        if (part.speed !== 0) {
          const max = area.scrollHeight - area.clientHeight;
          const next = stepScroll(area.scrollTop, dir, Math.abs(part.speed), dt, max);
          dir = next.dir;
          area.scrollTop = next.pos;
        }
        if (t - secondFrom >= 1000 || t - partFrom >= part.ms) {
          now.ms = t - secondFrom;
          now.counts = takeCounts();
          now.self += performance.now() - selfFrom;
          say("sec", {
            n: second++,
            phase: part.phase,
            ...compact(stretchFields(now)),
            // As they stand at the end of the second, not sums over it.
            rows: rowsNow(),
            tiles: drawnGridIn(area)?.onScreen().tiles ?? area.querySelectorAll(".g-cell").length,
            imgs: area.querySelectorAll(".g-cell img").length,
            pending: pendingNow(),
            top: area.scrollTop,
          });
          addStretch(sum, now);
          now = emptyStretch();
          secondFrom = t;
        } else {
          now.self += performance.now() - selfFrom;
        }
      }
      say("sum", { phase: part.phase, ...compact(stretchFields(sum)) });
      addStretch(whole, sum);
    }
    say("done", { ...compact(stretchFields(whole)) });
  } finally {
    window.requestAnimationFrame = nativeFrame;
    bench.on = false;
    benchReset();
  }
}
