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
import { photoSpan, photoSpanLabel } from "./albumSpan";

describe("an album's dates from its photos", () => {
  it("takes the first and the last capture time, leaving out photos with none", () => {
    expect(photoSpan([{ captureTime: 30 }, { captureTime: 0 }, { captureTime: 10 }, { captureTime: 20 }])).toEqual([10, 30]);
    expect(photoSpan([{ captureTime: 0 }])).toBeNull();
    expect(photoSpan([])).toBeNull();
  });

  it("says one day once, and a span from the first day to the last", () => {
    const morning = new Date(2024, 4, 3, 8).getTime();
    expect(photoSpanLabel([morning, new Date(2024, 4, 3, 20).getTime()], "en-US")).toBe("May 3, 2024");
    const label = photoSpanLabel([morning, new Date(2024, 4, 9, 12).getTime()], "en-US");
    expect(label).toContain("3");
    expect(label).toContain("9");
    expect(label).toContain("2024");
    expect(label).not.toBe("May 3, 2024");
  });
});
