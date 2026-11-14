/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

/** A face as left, top, right, bottom, each a share (0..1) of the photo's width or height. */
type Box = readonly [number, number, number, number];

/**
 * Where the thumbnail server serves a person's cover already cut to the face: a small
 * square JPEG, so the window neither decodes the whole HD preview nor scales it up to cut
 * the face out itself. Null when the box cannot be named in the URL (outside the photo or
 * without area once kept to it), and the caller cuts the grid thumbnail as before.
 */
export function faceCoverUrl(base: string, uid: string, box: Box): string | null {
  const share = (n: number) => Math.min(1, Math.max(0, n));
  const [l, t, r, b] = box.map(share);
  if (!(r > l) || !(b > t)) return null;
  // Four decimals: a ten-thousandth of a 4000 px photo is under half a pixel.
  const text = [l, t, r, b].map((n) => n.toFixed(4)).join(",");
  return `${base}${encodeURIComponent(uid)}/f/${text}`;
}
