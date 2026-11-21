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

import { cameraFactsOf } from "./cameraFacts.ts";

describe("cameraFactsOf", () => {
  it("collects the camera and the exposure", () => {
    expect(
      cameraFactsOf({
        Make: "Google",
        Model: "Pixel 8 Pro",
        LensModel: "Pixel 8 Pro back camera 6.9mm f/1.68",
        FNumber: 1.68,
        ExposureTime: 1 / 120,
        ISO: 64,
        FocalLength: 6.9,
        FocalLengthIn35mmFormat: 25,
      }),
    ).toEqual({
      device: "Google Pixel 8 Pro",
      lens: "Pixel 8 Pro back camera 6.9mm f/1.68",
      aperture: 1.68,
      exposure: 1 / 120,
      iso: 64,
      focalLength: 6.9,
      focalLength35: 25,
    });
  });

  it("does not repeat the make when the model starts with it", () => {
    expect(cameraFactsOf({ Make: "samsung", Model: "samsung SM-S901B" })?.device).toBe("samsung SM-S901B");
  });

  it("leaves out what is missing or zero", () => {
    expect(cameraFactsOf({ Model: "X100V", ISO: 0, FNumber: "n/a", ExposureTime: -1 })).toEqual({ device: "X100V" });
  });

  it("is null when nothing is there", () => {
    expect(cameraFactsOf({})).toBeNull();
    expect(cameraFactsOf(null)).toBeNull();
    expect(cameraFactsOf({ Make: "  ", LensModel: "\0" })).toBeNull();
  });
});
