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
 * The per-pixel Tone effects the Android editor runs after the colour matrix, with its
 * formulas: sharpen (an unsharp mask against a blur made by shrinking to a third and
 * back), then vibrance and grain in one pass. Pure functions over RGBA bytes, so the
 * preview and the full-resolution save run the same code.
 */

import type { Adjustments } from "./editorColor";

/** Sharpen's blur: the picture shrunk to a third of its size and scaled back up. */
export const SHARPEN_SHRINK = 3;

/** Grain's reach: at 100 a pixel moves by up to this much on every channel. */
const GRAIN_AMPLITUDE = 40;

/** A fixed seed, so the grain stays the same on every render and does not flicker. */
const GRAIN_SEED = 0x5eed1234;

export function hasPixelEffects(adj: Adjustments): boolean {
  return adj.sharpen !== 0 || adj.vibrance !== 0 || adj.grain !== 0;
}

/**
 * Unsharp mask, in place: each channel moves away from its blurred value by `amount`
 * (-100..100) percent of the difference. Negative softens.
 */
export function sharpenInto(data: Uint8ClampedArray, blurred: Uint8ClampedArray, amount: number): void {
  const amt = amount / 100;
  // A clamped array rounds and clamps on every write, which is the whole of the clamp.
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    data[i] = r + amt * (r - blurred[i]);
    data[i + 1] = g + amt * (g - blurred[i + 1]);
    data[i + 2] = b + amt * (b - blurred[i + 2]);
  }
}

/** The largest grain table kept between renders: a preview's, never a full-size save's. */
const NOISE_CACHE_MAX = 4_000_000;

/** One grain value in -1..1 per pixel, from the fixed seed; a preview-sized table is reused. */
let noiseCache: Float32Array | null = null;
function unitNoise(pixels: number): Float32Array {
  if (noiseCache?.length === pixels) return noiseCache;
  const rnd = seeded(GRAIN_SEED);
  const out = new Float32Array(pixels);
  for (let i = 0; i < pixels; i++) out[i] = (rnd() - 0.5) * 2;
  if (pixels <= NOISE_CACHE_MAX) noiseCache = out;
  return out;
}

/** A small seeded generator (mulberry32), returning 0..1. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Vibrance, then grain, in place. Vibrance pushes each pixel away from its Rec. 601 grey
 * by more the less saturated it already is, so muted colours gain most and skin barely
 * moves. Grain adds the same monochrome noise to all three channels.
 */
export function vibranceAndGrain(data: Uint8ClampedArray, vibrance: number, grain: number): void {
  const vib = vibrance / 100;
  const amp = (Math.abs(grain) / 100) * GRAIN_AMPLITUDE;
  if (vib === 0 && amp === 0) return;
  const noise = amp !== 0 ? unitNoise(data.length >> 2) : null;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];
    if (vib !== 0) {
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      const max = r > g ? (r > b ? r : b) : g > b ? g : b;
      const min = r < g ? (r < b ? r : b) : g < b ? g : b;
      const boost = 1 + vib * (1 - (max - min) / 255);
      r = gray + (r - gray) * boost;
      g = gray + (g - gray) * boost;
      b = gray + (b - gray) * boost;
    }
    if (noise) {
      if (vib !== 0) {
        // Vibrance lands as whole, in-range values before the grain, as on Android.
        r = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
        g = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
        b = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
      }
      // Rounded before it is added, so all three channels move by the same whole step.
      const n = Math.round(noise[p] * amp);
      r += n;
      g += n;
      b += n;
    }
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
}

/**
 * The vignette's colour at the edge and clear: black that darkens the corners for a
 * positive strength, white that lightens them for a negative one, up to 70 % opaque at
 * the edge. The clear stop is the same colour at no opacity, so the ramp never greys.
 */
export function vignetteStops(strength: number): { clear: string; edge: string } {
  const alpha = Math.min(1, Math.max(0, (Math.abs(strength) / 100) * 0.7));
  const rgb = strength > 0 ? "0, 0, 0" : "255, 255, 255";
  return { clear: `rgba(${rgb}, 0)`, edge: `rgba(${rgb}, ${alpha})` };
}
