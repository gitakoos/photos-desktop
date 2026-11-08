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
import { en } from "./locales/en";

// Every source file of the window as text, tests and the locale files left out.
const sources = import.meta.glob(["../**/*.ts", "../**/*.tsx", "!../**/*.test.ts", "!../**/*.test.tsx", "!./locales/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("the texts the window asks for", () => {
  // A key with no English text shows on screen as the key itself, as a "loading" line did.
  it("all have an English text", () => {
    const known = new Set(Object.keys(en));
    const missing: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      for (const m of text.matchAll(/t\(\s*"([A-Za-z0-9_.]+)"/g)) {
        if (!known.has(m[1])) missing.push(`${m[1]} (${file})`);
      }
    }
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(missing).toEqual([]);
  });
});
