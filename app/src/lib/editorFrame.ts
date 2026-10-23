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
 * The Frame tool, as the Android editor lays it out: the photo on a canvas of a chosen
 * shape, behind an even border (or a Polaroid card's deeper bottom), on a colour or on a
 * soft blur of the photo itself. Everything is a fraction of the photo, so one frame lays
 * out the preview and the full-size save alike.
 */

/** The canvas shapes, tall ones then wide ones; Original follows the photo. */
export const FRAME_RATIOS = {
  original: null,
  "1:1": 1,
  "4:5": 4 / 5,
  "3:4": 3 / 4,
  "2:3": 2 / 3,
  "9:16": 9 / 16,
  "4:3": 4 / 3,
  "3:2": 3 / 2,
  "16:9": 16 / 9,
} as const;

export type FrameRatio = keyof typeof FRAME_RATIOS;

export type FrameFill = { kind: "solid"; color: string } | { kind: "blur" };

/**
 * A frame: its canvas shape, what fills it, the photo's size in the room (`scale`, 1 fills
 * it, down to 0.3) and place (`offsetX`/`offsetY`, -1 to 1 across the room left), and the
 * border beside and above the photo (`margin`) and below it (`bottomMargin`), both as
 * fractions of the photo's shorter side.
 */
export type FrameSpec = {
  ratio: FrameRatio;
  fill: FrameFill;
  scale: number;
  offsetX: number;
  offsetY: number;
  margin: number;
  bottomMargin: number;
};

/** The shapes in chip order: none, each ratio, then the Polaroid card. */
export const FRAME_SHAPES = ["off", "original", "1:1", "4:5", "3:4", "2:3", "9:16", "4:3", "3:2", "16:9", "polaroid"] as const;
export type FrameShape = (typeof FRAME_SHAPES)[number];

export const FRAME_WHITE = "#ffffff";
export const FRAME_BLACK = "#000000";
/** The longest side a framed photo may take; a larger one scales down whole. */
export const FRAME_MAX_LONG_SIDE = 4096;
export const FRAME_MIN_SCALE = 0.3;
export const FRAME_BORDER_MARGIN = 0.05;
export const FRAME_POLAROID_MARGIN = 0.06;
export const FRAME_POLAROID_BOTTOM_FACTOR = 3.5;
/** The widest border the slider sets, and the narrowest a Polaroid keeps. */
export const FRAME_MAX_BORDER = 0.3;
export const FRAME_MIN_CARD_BORDER = 0.01;
const FRAME_MAX_MARGIN = 1;
/** A blurred fill: cells of its small copy along the canvas's long side, its largest side, its blur. */
export const FRAME_BLUR_CELLS = 64;
export const FRAME_BLUR_MAX_SIDE = 512;
export const FRAME_BLUR_RADIUS = 2;
export const FRAME_BLUR_PASSES = 3;
/** The black laid over a blurred fill, about 28 %, so the sharp photo stands out on it. */
export const FRAME_BLUR_SCRIM = "rgba(0, 0, 0, 0.278)";
/** How near the middle, in screen pixels, a dragged photo's centre comes before it snaps there. */
export const FRAME_SNAP_PX = 12;
const FRAME_MIN_ROOM_PX = 0.5;

function inRange(v: number, fallback: number, low: number, high: number): number {
  return Number.isNaN(v) ? fallback : Math.min(high, Math.max(low, v));
}

function clamped(s: FrameSpec): FrameSpec {
  return {
    ...s,
    scale: inRange(s.scale, 1, FRAME_MIN_SCALE, 1),
    offsetX: inRange(s.offsetX, 0, -1, 1),
    offsetY: inRange(s.offsetY, 0, -1, 1),
    margin: inRange(s.margin, 0, 0, FRAME_MAX_MARGIN),
    bottomMargin: inRange(s.bottomMargin, 0, 0, FRAME_MAX_MARGIN),
  };
}

/** The frame a shape opens with, the photo at full size in the middle; null for none. */
export function frameForShape(shape: FrameShape, fill: FrameFill = { kind: "solid", color: FRAME_WHITE }): FrameSpec | null {
  if (shape === "off") return null;
  const base = { fill, scale: 1, offsetX: 0, offsetY: 0 };
  if (shape === "polaroid") {
    return {
      ...base,
      ratio: "original",
      margin: FRAME_POLAROID_MARGIN,
      bottomMargin: FRAME_POLAROID_MARGIN * FRAME_POLAROID_BOTTOM_FACTOR,
    };
  }
  return { ...base, ratio: shape, margin: FRAME_BORDER_MARGIN, bottomMargin: FRAME_BORDER_MARGIN };
}

/** The shape chip a frame shows as, read from the frame so it follows an undo. */
export function shapeOf(spec: FrameSpec | null): FrameShape {
  if (!spec) return "off";
  const s = clamped(spec);
  if (s.bottomMargin > s.margin) return "polaroid";
  return s.ratio;
}

/** The borders the slider can set on a frame. */
export function borderRange(spec: FrameSpec): [number, number] {
  const s = clamped(spec);
  return s.bottomMargin > s.margin ? [FRAME_MIN_CARD_BORDER, FRAME_MAX_MARGIN / FRAME_POLAROID_BOTTOM_FACTOR] : [0, FRAME_MAX_BORDER];
}

/** A frame with its border set, a Polaroid keeping its deeper bottom in proportion. */
export function withBorder(spec: FrameSpec, border: number): FrameSpec {
  const [lo, hi] = borderRange(spec);
  const side = Math.min(hi, Math.max(lo, Number.isNaN(border) ? lo : border));
  const s = clamped(spec);
  const card = s.bottomMargin > s.margin;
  return { ...spec, margin: side, bottomMargin: card ? side * FRAME_POLAROID_BOTTOM_FACTOR : side };
}

type Room = {
  canvasW: number;
  canvasH: number;
  left: number;
  top: number;
  width: number;
  height: number;
  fitW: number;
  fitH: number;
};

function frameRoom(photoW: number, photoH: number, s: FrameSpec, maxLongSide: number): Room {
  const w = Math.max(1, photoW);
  const h = Math.max(1, photoH);
  const side = s.margin * Math.min(w, h);
  const below = s.bottomMargin * Math.min(w, h);
  const cardW = w + 2 * side;
  const cardH = h + side + below;
  const ratio = FRAME_RATIOS[s.ratio] ?? cardW / cardH;
  const fullW = Math.max(cardW, cardH * ratio);
  const fullH = Math.max(cardH, cardW / ratio);
  const cap = Math.max(1, maxLongSide);
  const k = Math.min(1, cap / Math.max(fullW, fullH));
  const canvasW = Math.min(cap, Math.max(1, Math.round(fullW * k)));
  const canvasH = Math.min(cap, Math.max(1, Math.round(fullH * k)));
  // Rounding down can leave the canvas a sliver short of the photo; only then does it shrink.
  const fit = Math.min(1, Math.min(canvasW / (w * k), canvasH / (h * k)));
  return {
    canvasW,
    canvasH,
    left: side * k,
    top: side * k,
    width: canvasW - 2 * side * k,
    height: canvasH - (side + below) * k,
    fitW: w * k * fit,
    fitH: h * k * fit,
  };
}

function placeAlong(start: number, room: number, size: number, offset: number, canvas: number): number {
  const free = room - size;
  const at = start + (free / 2) * (1 + (free > 0 ? offset : 0));
  return Math.min(Math.max(0, canvas - size), Math.max(0, at));
}

/** A frame laid out: its canvas and the box on it the whole photo is drawn into. */
export type FrameLayout = { width: number; height: number; photo: { left: number; top: number; right: number; bottom: number } };

/** The canvas a frame needs around a `photoW` x `photoH` photo, and where on it the photo goes. */
export function frameCanvas(photoW: number, photoH: number, spec: FrameSpec, maxLongSide = FRAME_MAX_LONG_SIDE): FrameLayout {
  const s = clamped(spec);
  const room = frameRoom(photoW, photoH, s, maxLongSide);
  const w = room.fitW * s.scale;
  const h = room.fitH * s.scale;
  const left = placeAlong(room.left, room.width, w, s.offsetX, room.canvasW);
  const top = placeAlong(room.top, room.height, h, s.offsetY, room.canvasH);
  return {
    width: room.canvasW,
    height: room.canvasH,
    photo: { left, top, right: Math.min(left + w, room.canvasW), bottom: Math.min(top + h, room.canvasH) },
  };
}

function offsetAfterPan(offset: number, pan: number, room: number): number {
  if (room < FRAME_MIN_ROOM_PX) return 0;
  return Math.min(1, Math.max(-1, offset + (2 * (Number.isFinite(pan) ? pan : 0)) / room));
}

/**
 * A frame after a zoom by `zoom` and a drag of (`panX`, `panY`) canvas pixels, both measured
 * from where the gesture began: the zoom held to 0.3..1, the drag turned into an offset
 * through the room left at the new size and stopped at the edges.
 */
export function afterGesture(spec: FrameSpec, zoom: number, panX: number, panY: number, photoW: number, photoH: number): FrameSpec {
  const start = clamped(spec);
  const scale = Math.min(1, Math.max(FRAME_MIN_SCALE, start.scale * (Number.isFinite(zoom) ? zoom : 1)));
  const room = frameRoom(photoW, photoH, start, FRAME_MAX_LONG_SIDE);
  return {
    ...start,
    scale,
    offsetX: offsetAfterPan(start.offsetX, panX, room.width - room.fitW * scale),
    offsetY: offsetAfterPan(start.offsetY, panY, room.height - room.fitH * scale),
  };
}

/**
 * The frame with the photo pulled onto the middle on each axis where its centre comes within
 * `reach` canvas pixels of it, and on which axes that happened.
 */
export function snappedToCentre(
  spec: FrameSpec,
  photoW: number,
  photoH: number,
  reach: number,
): { spec: FrameSpec; x: boolean; y: boolean } {
  const s = clamped(spec);
  const room = frameRoom(photoW, photoH, s, FRAME_MAX_LONG_SIDE);
  const near = (offset: number, r: number) => r >= FRAME_MIN_ROOM_PX && (Math.abs(offset) * r) / 2 <= reach;
  const x = near(s.offsetX, room.width - room.fitW * s.scale);
  const y = near(s.offsetY, room.height - room.fitH * s.scale);
  return { spec: { ...spec, offsetX: x ? 0 : spec.offsetX, offsetY: y ? 0 : spec.offsetY }, x, y };
}

/**
 * The size of the small copy a blurred fill is made from: 64 of its pixels along the
 * canvas's long side once the picture covers the canvas, so the preview and the save blur
 * the same share of the frame.
 */
export function frameBlurSize(pictureW: number, pictureH: number, canvasW: number, canvasH: number): [number, number] {
  const pw = Math.max(1, pictureW);
  const ph = Math.max(1, pictureH);
  const cw = Math.max(1, canvasW);
  const ch = Math.max(1, canvasH);
  const k = (FRAME_BLUR_CELLS * Math.max(cw / pw, ch / ph)) / Math.max(cw, ch);
  const w = pw * k;
  const h = ph * k;
  const fit = Math.min(1, FRAME_BLUR_MAX_SIDE / Math.max(w, h));
  const clampSide = (v: number) => Math.min(FRAME_BLUR_MAX_SIDE, Math.max(1, Math.round(v)));
  return [clampSide(w * fit), clampSide(h * fit)];
}

/**
 * RGBA bytes after `passes` box blurs of `radius`, across then down, each channel on its
 * own; a pixel past an edge reads as the edge, so the border keeps its colour.
 */
export function soften(data: Uint8ClampedArray, w: number, h: number, radius: number, passes: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data);
  if (w <= 0 || h <= 0 || radius <= 0 || passes <= 0) return out;
  const tmp = new Uint8ClampedArray(out.length);
  const span = 2 * radius + 1;
  const blur = (src: Uint8ClampedArray, dst: Uint8ClampedArray, lines: number, length: number, lineStep: number, step: number) => {
    const last = length - 1;
    for (let line = 0; line < lines; line++) {
      const base = line * lineStep;
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let i = -radius; i <= radius; i++) sum += src[(base + Math.min(last, Math.max(0, i)) * step) * 4 + c];
        for (let i = 0; i <= last; i++) {
          dst[(base + i * step) * 4 + c] = Math.floor((sum + (span >> 1)) / span);
          const leaving = src[(base + Math.min(last, Math.max(0, i - radius)) * step) * 4 + c];
          const entering = src[(base + Math.min(last, Math.max(0, i + radius + 1)) * step) * 4 + c];
          sum += entering - leaving;
        }
      }
    }
  };
  for (let p = 0; p < passes; p++) {
    blur(out, tmp, h, w, w, 1);
    blur(tmp, out, w, h, 1, w);
  }
  return out;
}

/** The fill swatches in order: the photo's blur, then white, black and the pen colours. */
export function frameFills(palette: string[]): FrameFill[] {
  const colours = [FRAME_WHITE, FRAME_BLACK, ...palette.filter((c) => c !== FRAME_WHITE && c !== FRAME_BLACK)];
  return [{ kind: "blur" }, ...[...new Set(colours)].map((color) => ({ kind: "solid" as const, color }))];
}
