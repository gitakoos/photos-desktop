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

// Where the rings and the name pills go over a photo in the viewer.

/** One face to tag: its box in fractions of the photo, its name if it has one, and what a click does. */
export type FaceTag = {
  key: string;
  box: [number, number, number, number];
  name: string | null;
  /** Opens the person; for a face without a name, offers to name it. */
  onClick?: () => void;
};

/** A tag placed on the stage, in stage pixels: the ring round the face and the pill with the name. */
export type PlacedTag = {
  tag: FaceTag;
  box: { l: number; t: number; w: number; h: number };
  pill: { l: number; t: number; w: number };
};

export const TAG_H = 26;
const TAG_GAP = 6;
/** How close to the edge of the stage a pill may go. */
const TAG_MARGIN = 4;

/**
 * Each box is mapped from the photo to the stage through the same fit and transform the image
 * rides, so a tag stays on its face while the photo is zoomed and panned, yet keeps its own size.
 * A pill goes under its face, or above it, or is nudged down off a pill already placed, so a group
 * photo reads as a set of names rather than one pile. A face out of sight takes its tag with it.
 *
 * `frame` is where the image element sits in the stage, before the zoom's transform.
 */
export function layoutFaceTags(
  tags: FaceTag[],
  natural: { w: number; h: number },
  frame: { l: number; t: number; w: number; h: number },
  view: { scale: number; x: number; y: number },
): PlacedTag[] {
  const ar = natural.w / natural.h;
  const dw = Math.min(frame.w, frame.h * ar);
  const dh = dw / ar;
  const dx = frame.l + (frame.w - dw) / 2;
  const dy = frame.t + (frame.h - dh) / 2;
  const cx = frame.l + frame.w / 2;
  const cy = frame.t + frame.h / 2;
  const toStage = (fx: number, fy: number) => ({
    x: cx + (dx + fx * dw - cx) * view.scale + view.x,
    y: cy + (dy + fy * dh - cy) * view.scale + view.y,
  });
  // The stage the tags are kept inside: the image element's box and the margin around it.
  const stageW = frame.l * 2 + frame.w;
  const stageH = frame.t * 2 + frame.h;
  const maxTop = stageH - TAG_H - TAG_MARGIN;
  const taken: { l: number; t: number; r: number; b: number }[] = [];
  const free = (l: number, top: number, w: number) =>
    !taken.some((p) => p.l < l + w && p.r > l && p.t < top + TAG_H && p.b > top);
  return tags
    .map((tag) => ({ tag, a: toStage(tag.box[0], tag.box[1]), b: toStage(tag.box[2], tag.box[3]) }))
    .filter(({ a, b }) => b.x > 0 && b.y > 0 && a.x < stageW && a.y < stageH)
    .map(({ tag, a, b }) => {
      const w = Math.max(TAG_H, (tag.name?.length ?? 0) * 7.5 + (tag.name ? 22 : 0));
      const left = Math.min(Math.max(TAG_MARGIN, (a.x + b.x) / 2 - w / 2), stageW - w - TAG_MARGIN);
      let top = Math.min(b.y + TAG_GAP, maxTop);
      if (!free(left, top, w)) {
        const above = a.y - TAG_GAP - TAG_H;
        if (free(left, above, w)) top = above;
        else for (let i = 0; i < 8 && !free(left, top, w); i++) top = Math.min(top + TAG_H + TAG_GAP, maxTop);
      }
      taken.push({ l: left, t: top, r: left + w, b: top + TAG_H });
      return { tag, box: { l: a.x, t: a.y, w: b.x - a.x, h: b.y - a.y }, pill: { l: left, t: top, w } };
    });
}
