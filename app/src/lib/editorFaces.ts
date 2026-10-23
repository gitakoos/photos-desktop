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
 * Hide faces, as the Android editor does it: each face the detector finds becomes an oval
 * along its eye line, kept in the ORIGINAL photo's pixels, so a turn, a straighten or a crop
 * made afterwards carries the cover with the face. At render time each oval is mapped
 * through the edit's geometry onto the picture being drawn.
 */

import { apply3, geometryWarp, mul3, IDENTITY3, type Mat3 } from "./editorWarp";

/** One face cover: an oval in the original photo's pixels, turned clockwise by `angle` degrees. */
export type FaceCover = { cx: number; cy: number; rx: number; ry: number; angle: number };

export type FaceStyle = "pixelate" | "blur";

/** The faces an edit hides and how: pixelate or blur, at a strength from 0 to 1. */
export type FaceSettings = { covers: FaceCover[]; style: FaceStyle; strength: number };

export const NO_FACES: FaceSettings = { covers: [], style: "pixelate", strength: 0.5 };

/** The square the detector reads, and the grey its letterbox margins are padded with. */
export const FACE_INPUT = 640;
export const FACE_PAD_GREY = 114;
/** The size the phone shrinks a photo to before detecting, which its size floor is measured in. */
const DETECT_MAX_EDGE = 1920;
/** A face's shorter side must be at least this many pixels of that copy, and this share of it. */
const MIN_FACE_PX = 40;
const MIN_FACE_FRACTION = 0.03;
/** How far an oval reaches past the face's box, so hair and jaw at the corners are covered. */
const OVAL_PADDING = 0.12;

/** How a `w` x `h` photo fits the detector's square: its scale and the centred margins. */
export function letterbox(w: number, h: number, side = FACE_INPUT) {
  const scale = Math.min(side / w, side / h);
  const fw = Math.min(side, Math.max(1, Math.round(w * scale)));
  const fh = Math.min(side, Math.max(1, Math.round(h * scale)));
  return { scale, fw, fh, padX: Math.floor((side - fw) / 2), padY: Math.floor((side - fh) / 2) };
}

/** The Android editor's `faceOval`: centred on the box, angled along the eyes, grown a little. */
export function faceOval(
  box: [number, number, number, number],
  eyes: [number, number, number, number],
  padding = OVAL_PADDING,
): FaceCover {
  const dx = eyes[2] - eyes[0];
  const dy = eyes[3] - eyes[1];
  const angle = Math.hypot(dx, dy) < 1e-3 ? 0 : (Math.atan2(dy, dx) * 180) / Math.PI;
  const grow = 1 + padding;
  return {
    cx: (box[0] + box[2]) / 2,
    cy: (box[1] + box[3]) / 2,
    rx: Math.max(0, ((box[2] - box[0]) / 2) * grow),
    ry: Math.max(0, ((box[3] - box[1]) / 2) * grow),
    angle,
  };
}

/**
 * The covers for the detector's hits on a `w` x `h` photo: each box and its eyes taken back
 * out of the letterbox into the photo's pixels, a face too small to matter dropped as the
 * phone drops it, and the rest turned into ovals.
 */
export function coversFromHits(
  hits: { box: [number, number, number, number]; eyes: [number, number, number, number] }[],
  w: number,
  h: number,
): FaceCover[] {
  const fit = letterbox(w, h);
  const back = (x: number, pad: number) => (x - pad) / fit.scale;
  const detect = Math.min(1, DETECT_MAX_EDGE / Math.max(w, h));
  const minEdge = Math.max(MIN_FACE_PX, MIN_FACE_FRACTION * Math.min(w * detect, h * detect));
  const covers: FaceCover[] = [];
  for (const hit of hits) {
    const box: [number, number, number, number] = [
      Math.min(w, Math.max(0, back(hit.box[0], fit.padX))),
      Math.min(h, Math.max(0, back(hit.box[1], fit.padY))),
      Math.min(w, Math.max(0, back(hit.box[2], fit.padX))),
      Math.min(h, Math.max(0, back(hit.box[3], fit.padY))),
    ];
    if (Math.min(box[2] - box[0], box[3] - box[1]) * detect < minEdge) continue;
    const eyes: [number, number, number, number] = [
      back(hit.eyes[0], fit.padX),
      back(hit.eyes[1], fit.padY),
      back(hit.eyes[2], fit.padX),
      back(hit.eyes[3], fit.padY),
    ];
    covers.push(faceOval(box, eyes));
  }
  return covers;
}

/** The parts of an edit that move a point of the original photo. */
export type Geometry = {
  rotation: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  straighten: number;
  perspectiveV: number;
  perspectiveH: number;
  crop: { left: number; top: number; right: number; bottom: number } | null;
};

/**
 * Where a point of the original `srcW` x `srcH` photo lands on a picture `outW` x `outH`
 * drawn from it: through the turn and flips, the straighten and keystone, the crop, then the
 * scale down to the picture, the same steps the render moves its pixels through.
 */
export function sourceToRender(g: Geometry, srcW: number, srcH: number, outW: number, outH: number): Mat3 {
  const quarter = g.rotation === 90 || g.rotation === 270;
  const rw = quarter ? srcH : srcW;
  const rh = quarter ? srcW : srcH;
  const t = (g.rotation * Math.PI) / 180;
  const c = Math.round(Math.cos(t));
  const s = Math.round(Math.sin(t));
  const fx = g.flipH ? -1 : 1;
  const fy = g.flipV ? -1 : 1;
  // translate(rw/2, rh/2) . rotate(t) . scale(fx, fy) . translate(-srcW/2, -srcH/2)
  const turn: Mat3 = mul3(
    [1, 0, rw / 2, 0, 1, rh / 2, 0, 0, 1],
    mul3([c * fx, -s * fy, 0, s * fx, c * fy, 0, 0, 0, 1], [1, 0, -srcW / 2, 0, 1, -srcH / 2, 0, 0, 1]),
  );
  const warp = geometryWarp(rw, rh, g.straighten, g.perspectiveV, g.perspectiveH) ?? IDENTITY3;
  const fullW = g.crop ? g.crop.right - g.crop.left : rw;
  const fullH = g.crop ? g.crop.bottom - g.crop.top : rh;
  const crop: Mat3 = g.crop ? [1, 0, -g.crop.left, 0, 1, -g.crop.top, 0, 0, 1] : IDENTITY3;
  const scale: Mat3 = [outW / fullW, 0, 0, 0, outH / fullH, 0, 0, 0, 1];
  return mul3(scale, mul3(crop, mul3(warp, turn)));
}

/**
 * A cover as it falls on the rendered picture: its centre mapped through `m`, and its two
 * axes mapped as the arms from the centre, which keeps it an oval however it was turned.
 */
export function coverInRender(cover: FaceCover, m: Mat3): FaceCover {
  const a = (cover.angle * Math.PI) / 180;
  const [cx, cy] = apply3(m, cover.cx, cover.cy);
  const [ax, ay] = apply3(m, cover.cx + cover.rx * Math.cos(a), cover.cy + cover.rx * Math.sin(a));
  const [bx, by] = apply3(m, cover.cx - cover.ry * Math.sin(a), cover.cy + cover.ry * Math.cos(a));
  return {
    cx,
    cy,
    rx: Math.hypot(ax - cx, ay - cy),
    ry: Math.hypot(bx - cx, by - cy),
    angle: (Math.atan2(ay - cy, ax - cx) * 180) / Math.PI,
  };
}

/** The box an oval fills: half its width and half its height about the centre, as turned. */
export function ovalExtent(c: FaceCover): { ex: number; ey: number } {
  const a = (c.angle * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return {
    ex: Math.sqrt((c.rx * cos) ** 2 + (c.ry * sin) ** 2),
    ey: Math.sqrt((c.rx * sin) ** 2 + (c.ry * cos) ** 2),
  };
}

/** The pixelate block for a face drawn at `span` pixels across: about 22 blocks faint, 7 strong. */
export function pixelBlock(span: number, strength: number): number {
  const s = Math.min(1, Math.max(0, strength));
  const across = 22 + (7 - 22) * s;
  return Math.max(2, span / across);
}

/** The blur's shrink factor at a strength: 10 faint, 40 strong. */
export function blurShrink(strength: number): number {
  return Math.max(1, Math.round(10 + Math.min(1, Math.max(0, strength)) * 30));
}
