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

import { TAG } from "./tags";

/** What kind of clip a photo carries, from its tags: Apple's or Android's. */
export type MotionKind = "live" | "motion";

export function motionKindOf(tags: number[] | null | undefined): MotionKind | null {
  if (!tags) return null;
  if (tags.includes(TAG.LivePhoto)) return "live";
  if (tags.includes(TAG.MotionPhoto)) return "motion";
  return null;
}

/** A clip as the sidecar hands it over. */
export type ClipPayload = { base64: string; mime: string };

/** The clip's bytes as a Blob the video element can play. */
export function clipBlob(clip: ClipPayload): Blob {
  const bin = atob(clip.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: clip.mime || "video/mp4" });
}

const SOUND_KEY = "viewer.clipSound";

/** Whether the clip's sound was left on; off until the user turns it on. */
export function readClipSound(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === "on";
  } catch {
    return false;
  }
}

export function writeClipSound(on: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, on ? "on" : "off");
  } catch {
    /* the choice lasts this session only */
  }
}

/** How long a press has to be held on the picture before it plays the clip. */
export const HOLD_PLAY_MS = 220;

/** How far the pointer may drift during that press before it counts as a drag. */
export const HOLD_SLOP_PX = 5;

/** Whether a press that moved `dx`, `dy` is still a hold rather than the start of a pan. */
export function isHold(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) <= HOLD_SLOP_PX;
}
