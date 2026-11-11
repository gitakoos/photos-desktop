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
import { layoutFaceTags, TAG_H, type FaceTag } from "./faceTags";

const frame = { l: 0, t: 0, w: 1000, h: 500 };
const natural = { w: 2000, h: 1000 };
const fit = { scale: 1, x: 0, y: 0 };

const tag = (box: FaceTag["box"], name: string | null = "Ana", key = "f"): FaceTag => ({ key, box, name });

describe("layoutFaceTags", () => {
  it("puts the ring on the face and the name under it", () => {
    const [placed] = layoutFaceTags([tag([0.4, 0.4, 0.6, 0.6])], natural, frame, fit);
    expect(placed.box).toEqual({ l: 400, t: 200, w: 200, h: 100 });
    expect(placed.pill).toEqual({ l: 477.75, t: 306, w: 44.5 });
  });

  it("follows the zoom", () => {
    const [placed] = layoutFaceTags([tag([0.4, 0.4, 0.6, 0.6])], natural, frame, { scale: 2, x: 0, y: 0 });
    expect(placed.box).toEqual({ l: 300, t: 150, w: 400, h: 200 });
  });

  it("maps the box through the bands of a photo narrower than its frame", () => {
    const [placed] = layoutFaceTags([tag([0, 0, 1, 1])], { w: 1000, h: 2000 }, frame, fit);
    expect(placed.box).toEqual({ l: 375, t: 0, w: 250, h: 500 });
  });

  it("drops a face panned out of sight", () => {
    expect(layoutFaceTags([tag([0.4, 0.4, 0.6, 0.6])], natural, frame, { scale: 1, x: 5000, y: 0 })).toEqual([]);
  });

  it("keeps every name inside the stage on a crowded photo", () => {
    const tags = Array.from({ length: 30 }, (_, i) => tag([0.45, 0.45, 0.55, 0.55], `Person ${i}`, `f${i}`));
    const placed = layoutFaceTags(tags, natural, frame, fit);
    expect(placed).toHaveLength(30);
    for (const { pill } of placed) {
      expect(pill.l).toBeGreaterThanOrEqual(4);
      expect(pill.l + pill.w).toBeLessThanOrEqual(1000 - 4);
    }
  });

  it("never puts a name below the photo", () => {
    const [placed] = layoutFaceTags([tag([0.4, 0.9, 0.6, 1])], natural, frame, fit);
    expect(placed.pill.t + TAG_H).toBeLessThanOrEqual(500);
  });

  it("moves a name off one already placed", () => {
    const box: FaceTag["box"] = [0.4, 0.4, 0.6, 0.6];
    const [first, second] = layoutFaceTags([tag(box, "Ana", "a"), tag(box, "Ana", "b")], natural, frame, fit);
    expect(first.pill.t).toBe(306);
    expect(second.pill.t).toBe(200 - 6 - TAG_H);
  });
});
