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

import {
  cornerRadiusPx,
  collageCells,
  coverPlacement,
  spacingPx,
  type CollageCell,
  type CollageTemplate,
} from "./collageLayout";
import { base64FromBytes } from "./editorRender";
import { cloudEditorSource } from "./cloudEditor";

/** A decoded photo the collage draws from, upright, as the editor's source gives it. */
export type CollagePhoto = { image: CanvasImageSource; w: number; h: number };

/** Everything the picture depends on besides the photos themselves. */
export type CollageSpec = {
  template: CollageTemplate;
  cells: CollageCell[];
  /** Slider levels, see `spacingPx` and `cornerRadiusPx`. */
  spacing: number;
  corners: number;
  background: string;
};

/**
 * The photo as the same upright pixels the photo editor works on, kept no larger than
 * `maxEdge` on its long side.
 */
export async function loadCollagePhoto(uid: string, maxEdge: number): Promise<CollagePhoto> {
  const source = await cloudEditorSource(uid);
  const image = new Image();
  image.src = source.dataUrl;
  await image.decode();
  const w = image.naturalWidth || source.width;
  const h = image.naturalHeight || source.height;
  const k = maxEdge / Math.max(w, h);
  if (k >= 1) return { image, w, h };
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.round(w * k));
  small.height = Math.max(1, Math.round(h * k));
  const g = small.getContext("2d");
  if (!g) return { image, w, h };
  g.imageSmoothingQuality = "high";
  g.drawImage(image, 0, 0, small.width, small.height);
  return { image: small, w: small.width, h: small.height };
}

/** A rounded rectangle as the current path, drawn with arcs so every webview has it. */
function roundedPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (r <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** The collage's cells on a `w` x `h` canvas, in that canvas's pixels. */
export function cellRects(spec: CollageSpec, w: number, h: number) {
  return collageCells(spec.template.cells, w, h, spacingPx(spec.spacing, w, h));
}

/**
 * Draws the collage into `ctx`, `w` x `h` in its own units. A cell whose photo has not
 * loaded yet shows a neutral block. The preview and the export both come through here.
 */
export function drawCollage(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  spec: CollageSpec,
  photos: Map<string, CollagePhoto>,
) {
  ctx.fillStyle = spec.background;
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const rects = cellRects(spec, w, h);
  rects.forEach((r, i) => {
    const cell = spec.cells[i];
    if (!cell) return;
    const radius = cornerRadiusPx(spec.corners, w, h, r.w, r.h);
    ctx.save();
    roundedPath(ctx, r.x, r.y, r.w, r.h, radius);
    ctx.clip();
    const photo = photos.get(cell.uid);
    if (photo) {
      const p = coverPlacement(photo.w, photo.h, r.w, r.h, cell.zoom, cell.panX, cell.panY);
      ctx.drawImage(photo.image, r.x + p.x, r.y + p.y, p.w, p.h);
    } else {
      ctx.fillStyle = "rgba(128, 128, 128, 0.35)";
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    ctx.restore();
  });
}

export type CollageFormat = "jpeg" | "png";

/**
 * The collage at `w` x `h`, encoded, as base64 with no `data:` prefix. A webview that
 * cannot write the format hands back a PNG instead, which is a failure here, not a save
 * under the wrong name.
 */
export async function encodeCollage(
  spec: CollageSpec,
  photos: Map<string, CollagePhoto>,
  w: number,
  h: number,
  format: CollageFormat = "jpeg",
  quality = 92,
): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  drawCollage(ctx, w, h, spec, photos);
  const type = `image/${format}`;
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, Math.min(100, Math.max(50, quality)) / 100),
  );
  if (!blob || blob.type !== type) throw new Error("encode failed");
  return base64FromBytes(new Uint8Array(await blob.arrayBuffer()));
}
