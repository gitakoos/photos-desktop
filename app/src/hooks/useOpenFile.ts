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

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type OpenFileRequest = {
  /** The file to show, or null while the host has not named one. */
  path: string | null;
  /**
   * How many files have been delivered here. The path alone is not enough to tell a
   * viewer to go somewhere: a window that has been stepped along to another file in the
   * same folder is still showing something else when the file it was opened with is
   * double-clicked a second time, and that arrives as the same string it already holds.
   * The host emits unconditionally for exactly that reason; this is what carries it.
   */
  delivery: number;
  /**
   * Whether the host has answered at all. It answers with nothing only when there
   * is nothing to show, which is the one case a viewer window has no reason to exist.
   */
  checked: boolean;
  /** Follow the file to its new path after a rename. */
  retarget: (path: string) => void;
};

/**
 * The file this window was opened for, from either of the two ways it arrives.
 *
 * The window is built by the same call that delivers the file, so at that moment
 * nothing here is listening: the host holds the path and this collects it on mount.
 * A later double-click, with the window already up, arrives as an event instead.
 *
 * Only the viewer window calls this. The app's window has no business taking a path
 * out of a slot that can be read once.
 */
export function useOpenFile(): OpenFileRequest {
  const [path, setPath] = useState<string | null>(null);
  const [delivery, setDelivery] = useState(0);
  const [checked, setChecked] = useState(false);
  /**
   * Whether a file has arrived by event. The held path and the event race on a
   * second double-click landing mid-mount, and the event is always the newer of the
   * two, so once one has been heard the held path is stale by definition.
   */
  const delivered = useRef(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    (async () => {
      // Subscribe before collecting the held path: a request arriving between the two
      // would otherwise fall down the gap between them.
      const stop = await listen<{ path: string }>("open-file", ({ payload }) => {
        if (!payload?.path) return;
        delivered.current = true;
        setPath(payload.path);
        setDelivery((n) => n + 1);
      }).catch(() => undefined);

      if (disposed) {
        stop?.();
        return;
      }
      unlisten = stop;

      const pending = await invoke<string | null>("take_pending_open").catch(() => null);
      if (disposed) return;
      if (pending && !delivered.current) {
        setPath(pending);
        setDelivery((n) => n + 1);
      }
      setChecked(true);
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const retarget = useCallback((next: string) => setPath(next), []);

  return { path, delivery, checked, retarget };
}
