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
import { sameStatus } from "./sameStatus";

describe("a status answer", () => {
  it("is the same when every field says the same", () => {
    expect(sameStatus({ state: "done", done: 3, search: { indexed: 2 } }, { state: "done", done: 3, search: { indexed: 2 } })).toBe(true);
    expect(sameStatus({ state: "done", done: 3 }, { state: "done", done: 4 })).toBe(false);
    expect(sameStatus(null, { state: "done" })).toBe(false);
  });
});
