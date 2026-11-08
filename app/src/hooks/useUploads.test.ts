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

import { libraryChanged, type UploadStatus } from "./useUploads";

const at = (done: number, skipped: number, failed = 0): UploadStatus => ({ running: false, total: done + skipped + failed, done, skipped, failed, items: [] });

describe("refreshing the views after a drop", () => {
  it("reads the library again when photos went up", () => {
    expect(libraryChanged(at(0, 0), at(3, 0))).toBe(true);
  });

  it("reads it again when every photo was already there, since the folder's album was still made", () => {
    expect(libraryChanged(at(2, 1), at(2, 7))).toBe(true);
  });

  it("leaves it when nothing went up and nothing was found already there", () => {
    expect(libraryChanged(at(2, 1), at(2, 1, 3))).toBe(false);
  });
});
