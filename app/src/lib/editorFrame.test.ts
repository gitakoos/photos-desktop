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
import {
  FRAME_MIN_SCALE,
  afterGesture,
  borderRange,
  frameBlurSize,
  frameCanvas,
  frameFills,
  frameForShape,
  shapeOf,
  snappedToCentre,
  soften,
  withBorder,
  type FrameRatio,
  type FrameSpec,
} from "./editorFrame";

function spec(ratio: FrameRatio = "original", scale = 1, offsetX = 0, offsetY = 0): FrameSpec {
  return { ratio, fill: { kind: "solid", color: "#ffffff" }, scale, offsetX, offsetY, margin: 0, bottomMargin: 0 };
}

function rect(c: ReturnType<typeof frameCanvas>) {
  const p = c.photo;
  return [p.left, p.top, p.right, p.bottom].map((v) => Math.round(v * 100) / 100);
}

const polaroid = frameForShape("polaroid") as FrameSpec;

// The cases are the Android editor's own frame tests, value for value.
describe("frameCanvas", () => {
  it("puts a landscape photo across a square with bars above and below", () => {
    const c = frameCanvas(1920, 1080, spec("1:1"));
    expect([c.width, c.height]).toEqual([1920, 1920]);
    expect(rect(c)).toEqual([0, 420, 1920, 1500]);
  });

  it("puts a portrait photo down a square with bars beside it", () => {
    const c = frameCanvas(1080, 1920, spec("1:1"));
    expect(rect(c)).toEqual([420, 0, 1500, 1920]);
  });

  it("is the photo itself at Original and full size, with a border once it shrinks", () => {
    const c = frameCanvas(3024, 4032, spec());
    expect([c.width, c.height]).toEqual([3024, 4032]);
    expect(rect(frameCanvas(1920, 1080, spec("original", 0.8)))).toEqual([192, 108, 1728, 972]);
  });

  it("scales the canvas and the photo together under the long-side cap", () => {
    const full = frameCanvas(4000, 3000, spec("9:16"));
    expect([full.width, full.height]).toEqual([2304, 4096]);
    expect(rect(full)).toEqual([0, 1184, 2304, 2912]);
    expect(rect(frameCanvas(4000, 3000, spec("9:16", 0.5)))).toEqual([576, 1616, 1728, 2480]);
    expect(rect(frameCanvas(1920, 1080, spec("1:1"), 1000))).toEqual([0, 218.75, 1000, 781.25]);
  });

  it("puts a photo with an offset of one against that edge", () => {
    const half = (x: number, y: number) => rect(frameCanvas(1920, 1080, spec("1:1", 0.5, x, y)));
    expect(half(0, 0)).toEqual([480, 690, 1440, 1230]);
    expect(half(-1, -1)).toEqual([0, 0, 960, 540]);
    expect(half(1, 1)).toEqual([960, 1380, 1920, 1920]);
    expect(half(0.5, -0.5)).toEqual([720, 345, 1680, 885]);
    expect(half(5, -7)).toEqual(half(1, -1));
  });

  it("lays out a Polaroid card with a bottom three and a half times its other borders", () => {
    const c = frameCanvas(2000, 1500, polaroid);
    expect([c.width, c.height]).toEqual([2180, 1905]);
    expect(rect(c)).toEqual([90, 90, 2090, 1590]);
    const up = frameCanvas(1500, 2000, polaroid);
    expect([up.width, up.height]).toEqual([1680, 2405]);
  });
});

describe("gestures", () => {
  const g = (s: FrameSpec, zoom = 1, panX = 0, panY = 0) => afterGesture(s, zoom, panX, panY, 1920, 1080);

  it("multiplies the scale by a zoom, held to the minimum and the fit", () => {
    expect(g(spec("1:1"), 0.5).scale).toBeCloseTo(0.5, 6);
    expect(g(spec("1:1", 0.6), 0.01).scale).toBe(FRAME_MIN_SCALE);
    expect(g(spec("1:1", 0.6), 10).scale).toBe(1);
  });

  it("moves the photo by exactly the dragged canvas pixels", () => {
    const start = spec("1:1", 0.5);
    const moved = g(start, 1, 240, -345);
    expect(moved.offsetX).toBeCloseTo(0.5, 6);
    expect(moved.offsetY).toBeCloseTo(-0.5, 6);
    const before = frameCanvas(1920, 1080, start).photo;
    const after = frameCanvas(1920, 1080, moved).photo;
    expect(after.left - before.left).toBeCloseTo(240, 2);
    expect(after.top - before.top).toBeCloseTo(-345, 2);
  });

  it("keeps an axis with no room at zero and stops at the edge", () => {
    const moved = g(spec("1:1"), 1, 500, 210);
    expect(moved.offsetX).toBe(0);
    expect(moved.offsetY).toBeCloseTo(0.5, 6);
    const far = g(spec("1:1", 0.5), 1, 99999, -99999);
    expect([far.offsetX, far.offsetY]).toEqual([1, -1]);
  });

  it("pulls a photo near the middle onto it", () => {
    const near = snappedToCentre(spec("1:1", 0.5, 0.01, 0.6), 1920, 1080, 12);
    expect(near.x).toBe(true);
    expect(near.y).toBe(false);
    expect(near.spec.offsetX).toBe(0);
    expect(near.spec.offsetY).toBe(0.6);
  });
});

describe("shapes and borders", () => {
  it("opens each shape at full size in the middle and reads it back", () => {
    expect(frameForShape("off")).toBeNull();
    expect(shapeOf(null)).toBe("off");
    for (const s of ["original", "1:1", "4:5", "3:4", "2:3", "9:16", "4:3", "3:2", "16:9", "polaroid"] as const) {
      const f = frameForShape(s) as FrameSpec;
      expect(shapeOf(f)).toBe(s);
      expect([f.scale, f.offsetX, f.offsetY]).toEqual([1, 0, 0]);
    }
  });

  it("sets a border in range, a Polaroid keeping its deeper bottom", () => {
    const even = frameForShape("1:1") as FrameSpec;
    expect(borderRange(even)).toEqual([0, 0.3]);
    expect(withBorder(even, 0.9).margin).toBe(0.3);
    const card = withBorder(polaroid, 0.1);
    expect(card.margin).toBeCloseTo(0.1, 9);
    expect(card.bottomMargin).toBeCloseTo(0.35, 9);
  });

  it("lists the photo's blur, then white, black and the pen colours", () => {
    const fills = frameFills(["#ff0000", "#ffffff"]);
    expect(fills[0]).toEqual({ kind: "blur" });
    expect(fills.slice(1).map((f) => (f.kind === "solid" ? f.color : ""))).toEqual(["#ffffff", "#000000", "#ff0000"]);
  });
});

describe("blurred fill", () => {
  it("puts a fixed count of pixels along the canvas's long side", () => {
    expect(frameBlurSize(4000, 3000, 4000, 3000)).toEqual([64, 48]);
    expect(frameBlurSize(720, 540, 720, 540)).toEqual([64, 48]);
    expect(frameBlurSize(1920, 1080, 1080, 1920)).toEqual([114, 64]);
  });

  it("leaves a flat colour alone", () => {
    const flat = new Uint8ClampedArray(20 * 10 * 4);
    for (let i = 0; i < flat.length; i += 4) flat.set([0x33, 0x66, 0x99, 255], i);
    expect([...soften(flat, 20, 10, 2, 3)]).toEqual([...flat]);
  });

  it("spreads a dot evenly over its blur box", () => {
    const w = 9;
    const dot = new Uint8ClampedArray(w * w * 4);
    for (let i = 0; i < w * w; i++) dot.set(i === 4 * w + 4 ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);
    const out = soften(dot, w, w, 2, 1);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        expect(out[(y * w + x) * 4]).toBe(x >= 2 && x <= 6 && y >= 2 && y <= 6 ? 10 : 0);
      }
    }
  });
});
