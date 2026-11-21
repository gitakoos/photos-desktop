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
import {
  cameraName,
  cameraTiles,
  formatAperture,
  formatCoords,
  formatExposure,
  formatFocal,
  hasCameraInfo,
  nodeDevice,
  nodePlace,
} from "./cameraFacts";

describe("formatting", () => {
  it("writes the aperture as an f-number", () => {
    expect(formatAperture(1.68)).toBe("f/1.7");
    expect(formatAperture(2)).toBe("f/2");
    expect(formatAperture(11)).toBe("f/11");
    expect(formatAperture(16.4)).toBe("f/16");
  });

  it("writes a short shutter as a fraction and a long one in seconds", () => {
    expect(formatExposure(1 / 120)).toBe("1/120");
    expect(formatExposure(0.5)).toBe("1/2");
    expect(formatExposure(1)).toBe("1 s");
    expect(formatExposure(2.5)).toBe("2.5 s");
  });

  it("writes the focal length in millimetres", () => {
    expect(formatFocal(6.9)).toBe("6.9 mm");
    expect(formatFocal(50)).toBe("50 mm");
  });

  it("prints the coordinates to four places", () => {
    expect(formatCoords(38.72234, -9.13933)).toBe("38.7223, -9.1393");
  });
});

describe("cameraTiles", () => {
  it("keeps the order and only what the photo has", () => {
    expect(cameraTiles({ aperture: 1.8, exposure: 1 / 60, iso: 100, focalLength: 24 })).toEqual([
      { key: "aperture", value: "f/1.8" },
      { key: "shutter", value: "1/60" },
      { key: "iso", value: "100" },
      { key: "focal", value: "24 mm" },
    ]);
    expect(cameraTiles({ iso: 400 })).toEqual([{ key: "iso", value: "400" }]);
    expect(cameraTiles({ device: "X" })).toEqual([]);
  });
});

describe("the camera name", () => {
  it("prefers the EXIF device over the node's", () => {
    expect(cameraName({ device: "Google Pixel 8" }, "Pixel")).toBe("Google Pixel 8");
    expect(cameraName(null, "Pixel")).toBe("Pixel");
    expect(cameraName(null, null)).toBeNull();
    expect(hasCameraInfo(null, null)).toBe(false);
    expect(hasCameraInfo(null, "Pixel")).toBe(true);
    expect(hasCameraInfo({ iso: 1 }, null)).toBe(true);
  });

  it("reads the node's device in either casing", () => {
    expect(nodeDevice({ Camera: { Device: " Pixel 8 " } })).toBe("Pixel 8");
    expect(nodeDevice({ camera: { device: "A" } })).toBe("A");
    expect(nodeDevice({ Camera: {} })).toBeNull();
    expect(nodeDevice(null)).toBeNull();
  });
});

describe("nodePlace", () => {
  it("reads the coordinate, zero included", () => {
    expect(nodePlace({ Location: { Latitude: 38.7, Longitude: -9.1 } })).toEqual({ lat: 38.7, lon: -9.1 });
    expect(nodePlace({ location: { latitude: 0, longitude: 0 } })).toEqual({ lat: 0, lon: 0 });
  });

  it("refuses a missing, half or impossible one", () => {
    expect(nodePlace(null)).toBeNull();
    expect(nodePlace({})).toBeNull();
    expect(nodePlace({ Location: { Latitude: 38.7 } })).toBeNull();
    expect(nodePlace({ Location: { Latitude: 95, Longitude: 0 } })).toBeNull();
  });
});
