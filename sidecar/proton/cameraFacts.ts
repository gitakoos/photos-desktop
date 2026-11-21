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

// What a photo's EXIF says about the camera and the exposure, for the details panel.
//
// The Drive node only keeps the device name, so the lens and the exposure are read from
// the file itself, the one the viewer already holds.

import exifr from "exifr";

import { deviceName } from "./upload.ts";

export type CameraFacts = {
  device?: string;
  lens?: string;
  /** The f-number, so 1.8 for f/1.8. */
  aperture?: number;
  /** The shutter time in seconds. */
  exposure?: number;
  iso?: number;
  /** The focal length in millimetres, and its 35 mm equivalent when the camera says. */
  focalLength?: number;
  focalLength35?: number;
};

const positive = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : Array.isArray(v) ? Number(v[0]) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const text = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.replace(/\0/g, "").trim() : "";
  return s || undefined;
};

/** The camera facts out of a parsed EXIF block, or null when it has none of them. */
export function cameraFactsOf(exif: Record<string, unknown> | null | undefined): CameraFacts | null {
  if (!exif) return null;
  const facts: CameraFacts = {};
  const device = deviceName(text(exif.Make), text(exif.Model));
  if (device) facts.device = device;
  const lens = text(exif.LensModel);
  if (lens) facts.lens = lens;
  const aperture = positive(exif.FNumber);
  if (aperture) facts.aperture = aperture;
  const exposure = positive(exif.ExposureTime);
  if (exposure) facts.exposure = exposure;
  const iso = positive(exif.ISO);
  if (iso) facts.iso = Math.round(iso);
  const focal = positive(exif.FocalLength);
  if (focal) facts.focalLength = focal;
  const focal35 = positive(exif.FocalLengthIn35mmFormat);
  if (focal35) facts.focalLength35 = focal35;
  return Object.keys(facts).length > 0 ? facts : null;
}

/** Reads the camera facts out of a photo's bytes; null for a file with no EXIF. */
export async function readCameraFacts(bytes: Buffer): Promise<CameraFacts | null> {
  try {
    const exif = await exifr.parse(bytes, {
      pick: ["Make", "Model", "LensModel", "FNumber", "ExposureTime", "ISO", "FocalLength", "FocalLengthIn35mmFormat"],
    });
    return cameraFactsOf(exif);
  } catch {
    return null;
  }
}
