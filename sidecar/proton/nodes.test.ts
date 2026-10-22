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
import { nodeLocation } from "./nodes.ts";

const withExtra = (extra: unknown) => ({ activeRevision: { ok: true, value: { claimedAdditionalMetadata: extra } } });

describe("where a photo was taken", () => {
  it("is read from Drive's Location attribute", () => {
    expect(nodeLocation(withExtra({ Location: { Latitude: 41.15, Longitude: -8.61 } }))).toEqual([41.15, -8.61]);
  });

  it("is nowhere without one, off the globe, or at the 0,0 a camera with no fix writes", () => {
    expect(nodeLocation(withExtra({ Media: { Width: 10 } }))).toBeNull();
    expect(nodeLocation(withExtra({ Location: { Latitude: 120, Longitude: 5 } }))).toBeNull();
    expect(nodeLocation(withExtra({ Location: { Latitude: 0, Longitude: 0 } }))).toBeNull();
    expect(nodeLocation({ activeRevision: { ok: false } })).toBeNull();
  });
});
