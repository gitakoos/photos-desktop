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
import { fittedRect, textRunLayout, type TextReadBlock } from "./textLayout";

const level: TextReadBlock = {
  text: "Hello",
  confidence: 0.9,
  quad: [
    { x: 100, y: 200 },
    { x: 500, y: 200 },
    { x: 500, y: 260 },
    { x: 100, y: 260 },
  ],
};

describe("where read text is drawn over the photo", () => {
  it("scales a level run onto the drawn photo and stretches its letters to its length", () => {
    // Every letter 50 px wide at a 100 px font.
    const run = textRunLayout(level, 0.5, 10, 20, (t) => t.length * 50);
    expect(run.left).toBe(60);
    expect(run.top).toBe(120);
    expect(run.height).toBe(30);
    expect(run.angle).toBe(0);
    expect(run.fontSize).toBeCloseTo(24.6);
    // The run is 200 px long; five letters at 24.6 px make 61.5 px.
    expect(run.stretch).toBeCloseTo(200 / 61.5, 3);
  });

  it("keeps a slanted run's angle", () => {
    const slanted: TextReadBlock = {
      ...level,
      quad: [
        { x: 0, y: 100 },
        { x: 100, y: 0 },
        { x: 110, y: 10 },
        { x: 10, y: 110 },
      ],
    };
    expect(textRunLayout(slanted, 1, 0, 0, () => 100).angle).toBeCloseTo(-Math.PI / 4);
  });

  it("fits the photo inside its box, centred", () => {
    expect(fittedRect(1000, 500, 4000, 3000)).toEqual({ x: (1000 - 500 * (4 / 3)) / 2, y: 0, w: 500 * (4 / 3), h: 500 });
    expect(fittedRect(0, 500, 4000, 3000)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});
