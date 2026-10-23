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
import { hexToHsv, hsvToHex, inTurnedBox, newText, snapTextAngle, textBackdrop } from "./editorOverlay";

describe("snapTextAngle", () => {
  it("pulls an angle within 5 degrees of a 45-degree detent onto it", () => {
    expect(snapTextAngle(3)).toBe(0);
    expect(snapTextAngle(-4)).toBe(0);
    expect(snapTextAngle(48)).toBe(45);
    expect(snapTextAngle(92)).toBe(90);
    expect(snapTextAngle(357)).toBe(0);
  });

  it("leaves an angle between detents alone, normalised to 0..360", () => {
    expect(snapTextAngle(20)).toBe(20);
    expect(snapTextAngle(-20)).toBe(340);
    expect(snapTextAngle(380)).toBe(20);
  });
});

describe("textBackdrop", () => {
  it("pads the text by Android's margins and rounds by a share of the shorter half", () => {
    const b = textBackdrop(100, 400, 2, 0.5);
    expect(b.halfWidth).toBeCloseTo(200 + 40, 9);
    expect(b.halfHeight).toBeCloseTo((100 * 1.2 * 2) / 2 + 12, 9);
    expect(b.radius).toBeCloseTo(Math.min(240, 132) * 0.5, 9);
  });

  it("treats a missing corner value as square and keeps at least one line", () => {
    expect(textBackdrop(10, 0, 0, Number.NaN).radius).toBe(0);
    expect(textBackdrop(10, 0, 0, 0).halfHeight).toBeCloseTo(6 + 1.2, 9);
  });
});

describe("inTurnedBox", () => {
  const box = { cx: 100, cy: 100, halfWidth: 50, halfHeight: 10 };

  it("hits inside the unturned box and misses outside it", () => {
    expect(inTurnedBox(140, 105, box, 0)).toBe(true);
    expect(inTurnedBox(100, 120, box, 0)).toBe(false);
  });

  it("follows the box when it is turned upright", () => {
    expect(inTurnedBox(100, 140, box, 90)).toBe(true);
    expect(inTurnedBox(140, 100, box, 90)).toBe(false);
  });
});

describe("colours", () => {
  it("round-trips through hue, saturation and value", () => {
    for (const hex of ["#ff3b30", "#34c759", "#007aff", "#ffffff", "#000000", "#808080"]) {
      const { h, s, v } = hexToHsv(hex);
      expect(hsvToHex(h, s, v)).toBe(hex);
    }
  });

  it("gives pure hues at full saturation and value", () => {
    expect(hsvToHex(0, 1, 1)).toBe("#ff0000");
    expect(hsvToHex(120, 1, 1)).toBe("#00ff00");
    expect(hsvToHex(240, 1, 1)).toBe("#0000ff");
  });

  it("starts a new text white, centred, at 8 % of the height with no box", () => {
    const t = newText(3);
    expect(t).toMatchObject({ id: 3, cx: 0.5, cy: 0.5, color: "#ffffff", size: 0.08, backgroundOpacity: 0 });
  });
});
