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

// Where each run of text read off a photo is drawn over it.

export type TextPoint = { x: number; y: number };
export type TextReadBlock = { text: string; confidence: number; quad: [TextPoint, TextPoint, TextPoint, TextPoint] };
/** A read in the pixels of the picture it was made from, which is the photo shown, upright. */
export type TextRead = { width: number; height: number; blocks: TextReadBlock[] };

export type RunLayout = {
  left: number;
  top: number;
  height: number;
  fontSize: number;
  /** The run's angle, about its top-left corner. */
  angle: number;
  /** How far the letters are stretched along the run so they end where it does. */
  stretch: number;
};

/** The share of a run's height its letters take. */
const FONT_SHARE = 0.82;

let canvas: CanvasRenderingContext2D | null = null;
/** How wide `text` is at a 100 px font, as the layer's font draws it. */
function measure100(text: string): number {
  canvas ??= document.createElement("canvas").getContext("2d");
  if (!canvas) return text.length * 55;
  canvas.font = "100px Arial, sans-serif";
  return canvas.measureText(text).width;
}

/**
 * The box a run is drawn in on the layer: its quad scaled by `scale` (layer pixels per picture
 * pixel) and moved to where the picture is drawn, at the run's own angle, the font sized to the
 * run's height and stretched along it to its length.
 */
export function textRunLayout(
  block: TextReadBlock,
  scale: number,
  offsetX: number,
  offsetY: number,
  measure: (text: string) => number = measure100,
): RunLayout {
  const [tl, tr, , bl] = block.quad;
  const length = Math.hypot(tr.x - tl.x, tr.y - tl.y) * scale;
  const height = Math.max(Math.hypot(bl.x - tl.x, bl.y - tl.y) * scale, 1);
  const fontSize = height * FONT_SHARE;
  const natural = (measure(block.text) * fontSize) / 100;
  return {
    left: offsetX + tl.x * scale,
    top: offsetY + tl.y * scale,
    height,
    fontSize,
    angle: Math.atan2(tr.y - tl.y, tr.x - tl.x),
    stretch: natural > 0 ? length / natural : 1,
  };
}

/** Where a picture `naturalW` by `naturalH` is drawn when fitted inside a `boxW` by `boxH` box, centred. */
export function fittedRect(boxW: number, boxH: number, naturalW: number, naturalH: number) {
  if (boxW <= 0 || boxH <= 0 || naturalW <= 0 || naturalH <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const s = Math.min(boxW / naturalW, boxH / naturalH);
  const w = naturalW * s;
  const h = naturalH * s;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}
