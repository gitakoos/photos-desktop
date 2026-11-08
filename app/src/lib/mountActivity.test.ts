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

vi.mock("./platform", () => ({ isWindows: true }));

import { describeMount, type MountActivity } from "./mountActivity";

const t = (key: string, values?: Record<string, string | number>) =>
  values ? `${key}(${Object.values(values).join("/")})` : key;
const fill = (over: Partial<MountActivity>): MountActivity => ({ what: "fill", name: null, by: null, done: 0, total: 0, ...over });

describe("the Explorer folder's fill, in words", () => {
  it("counts the photos, then the albums, then says it is tidying up", () => {
    expect(describeMount(fill({ done: 40, total: 100 }), t).title).toBe("sync.fillCount(40/100)");
    expect(describeMount(fill({ phase: "albums" }), t).title).toBe("sync.fillAlbums");
    expect(describeMount(fill({ phase: "albums", done: 12, total: 30 }), t).title).toBe("sync.fillAlbumsCount(12/30)");
    expect(describeMount(fill({ phase: "tidy", done: 100, total: 100 }), t).title).toBe("sync.fillTidy");
  });
});
