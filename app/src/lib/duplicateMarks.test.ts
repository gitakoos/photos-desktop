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
import { canMark, picksFrom, toggleMark, type Marks } from "./duplicateMarks";

const group = { key: "a|b|c", uids: ["a", "b", "c"] };

describe("marking duplicate copies", () => {
  it("marks and unmarks, but never the last copy left", () => {
    let marks: Marks = new Map();
    marks = toggleMark(marks, group, "a");
    marks = toggleMark(marks, group, "b");
    expect([...marks.get(group.key)!]).toEqual(["a", "b"]);
    expect(canMark(marks, group, "c")).toBe(false);
    expect(toggleMark(marks, group, "c")).toBe(marks);
    marks = toggleMark(marks, group, "a");
    expect([...marks.get(group.key)!]).toEqual(["b"]);
    marks = toggleMark(marks, group, "b");
    expect(marks.has(group.key)).toBe(false);
  });

  it("asks for each marked group with the copies it keeps, and for no group with none kept", () => {
    const other = { key: "x|y", uids: ["x", "y"] };
    const marks: Marks = new Map([
      [group.key, new Set(["b"])],
      [other.key, new Set(["x", "y"])],
    ]);
    expect(picksFrom(marks, [group, other])).toEqual([{ uids: ["a", "b", "c"], keep: ["a", "c"] }]);
  });
});
