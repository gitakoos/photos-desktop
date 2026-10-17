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

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import "../styles/ContextMenu.css";

/** How close to the window edge the menu may sit before it flips over the click. */
const EDGE_MARGIN_PX = 6;

export type MenuAction = {
  key: string;
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  /** Reads as destructive before it is clicked, the way the app marks the rest. */
  danger?: boolean;
  /** Draws a divider above this row, to set a group (or the destructive action) apart. */
  separator?: boolean;
  /** Named but not offered yet. Skipped by the keys, and `onSelect` never runs. */
  disabled?: boolean;
};

/** Where a right-click landed, and what it landed on. */
export type MenuAt<T> = { x: number; y: number; target: T };

/** The rows the keys and the focus may land on: everything but the placeholders. */
const REACHABLE = '[role="menuitem"]:not(:disabled)';

type Props = {
  x: number;
  y: number;
  actions: MenuAction[];
  onClose: () => void;
};

/**
 * The app's one right-click menu: the shell's own menu, the album list's and the
 * photo grids' are all this, holding different actions.
 *
 * It opens where the click landed and flips back over it near a window edge, so
 * it is never half off the screen. Escape, a click anywhere else, a scroll and a
 * resize all close it — a menu pinned to a spot has no business outliving the
 * spot. The keys work it in full: it takes the focus as it opens, the arrows walk
 * the actions, and the focus goes back where it came from on the way out.
 */
export function ContextMenu({ x, y, actions, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Placed only once measured, so it cannot paint at the wrong spot first.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: x + width + EDGE_MARGIN_PX > window.innerWidth ? Math.max(EDGE_MARGIN_PX, x - width) : x,
      top: y + height + EDGE_MARGIN_PX > window.innerHeight ? Math.max(EDGE_MARGIN_PX, y - height) : y,
    });
  }, [x, y, actions.length]);

  /** Walk the actions with the arrows, wrapping at both ends. */
  const move = useCallback((delta: number) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>(REACHABLE) ?? []);
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + delta + items.length) % items.length].focus();
  }, []);

  // Hand the focus back where it came from on the way out, so closing a menu
  // never strands the keys on nothing.
  useEffect(() => {
    const from = document.activeElement as HTMLElement | null;
    return () => from?.focus?.();
  }, []);

  // Take the focus only once the menu has been placed. It is hidden until then,
  // and a hidden element cannot take the focus: doing this on mount looked right
  // and quietly left the whole menu unreachable by keyboard.
  const placed = pos !== null;
  useEffect(() => {
    if (!placed) return;
    ref.current?.querySelector<HTMLButtonElement>(REACHABLE)?.focus();
  }, [placed]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // Stop it here: Escape belongs to the menu while it is up, not to the
        // selection or the lightbox underneath.
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "Tab") {
        onClose();
      }
    }
    function onDown(e: globalThis.MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    // Captured: the scroller is a parent of the click, not of this menu, and a
    // scroll event does not bubble to the window on its own.
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose, move]);

  return (
    <div
      ref={ref}
      className="cm"
      role="menu"
      style={{
        left: pos?.left ?? x,
        top: pos?.top ?? y,
        // Measured off-screen on the first pass, so the flip is decided before
        // anything is shown rather than corrected afterwards.
        visibility: pos ? "visible" : "hidden",
      }}
      // A right-click on an open menu is not a fresh right-click on the window
      // behind it, so it is stopped here rather than left to reach the shell's
      // document listener, which would open a second menu over this one.
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {actions.map((a) => (
        <Fragment key={a.key}>
          {a.separator && <div className="cm-sep" role="separator" />}
          <button
            role="menuitem"
            className={`cm-item ${a.danger ? "danger" : ""}`}
            disabled={a.disabled}
            onClick={() => {
              onClose();
              a.onSelect();
            }}
          >
            {a.icon && <span className="cm-icon">{a.icon}</span>}
            {a.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
