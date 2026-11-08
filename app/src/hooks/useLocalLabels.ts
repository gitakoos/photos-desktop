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
import { rpc } from "../lib/rpc";

/** A label kept on this computer, with the Drive link ids of its photos. */
export type LocalLabel = { name: string; keys: string[] };

/** How often the window asks whether the labels changed, also by a copy taken in from Drive. */
const LOOK_EVERY_MS = 4000;

/**
 * The labels kept on this computer, read again whenever they change, and the way to change them:
 * `act` runs one of the label calls and reads the labels back after it.
 */
export function useLocalLabels(enabled: boolean): {
  labels: LocalLabel[];
  loaded: boolean;
  act: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
} {
  const [labels, setLabels] = useState<LocalLabel[]>([]);
  const [loaded, setLoaded] = useState(false);
  const seen = useRef(-1);

  const read = useCallback(async () => {
    const list = await rpc<{ version: number; labels: LocalLabel[] }>("labelsList");
    seen.current = list.version;
    setLabels(list.labels);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLabels([]);
      setLoaded(false);
      seen.current = -1;
      return;
    }
    let live = true;
    let timer = 0;
    const look = async () => {
      try {
        const version = await rpc<number>("labelsVersion");
        if (live && version !== seen.current) await read();
      } catch {
        /* locked or busy: the next look tries again */
      }
      if (live) timer = window.setTimeout(look, LOOK_EVERY_MS);
    };
    void look();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [enabled, read]);

  const act = useCallback(
    async (method: string, params?: Record<string, unknown>) => {
      const result = await rpc(method, params);
      await read().catch(() => {});
      return result;
    },
    [read],
  );

  return { labels, loaded, act };
}
