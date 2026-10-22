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
import { mix, textOnAccent } from "./colour";

describe("palette colours", () => {
  it("mix a share of one colour into another", () => {
    expect(mix("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mix("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mix("#19191b", "#8b7cff", 0.05)).toBe("#1f1e26");
  });

  it("keep white text on a deep accent and take dark text on a pale one", () => {
    expect(textOnAccent("#8b7cff")).toBe("#fff");
    expect(textOnAccent("#6957d7")).toBe("#fff");
    expect(textOnAccent("#e0e0e0")).toBe("#141416");
    expect(textOnAccent("#4fc3f7")).toBe("#141416");
    expect(textOnAccent("#7bc47f")).toBe("#141416");
  });
});
