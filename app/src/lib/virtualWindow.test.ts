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

import { describe, expect, it } from "vitest";
import { anchorAfterScroll, builtSpan, BUILT_AT_LEAST, rowsInSpan, screenOf } from "./virtualWindow";

const SCREEN = 1000;

describe("which rows of the timeline are built during a scroll", () => {
  it("leaves the built rows alone for a scroll that stays well inside them", () => {
    expect(anchorAfterScroll(5000, 5001, SCREEN)).toBe(5000);
    expect(anchorAfterScroll(5000, 5499, SCREEN)).toBe(5000);
    expect(anchorAfterScroll(5000, 4501, SCREEN)).toBe(5000);
  });

  it("builds around the screen again once it has moved half a screen", () => {
    expect(anchorAfterScroll(5000, 5500, SCREEN)).toBe(5500);
    expect(anchorAfterScroll(5000, 4500, SCREEN)).toBe(4500);
    expect(anchorAfterScroll(5000, 90_000, SCREEN)).toBe(90_000);
  });

  it("works the rows out a few times a screen, not once a frame", () => {
    let anchor = 0;
    let rebuilt = 0;
    // A minute's steady scroll at 60 frames a second, 20 px a frame: 72 screens.
    for (let frame = 1; frame <= 3600; frame++) {
      const next = anchorAfterScroll(anchor, frame * 20, SCREEN);
      if (next !== anchor) rebuilt++;
      anchor = next;
    }
    expect(rebuilt).toBe(144);
  });

  it("builds nothing new for a scroll back and forth inside the slack", () => {
    let anchor = 5000;
    for (let i = 0; i < 200; i++) {
      anchor = anchorAfterScroll(anchor, 5000 + (i % 2 ? 450 : -450), SCREEN);
    }
    expect(anchor).toBe(5000);
  });

  it("always has a screen and a half built either side of the screen", () => {
    let anchor = 0;
    for (let top = 0; top < 20_000; top += 37) {
      anchor = anchorAfterScroll(anchor, top, SCREEN);
      const { from, to } = builtSpan(anchor, SCREEN);
      expect(top - from).toBeGreaterThanOrEqual(BUILT_AT_LEAST * SCREEN);
      expect(to - (top + SCREEN)).toBeGreaterThanOrEqual(BUILT_AT_LEAST * SCREEN);
    }
  });

  it("builds a bounded stretch whatever the library's length", () => {
    const { from, to } = builtSpan(3_000_000, SCREEN);
    expect(to - from).toBe(5 * SCREEN);
  });

  it("treats a very short window as a taller one, so enough is built", () => {
    expect(screenOf(0)).toBe(600);
    expect(screenOf(200)).toBe(600);
    expect(screenOf(1400)).toBe(1400);
    expect(builtSpan(0, 0)).toEqual({ from: -1200, to: 1800 });
  });
});

describe("a section's rows inside the built stretch", () => {
  const pitch = 100;

  it("is every row of a section wholly inside it", () => {
    expect(rowsInSpan({ from: 0, to: 5000 }, 1000, 10, pitch)).toEqual({ first: 0, last: 10 });
  });

  it("starts at the row the stretch begins in and ends with the one it ends in", () => {
    // Rows at 1000, 1100, ...; the stretch covers 1250 to 1620.
    expect(rowsInSpan({ from: 1250, to: 1620 }, 1000, 10, pitch)).toEqual({ first: 2, last: 7 });
  });

  it("is empty, not backwards, for a section the stretch does not reach", () => {
    const above = rowsInSpan({ from: 5000, to: 6000 }, 1000, 10, pitch);
    expect(above.last - above.first).toBe(0);
    const below = rowsInSpan({ from: 0, to: 500 }, 1000, 10, pitch);
    expect(below.last - below.first).toBe(0);
    expect(rowsInSpan({ from: 0, to: 5000 }, 1000, 0, pitch)).toEqual({ first: 0, last: 0 });
  });
});
