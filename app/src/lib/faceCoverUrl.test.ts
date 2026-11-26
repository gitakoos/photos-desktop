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

import { describe, it, expect } from "vitest";
import { faceCoverUrl } from "./faceCoverUrl";

const BASE = "http://127.0.0.1:4000/t/tok/";

describe("a face cover's URL", () => {
  it("names the uid and the box after the server's base", () => {
    expect(faceCoverUrl(BASE, "a~b==", [0.1, 0.2, 0.30001, 0.4])).toBe(`${BASE}a~b%3D%3D/f/0.1000,0.2000,0.3000,0.4000`);
  });

  it("keeps a box that strays past the photo's edge inside it", () => {
    expect(faceCoverUrl(BASE, "u", [-0.02, 0.9, 0.1, 1.03])).toBe(`${BASE}u/f/0.0000,0.9000,0.1000,1.0000`);
  });

  it("asks for the size the circle is drawn at, rounded up to the server's steps", () => {
    const at = `${BASE}u/f/0.1000,0.2000,0.3000,0.4000`;
    expect(faceCoverUrl(BASE, "u", [0.1, 0.2, 0.3, 0.4], 104)).toBe(`${at}?w=128`);
    expect(faceCoverUrl(BASE, "u", [0.1, 0.2, 0.3, 0.4], 200)).toBe(`${at}?w=256`);
    // Larger than the largest step: the full cover, as with no size at all.
    expect(faceCoverUrl(BASE, "u", [0.1, 0.2, 0.3, 0.4], 640)).toBe(at);
  });

  it("gives none for a box with no area in the photo", () => {
    expect(faceCoverUrl(BASE, "u", [0.5, 0.2, 0.5, 0.4])).toBeNull();
    expect(faceCoverUrl(BASE, "u", [1.2, 0.2, 1.5, 0.4])).toBeNull();
    expect(faceCoverUrl(BASE, "u", [NaN, 0.2, 0.5, 0.4])).toBeNull();
  });
});
