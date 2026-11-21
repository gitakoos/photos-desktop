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

/** The pauses between slides the bar offers, in seconds. */
export const SLIDE_SECONDS = [3, 5, 10] as const;
export const DEFAULT_SLIDE_SECONDS = 5;

/** The longest a video slide plays before the show moves on. */
export const VIDEO_SLIDE_CAP_MS = 60_000;

/** How long the bar and the pointer stay once the mouse is still. */
export const SLIDE_IDLE_MS = 2000;

const STORAGE_KEY = "slideshow.seconds";

/** Whether `n` is one of the pauses on offer. */
export function isSlideSeconds(n: unknown): n is (typeof SLIDE_SECONDS)[number] {
  return SLIDE_SECONDS.some((s) => s === n);
}

/** The pause last chosen, or the default when none was or storage is unavailable. */
export function readSlideSeconds(): number {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    return isSlideSeconds(stored) ? stored : DEFAULT_SLIDE_SECONDS;
  } catch {
    return DEFAULT_SLIDE_SECONDS;
  }
}

export function writeSlideSeconds(seconds: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(seconds));
  } catch {
    /* the choice lasts this session only */
  }
}

/** The slide `step` away from `index`, wrapping round the list so the show loops. */
export function stepSlide(index: number, count: number, step: number): number {
  if (count <= 0) return 0;
  return (((index + step) % count) + count) % count;
}

/** The slides worth loading ahead of `index`: the next one, and the one after it. */
export function slidesAhead(index: number, count: number): number[] {
  if (count <= 1) return [];
  const out = [stepSlide(index, count, 1)];
  if (count > 2) out.push(stepSlide(index, count, 2));
  return out;
}

/** How far through its time a slide is, from 0 to 1. */
export function slideProgress(elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return 1;
  return Math.min(1, Math.max(0, elapsedMs / durationMs));
}

/** How long a slide stays: the chosen pause for a photo, the cap for a video that plays. */
export function slideDurationMs(seconds: number, playingVideo: boolean): number {
  return playingVideo ? VIDEO_SLIDE_CAP_MS : seconds * 1000;
}
