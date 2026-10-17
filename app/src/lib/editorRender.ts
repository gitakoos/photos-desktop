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
 * The editor's render pipeline, and the one authority on the order the operations run in.
 * It mirrors the Android app's `applyAdjustments`: rotate and flip first, then crop, then
 * the colour matrix, and the redaction strokes drawn last, on top of everything.
 *
 * Two entry points share that order so a preview and the saved file can never diverge:
 * `renderPreview` works on a downscaled copy for interactive speed (the way Android drives
 * its sliders off a 720px preview), and `encodeFull` runs the exact same steps at full
 * resolution and returns the bytes to save.
 *
 * The geometry-changing state (rotation, flip, crop) is separated from the pixel-changing
 * state (colour, redaction) so a caller can rebuild the small geometry base once when a
 * crop or a turn happens and then re-apply colour on every slider tick cheaply.
 */

import { applyMatrix, buildColorMatrix, type Adjustments } from "./editorColor";
import { type CropBox, boxHeight, boxWidth } from "./editorCrop";

export type Rotation = 0 | 90 | 180 | 270;
export type RedactMode = "black" | "pixelate";

/**
 * One redaction stroke. Points and brush are stored as fractions of the post-geometry
 * image (0..1), not pixels, so the same stroke lands in the same place whether it is drawn
 * on the downscaled preview or the full-resolution save.
 */
export type RedactStroke = {
  mode: RedactMode;
  /** The path, each point a fraction of the post-geometry width/height. */
  points: { x: number; y: number }[];
  /** Brush diameter as a fraction of the post-geometry longest edge. */
  brush: number;
};

/** Everything an edit is, held as parameters so the undo history is cheap to snapshot. */
export type EditState = {
  adjustments: Adjustments;
  rotation: Rotation;
  flipH: boolean;
  flipV: boolean;
  /** In post-rotate full-resolution pixel space, or null for the whole image. */
  crop: CropBox | null;
  redact: RedactStroke[];
};

/** Android's pixelate block, in source pixels: a 24x24 area of the image per mosaic cell. */
const PIXELATE_SOURCE_BLOCK = 24;

/** The size a source of `w` x `h` becomes after a rotation, axes swapped on a quarter turn. */
export function rotatedSize(w: number, h: number, rotation: Rotation): { w: number; h: number } {
  return rotation === 90 || rotation === 270 ? { w: h, h: w } : { w, h };
}

/** The full-resolution post-geometry size: the rotated size, then the crop if there is one. */
export function outputSize(
  srcW: number,
  srcH: number,
  rotation: Rotation,
  crop: CropBox | null,
): { w: number; h: number } {
  if (crop) return { w: boxWidth(crop), h: boxHeight(crop) };
  return rotatedSize(srcW, srcH, rotation);
}

type Drawable = HTMLImageElement | HTMLCanvasElement | ImageBitmap;

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) throw new Error("no 2d context");
  return g;
}

/**
 * Rotate and flip `source` into an upright canvas, then take the crop if one is set, and
 * downscale the result so its longest edge is at most `maxEdge` (Infinity for the full
 * save). Returns the canvas plus the full-resolution post-geometry size, which is what the
 * crop and the strokes are measured against.
 */
export function applyGeometry(
  source: Drawable,
  srcW: number,
  srcH: number,
  state: EditState,
  maxEdge: number,
): { canvas: HTMLCanvasElement; fullW: number; fullH: number } {
  // 1. Rotate + flip into a canvas sized to the rotated image.
  const rot = rotatedSize(srcW, srcH, state.rotation);
  const turned = newCanvas(rot.w, rot.h);
  const tg = ctx2d(turned);
  tg.save();
  tg.translate(rot.w / 2, rot.h / 2);
  tg.rotate((state.rotation * Math.PI) / 180);
  tg.scale(state.flipH ? -1 : 1, state.flipV ? -1 : 1);
  tg.drawImage(source, -srcW / 2, -srcH / 2, srcW, srcH);
  tg.restore();

  // 2. Crop, in the rotated space, clamped to the rotated bounds.
  const full = outputSize(srcW, srcH, state.rotation, state.crop);
  let base = turned;
  if (state.crop) {
    const cx = Math.max(0, Math.min(state.crop.left, rot.w));
    const cy = Math.max(0, Math.min(state.crop.top, rot.h));
    const cw = Math.max(1, Math.min(boxWidth(state.crop), rot.w - cx));
    const ch = Math.max(1, Math.min(boxHeight(state.crop), rot.h - cy));
    const cropped = newCanvas(cw, ch);
    ctx2d(cropped).drawImage(turned, cx, cy, cw, ch, 0, 0, cw, ch);
    base = cropped;
  }

  // 3. Downscale for the preview; the save passes Infinity and keeps full resolution.
  const longest = Math.max(base.width, base.height);
  if (longest > maxEdge) {
    const scale = maxEdge / longest;
    const small = newCanvas(base.width * scale, base.height * scale);
    const sg = ctx2d(small);
    sg.imageSmoothingQuality = "high";
    sg.drawImage(base, 0, 0, small.width, small.height);
    base = small;
  }

  return { canvas: base, fullW: full.w, fullH: full.h };
}

/**
 * Apply the colour matrix and then the redaction strokes onto `canvas`, in place. The
 * order is fixed: colour first, redaction last, so a black-out covers the adjusted pixels
 * and a pixelate mosaic is built from what is actually on screen.
 */
export function applyPixels(canvas: HTMLCanvasElement, adjustments: Adjustments, redact: RedactStroke[]): void {
  const g = ctx2d(canvas);
  const matrix = buildColorMatrix(adjustments);
  if (matrix) {
    const img = g.getImageData(0, 0, canvas.width, canvas.height);
    applyMatrix(img.data, matrix);
    g.putImageData(img, 0, 0);
  }
  if (redact.length > 0) drawRedact(canvas, g, redact);
}

function drawRedact(canvas: HTMLCanvasElement, g: CanvasRenderingContext2D, strokes: RedactStroke[]): void {
  const w = canvas.width;
  const h = canvas.height;
  const longest = Math.max(w, h);

  // One mosaic of the whole canvas, reused by every pixelate stroke and clipped to each.
  // Built lazily so a redaction of only black-out strokes never pays for it.
  let mosaic: HTMLCanvasElement | null = null;
  const buildMosaic = (): HTMLCanvasElement => {
    if (mosaic) return mosaic;
    // The block scales with the canvas so a downscaled preview mosaics as coarsely as the
    // full-resolution save does, relative to the picture.
    const fullLongest = longest; // strokes are relative, so the canvas is the reference here
    const block = Math.max(1, Math.round((PIXELATE_SOURCE_BLOCK * longest) / fullLongest));
    const smallW = Math.max(1, Math.round(w / block));
    const smallH = Math.max(1, Math.round(h / block));
    const small = newCanvas(smallW, smallH);
    ctx2d(small).drawImage(canvas, 0, 0, smallW, smallH);
    const up = newCanvas(w, h);
    const ug = ctx2d(up);
    ug.imageSmoothingEnabled = false;
    ug.drawImage(small, 0, 0, smallW, smallH, 0, 0, w, h);
    mosaic = up;
    return up;
  };

  for (const stroke of strokes) {
    if (stroke.points.length === 0) continue;
    const brushPx = Math.max(1, stroke.brush * longest);
    g.save();
    g.lineCap = "round";
    g.lineJoin = "round";
    g.lineWidth = brushPx;
    const path = new Path2D();
    const p0 = stroke.points[0];
    path.moveTo(p0.x * w, p0.y * h);
    for (let i = 1; i < stroke.points.length; i++) {
      path.lineTo(stroke.points[i].x * w, stroke.points[i].y * h);
    }
    if (stroke.mode === "black") {
      if (stroke.points.length === 1) {
        // A single tap is a filled dot, matching the platform's single-point stroke.
        g.fillStyle = "#000";
        g.beginPath();
        g.arc(p0.x * w, p0.y * h, brushPx / 2, 0, Math.PI * 2);
        g.fill();
      } else {
        g.strokeStyle = "#000";
        g.stroke(path);
      }
    } else {
      // Pixelate: show the mosaic only through the stroke, by clipping to the stroked path.
      const region = strokeToRegion(stroke, w, h, brushPx);
      g.clip(region);
      g.drawImage(buildMosaic(), 0, 0);
    }
    g.restore();
  }
}

/**
 * The area a stroke covers, as a fillable region: the round-capped band along its path,
 * approximated by a disc at each point. Used to mask the pixelate mosaic to the stroke.
 */
function strokeToRegion(stroke: RedactStroke, w: number, h: number, brushPx: number): Path2D {
  const region = new Path2D();
  const r = brushPx / 2;
  for (const p of stroke.points) {
    region.moveTo(p.x * w + r, p.y * h);
    region.arc(p.x * w, p.y * h, r, 0, Math.PI * 2);
  }
  return region;
}

/** Render a preview at `maxEdge` longest edge: the full pipeline on a downscaled copy. */
export function renderPreview(
  source: Drawable,
  srcW: number,
  srcH: number,
  state: EditState,
  maxEdge: number,
): HTMLCanvasElement {
  const { canvas } = applyGeometry(source, srcW, srcH, state, maxEdge);
  applyPixels(canvas, state.adjustments, state.redact);
  return canvas;
}

/**
 * The full-resolution pipeline, encoded to a JPEG at quality 0.92 (matching Android), as
 * base64 with no `data:` prefix, ready for `save_local_edit`.
 */
export async function encodeFull(
  source: Drawable,
  srcW: number,
  srcH: number,
  state: EditState,
): Promise<string> {
  const { canvas } = applyGeometry(source, srcW, srcH, state, Infinity);
  applyPixels(canvas, state.adjustments, state.redact);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.92),
  );
  if (!blob) throw new Error("encode failed");
  const buf = await blob.arrayBuffer();
  return base64FromBytes(new Uint8Array(buf));
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
