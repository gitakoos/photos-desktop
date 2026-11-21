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

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLIDE_SECONDS,
  VIDEO_SLIDE_CAP_MS,
  isSlideSeconds,
  readSlideSeconds,
  slideDurationMs,
  slideProgress,
  slidesAhead,
  stepSlide,
  writeSlideSeconds,
} from "./slideshow";

describe("stepSlide", () => {
  it("moves forward and back", () => {
    expect(stepSlide(2, 8, 1)).toBe(3);
    expect(stepSlide(2, 8, -1)).toBe(1);
  });

  it("wraps at both ends so the show loops", () => {
    expect(stepSlide(7, 8, 1)).toBe(0);
    expect(stepSlide(0, 8, -1)).toBe(7);
    expect(stepSlide(0, 3, -7)).toBe(2);
  });

  it("stays put over an empty list", () => {
    expect(stepSlide(0, 0, 1)).toBe(0);
  });
});

describe("slidesAhead", () => {
  it("names the next two slides, wrapping", () => {
    expect(slidesAhead(0, 5)).toEqual([1, 2]);
    expect(slidesAhead(4, 5)).toEqual([0, 1]);
  });

  it("names fewer when the list is short", () => {
    expect(slidesAhead(0, 2)).toEqual([1]);
    expect(slidesAhead(0, 1)).toEqual([]);
  });
});

describe("slideProgress and slideDurationMs", () => {
  it("clamps the progress to the slide's time", () => {
    expect(slideProgress(1500, 3000)).toBe(0.5);
    expect(slideProgress(9000, 3000)).toBe(1);
    expect(slideProgress(-5, 3000)).toBe(0);
    expect(slideProgress(10, 0)).toBe(1);
  });

  it("gives a photo the chosen pause and a playing video the cap", () => {
    expect(slideDurationMs(5, false)).toBe(5000);
    expect(slideDurationMs(5, true)).toBe(VIDEO_SLIDE_CAP_MS);
  });
});

describe("the remembered pause", () => {
  it("accepts only the pauses on offer", () => {
    expect(isSlideSeconds(3)).toBe(true);
    expect(isSlideSeconds(4)).toBe(false);
    expect(isSlideSeconds("5")).toBe(false);
  });

  it("falls back to the default and keeps a choice", () => {
    const store = new Map<string, string>();
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    });
    try {
      expect(readSlideSeconds()).toBe(DEFAULT_SLIDE_SECONDS);
      writeSlideSeconds(10);
      expect(readSlideSeconds()).toBe(10);
      store.set("slideshow.seconds", "7");
      expect(readSlideSeconds()).toBe(DEFAULT_SLIDE_SECONDS);
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original });
    }
  });
});
