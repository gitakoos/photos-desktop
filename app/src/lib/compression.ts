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

// The upload compression choices as the window keeps them; the sidecar's `compression.ts` reads
// the same values.

export type CompressionTier = "high" | "balanced" | "small";
export type VideoCodecChoice = "auto" | "avc" | "hevc" | "av1" | "keep";

/** Where a Compress on Drive run stands, as the sidecar answers `cloudCompressStatus`. */
export type CompressStatus = {
  running: boolean;
  total: number;
  done: number;
  compressed: number;
  kept: number;
  failed: number;
  savedBytes: number;
  /** How far the photo in hand is, 0 to 1. */
  current: number;
  errors: { uid: string; error: string }[];
  cancelled: boolean;
};
