/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
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

  it("gives none for a box with no area in the photo", () => {
    expect(faceCoverUrl(BASE, "u", [0.5, 0.2, 0.5, 0.4])).toBeNull();
    expect(faceCoverUrl(BASE, "u", [1.2, 0.2, 1.5, 0.4])).toBeNull();
    expect(faceCoverUrl(BASE, "u", [NaN, 0.2, 0.5, 0.4])).toBeNull();
  });
});
