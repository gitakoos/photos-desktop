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

/**
 * The crop overlay's resize math, ported one for one from the Android app's
 * `CropGeometry.kt` so a chosen aspect stays chosen the same way. Everything is in
 * bitmap-pixel space and integer, and the port keeps the exact rounding of the original
 * (`toInt` truncates towards zero, `roundToInt` is round-half-up) because the crop tests
 * pin those choices.
 */

/** A crop rectangle in bitmap-pixel space. */
export type CropBox = { left: number; top: number; right: number; bottom: number };

export function boxWidth(b: CropBox): number {
  return b.right - b.left;
}
export function boxHeight(b: CropBox): number {
  return b.bottom - b.top;
}

export type CropHandle =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "inside";

/**
 * The shapes the crop tool offers, in chip order. `null` ratio is unconstrained. Original
 * has no fixed number: it resolves to the photo's own ratio at runtime, which is why the
 * screen holds the chosen ENTRY, not a ratio (on a 4:3 photo, Original and 4:3 are the
 * same number and a ratio could not say which chip was tapped).
 */
export type CropAspect =
  | "free"
  | "original"
  | "1:1"
  | "4:3"
  | "3:4"
  | "16:9"
  | "9:16";

export const CROP_ASPECTS: CropAspect[] = [
  "free",
  "original",
  "1:1",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
];

const FIXED_RATIO: Record<CropAspect, number | null> = {
  free: null,
  original: null,
  "1:1": 1,
  "4:3": 4 / 3,
  "3:4": 3 / 4,
  "16:9": 16 / 9,
  "9:16": 9 / 16,
};

/** The width/height the tool should lock to for this chip, given the display size. */
export function lockRatio(aspect: CropAspect, dispW: number, dispH: number): number | null {
  if (aspect === "free") return null;
  if (aspect === "original") return dispW / dispH;
  return FIXED_RATIO[aspect];
}

/**
 * The same chip after a quarter turn of the image. Free and 1:1 are unchanged by
 * symmetry, and Original because its ratio is read from the already-turned bitmap.
 */
export function turned(aspect: CropAspect): CropAspect {
  switch (aspect) {
    case "4:3":
      return "3:4";
    case "3:4":
      return "4:3";
    case "16:9":
      return "9:16";
    case "9:16":
      return "16:9";
    default:
      return aspect;
  }
}

const trunc = Math.trunc;
const round = (n: number): number => Math.round(n); // round-half-up, matching Kotlin roundToInt
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function atLeast(v: number, lo: number): number {
  return v < lo ? lo : v;
}
function atMost(v: number, hi: number): number {
  return v > hi ? hi : v;
}

/** The largest `aspect`-shaped box centred inside a srcW x srcH image. */
export function centeredCrop(srcW: number, srcH: number, aspect: number): CropBox {
  const srcRatio = srcW / srcH;
  if (srcRatio > aspect) {
    const newW = atLeast(trunc(srcH * aspect), 1);
    const xOffset = trunc((srcW - newW) / 2);
    return { left: xOffset, top: 0, right: xOffset + newW, bottom: srcH };
  }
  const newH = atLeast(trunc(srcW / aspect), 1);
  const yOffset = trunc((srcH - newH) / 2);
  return { left: 0, top: yOffset, right: srcW, bottom: yOffset + newH };
}

/**
 * One resize decision for the crop overlay. `bx`/`by` is the finger in bitmap
 * coordinates (already clamped to the bitmap by the caller). A null ratio is free-form; a
 * non-null ratio (width/height) is locked, and when the result would leave the bitmap it
 * shrinks along both axes rather than clipping one, so the ratio survives the edge.
 */
export function resizeCrop(
  box: CropBox,
  handle: CropHandle,
  bx: number,
  by: number,
  ratio: number | null,
  boundsW: number,
  boundsH: number,
  minPx: number,
  insideOffsetX = 0,
  insideOffsetY = 0,
): CropBox {
  if (handle === "inside") {
    const w = boxWidth(box);
    const h = boxHeight(box);
    const newLeft = clamp(bx - insideOffsetX, 0, atLeast(boundsW - w, 0));
    const newTop = clamp(by - insideOffsetY, 0, atLeast(boundsH - h, 0));
    return { left: newLeft, top: newTop, right: newLeft + w, bottom: newTop + h };
  }
  if (ratio == null || ratio <= 0) return resizeFree(box, handle, bx, by, minPx);
  switch (handle) {
    case "top-left":
    case "top-right":
    case "bottom-left":
    case "bottom-right":
      return resizeLockedCorner(box, handle, bx, by, ratio, boundsW, boundsH, minPx);
    case "left":
    case "right":
      return resizeLockedHorizontal(box, handle, bx, ratio, boundsW, boundsH, minPx);
    case "top":
    case "bottom":
      return resizeLockedVertical(box, handle, by, ratio, boundsW, boundsH, minPx);
    default:
      return box;
  }
}

/** Free-form: the grabbed edge follows the finger, the opposite three stay put. */
function resizeFree(box: CropBox, handle: CropHandle, bx: number, by: number, minPx: number): CropBox {
  switch (handle) {
    case "top-left":
      return { left: atMost(bx, box.right - minPx), top: atMost(by, box.bottom - minPx), right: box.right, bottom: box.bottom };
    case "top-right":
      return { left: box.left, top: atMost(by, box.bottom - minPx), right: atLeast(bx, box.left + minPx), bottom: box.bottom };
    case "bottom-left":
      return { left: atMost(bx, box.right - minPx), top: box.top, right: box.right, bottom: atLeast(by, box.top + minPx) };
    case "bottom-right":
      return { left: box.left, top: box.top, right: atLeast(bx, box.left + minPx), bottom: atLeast(by, box.top + minPx) };
    case "top":
      return { left: box.left, top: atMost(by, box.bottom - minPx), right: box.right, bottom: box.bottom };
    case "bottom":
      return { left: box.left, top: box.top, right: box.right, bottom: atLeast(by, box.top + minPx) };
    case "left":
      return { left: atMost(bx, box.right - minPx), top: box.top, right: box.right, bottom: box.bottom };
    case "right":
      return { left: box.left, top: box.top, right: atLeast(bx, box.left + minPx), bottom: box.bottom };
    default:
      return box;
  }
}

/** Bounds win over the minimum: on an image smaller than minPx, return the largest fit. */
function clampSize(want: number, minSize: number, maxSize: number): number {
  return maxSize < minSize ? maxSize : clamp(want, minSize, maxSize);
}

function resizeLockedCorner(
  box: CropBox,
  handle: CropHandle,
  bx: number,
  by: number,
  ratio: number,
  boundsW: number,
  boundsH: number,
  minPx: number,
): CropBox {
  const growsLeft = handle === "top-left" || handle === "bottom-left";
  const growsUp = handle === "top-left" || handle === "top-right";
  const anchorX = growsLeft ? box.right : box.left;
  const anchorY = growsUp ? box.bottom : box.top;

  const availW = growsLeft ? anchorX : boundsW - anchorX;
  const availH = growsUp ? anchorY : boundsH - anchorY;

  // Measured from the anchor only in the growing direction, floored at 0, so a finger
  // dragged past the anchor collapses the box instead of mirroring it larger.
  const dx = atLeast(growsLeft ? anchorX - bx : bx - anchorX, 0);
  const dy = atLeast(growsUp ? anchorY - by : by - anchorY, 0);
  const want = Math.max(dx, dy * ratio);
  const w = clampSize(want, Math.max(minPx, minPx * ratio), Math.min(availW, availH * ratio));
  const wi = atLeast(round(w), 1);
  const hi = atLeast(round(w / ratio), 1);

  const left = growsLeft ? anchorX - wi : anchorX;
  const top = growsUp ? anchorY - hi : anchorY;
  return { left, top, right: left + wi, bottom: top + hi };
}

function resizeLockedHorizontal(
  box: CropBox,
  handle: CropHandle,
  bx: number,
  ratio: number,
  boundsW: number,
  boundsH: number,
  minPx: number,
): CropBox {
  const growsLeft = handle === "left";
  const anchorX = growsLeft ? box.right : box.left;
  const availW = growsLeft ? anchorX : boundsW - anchorX;

  const want = atLeast(growsLeft ? anchorX - bx : bx - anchorX, 0);
  const w = clampSize(want, Math.max(minPx, minPx * ratio), Math.min(availW, boundsH * ratio));
  const wi = atLeast(round(w), 1);
  const hi = atLeast(round(w / ratio), 1);

  const left = growsLeft ? anchorX - wi : anchorX;
  const centerY = trunc((box.top + box.bottom) / 2);
  const top = clamp(centerY - trunc(hi / 2), 0, atLeast(boundsH - hi, 0));
  return { left, top, right: left + wi, bottom: top + hi };
}

/**
 * Which handle a point in bitmap-pixel space has grabbed, or null for empty space. A
 * corner wins over an edge, and an edge over the inside, so the corners stay reachable
 * where they overlap the edges. `slop` is the grab radius, in the same pixel space.
 */
export function pickHandle(box: CropBox, px: number, py: number, slop: number): CropHandle | null {
  const nearLeft = Math.abs(px - box.left) <= slop;
  const nearRight = Math.abs(px - box.right) <= slop;
  const nearTop = Math.abs(py - box.top) <= slop;
  const nearBottom = Math.abs(py - box.bottom) <= slop;
  const withinX = px >= box.left - slop && px <= box.right + slop;
  const withinY = py >= box.top - slop && py <= box.bottom + slop;

  if (nearLeft && nearTop) return "top-left";
  if (nearRight && nearTop) return "top-right";
  if (nearLeft && nearBottom) return "bottom-left";
  if (nearRight && nearBottom) return "bottom-right";
  if (nearTop && withinX) return "top";
  if (nearBottom && withinX) return "bottom";
  if (nearLeft && withinY) return "left";
  if (nearRight && withinY) return "right";
  if (px > box.left && px < box.right && py > box.top && py < box.bottom) return "inside";
  return null;
}

/** The floor a crop edge is held to, in bitmap pixels, matching the Android tool. */
export const MIN_CROP_PX = 32;

function resizeLockedVertical(
  box: CropBox,
  handle: CropHandle,
  by: number,
  ratio: number,
  boundsW: number,
  boundsH: number,
  minPx: number,
): CropBox {
  const growsUp = handle === "top";
  const anchorY = growsUp ? box.bottom : box.top;
  const availH = growsUp ? anchorY : boundsH - anchorY;

  const want = atLeast(growsUp ? anchorY - by : by - anchorY, 0);
  const h = clampSize(want, Math.max(minPx, minPx / ratio), Math.min(availH, boundsW / ratio));
  const hi = atLeast(round(h), 1);
  const wi = atLeast(round(h * ratio), 1);

  const top = growsUp ? anchorY - hi : anchorY;
  const centerX = trunc((box.left + box.right) / 2);
  const left = clamp(centerX - trunc(wi / 2), 0, atLeast(boundsW - wi, 0));
  return { left, top, right: left + wi, bottom: top + hi };
}
