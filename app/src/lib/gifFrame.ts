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

// The GIF maker's framing, one rule for the preview and the frames it writes, so what is saved
// is what was shown: the video fitted into the frame at zoom 1 (black around it when the frame's
// shape differs), larger as it zooms, and moved within what spills over.

export type GifAspect = "original" | "square";

/** The sizes a GIF's longest edge can have. */
export const GIF_EDGES = [480, 720, 1080] as const;

/** The longest a GIF runs, and the shortest. */
export const GIF_MAX_SECONDS = 10;
export const GIF_MIN_SECONDS = 0.5;
export const GIF_FPS = 12;

/** The frame's width over its height. */
export function gifRatio(videoW: number, videoH: number, aspect: GifAspect): number {
  if (aspect === "square" || !(videoW > 0 && videoH > 0)) return 1;
  return videoW / videoH;
}

/** The GIF's size in pixels for a longest edge, from the frame's ratio. */
export function gifSize(ratio: number, edge: number): { width: number; height: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return ratio >= 1 ? { width: even(edge), height: even(edge / ratio) } : { width: even(edge * ratio), height: even(edge) };
}

/**
 * Where the video is drawn in a frame of `width` by `height`: its top-left corner and size.
 * `zoom` is 1 and up; `panX` and `panY` run from -1 to 1 across what spills over each way.
 */
export function gifPlacement(
  videoW: number,
  videoH: number,
  width: number,
  height: number,
  zoom: number,
  panX: number,
  panY: number,
): { x: number; y: number; w: number; h: number } {
  const fit = Math.min(width / videoW, height / videoH);
  const scale = fit * Math.max(1, zoom);
  const w = videoW * scale;
  const h = videoH * scale;
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  const spillX = Math.max(0, w - width);
  const spillY = Math.max(0, h - height);
  return {
    x: (width - w) / 2 + (clamp(panX) * spillX) / 2,
    y: (height - h) / 2 + (clamp(panY) * spillY) / 2,
    w,
    h,
  };
}

/** The window of the video the GIF takes: kept inside the video and within the longest a GIF runs. */
export function gifWindow(start: number, end: number, duration: number): { start: number; end: number } {
  const total = Math.max(0, duration);
  let s = Math.max(0, Math.min(start, total));
  let e = Math.max(s, Math.min(end, total));
  if (e - s > GIF_MAX_SECONDS) e = s + GIF_MAX_SECONDS;
  if (e - s < GIF_MIN_SECONDS) {
    e = Math.min(total, s + GIF_MIN_SECONDS);
    s = Math.max(0, e - GIF_MIN_SECONDS);
  }
  return { start: s, end: e };
}

/** The moments the frames are taken at, from the window's start, 12 a second. */
export function gifTimes(start: number, end: number): number[] {
  const count = Math.max(2, Math.floor((end - start) * GIF_FPS));
  return Array.from({ length: Math.min(count, GIF_MAX_SECONDS * GIF_FPS) }, (_, i) => start + i / GIF_FPS);
}
