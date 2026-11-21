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

import { describe, it, expect, vi } from "vitest";
import type { MouseEvent } from "react";
import { backdropClose } from "./backdrop";

const backdrop = { name: "backdrop" };
const field = { name: "field" };
const ev = (target: object) =>
  ({ target, currentTarget: backdrop, stopPropagation: vi.fn() }) as unknown as MouseEvent;

describe("a dialog's backdrop", () => {
  it("closes on a click that began and ended on it", () => {
    const close = vi.fn();
    const p = backdropClose(close);
    p.onMouseDownCapture(ev(backdrop));
    p.onClick(ev(backdrop));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("stays open when a press inside the dialog is let go outside it, as selecting text does", () => {
    const close = vi.fn();
    const p = backdropClose(close);
    p.onMouseDownCapture(ev(field));
    // The browser reports it on the element holding both: the backdrop.
    p.onClick(ev(backdrop));
    expect(close).not.toHaveBeenCalled();
  });

  it("closes on a click on it while text inside the dialog stays selected", () => {
    vi.stubGlobal("getSelection", () => ({ toString: () => "a name" }));
    const close = vi.fn();
    const p = backdropClose(close);
    p.onMouseDownCapture(ev(backdrop));
    p.onClick(ev(backdrop));
    vi.unstubAllGlobals();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps the click from what is under it, unless told not to", () => {
    const e = ev(backdrop);
    backdropClose(() => {}).onClick(e);
    expect(e.stopPropagation).toHaveBeenCalled();
    const f = ev(backdrop);
    backdropClose(() => {}, false).onClick(f);
    expect(f.stopPropagation).not.toHaveBeenCalled();
  });
});
