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
 * Which rows of a long list are built, as the reader scrolls.
 *
 * The rows are built around an anchor, not around the scroll position itself: the anchor
 * stays where it is while the screen is still well inside what is built, and only then
 * jumps to where the screen is. A scroll frame that does not move the anchor changes
 * nothing, so the list is not worked out again on every frame, and a row is not taken
 * down and put back by a small scroll one way and the other.
 */

/** Screens of rows built either side of the screen when the anchor is set. */
export const BUILT_AROUND = 2;

/** Screens of built rows that must remain either side of the screen; fewer moves the anchor. */
export const BUILT_AT_LEAST = 1.5;

/** A screen's height for this purpose: never so short that too little is built. */
export function screenOf(viewHeight: number): number {
  return Math.max(viewHeight, 600);
}

/**
 * The anchor after a scroll: `anchor` itself while the screen at `top` still has
 * `BUILT_AT_LEAST` screens built either side, and `top` once it has not.
 */
export function anchorAfterScroll(anchor: number, top: number, viewHeight: number): number {
  const slack = (BUILT_AROUND - BUILT_AT_LEAST) * screenOf(viewHeight);
  return Math.abs(top - anchor) < slack ? anchor : top;
}

/** The stretch of the list that is built around an anchor, in the list's own pixels. */
export function builtSpan(anchor: number, viewHeight: number): { from: number; to: number } {
  const screen = screenOf(viewHeight);
  return { from: anchor - BUILT_AROUND * screen, to: anchor + (1 + BUILT_AROUND) * screen };
}

/**
 * The rows of one section inside a built stretch: `first` to `last` (exclusive), which is
 * an empty range when the section has no row in it. `gridTop` is where the section's first
 * row starts, `pitch` a row's height plus the gap under it.
 */
export function rowsInSpan(
  span: { from: number; to: number },
  gridTop: number,
  rows: number,
  pitch: number,
): { first: number; last: number } {
  const first = Math.min(rows, Math.max(0, Math.floor((span.from - gridTop) / pitch)));
  const last = Math.max(first, Math.min(rows, Math.ceil((span.to - gridTop) / pitch)));
  return { first, last };
}
