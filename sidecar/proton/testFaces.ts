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

// Made-up faces for the face tests: unit directions, and faces of one identity scattered
// around its direction.

import { FACE_EMBEDDING_DIM } from "./faceCluster.ts";

/** A seeded random source, so every run sees the same faces. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function unit(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  const inv = 1 / Math.sqrt(n);
  return v.map((x) => x * inv);
}

export function direction(rand: () => number): Float32Array {
  return unit(Float32Array.from({ length: FACE_EMBEDDING_DIM }, () => rand() - 0.5));
}

/** A face of the identity `base`, `spread` off it: 0.5 gives a cosine of about 0.9 to it. */
export function faceOf(base: Float32Array, rand: () => number, spread = 0.5): Float32Array {
  const noise = direction(rand);
  return unit(base.map((x, i) => x + spread * noise[i]));
}
