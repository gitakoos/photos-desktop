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
import { apply3 } from "./editorWarp";
import {
  blurShrink,
  coverInRender,
  coversFromHits,
  faceOval,
  letterbox,
  ovalExtent,
  pixelBlock,
  sourceToRender,
  type Geometry,
} from "./editorFaces";

const PLAIN: Geometry = {
  rotation: 0,
  flipH: false,
  flipV: false,
  straighten: 0,
  perspectiveV: 0,
  perspectiveH: 0,
  crop: null,
};

describe("faceOval", () => {
  it("centres on the box, grows it by 12 % and lies along the eyes", () => {
    const o = faceOval([100, 200, 200, 340], [130, 250, 170, 290]);
    expect(o.cx).toBe(150);
    expect(o.cy).toBe(270);
    expect(o.rx).toBeCloseTo(56, 9);
    expect(o.ry).toBeCloseTo(78.4, 9);
    expect(o.angle).toBeCloseTo(45, 9);
  });

  it("stays level when the eyes coincide", () => {
    expect(faceOval([0, 0, 10, 10], [5, 5, 5, 5]).angle).toBe(0);
  });
});

describe("coversFromHits", () => {
  it("takes a hit out of the letterbox into the photo's pixels", () => {
    // 1280 x 640 fits 640 x 320, centred 160 down.
    const fit = letterbox(1280, 640);
    expect(fit).toMatchObject({ scale: 0.5, fw: 640, fh: 320, padX: 0, padY: 160 });
    const [c] = coversFromHits([{ box: [100, 260, 200, 360], eyes: [120, 290, 180, 290] }], 1280, 640);
    expect(c.cx).toBeCloseTo(300, 9);
    expect(c.cy).toBeCloseTo(300, 9);
    expect(c.rx).toBeCloseTo(100 * 1.12, 9);
    expect(c.angle).toBe(0);
  });

  it("drops a face smaller than the phone's floor", () => {
    // On a 4000 x 3000 photo the floor is 3 % of 1440 at the 1920 detection size.
    const tiny = { box: [300, 300, 310, 310] as [number, number, number, number], eyes: [0, 0, 1, 0] as [number, number, number, number] };
    expect(coversFromHits([tiny], 4000, 3000)).toHaveLength(0);
  });
});

describe("sourceToRender", () => {
  it("is a plain scale with no geometry", () => {
    const m = sourceToRender(PLAIN, 400, 300, 200, 150);
    expect(apply3(m, 400, 300)).toEqual([200, 150]);
  });

  it("puts the top left corner top right after a quarter turn", () => {
    const m = sourceToRender({ ...PLAIN, rotation: 90 }, 400, 300, 300, 400);
    const [x, y] = apply3(m, 0, 0);
    expect(x).toBeCloseTo(300, 9);
    expect(y).toBeCloseTo(0, 9);
  });

  it("mirrors across the middle for a horizontal flip", () => {
    const m = sourceToRender({ ...PLAIN, flipH: true }, 400, 300, 400, 300);
    const [x, y] = apply3(m, 100, 50);
    expect(x).toBeCloseTo(300, 9);
    expect(y).toBeCloseTo(50, 9);
  });

  it("shifts by the crop and scales the crop to the picture", () => {
    const crop = { left: 100, top: 50, right: 300, bottom: 250 };
    const m = sourceToRender({ ...PLAIN, crop }, 400, 300, 100, 100);
    const [x, y] = apply3(m, 200, 150);
    expect(x).toBeCloseTo(50, 9);
    expect(y).toBeCloseTo(50, 9);
  });
});

describe("coverInRender", () => {
  it("turns an oval with the photo", () => {
    const m = sourceToRender({ ...PLAIN, rotation: 90 }, 400, 300, 300, 400);
    const c = coverInRender({ cx: 200, cy: 150, rx: 40, ry: 20, angle: 0 }, m);
    expect(c.cx).toBeCloseTo(150, 9);
    expect(c.cy).toBeCloseTo(200, 9);
    expect(c.rx).toBeCloseTo(40, 9);
    expect(c.ry).toBeCloseTo(20, 9);
    expect(c.angle).toBeCloseTo(90, 9);
  });

  it("measures a turned oval's box", () => {
    const e = ovalExtent({ cx: 0, cy: 0, rx: 40, ry: 20, angle: 90 });
    expect(e.ex).toBeCloseTo(20, 9);
    expect(e.ey).toBeCloseTo(40, 9);
  });
});

describe("strength", () => {
  it("runs the pixelate block from 22 blocks across to 7, never under 2 pixels", () => {
    expect(pixelBlock(220, 0)).toBeCloseTo(10, 9);
    expect(pixelBlock(70, 1)).toBeCloseTo(10, 9);
    expect(pixelBlock(10, 0)).toBe(2);
  });

  it("runs the blur shrink from 10 to 40", () => {
    expect(blurShrink(0)).toBe(10);
    expect(blurShrink(0.5)).toBe(25);
    expect(blurShrink(1)).toBe(40);
  });
});
