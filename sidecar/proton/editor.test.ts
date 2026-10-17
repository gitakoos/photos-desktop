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

import { describe, it, expect } from "vitest";

import { cameraOf, editedName, locationOf } from "./editor.ts";

describe("editedName", () => {
  const when = new Date(2026, 8, 5, 14, 3, 9); // 2026-09-05 14:03:09 local

  it("keeps the stem and stamps a local timestamp with a .jpg extension", () => {
    expect(editedName("beach.HEIC", when)).toBe("beach_edit_20260905_140309.jpg");
  });

  it("replaces the source extension whatever it was", () => {
    expect(editedName("clip.png", when)).toBe("clip_edit_20260905_140309.jpg");
  });

  it("handles a name with no extension", () => {
    expect(editedName("noext", when)).toBe("noext_edit_20260905_140309.jpg");
  });

  it("handles a name that is only an extension (a dotfile)", () => {
    // lastIndexOf('.') is 0, so the whole thing is the stem, not an extension.
    expect(editedName(".gitignore", when)).toBe(".gitignore_edit_20260905_140309.jpg");
  });

  it("falls back to a stem for an empty or blank name", () => {
    expect(editedName("", when)).toBe("photo_edit_20260905_140309.jpg");
    expect(editedName("   ", when)).toBe("photo_edit_20260905_140309.jpg");
  });

  it("zero-pads every field", () => {
    expect(editedName("x.jpg", new Date(2026, 0, 1, 0, 0, 0))).toBe("x_edit_20260101_000000.jpg");
  });
});

describe("locationOf", () => {
  it("reads a valid pair in either casing", () => {
    expect(locationOf({ Location: { Latitude: 47.5, Longitude: 19.05 } })).toEqual({
      latitude: 47.5,
      longitude: 19.05,
    });
    expect(locationOf({ location: { latitude: -33.9, longitude: 151.2 } })).toEqual({
      latitude: -33.9,
      longitude: 151.2,
    });
  });

  it("keeps a real zero coordinate", () => {
    expect(locationOf({ Location: { Latitude: 0, Longitude: 0 } })).toEqual({
      latitude: 0,
      longitude: 0,
    });
  });

  it("rejects a half pair, out-of-range values, and a missing block", () => {
    expect(locationOf({ Location: { Latitude: 47.5 } })).toEqual({ latitude: null, longitude: null });
    expect(locationOf({ Location: { Latitude: 200, Longitude: 19 } })).toEqual({
      latitude: null,
      longitude: null,
    });
    expect(locationOf(null)).toEqual({ latitude: null, longitude: null });
    expect(locationOf({})).toEqual({ latitude: null, longitude: null });
  });
});

describe("cameraOf", () => {
  it("reads and trims the device in either casing", () => {
    expect(cameraOf({ Camera: { Device: "  Apple iPhone 15  " } })).toBe("Apple iPhone 15");
    expect(cameraOf({ camera: { device: "Pixel 8" } })).toBe("Pixel 8");
  });

  it("is null when absent or blank", () => {
    expect(cameraOf(null)).toBeNull();
    expect(cameraOf({})).toBeNull();
    expect(cameraOf({ Camera: { Device: "   " } })).toBeNull();
  });
});
