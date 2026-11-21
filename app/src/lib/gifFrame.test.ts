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
import { gifPlacement, gifRatio, gifSize, gifTimes, gifWindow } from "./gifFrame";

describe("the GIF maker's framing", () => {
  it("frames the whole video at zoom 1, black around it in a square", () => {
    expect(gifRatio(1920, 1080, "original")).toBeCloseTo(16 / 9);
    expect(gifRatio(1920, 1080, "square")).toBe(1);
    const p = gifPlacement(1920, 1080, 720, 720, 1, 0, 0);
    expect(p.w).toBeCloseTo(720);
    expect(p.h).toBeCloseTo(405);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo((720 - 405) / 2);
  });

  it("fills the square as it zooms and moves only within what spills over", () => {
    const centre = gifPlacement(1920, 1080, 720, 720, 2, 0, 0);
    expect(centre.h).toBeCloseTo(810);
    const left = gifPlacement(1920, 1080, 720, 720, 2, 1, 0);
    expect(left.x).toBeCloseTo(0);
    const right = gifPlacement(1920, 1080, 720, 720, 2, -1, 0);
    expect(right.x + right.w).toBeCloseTo(720);
    expect(gifPlacement(1920, 1080, 720, 720, 2, 5, 0).x).toBeCloseTo(left.x);
  });

  it("sizes the GIF by its longest edge, in even pixels", () => {
    expect(gifSize(16 / 9, 720)).toEqual({ width: 720, height: 406 });
    expect(gifSize(9 / 16, 480)).toEqual({ width: 270, height: 480 });
    expect(gifSize(1, 1080)).toEqual({ width: 1080, height: 1080 });
  });

  it("keeps the window inside the video, at most ten seconds and at least half of one", () => {
    expect(gifWindow(2, 20, 30)).toEqual({ start: 2, end: 12 });
    expect(gifWindow(5, 5.1, 30)).toEqual({ start: 5, end: 5.5 });
    expect(gifWindow(29.9, 30, 30)).toEqual({ start: 29.5, end: 30 });
    expect(gifTimes(0, 1)).toHaveLength(12);
    expect(gifTimes(0, 10)).toHaveLength(120);
    expect(gifTimes(3, 3.1)).toHaveLength(2);
  });
});
