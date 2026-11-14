/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * This file is part of Photos for Proton, free software under the GNU General Public
 * License version 3. See <https://www.gnu.org/licenses/>.
 */

import { useEffect, useState, type CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** The edge a resize starts from, as the window API names them (its type is not exported). */
type ResizeDirection = Parameters<ReturnType<typeof getCurrentWindow>["startResizeDragging"]>[0];

/**
 * How far in from the window's edge a press resizes it, and how far along a corner reaches.
 * The edge is the toolkit's own band (5 px), which resizes on a press there anyway, so the
 * handles take no more of the scroll bar on the right or the title bar's buttons above than it
 * already does, and both ask for the same edge. The corners reach a little further, to be found.
 */
const EDGE = 5;
const CORNER = 10;

type Handle = { dir: ResizeDirection; cursor: string; style: CSSProperties };

const HANDLES: Handle[] = [
  { dir: "North", cursor: "ns-resize", style: { top: 0, left: CORNER, right: CORNER, height: EDGE } },
  { dir: "South", cursor: "ns-resize", style: { bottom: 0, left: CORNER, right: CORNER, height: EDGE } },
  { dir: "West", cursor: "ew-resize", style: { left: 0, top: CORNER, bottom: CORNER, width: EDGE } },
  { dir: "East", cursor: "ew-resize", style: { right: 0, top: CORNER, bottom: CORNER, width: EDGE } },
  { dir: "NorthWest", cursor: "nwse-resize", style: { top: 0, left: 0, width: CORNER, height: CORNER } },
  { dir: "NorthEast", cursor: "nesw-resize", style: { top: 0, right: 0, width: CORNER, height: CORNER } },
  { dir: "SouthWest", cursor: "nesw-resize", style: { bottom: 0, left: 0, width: CORNER, height: CORNER } },
  { dir: "SouthEast", cursor: "nwse-resize", style: { bottom: 0, right: 0, width: CORNER, height: CORNER } },
];

/**
 * The edges and corners of a window the app draws itself (no system frame, as on Linux):
 * each shows the resize cursor and starts the resize on a press.
 *
 * The toolkit's own handling for such a window only listens for a press within a few pixels
 * of the edge, works out the edge from window coordinates that a Wayland session does not
 * give reliably, and never changes the cursor over the page: on KDE under Wayland the sides
 * and the corners did not resize at all, and nothing showed that they could. These are
 * plain elements over the page's edge, so the page's own cursor rules and its scroll bars
 * cannot hide them, and the resize is asked of the window directly.
 *
 * Not shown while the window is maximized or full screen, where there is nothing to resize.
 */
export function ResizeEdges() {
  const [shown, setShown] = useState(true);

  useEffect(() => {
    const win = getCurrentWindow();
    let live = true;
    const check = async () => {
      try {
        const [max, full] = await Promise.all([win.isMaximized(), win.isFullscreen()]);
        if (live) setShown(!max && !full);
      } catch {
        /* keep the handles */
      }
    };
    void check();
    let stop: (() => void) | undefined;
    void win
      .onResized(() => void check())
      .then((un) => {
        if (live) stop = un;
        else un();
      })
      .catch(() => {});
    return () => {
      live = false;
      stop?.();
    };
  }, []);

  if (!shown) return null;
  return (
    <>
      {HANDLES.map((h) => (
        <div
          key={h.dir}
          aria-hidden
          style={{ position: "fixed", zIndex: 2147483000, cursor: h.cursor, ...h.style }}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            void getCurrentWindow().startResizeDragging(h.dir).catch(() => {});
          }}
        />
      ))}
    </>
  );
}
