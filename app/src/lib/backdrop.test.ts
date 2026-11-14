/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
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

  it("keeps the click from what is under it, unless told not to", () => {
    const e = ev(backdrop);
    backdropClose(() => {}).onClick(e);
    expect(e.stopPropagation).toHaveBeenCalled();
    const f = ev(backdrop);
    backdropClose(() => {}, false).onClick(f);
    expect(f.stopPropagation).not.toHaveBeenCalled();
  });
});
