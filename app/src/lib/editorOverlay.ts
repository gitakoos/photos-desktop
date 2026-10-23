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
 * Pen strokes and texts, the marks drawn over the finished picture, as the Android editor
 * keeps them: every position and size is a fraction of the picture, so a mark drawn on
 * the preview lands in the same place, at the same size, on the full-resolution save.
 */

/** A freehand pen stroke: points in 0..1 of the picture, width as a fraction of its width. */
export type DrawStroke = {
  points: { x: number; y: number }[];
  color: string;
  width: number;
};

/**
 * A text: its centre in 0..1 of the picture, its font size as a fraction of the picture's
 * height, its turn in degrees about the centre, and the box behind it (a colour, how
 * opaque, 0 for none, and how round its corners are, 0 square to 1 fully round).
 */
export type TextItem = {
  id: number;
  text: string;
  cx: number;
  cy: number;
  color: string;
  size: number;
  rotation: number;
  background: string;
  backgroundOpacity: number;
  cornerRadius: number;
};

/** The pen's colour swatches, the Android editor's ten. */
export const DRAW_COLORS = [
  "#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#00c7be",
  "#007aff", "#5856d6", "#af52de", "#ffffff", "#000000",
];

/** A new text: white, centred, 8 % of the picture's height, no box. */
export function newText(id: number): TextItem {
  return {
    id,
    text: "",
    cx: 0.5,
    cy: 0.5,
    color: "#ffffff",
    size: 0.08,
    rotation: 0,
    background: "#000000",
    backgroundOpacity: 0,
    cornerRadius: 0.3,
  };
}

/** Room between a text and the edge of its box, sideways and up and down, in font sizes. */
export const TEXT_BACKDROP_PAD_X = 0.4;
export const TEXT_BACKDROP_PAD_Y = 0.12;
/** Lines of a text sit this many font sizes apart. */
export const TEXT_LINE_HEIGHT = 1.2;

/**
 * The angle a text is drawn at: its own, pulled to the nearest 45 degrees when within 5,
 * a magnet at level, diagonal and upright. Only the drawing snaps, so a turn that keeps
 * going passes through a detent.
 */
export function snapTextAngle(deg: number): number {
  const norm = ((deg % 360) + 360) % 360;
  const nearest = Math.round(norm / 45) * 45;
  return Math.abs(norm - nearest) <= 5 ? nearest % 360 : norm;
}

/** Half the width and height of a text's box, from its centre, and the box's corner radius. */
export function textBackdrop(
  fontPx: number,
  widestLinePx: number,
  lineCount: number,
  cornerRadius: number,
): { halfWidth: number; halfHeight: number; radius: number } {
  const lines = Math.max(1, lineCount);
  const halfWidth = Math.max(0, widestLinePx) / 2 + fontPx * TEXT_BACKDROP_PAD_X;
  const halfHeight = (fontPx * TEXT_LINE_HEIGHT * lines) / 2 + fontPx * TEXT_BACKDROP_PAD_Y;
  const corner = Number.isNaN(cornerRadius) ? 0 : Math.min(1, Math.max(0, cornerRadius));
  return { halfWidth, halfHeight, radius: Math.min(halfWidth, halfHeight) * corner };
}

/** The font a text is drawn in: bold, in the app's own face. */
export function textFont(px: number): string {
  return `700 ${px}px Inter, "Segoe UI", system-ui, sans-serif`;
}

/** A text's font size in pixels on a picture `h` pixels tall, never below 8. */
export function textPx(item: TextItem, h: number): number {
  return Math.max(8, item.size * h);
}

/**
 * The box a text fills on a `w` x `h` picture, before its turn: its centre, its half
 * width and half height, measured with `g`. The box behind the text when it has one,
 * and the area that selects it either way.
 */
export function textBox(
  g: CanvasRenderingContext2D,
  item: TextItem,
  w: number,
  h: number,
): { cx: number; cy: number; halfWidth: number; halfHeight: number; radius: number; px: number; lines: string[] } {
  const px = textPx(item, h);
  g.font = textFont(px);
  const lines = item.text.split("\n");
  const widest = Math.max(...lines.map((l) => g.measureText(l).width));
  const box = textBackdrop(px, widest, lines.length, item.cornerRadius);
  return { cx: item.cx * w, cy: item.cy * h, ...box, px, lines };
}

/** Whether the point (x, y) of the picture falls in a text's turned box. */
export function inTurnedBox(
  x: number,
  y: number,
  box: { cx: number; cy: number; halfWidth: number; halfHeight: number },
  degrees: number,
): boolean {
  const a = (-degrees * Math.PI) / 180;
  const dx = x - box.cx;
  const dy = y - box.cy;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(lx) <= box.halfWidth && Math.abs(ly) <= box.halfHeight;
}

function hexAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.min(1, Math.max(0, alpha))})`;
}

/**
 * The pen strokes and then the texts, onto a `w` x `h` picture in `g`, the way the save
 * bakes them. `skipText` leaves out the text being typed, which its own field shows.
 */
export function drawOverlays(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  strokes: DrawStroke[],
  texts: TextItem[],
  skipText?: number | null,
): void {
  for (const s of strokes) {
    if (s.points.length === 0) continue;
    const lw = Math.max(1, s.width * w);
    g.save();
    g.strokeStyle = s.color;
    g.fillStyle = s.color;
    g.lineWidth = lw;
    g.lineCap = "round";
    g.lineJoin = "round";
    const p0 = s.points[0];
    if (s.points.length === 1) {
      g.beginPath();
      g.arc(p0.x * w, p0.y * h, lw / 2, 0, Math.PI * 2);
      g.fill();
    } else {
      g.beginPath();
      g.moveTo(p0.x * w, p0.y * h);
      for (let i = 1; i < s.points.length; i++) g.lineTo(s.points[i].x * w, s.points[i].y * h);
      g.stroke();
    }
    g.restore();
  }
  for (const item of texts) {
    if (item.id === skipText || item.text.trim() === "") continue;
    g.save();
    const box = textBox(g, item, w, h);
    const angle = snapTextAngle(item.rotation);
    g.translate(box.cx, box.cy);
    if (angle !== 0) g.rotate((angle * Math.PI) / 180);
    if (item.backgroundOpacity > 0.001) {
      g.fillStyle = hexAlpha(item.background, item.backgroundOpacity);
      g.beginPath();
      g.roundRect(-box.halfWidth, -box.halfHeight, box.halfWidth * 2, box.halfHeight * 2, box.radius);
      g.fill();
    }
    g.font = textFont(box.px);
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    g.fillStyle = item.color;
    // A soft shadow keeps light text legible over a bright photo.
    g.shadowColor = "rgba(0, 0, 0, 0.55)";
    g.shadowBlur = box.px * 0.08;
    g.shadowOffsetY = box.px * 0.04;
    const lineH = box.px * TEXT_LINE_HEIGHT;
    let baseline = -(lineH * box.lines.length) / 2 + box.px;
    for (const line of box.lines) {
      g.fillText(line, 0, baseline);
      baseline += lineH;
    }
    g.restore();
  }
}

/** A colour as `#rrggbb` from hue (0..360), saturation and value (0..1 each). */
export function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  const to = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0");
  return `#${to(f(5))}${to(f(3))}${to(f(1))}`;
}

/** The hue (0..360), saturation and value (0..1) of a `#rrggbb` colour; a grey has hue 0. */
export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}
