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

import { sameAccount } from "./accountSwitch.ts";

describe("sameAccount", () => {
  it("knows the account again by a user key it unlocked before", () => {
    expect(sameAccount(["k1", "k2"], ["k2"])).toBe(true);
    expect(sameAccount(["k1"], ["k1", "k3"])).toBe(true);
  });

  it("takes keys that share nothing for another account", () => {
    expect(sameAccount(["k1", "k2"], ["k3"])).toBe(false);
  });

  it("takes an empty side for another account", () => {
    expect(sameAccount([], ["k1"])).toBe(false);
    expect(sameAccount(["k1"], [])).toBe(false);
  });
});
