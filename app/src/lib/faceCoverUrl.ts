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

/** A face as left, top, right, bottom, each a share (0..1) of the photo's width or height. */
type Box = readonly [number, number, number, number];

/** The thumbnail server's cover sides (faceCover.ts COVER_STEPS, then COVER_SIZE). */
const COVER_STEPS = [128, 192, 256, 320];

/**
 * Where the thumbnail server serves a person's cover already cut to the face: a small
 * square JPEG, so the window neither decodes the whole HD preview nor scales it up to cut
 * the face out itself. `px` is how large the circle is drawn, in device pixels. Null when
 * the box cannot be named in the URL (outside the photo or without area once kept to it),
 * and the caller cuts the grid thumbnail as before.
 */
export function faceCoverUrl(base: string, uid: string, box: Box, px?: number): string | null {
  const share = (n: number) => Math.min(1, Math.max(0, n));
  const [l, t, r, b] = box.map(share);
  if (!(r > l) || !(b > t)) return null;
  // Four decimals: a ten-thousandth of a 4000 px photo is under half a pixel.
  const text = [l, t, r, b].map((n) => n.toFixed(4)).join(",");
  // Rounded up to the server's steps: a small circle is cut from the grid thumbnail rather
  // than an HD preview, and circles of nearly the same size share one cut.
  const step = px ? COVER_STEPS.find((s) => px <= s) : undefined;
  return `${base}${encodeURIComponent(uid)}/f/${text}${step ? `?w=${step}` : ""}`;
}
