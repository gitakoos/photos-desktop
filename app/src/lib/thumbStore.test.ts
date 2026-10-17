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

import { describe, it, expect, vi } from "vitest";

vi.mock("./rpc", () => ({ rpc: vi.fn() }));
vi.mock("./lightboxSignal", () => ({ isLightboxOpen: () => false }));

import { cachedThumbnail, putThumbnail, thumbCacheSize } from "./thumbStore";

describe("the grid's thumbnail cache", () => {
  it("keeps thousands of small thumbnails, which a count cap of 500 threw away", () => {
    for (let i = 0; i < 3000; i++) putThumbnail(`small-${i}`, "x".repeat(4 * 1024));
    expect(thumbCacheSize()).toBeGreaterThanOrEqual(3000);
    expect(cachedThumbnail("small-0")).toBeDefined();
  });

  it("stays within its size, throwing out the least recently used first", () => {
    const large = "y".repeat(1024 * 1024); // 1 MB each: far past the budget at 100
    for (let i = 0; i < 100; i++) putThumbnail(`large-${i}`, large);
    // Touched last, so kept.
    expect(cachedThumbnail("large-99")).toBe(large);
    // The oldest went first, the small ones above included.
    expect(cachedThumbnail("small-0")).toBeUndefined();
    expect(cachedThumbnail("large-0")).toBeUndefined();
    expect(thumbCacheSize()).toBeLessThanOrEqual(49);
  });
});
