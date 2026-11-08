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
import { labelState, matchingLabels, sameLabel } from "./labels";

describe("the label list", () => {
  it("treats case, accents and spacing as one label", () => {
    expect(sameLabel("Nyár  ", "nyar")).toBe(true);
    expect(sameLabel("Nyár", "Nyárs")).toBe(false);
  });

  it("finds by part of a name, the ones that start with it first", () => {
    const labels = [{ name: "Summer beach" }, { name: "Beach" }, { name: "Family" }];
    expect(matchingLabels(labels, "beach").map((l) => l.name)).toEqual(["Beach", "Summer beach"]);
    expect(matchingLabels(labels, "  ")).toBe(labels);
  });

  it("marks a label as on all, some or none of the selected photos", () => {
    const carried = { a: ["Beach"], b: ["beach", "Sun"], c: [] };
    expect(labelState("Beach", ["a", "b"], carried)).toBe("all");
    expect(labelState("Beach", ["a", "c"], carried)).toBe("some");
    expect(labelState("Sun", ["a"], carried)).toBe("none");
  });
});
