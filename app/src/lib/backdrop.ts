/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import type { MouseEvent } from "react";

/** The backdrop the last press began on, if it began on one and not on something inside it. */
let pressedBackdrop: EventTarget | null = null;

/**
 * What a dialog's backdrop needs to close on a click outside the dialog, and only then.
 *
 * A press inside the dialog that is let go outside it (selecting the text of a field by
 * dragging, or a slider pulled past the panel's edge) is reported by the browser as a
 * click on the element holding both, which is the backdrop: the dialog closed under the
 * reader's hand, taking whatever they had typed. A click closes it here only if the press
 * began on the backdrop itself, and never while text is selected.
 *
 * `stop` keeps the click from reaching what is under the dialog (the grid, the viewer).
 */
export function backdropClose(close: () => void, stop = true) {
  return {
    // In the capture phase, so the press is seen even where the dialog stops it.
    onMouseDownCapture: (e: MouseEvent) => {
      pressedBackdrop = e.target === e.currentTarget ? e.currentTarget : null;
    },
    onClick: (e: MouseEvent) => {
      if (stop) e.stopPropagation();
      const fromHere = pressedBackdrop === e.currentTarget && e.target === e.currentTarget;
      pressedBackdrop = null;
      if (!fromHere || (globalThis.getSelection?.()?.toString() ?? "") !== "") return;
      close();
    },
  };
}
