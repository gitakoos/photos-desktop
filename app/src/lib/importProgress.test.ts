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
import { importFraction, importOwnsBar } from "./importProgress";

const state = (phase: "downloading" | "unpacking" | "ready" | "planning" | "review", done = 0, total = 0) => ({
  phase,
  done,
  total,
  part: 1,
  parts: 1,
});

describe("how far an import has got", () => {
  it("follows the bytes while a zip unpacks", () => {
    expect(importFraction(state("unpacking", 25, 100))).toBe(0.25);
  });

  it("never runs past the end, whatever the zip's own sizes claimed", () => {
    expect(importFraction(state("unpacking", 120, 100))).toBe(1);
  });

  it("does not claim a number before the size of the zip is known", () => {
    expect(importFraction(state("unpacking", 0, 0))).toBeNull();
  });

  it("follows the bytes while a download comes down", () => {
    expect(importFraction(state("downloading", 30, 120))).toBe(0.25);
  });

  it("does not claim a number before the size of a download is known", () => {
    expect(importFraction(state("downloading", 0, 0))).toBeNull();
  });

  it.each(["ready", "planning", "review"] as const)("has no number to show while %s", (phase) => {
    expect(importFraction(state(phase))).toBeNull();
  });
});

describe("who the bar belongs to", () => {
  it("goes to the import over the totals of an upload that finished earlier", () => {
    expect(importOwnsBar(state("ready"), false)).toBe(true);
    expect(importOwnsBar(state("unpacking", 25, 100), false)).toBe(true);
  });

  it("stays with files that are uploading right now", () => {
    expect(importOwnsBar(state("unpacking", 25, 100), true)).toBe(false);
  });

  it("stays with the upload when there is no import", () => {
    expect(importOwnsBar(undefined, false)).toBe(false);
  });
});
