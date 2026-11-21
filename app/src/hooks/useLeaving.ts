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

import { useLayoutEffect, useRef, useState } from "react";

/** Whether the system has been asked to still motion. */
export function stillMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Keeps the last shown `value` on screen for `ms` after it goes away, with `leaving` set, so
 * it can animate out instead of vanishing. A timer, not the animation's end, takes it off, so
 * it also goes when no animation runs. With still motion it goes at once.
 */
export function useLeaving<T>(value: T | null | undefined | false, ms: number): { value: T | null; leaving: boolean } {
  const present = value !== null && value !== undefined && value !== false;
  const last = useRef<T | null>(null);
  const [, redraw] = useState(0);
  if (present) last.current = value as T;

  useLayoutEffect(() => {
    if (present || last.current === null) return;
    const drop = () => {
      last.current = null;
      redraw((n) => n + 1);
    };
    if (stillMotion()) {
      drop();
      return;
    }
    const id = window.setTimeout(drop, ms);
    return () => window.clearTimeout(id);
  }, [present, ms]);

  if (present) return { value: value as T, leaving: false };
  return { value: last.current, leaving: last.current !== null };
}
