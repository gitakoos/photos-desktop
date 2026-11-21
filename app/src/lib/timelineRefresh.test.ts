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

import { describe, expect, it, vi } from "vitest";

import { TIMELINE_STALE_MS, timelineReadOnReturn } from "./timelineRefresh";

const now = 1_000_000;
const old = now - TIMELINE_STALE_MS - 1;
const recent = now - TIMELINE_STALE_MS + 1;

describe("the timeline on the window's return", () => {
  it("always asks the photos feed to look", async () => {
    const call = vi.fn(() => Promise.resolve({ healthy: true }));
    await timelineReadOnReturn(old, true, call, now);
    expect(call).toHaveBeenCalledWith("checkPhotoEvents");
  });

  it("leaves the reading to the feed while it is trusted", async () => {
    expect(await timelineReadOnReturn(old, true, () => Promise.resolve({ healthy: true }), now)).toBe(false);
  });

  it("reads again when the feed is not trusted and the last read is over a minute old", async () => {
    const broken = () => Promise.resolve({ healthy: false });
    expect(await timelineReadOnReturn(old, true, broken, now)).toBe(true);
    expect(await timelineReadOnReturn(recent, true, broken, now)).toBe(false);
  });

  it("reads nothing offline, before a first read, or when the call fails", async () => {
    const broken = () => Promise.resolve({ healthy: false });
    expect(await timelineReadOnReturn(old, false, broken, now)).toBe(false);
    expect(await timelineReadOnReturn(0, true, broken, now)).toBe(false);
    expect(await timelineReadOnReturn(old, true, () => Promise.reject(new Error("locked")), now)).toBe(false);
    expect(await timelineReadOnReturn(old, true, () => Promise.resolve(null), now)).toBe(true);
  });
});
