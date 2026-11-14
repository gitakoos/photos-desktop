/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { describe, it, expect } from "vitest";
import { thumbPxFor, thumbUrlFor } from "./thumbSize";

describe("the size a tile asks for", () => {
  it("is the tile's height in device pixels, rounded up to a size the server cuts", () => {
    expect(thumbPxFor(120, 1)).toBe(192); // 120 / 0.85 = 142
    expect(thumbPxFor(100, 1)).toBe(128); // 118
    expect(thumbPxFor(120, 2)).toBe(320); // 283
    expect(thumbPxFor(160, 2)).toBe(384); // 376.5 -> 377
  });

  it("asks for the full thumbnail past the largest size", () => {
    expect(thumbPxFor(400, 1)).toBeNull();
    expect(thumbPxFor(200, 2)).toBeNull();
  });

  it("treats a missing pixel ratio as 1", () => {
    expect(thumbPxFor(120, 0)).toBe(192);
  });
});

describe("a thumbnail's URL", () => {
  it("carries the size and the attempt only when there are any", () => {
    const base = "http://127.0.0.1:4000/t/tok/";
    expect(thumbUrlFor(base, "a~b=", 192, 0)).toBe(`${base}a~b%3D?w=192`);
    expect(thumbUrlFor(base, "u", 192, 2)).toBe(`${base}u?w=192&a=2`);
    expect(thumbUrlFor(base, "u", null, 0)).toBe(`${base}u`);
    expect(thumbUrlFor(base, "u", null, 1)).toBe(`${base}u?a=1`);
  });
});
