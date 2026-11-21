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

// How a photo's camera facts read in the details panel.

/** What the sidecar reads out of the photo's EXIF. */
export type CameraFacts = {
  device?: string;
  lens?: string;
  aperture?: number;
  /** Seconds. */
  exposure?: number;
  iso?: number;
  focalLength?: number;
  focalLength35?: number;
};

/** The f-number as photographers write it: f/1.8, f/11. */
export function formatAperture(f: number): string {
  const text = f >= 10 ? String(Math.round(f)) : String(Math.round(f * 10) / 10);
  return `f/${text}`;
}

/** The shutter time as 1/120 for a fraction of a second and 2.5 s for a long one. */
export function formatExposure(seconds: number): string {
  if (seconds >= 0.95) {
    const rounded = Math.round(seconds * 10) / 10;
    return `${rounded} s`;
  }
  return `1/${Math.round(1 / seconds)}`;
}

/** The focal length in millimetres, with at most one decimal. */
export function formatFocal(mm: number): string {
  return `${Math.round(mm * 10) / 10} mm`;
}

/** The tiles under the camera name: only the numbers the photo has. */
export type CameraTile = { key: "aperture" | "shutter" | "iso" | "focal"; value: string };

export function cameraTiles(facts: CameraFacts): CameraTile[] {
  const tiles: CameraTile[] = [];
  if (facts.aperture) tiles.push({ key: "aperture", value: formatAperture(facts.aperture) });
  if (facts.exposure) tiles.push({ key: "shutter", value: formatExposure(facts.exposure) });
  if (facts.iso) tiles.push({ key: "iso", value: String(facts.iso) });
  if (facts.focalLength) tiles.push({ key: "focal", value: formatFocal(facts.focalLength) });
  return tiles;
}

/** The camera's name, falling back to the device the node records when EXIF has none. */
export function cameraName(facts: CameraFacts | null, nodeDevice: string | null): string | null {
  return facts?.device ?? nodeDevice ?? null;
}

/** Whether there is anything about the camera to show. */
export function hasCameraInfo(facts: CameraFacts | null, nodeDevice: string | null): boolean {
  return !!facts || !!nodeDevice;
}

/** The camera name the node's extended attributes record, if any. */
export function nodeDevice(extra: Record<string, unknown> | null | undefined): string | null {
  const camera = (extra?.Camera ?? extra?.camera) as Record<string, unknown> | undefined;
  const device = camera?.Device ?? camera?.device;
  return typeof device === "string" && device.trim() ? device.trim() : null;
}

/** Where the node says the photo was taken, or null. */
export function nodePlace(extra: Record<string, unknown> | null | undefined): { lat: number; lon: number } | null {
  const loc = (extra?.Location ?? extra?.location) as Record<string, unknown> | undefined;
  const lat = Number(loc?.Latitude ?? loc?.latitude);
  const lon = Number(loc?.Longitude ?? loc?.longitude);
  if (!loc || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** A coordinate pair as the panel prints it. */
export function formatCoords(lat: number, lon: number): string {
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}
