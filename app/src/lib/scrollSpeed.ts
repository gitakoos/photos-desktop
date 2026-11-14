/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

/** How long without a scroll step counts as stopped. */
export const SETTLE_MS = 120;

/**
 * How fast a list is moving, in px/s, from its scroll steps. Above `fast` the grid asks for
 * no thumbnails (Google Photos' web grid and Glide during a fling do the same): a tile on
 * screen for a few frames is not worth a fetch and a decode, and asking for it pushes the
 * tiles the reader stops on to the back of the line. `onSettle` runs once scrolling stops.
 */
export class ScrollSpeed {
  private top = 0;
  private at = 0;
  private v = 0;
  /** One timer for the whole scroll: it checks, when it fires, whether scrolling went on. */
  private settle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private fast: number,
    private onSettle: () => void,
    private now: () => number = () => performance.now(),
  ) {}

  setFast(fast: number): void {
    this.fast = fast;
  }

  /** Called on each scroll step. */
  step(top: number): void {
    const now = this.now();
    const dt = now - this.at;
    if (this.at > 0 && dt > 0 && dt < 250) {
      // Smoothed over a few steps, so one long frame does not read as a fling.
      this.v = this.v * 0.6 + (Math.abs(top - this.top) / dt) * 1000 * 0.4;
    } else {
      this.v = 0;
    }
    this.top = top;
    this.at = now;
    if (!this.settle) this.arm(SETTLE_MS);
  }

  isFast(): boolean {
    return this.v > this.fast;
  }

  /** Whether a scroll step came within the last SETTLE_MS. */
  moving(): boolean {
    return this.settle !== null;
  }

  stop(): void {
    if (this.settle) clearTimeout(this.settle);
    this.settle = null;
  }

  private arm(ms: number): void {
    this.settle = setTimeout(() => {
      const quiet = this.now() - this.at;
      if (quiet < SETTLE_MS) return this.arm(SETTLE_MS - quiet);
      this.settle = null;
      this.v = 0;
      this.onSettle();
    }, ms);
  }
}
