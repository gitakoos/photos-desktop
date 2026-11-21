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
  buildEdit,
  canSplitAt,
  cropFractions,
  cssFilter,
  cutSize,
  estimateGifBytes,
  flipBox,
  formatClock,
  freshEdit,
  gifFits,
  gifFrameSize,
  isEdited,
  keepSide,
  moveHandle,
  msAtX,
  outputMs,
  playheadIn,
  rulerTicks,
  previewLayout,
  rangesToSave,
  startingCrop,
  stripCount,
  turnBoxRight,
  turnRight,
  turnedSize,
  type EditState,
} from "./videoEdit";

const base = (over: Partial<EditState> = {}): EditState => ({ ...freshEdit(20_000), ...over });

describe("trim", () => {
  it("maps a pointer on the track to a position, held inside the video", () => {
    expect(msAtX(150, 100, 200, 20_000)).toBe(5_000);
    expect(msAtX(50, 100, 200, 20_000)).toBe(0);
    expect(msAtX(900, 100, 200, 20_000)).toBe(20_000);
    expect(msAtX(150, 100, 0, 20_000)).toBe(0);
  });

  it("keeps the two handles apart and inside the video", () => {
    const t = { startMs: 4_000, endMs: 9_000 };
    expect(moveHandle(t, "start", 2_500, 20_000)).toEqual({ startMs: 2_500, endMs: 9_000 });
    expect(moveHandle(t, "start", 9_500, 20_000)).toEqual({ startMs: 8_900, endMs: 9_000 });
    expect(moveHandle(t, "start", -50, 20_000)).toEqual({ startMs: 0, endMs: 9_000 });
    expect(moveHandle(t, "end", 4_010, 20_000)).toEqual({ startMs: 4_000, endMs: 4_100 });
    expect(moveHandle(t, "end", 99_000, 20_000)).toEqual({ startMs: 4_000, endMs: 20_000 });
  });

  it("keeps the playhead inside the kept part", () => {
    expect(playheadIn({ startMs: 4_000, endMs: 9_000 }, 1_000)).toBe(4_000);
    expect(playheadIn({ startMs: 4_000, endMs: 9_000 }, 12_000)).toBe(9_000);
    expect(playheadIn({ startMs: 4_000, endMs: 9_000 }, 6_000)).toBe(6_000);
  });

  it("formats a position as minutes, seconds and tenths", () => {
    expect(formatClock(0)).toBe("0:00.0");
    expect(formatClock(65_400)).toBe("1:05.4");
    expect(formatClock(-5)).toBe("0:00.0");
  });
});

describe("split", () => {
  const cut = base({ startMs: 2_000, endMs: 12_000 });

  it("needs a piece on each side", () => {
    expect(canSplitAt(cut, 6_000)).toBe(true);
    expect(canSplitAt(cut, 2_050)).toBe(false);
    expect(canSplitAt(cut, 11_950)).toBe(false);
    expect(canSplitAt(cut, 500)).toBe(false);
  });

  it("keeps the first or the second part and clears the split", () => {
    const split = { ...cut, split: { atMs: 6_000, both: false } };
    expect(keepSide(split, "first")).toMatchObject({ startMs: 2_000, endMs: 6_000, split: null });
    expect(keepSide(split, "second")).toMatchObject({ startMs: 6_000, endMs: 12_000, split: null });
    expect(keepSide(cut, "first")).toBe(cut);
  });

  it("saves one file, or two when both parts are asked for", () => {
    expect(rangesToSave(cut)).toEqual([{ startMs: 2_000, endMs: 12_000 }]);
    const one = { ...cut, split: { atMs: 6_000, both: false } };
    expect(rangesToSave(one)).toEqual([{ startMs: 2_000, endMs: 12_000 }]);
    const both = { ...cut, split: { atMs: 6_000, both: true } };
    expect(rangesToSave(both)).toEqual([
      { startMs: 2_000, endMs: 6_000 },
      { startMs: 6_000, endMs: 12_000 },
    ]);
    // A split that no longer fits inside the trim is ignored.
    expect(rangesToSave({ ...cut, split: { atMs: 20_000, both: true } })).toHaveLength(1);
  });

  it("measures a part at its speed", () => {
    expect(outputMs({ startMs: 0, endMs: 10_000 }, 2)).toBe(5_000);
    expect(outputMs({ startMs: 0, endMs: 10_000 }, 0.5)).toBe(20_000);
    expect(outputMs({ startMs: 4_000, endMs: 3_000 }, 1)).toBe(0);
  });
});

describe("turn, flip and crop", () => {
  it("swaps the frame on a sideways turn", () => {
    expect(turnedSize(1920, 1080, 0)).toEqual({ w: 1920, h: 1080 });
    expect(turnedSize(1920, 1080, 90)).toEqual({ w: 1080, h: 1920 });
    expect(turnedSize(1920, 1080, 180)).toEqual({ w: 1920, h: 1080 });
    expect(turnedSize(1920, 1080, 270)).toEqual({ w: 1080, h: 1920 });
    expect(turnRight(270)).toBe(0);
    expect(turnRight(0)).toBe(90);
  });

  it("carries a crop box through a quarter turn and four of them home", () => {
    const box = { left: 100, top: 40, right: 500, bottom: 300 };
    const once = turnBoxRight(box, 600);
    expect(once).toEqual({ left: 300, top: 100, right: 560, bottom: 500 });
    let b = box;
    let w = 800;
    let h = 600;
    for (let i = 0; i < 4; i++) {
      b = turnBoxRight(b, h);
      [w, h] = [h, w];
    }
    expect(b).toEqual(box);
  });

  it("mirrors a crop box", () => {
    const box = { left: 100, top: 40, right: 500, bottom: 300 };
    expect(flipBox(box, 800, 600, true)).toEqual({ left: 300, top: 40, right: 700, bottom: 300 });
    expect(flipBox(box, 800, 600, false)).toEqual({ left: 100, top: 300, right: 500, bottom: 560 });
    expect(flipBox(flipBox(box, 800, 600, true), 800, 600, true)).toEqual(box);
  });

  it("gives the crop as fractions of the turned frame, none for the whole frame", () => {
    expect(cropFractions({ left: 480, top: 0, right: 1440, bottom: 1080 }, 1920, 1080)).toEqual({ x: 0.25, y: 0, w: 0.5, h: 1 });
    expect(cropFractions({ left: 0, top: 0, right: 1920, bottom: 1080 }, 1920, 1080)).toBeNull();
    expect(cropFractions(null, 1920, 1080)).toBeNull();
    expect(cropFractions({ left: 0, top: 0, right: 10, bottom: 10 }, 0, 0)).toBeNull();
  });

  it("sizes the cut as the host will, even and inside the frame", () => {
    expect(cutSize({ left: 0, top: 0, right: 501, bottom: 333 }, 1920, 1080)).toEqual({ w: 500, h: 332 });
    expect(cutSize(null, 1081, 607)).toEqual({ w: 1080, h: 606 });
  });

  it("starts a fixed shape as the largest in the middle, and free as none", () => {
    expect(startingCrop("free", 1920, 1080)).toBeNull();
    expect(startingCrop("1:1", 1920, 1080)).toEqual({ left: 420, top: 0, right: 1500, bottom: 1080 });
    expect(startingCrop("16:9", 1920, 1080)).toBeNull();
    const portrait = startingCrop("9:16", 1920, 1080)!;
    expect(portrait.bottom - portrait.top).toBe(1080);
    expect(portrait.right - portrait.left).toBe(607);
    const four5 = startingCrop("4:5", 1080, 1920)!;
    expect(four5.right - four5.left).toBe(1080);
    expect(four5.bottom - four5.top).toBe(1350);
  });
});

describe("the preview layout", () => {
  it("shows the whole frame while cropping and fills the stage by the shape", () => {
    const l = previewLayout({ w: 1920, h: 1080 }, { left: 0, top: 0, right: 960, bottom: 1080 }, { w: 960, h: 540 }, true);
    expect(l.scale).toBeCloseTo(0.5);
    expect(l.wrapW).toBeCloseTo(960);
    expect(l.wrapH).toBeCloseTo(540);
    expect(l.offX).toBeCloseTo(0);
    expect(l.frameW).toBeCloseTo(960);
  });

  it("shows only the cropped part otherwise, the frame moved behind the window", () => {
    const l = previewLayout({ w: 1920, h: 1080 }, { left: 480, top: 0, right: 1440, bottom: 1080 }, { w: 960, h: 540 }, false);
    expect(l.scale).toBeCloseTo(0.5);
    expect(l.wrapW).toBeCloseTo(480);
    expect(l.wrapH).toBeCloseTo(540);
    expect(l.offX).toBeCloseTo(-240);
    expect(l.frameW).toBeCloseTo(960);
  });

  it("copes with a stage that has no size yet", () => {
    const l = previewLayout({ w: 1920, h: 1080 }, null, { w: 0, h: 0 }, false);
    expect(l.wrapW).toBe(0);
    expect(Number.isFinite(l.scale)).toBe(true);
  });
});

describe("the look", () => {
  it("is no filter when nothing is set", () => {
    expect(cssFilter(base())).toBe("none");
  });

  it("joins the preset and the sliders", () => {
    expect(cssFilter(base({ filter: "mono", brightness: 20, contrast: -50, saturation: 100 }))).toBe(
      "grayscale(1) contrast(1.08) brightness(1.100) contrast(0.500) saturate(2.000)",
    );
    expect(cssFilter(base({ brightness: 500 }))).toBe("brightness(1.500)");
  });
});

describe("GIF", () => {
  it("is never wider than the cut and keeps its shape with an even height", () => {
    expect(gifFrameSize(1920, 1080, 480)).toEqual({ w: 480, h: 270 });
    expect(gifFrameSize(300, 500, 640)).toEqual({ w: 300, h: 500 });
    expect(gifFrameSize(1081, 607, 320).h % 2).toBe(0);
  });

  it("estimates by pixels, frames and seconds", () => {
    expect(estimateGifBytes(480, 270, 12, 3)).toBe(Math.round(480 * 270 * 12 * 3 * 0.09));
    expect(estimateGifBytes(480, 270, 12, 0)).toBe(0);
  });

  it("fits only a short enough part at its speed", () => {
    expect(gifFits({ startMs: 0, endMs: 10_000 }, 1)).toBe(true);
    expect(gifFits({ startMs: 0, endMs: 10_001 }, 1)).toBe(false);
    expect(gifFits({ startMs: 0, endMs: 20_000 }, 2)).toBe(true);
    expect(gifFits({ startMs: 0, endMs: 50 }, 1)).toBe(false);
  });
});

describe("the request to the host", () => {
  const context = { src: "C:/v/clip.mp4", creationMs: 1_700_000_000_000 };

  it("describes the whole edit in the host's words", () => {
    const state = base({
      rotate: 90,
      flipH: true,
      crop: { left: 0, top: 480, right: 1080, bottom: 1440 },
      filter: "warm",
      brightness: 10,
      speed: 1.5,
      audio: {
        mute: false,
        volume: 120,
        fadeInMs: 500,
        fadeOutMs: 800,
        music: { path: "C:/m/song.mp3", name: "song.mp3", durationMs: 3000, volume: 40, mode: "mix", looped: true },
      },
    });
    const req = buildEdit(state, context, { w: 1920, h: 1080 }, "video", { startMs: 1_000, endMs: 9_000 });
    expect(req).toMatchObject({
      kind: "video",
      src: "C:/v/clip.mp4",
      startMs: 1_000,
      endMs: 9_000,
      rotate: 90,
      flipH: true,
      flipV: false,
      crop: { x: 0, y: 0.25, w: 1, h: 0.5 },
      filter: "warm",
      speed: 1.5,
      creationMs: 1_700_000_000_000,
      gif: { width: 480, fps: 12 },
    });
    expect(req.audio).toEqual({
      mute: false,
      volume: 120,
      fadeInMs: 500,
      fadeOutMs: 800,
      music: { path: "C:/m/song.mp3", volume: 40, mode: "mix", looped: true },
    });
  });

  it("carries a frame's moment and no crop when the whole frame is kept", () => {
    const req = buildEdit(base(), context, { w: 1920, h: 1080 }, "frame", { startMs: 0, endMs: 20_000 }, 4_321.6);
    expect(req.kind).toBe("frame");
    expect(req.frameMs).toBe(4_322);
    expect(req.crop).toBeNull();
    expect(req.audio.music).toBeNull();
  });
});

describe("what counts as an edit", () => {
  it("is nothing for a fresh state and something for each change", () => {
    expect(isEdited(base(), 20_000)).toBe(false);
    expect(isEdited(base({ startMs: 100 }), 20_000)).toBe(true);
    expect(isEdited(base({ endMs: 19_000 }), 20_000)).toBe(true);
    expect(isEdited(base({ rotate: 90 }), 20_000)).toBe(true);
    expect(isEdited(base({ flipV: true }), 20_000)).toBe(true);
    expect(isEdited(base({ filter: "sepia" }), 20_000)).toBe(true);
    expect(isEdited(base({ contrast: 5 }), 20_000)).toBe(true);
    expect(isEdited(base({ speed: 2 }), 20_000)).toBe(true);
    expect(isEdited(base({ audio: { ...base().audio, mute: true } }), 20_000)).toBe(true);
    expect(isEdited(base({ audio: { ...base().audio, fadeOutMs: 1 } }), 20_000)).toBe(true);
    expect(isEdited(base({ crop: { left: 0, top: 0, right: 10, bottom: 10 } }), 20_000)).toBe(true);
  });
});

describe("the filmstrip", () => {
  it("asks for enough thumbnails to keep each in proportion", () => {
    expect(stripCount(1000, 1920, 1080)).toBe(Math.ceil(1000 / (56 * (1920 / 1080))));
    expect(stripCount(10, 1920, 1080)).toBe(4);
    expect(stripCount(100_000, 1920, 1080)).toBe(48);
    expect(stripCount(0, 1920, 1080)).toBe(8);
  });
});

describe("the ruler", () => {
  it("marks whole seconds at a step that keeps the marks few", () => {
    expect(rulerTicks(24_000)).toEqual([0, 5, 10, 15, 20]);
    expect(rulerTicks(6_000)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(rulerTicks(600_000).length).toBeLessThanOrEqual(8);
    expect(rulerTicks(0)).toEqual([]);
  });
});
