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
 * the colour matrix, the per-pixel effects (curves and HSL among them) and the vignette,
 * then the redaction strokes and the face covers, then the frame, and the pen strokes and
 * texts drawn last, on its canvas, on top of everything.
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
import { geometryWarp, warpPixels } from "./editorWarp";
import { drawOverlays, type DrawStroke, type TextItem } from "./editorOverlay";
import { applyCurvesHsl, colorIsNeutral, type ColorEdit } from "./editorCurves";
import {
  FRAME_BLUR_PASSES,
  FRAME_BLUR_RADIUS,
  FRAME_BLUR_SCRIM,
  FRAME_MAX_LONG_SIDE,
  frameBlurSize,
  frameCanvas,
  soften,
  type FrameSpec,
} from "./editorFrame";
import {
  blurShrink,
  coverInRender,
  ovalExtent,
  pixelBlock,
  sourceToRender,
  type FaceCover,
  type FaceSettings,
} from "./editorFaces";
import { SHARPEN_SHRINK, hasPixelEffects, sharpenInto, vibranceAndGrain, vignetteStops } from "./editorEffects";
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
  /** Straighten and the two keystones, -100..100 each, applied after the turn and before the crop. */
  straighten: number;
  perspectiveV: number;
  perspectiveH: number;
  /** In post-rotate full-resolution pixel space, or null for the whole image. */
  crop: CropBox | null;
  redact: RedactStroke[];
  /** The faces hidden, kept in the original photo's pixels, drawn over the redaction. */
  faces: FaceSettings;
  /** The tone curves and the per-colour HSL, run after sharpening. */
  color: ColorEdit;
  /** A frame around the finished photo, or none; the pen and the text draw on its canvas. */
  frame: FrameSpec | null;
  /** Pen strokes and texts, drawn last, over everything. */
  draw: DrawStroke[];
  texts: TextItem[];
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

/** `state`'s straighten and keystone, or null when it has none. */
function hasWarp(state: Pick<EditState, "straighten" | "perspectiveV" | "perspectiveH">): boolean {
  return state.straighten !== 0 || state.perspectiveV !== 0 || state.perspectiveH !== 0;
}

/**
 * `canvas` straightened and keystoned in place of the frame it fills, as a new canvas of
 * the same size, or `canvas` itself when there is nothing to do.
 */
export function warpCanvas(
  canvas: HTMLCanvasElement,
  state: Pick<EditState, "straighten" | "perspectiveV" | "perspectiveH">,
): HTMLCanvasElement {
  if (!hasWarp(state)) return canvas;
  const w = canvas.width;
  const h = canvas.height;
  const m = geometryWarp(w, h, state.straighten, state.perspectiveV, state.perspectiveH);
  if (!m) return canvas;
  const data = ctx2d(canvas).getImageData(0, 0, w, h).data;
  const out = newCanvas(w, h);
  ctx2d(out).putImageData(new ImageData(warpPixels(data, w, h, m), w, h), 0, 0);
  return out;
}

/**
 * Rotate and flip `source` into an upright canvas, straighten and keystone it, then take
 * the crop if one is set, and downscale the result so its longest edge is at most
 * `maxEdge` (Infinity for the full save). Returns the canvas plus the full-resolution
 * post-geometry size, which is what the crop and the strokes are measured against.
 *
 * The warp runs per pixel, so a preview shrinks the turned picture first, to the scale
 * the crop will end up at, rather than warping every source pixel.
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

  const full = outputSize(srcW, srcH, state.rotation, state.crop);

  // 1b. Straighten + keystone, in the rotated frame and before the crop, so the crop is
  //     taken from the straightened picture. A preview warps a copy already at its scale.
  let k = 1;
  let base = turned;
  if (hasWarp(state)) {
    k = Math.min(1, maxEdge / Math.max(full.w, full.h));
    if (k < 1) base = shrinkTo(turned, k);
    base = warpCanvas(base, state);
  }

  // 2. Crop, in the rotated space (scaled by k), clamped to the rotated bounds.
  if (state.crop) {
    const bw = base.width;
    const bh = base.height;
    const cx = Math.max(0, Math.min(state.crop.left * k, bw));
    const cy = Math.max(0, Math.min(state.crop.top * k, bh));
    const cw = Math.max(1, Math.min(boxWidth(state.crop) * k, bw - cx));
    const ch = Math.max(1, Math.min(boxHeight(state.crop) * k, bh - cy));
    const cropped = newCanvas(cw, ch);
    ctx2d(cropped).drawImage(base, cx, cy, cw, ch, 0, 0, cropped.width, cropped.height);
    base = cropped;
  }

  // 3. Downscale for the preview; the save passes Infinity and keeps full resolution.
  const longest = Math.max(base.width, base.height);
  if (longest > maxEdge) base = shrinkTo(base, maxEdge / longest);

  return { canvas: base, fullW: full.w, fullH: full.h };
}

function shrinkTo(c: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  const small = newCanvas(c.width * scale, c.height * scale);
  const sg = ctx2d(small);
  sg.imageSmoothingQuality = "high";
  sg.drawImage(c, 0, 0, small.width, small.height);
  return small;
}

/**
 * Apply the colour matrix, the per-pixel effects, the vignette and then the redaction
 * strokes onto `canvas`, in place, in the Android editor's order: sharpen works on the
 * coloured picture, vibrance and grain follow it, the vignette shades the result, and the
 * redaction goes last so a black-out covers everything and a pixelate mosaic is built
 * from what is actually on screen.
 */
export function applyPixels(
  canvas: HTMLCanvasElement,
  adjustments: Adjustments,
  redact: RedactStroke[],
  faces?: { covers: FaceCover[]; style: FaceSettings["style"]; strength: number },
  color?: ColorEdit,
): void {
  const g = ctx2d(canvas);
  const matrix = buildColorMatrix(adjustments);
  const tones = !!color && !colorIsNeutral(color);
  const effects = hasPixelEffects(adjustments) || tones;
  if (matrix || effects) {
    const img = g.getImageData(0, 0, canvas.width, canvas.height);
    if (matrix) applyMatrix(img.data, matrix);
    if (adjustments.sharpen !== 0) {
      if (matrix) g.putImageData(img, 0, 0);
      sharpenInto(img.data, blurOf(canvas), adjustments.sharpen);
    }
    if (tones && color) applyCurvesHsl(img.data, color);
    vibranceAndGrain(img.data, adjustments.vibrance, adjustments.grain);
    g.putImageData(img, 0, 0);
  }
  if (adjustments.vignette !== 0) drawVignette(g, canvas.width, canvas.height, adjustments.vignette);
  if (redact.length > 0) drawRedact(canvas, g, redact);
  if (faces && faces.covers.length > 0) drawFaceCovers(canvas, g, faces.covers, faces.style, faces.strength);
}

/**
 * The photo on a frame's canvas: the fill, a colour or a soft blur of the photo itself
 * under a dark scrim, then the photo in its box. The canvas's long side is held to
 * `maxLongSide`, the photo scaling down with it.
 */
export function applyFrame(photo: HTMLCanvasElement, spec: FrameSpec, maxLongSide = FRAME_MAX_LONG_SIDE): HTMLCanvasElement {
  const layout = frameCanvas(photo.width, photo.height, spec, maxLongSide);
  const out = newCanvas(layout.width, layout.height);
  const g = ctx2d(out);
  if (spec.fill.kind === "solid") {
    g.fillStyle = spec.fill.color;
    g.fillRect(0, 0, out.width, out.height);
  } else {
    const [bw, bh] = frameBlurSize(photo.width, photo.height, out.width, out.height);
    const small = newCanvas(bw, bh);
    const sg = ctx2d(small);
    sg.imageSmoothingQuality = "high";
    sg.drawImage(photo, 0, 0, bw, bh);
    const soft = soften(sg.getImageData(0, 0, bw, bh).data, bw, bh, FRAME_BLUR_RADIUS, FRAME_BLUR_PASSES);
    sg.putImageData(new ImageData(soft, bw, bh), 0, 0);
    // The blur covers the whole canvas, centred, as the photo would if it filled it.
    const k = Math.max(out.width / bw, out.height / bh);
    g.imageSmoothingQuality = "high";
    g.drawImage(small, (out.width - bw * k) / 2, (out.height - bh * k) / 2, bw * k, bh * k);
    g.fillStyle = FRAME_BLUR_SCRIM;
    g.fillRect(0, 0, out.width, out.height);
  }
  const p = layout.photo;
  g.imageSmoothingQuality = "high";
  g.drawImage(photo, p.left, p.top, p.right - p.left, p.bottom - p.top);
  return out;
}

/** `state`'s face covers as they fall on a `w` x `h` render of it. */
export function facesInRender(state: EditState, srcW: number, srcH: number, w: number, h: number) {
  const m = sourceToRender(state, srcW, srcH, w, h);
  return { ...state.faces, covers: state.faces.covers.map((c) => coverInRender(c, m)) };
}

function ovalPath(g: CanvasRenderingContext2D, c: FaceCover): void {
  g.ellipse(c.cx, c.cy, Math.max(0.5, c.rx), Math.max(0.5, c.ry), (c.angle * Math.PI) / 180, 0, Math.PI * 2);
}

/**
 * Each face cover, as the Android editor draws it: a mosaic whose blocks follow the face's
 * own size (so a small face keeps its oval), or one soft blur of the whole picture shown
 * through every oval at once.
 */
function drawFaceCovers(
  canvas: HTMLCanvasElement,
  g: CanvasRenderingContext2D,
  covers: FaceCover[],
  style: FaceSettings["style"],
  strength: number,
): void {
  const w = canvas.width;
  const h = canvas.height;
  if (style === "blur") {
    const k = blurShrink(strength);
    const small = newCanvas(Math.max(1, w / k), Math.max(1, h / k));
    const sg = ctx2d(small);
    sg.imageSmoothingQuality = "high";
    sg.drawImage(canvas, 0, 0, small.width, small.height);
    const soft = newCanvas(w, h);
    const fg = ctx2d(soft);
    fg.imageSmoothingQuality = "high";
    fg.drawImage(small, 0, 0, w, h);
    g.save();
    g.beginPath();
    for (const c of covers) {
      // Each oval starts where its own outline does, so no edge joins one oval to the next.
      const a = (c.angle * Math.PI) / 180;
      g.moveTo(c.cx + c.rx * Math.cos(a), c.cy + c.rx * Math.sin(a));
      ovalPath(g, c);
    }
    g.clip();
    g.drawImage(soft, 0, 0);
    g.restore();
    return;
  }
  for (const c of covers) {
    const { ex, ey } = ovalExtent(c);
    const left = Math.max(0, Math.floor(c.cx - ex));
    const top = Math.max(0, Math.floor(c.cy - ey));
    const right = Math.min(w, Math.ceil(c.cx + ex));
    const bottom = Math.min(h, Math.ceil(c.cy + ey));
    const rw = right - left;
    const rh = bottom - top;
    if (rw <= 0 || rh <= 0) continue;
    const block = pixelBlock(2 * Math.min(c.rx, c.ry), strength);
    const small = newCanvas(Math.max(1, Math.round(rw / block)), Math.max(1, Math.round(rh / block)));
    const sg = ctx2d(small);
    sg.imageSmoothingEnabled = false;
    sg.drawImage(canvas, left, top, rw, rh, 0, 0, small.width, small.height);
    g.save();
    g.beginPath();
    ovalPath(g, c);
    g.clip();
    g.imageSmoothingEnabled = false;
    g.drawImage(small, 0, 0, small.width, small.height, left, top, rw, rh);
    g.restore();
  }
}

/** Sharpen's blur of what `canvas` holds: shrunk to a third with smoothing and scaled back. */
function blurOf(canvas: HTMLCanvasElement): Uint8ClampedArray {
  const w = canvas.width;
  const h = canvas.height;
  const small = newCanvas(Math.max(1, Math.floor(w / SHARPEN_SHRINK)), Math.max(1, Math.floor(h / SHARPEN_SHRINK)));
  const sg = ctx2d(small);
  sg.imageSmoothingQuality = "high";
  sg.drawImage(canvas, 0, 0, small.width, small.height);
  const up = newCanvas(w, h);
  const ug = ctx2d(up);
  ug.imageSmoothingQuality = "high";
  ug.drawImage(small, 0, 0, w, h);
  return ug.getImageData(0, 0, w, h).data;
}

/**
 * Radial edge shading: clear from the centre out to half the radius, then ramping to the
 * vignette's edge colour at the corners.
 */
function drawVignette(g: CanvasRenderingContext2D, w: number, h: number, strength: number): void {
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.max(1, Math.hypot(cx, cy));
  const { clear, edge } = vignetteStops(strength);
  const grad = g.createRadialGradient(cx, cy, 0, cx, cy, radius);
  grad.addColorStop(0, clear);
  grad.addColorStop(0.5, clear);
  grad.addColorStop(1, edge);
  g.save();
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.restore();
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

/** The file types a copy can be saved as. */
export type SaveFormat = "jpeg" | "png" | "webp";

/** How a copy is written, as the Android save sheet offers it. */
export type SaveOptions = {
  format: SaveFormat;
  /** 50..100; PNG is lossless and ignores it. */
  quality: number;
  /** The longest side the copy may have, or null for the edit's own full size. */
  maxEdge: number | null;
};

export const DEFAULT_SAVE: SaveOptions = { format: "jpeg", quality: 92, maxEdge: null };

/** The size a copy is written at: the full size, shrunk to fit `maxEdge`, never grown. */
export function fitEdge(w: number, h: number, maxEdge: number | null): { w: number; h: number } {
  const long = Math.max(w, h);
  if (!maxEdge || long <= maxEdge) return { w, h };
  const k = maxEdge / long;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/**
 * The full-resolution pipeline, encoded as the save options say (a JPEG at quality 92 by
 * default, matching Android), as base64 with no `data:` prefix, ready for `save_local_edit`.
 */
export async function encodeFull(
  source: Drawable,
  srcW: number,
  srcH: number,
  state: EditState,
  options: SaveOptions = DEFAULT_SAVE,
): Promise<string> {
  const { canvas: photo } = applyGeometry(source, srcW, srcH, state, Infinity);
  applyPixels(
    photo,
    state.adjustments,
    state.redact,
    facesInRender(state, srcW, srcH, photo.width, photo.height),
    state.color,
  );
  const canvas = state.frame ? applyFrame(photo, state.frame) : photo;
  drawOverlays(ctx2d(canvas), canvas.width, canvas.height, state.draw, state.texts);
  // The size is chosen last, over the finished picture, so a frame, a pen line and a text
  // shrink with the photo and look as they did in the preview.
  const out = fitEdge(canvas.width, canvas.height, options.maxEdge);
  let final = canvas;
  if (out.w !== canvas.width || out.h !== canvas.height) {
    final = document.createElement("canvas");
    final.width = out.w;
    final.height = out.h;
    const g = ctx2d(final);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(canvas, 0, 0, out.w, out.h);
  }
  const type = `image/${options.format}`;
  const blob = await new Promise<Blob | null>((resolve) =>
    final.toBlob(resolve, type, Math.min(100, Math.max(50, options.quality)) / 100),
  );
  // A webview without the encoder hands back a PNG instead; that is a failure, not a save
  // under the wrong name.
  if (!blob || blob.type !== type) throw new Error("encode failed");
  const buf = await blob.arrayBuffer();
  return base64FromBytes(new Uint8Array(buf));
}

export function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
