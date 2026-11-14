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

import { beforeEach, describe, expect, it } from "vitest";
import {
  addFrame,
  addStretch,
  bench,
  benchCount,
  benchLine,
  benchPending,
  benchReset,
  benchSettled,
  benchSpan,
  compact,
  COUNTERS,
  emptyStretch,
  frameStats,
  LINE_MAX,
  pendingNow,
  PLAN,
  stepScroll,
  stretchFields,
  takeCounts,
  takeFrameJs,
  unionMs,
} from "./benchProbe";

beforeEach(() => benchReset());

describe("the scroll measurement's sums", () => {
  it("is off unless a measurement turns it on", () => {
    expect(bench.on).toBe(false);
  });

  it("counts overlapping stretches of time once", () => {
    expect(unionMs([])).toBe(0);
    expect(unionMs([0, 10])).toBe(10);
    // The list's draw inside the view's draw, then something apart from both.
    expect(unionMs([0, 10, 2, 6, 20, 25])).toBe(15);
    // Given in any order, and one running past the end of another.
    expect(unionMs([5, 12, 0, 8])).toBe(12);
  });

  it("says what a stretch of frames was like", () => {
    expect(frameStats([])).toEqual({ fr: 0, p50: 0, p95: 0, max: 0, over50: 0 });
    const times = [...Array(95).fill(16), 60, 70, 80, 90, 200];
    expect(frameStats(times)).toEqual({ fr: 100, p50: 16, p95: 60, max: 200, over50: 5 });
  });

  it("hands counts over once and starts them again", () => {
    benchCount("cells");
    benchCount("cells", 4);
    benchCount("loads");
    expect(takeCounts()).toEqual({ cells: 5, loads: 1 });
    expect(takeCounts()).toEqual({});
  });

  it("adds a handler's time to its own count and to the frame's", () => {
    const t0 = performance.now() - 5;
    benchSpan("read_ms", t0);
    const counts = takeCounts();
    expect(counts.read_ms).toBeGreaterThanOrEqual(5);
    const js = takeFrameJs();
    expect(js).toBeGreaterThanOrEqual(5);
    expect(js).toBeLessThan(50);
    expect(takeFrameJs()).toBe(0);
  });

  it("follows a thumbnail until it is answered or let go", () => {
    const listeners: Record<string, () => void> = {};
    const img = { addEventListener: (type: string, cb: () => void) => void (listeners[type] = cb) };
    benchPending(img);
    const other = { addEventListener() {} };
    benchPending(other);
    expect(pendingNow()).toBe(2);
    listeners.load();
    expect(pendingNow()).toBe(1);
    benchSettled(other);
    expect(pendingNow()).toBe(0);
  });

  it("adds frames up into seconds, and seconds into a part of the run", () => {
    const one = emptyStretch();
    // An on-time frame, a late one that is mostly the app's own code, a late one that is not.
    addFrame(one, 16, 2);
    addFrame(one, 100, 80);
    addFrame(one, 60, 5);
    one.ms = 1000;
    one.counts = { cells: 40, vs: 2 };
    const two = emptyStretch();
    addFrame(two, 16, 1);
    addFrame(two, 40, 0);
    two.ms = 1000;
    two.counts = { cells: 10 };
    const sum = emptyStretch();
    addStretch(sum, one);
    addStretch(sum, two);
    const f = stretchFields(sum);
    expect(f.ms).toBe(2000);
    expect(f.fr).toBe(5);
    expect(f.max).toBe(100);
    expect(f.over50).toBe(2);
    expect(f.late_ms).toBe(200);
    expect(f.late_pct).toBe(10);
    expect(f.js_ms).toBe(88);
    // What the late frames took that the app's own code does not account for.
    expect(f.other_ms).toBe(115);
    expect(f.cells).toBe(50);
    expect(f.vs).toBe(2);
    expect(f.loads).toBe(0);
  });

  it("never counts more of the app's code in a frame than the frame lasted", () => {
    const s = emptyStretch();
    addFrame(s, 30, 45);
    expect(stretchFields(s).other_ms).toBe(0);
  });

  it("leaves out the counts that are nought, and only those", () => {
    const f = compact(stretchFields({ ms: 1000, frames: [16], js: 0, late: 0, lateJs: 0, self: 0, counts: { cells: 3 } }));
    expect(f.cells).toBe(3);
    expect("loads" in f).toBe(false);
    // The frame numbers stay even at nought: a second with no slow frame says so.
    expect(f.over50).toBe(0);
    expect(f.late_pct).toBe(0);
  });
});

describe("a line of the measurement", () => {
  it("is a word and whole numbers by name", () => {
    expect(benchLine("sec", { n: 3, phase: "down", p50: 16.4, late_pct: 87.6 })).toBe("sec n=3 phase=down p50=16 late_pct=88");
  });

  it("can hold nothing but lowercase letters, digits, and _ = - and spaces", () => {
    const line = benchLine("Sec", {
      phase: "IMG_2041.JPG",
      "na me": "http://127.0.0.1:4000/t/tok/uid~x",
      bad: Number.NaN,
      neg: -3,
    });
    expect(line).toMatch(/^[a-z0-9_=\- ]+$/);
    expect(line).toContain("bad=0");
    expect(line).toContain("neg=-3");
  });

  it("stays within what the host takes, with every count in it", () => {
    const counts: Record<string, number> = {};
    for (const name of COUNTERS) counts[name] = 123456;
    const fields = stretchFields({ ms: 1000, frames: [1234.5], js: 123456, late: 123456, lateJs: 0, self: 1234, counts });
    const line = benchLine("sec", {
      n: 99,
      phase: "settle",
      ...compact(fields),
      rows: 1234,
      tiles: 12345,
      imgs: 12345,
      pending: 1234,
      top: 12345678,
    });
    expect(line.length).toBeLessThan(LINE_MAX);
  });
});

describe("the scroll the measurement makes", () => {
  it("is the same run every time: down, back up, a fling, and a rest", () => {
    expect(PLAN.map((p) => p.phase)).toEqual(["down", "up", "fling", "settle"]);
    expect(PLAN.reduce((ms, p) => ms + p.ms, 0)).toBe(58_000);
    expect(PLAN[3].speed).toBe(0);
  });

  it("moves at the speed asked, whatever the frame rate", () => {
    let a = { pos: 0, dir: 1 };
    for (let i = 0; i < 60; i++) a = stepScroll(a.pos, a.dir, 1500, 1000 / 60, 1e9);
    let b = { pos: 0, dir: 1 };
    for (let i = 0; i < 10; i++) b = stepScroll(b.pos, b.dir, 1500, 100, 1e9);
    expect(a.pos).toBeCloseTo(1500, 5);
    expect(b.pos).toBeCloseTo(1500, 5);
  });

  it("turns round at the end of a short library and carries on", () => {
    let s = { pos: 900, dir: 1 };
    s = stepScroll(s.pos, s.dir, 1500, 100, 1000);
    expect(s).toEqual({ pos: 950, dir: -1 });
    s = stepScroll(s.pos, s.dir, 1500, 100, 1000);
    expect(s).toEqual({ pos: 800, dir: -1 });
    // And at the top, on the way back up.
    s = stepScroll(100, -1, 1500, 100, 1000);
    expect(s).toEqual({ pos: 50, dir: 1 });
  });

  it("stays put with nothing to scroll, or when resting", () => {
    expect(stepScroll(0, 1, 1500, 16, 0)).toEqual({ pos: 0, dir: 1 });
    expect(stepScroll(420, 1, 0, 16, 5000)).toEqual({ pos: 420, dir: 1 });
  });
});
