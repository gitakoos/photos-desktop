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

import { useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * The sign-in card, sized to what it holds: a step that needs more or less room grows or
 * shrinks the card smoothly instead of jumping. `phase` lets the stylesheet give the
 * steps a user goes back and forth between the same height.
 */
export function LoginCard({ phase, children }: { phase?: string; children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const card = outer.current;
    const body = inner.current;
    if (!card || !body) return;
    let first = true;
    const fit = () => {
      const cs = getComputedStyle(card);
      const frame =
        parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      const height = `${body.offsetHeight + frame}px`;
      if (first) {
        // The first size is taken as it is: only a change afterwards is animated.
        card.style.transition = "none";
        card.style.height = height;
        void card.offsetHeight;
        card.style.transition = "";
        first = false;
      } else {
        card.style.height = height;
      }
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(body);
    return () => watch.disconnect();
  }, []);

  return (
    <div className="login-card login-card-fit" ref={outer} data-phase={phase}>
      <div className="login-card-body" ref={inner}>
        {children}
      </div>
    </div>
  );
}
