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

import { afterEach, describe, expect, it, vi } from "vitest";
import { autoUpdateOn, setAutoUpdate } from "./updatePrefs";

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("automatic updates", () => {
  it("follow the build when nothing was chosen", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(autoUpdateOn(true)).toBe(true);
    expect(autoUpdateOn(false)).toBe(false);
  });

  it("follow the choice once one is made, whatever the build", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    setAutoUpdate(false);
    expect(autoUpdateOn(true)).toBe(false);
    setAutoUpdate(true);
    expect(autoUpdateOn(false)).toBe(true);
  });

  it("fall back to the build's default without storage", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(autoUpdateOn(true)).toBe(true);
    expect(() => setAutoUpdate(false)).not.toThrow();
  });
});
