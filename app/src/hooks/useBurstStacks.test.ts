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

import { stacksFrom } from "./useBurstStacks";

describe("stacking bursts", () => {
  const bursts = [["a1", "a2", "a3", "a4", "a5"], ["b1", "b2", "b3", "b4"], ["c1", "c2", "c3"], ["lone"]];

  it("stacks a run of four or more on the shot the timeline shows first, played in the order taken", () => {
    const s = stacksFrom(bursts, new Set(), true);
    expect([...s.counts]).toEqual([["a5", 5], ["b4", 4]]);
    expect(s.shotsOf.get("a5")).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    expect([...s.under].sort()).toEqual(["a1", "a2", "a3", "a4", "b1", "b2", "b3"]);
    expect(s.coverOf.get("a1")).toBe("a5");
    expect(stacksFrom(bursts, new Set(), false).counts.has("a1")).toBe(true);
  });

  it("leaves three shots or fewer as they are", () => {
    const s = stacksFrom(bursts, new Set(), true);
    expect(s.counts.has("c3")).toBe(false);
    expect(s.under.has("c1")).toBe(false);
  });

  it("leaves a stack spread out once opened by its oldest shot, whichever way the timeline runs", () => {
    for (const newestFirst of [true, false]) {
      const s = stacksFrom(bursts, new Set(["a1"]), newestFirst);
      expect(s.under.has("a2")).toBe(false);
      expect(s.under.has("b1") || s.under.has("b4")).toBe(true);
    }
    expect(stacksFrom(bursts, new Set(), true).oldestOf.get("a5")).toBe("a1");
  });

  it("stacks only the shots the timeline holds, and no burst left with too few", () => {
    // a5 hidden, b1 trashed.
    const s = stacksFrom(bursts, new Set(), true, new Set(["a1", "a2", "a3", "a4", "b2", "b3", "b4", "lone"]));
    expect([...s.counts]).toEqual([["a4", 4]]);
    expect(s.shotsOf.get("a4")).toEqual(["a1", "a2", "a3", "a4"]);
    expect(s.under.has("a5")).toBe(false);
    expect(s.counts.has("b4")).toBe(false);
  });
});
