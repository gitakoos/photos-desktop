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

// Keeps the window in step with the scan on this computer: tells the sidecar what is wanted (face
// recognition, the search index, or both), follows what the scan is doing, and reads the people
// again whenever they change.

import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { sameStatus } from "../lib/sameStatus";
import { scanBusy, type FaceScanStatus, type LocalPeople, type ScanSpeed } from "../lib/localFaces";

/** How often the status is read while the scan works, and while it rests. */
const BUSY_POLL_MS = 2_000;
const IDLE_POLL_MS = 15_000;

export function useLocalFaces(
  enabled: boolean,
  ready: boolean,
  autoMerge: boolean,
  findMore: boolean,
  sync: boolean,
  /** Index the photos for the search by what they show, with or without the faces. */
  index: boolean,
  /** Another device deleted the face data everywhere, and face recognition went off here with it. */
  onOffElsewhere?: () => void,
  /** How fast the scan reads the library; null for the speed this PC starts at. */
  speed: ScanSpeed | null = null,
) {
  const offElsewhere = useRef(onOffElsewhere);
  offElsewhere.current = onOffElsewhere;
  const active = enabled || index;
  const [status, setStatus] = useState<FaceScanStatus | null>(null);
  const [people, setPeople] = useState<LocalPeople | null>(null);
  const peopleVersion = useRef(-1);

  const readPeople = useCallback(async () => {
    try {
      setPeople(await rpc<LocalPeople>("facePeople"));
    } catch {
      /* kept as last read */
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    void rpc<FaceScanStatus>("faceScanSetEnabled", { on: enabled, autoMerge, findMore, sync, index, speed }).then(
      setStatus,
      () => {},
    );
    if (!enabled) {
      peopleVersion.current = -1;
      setPeople(null);
    }
  }, [enabled, ready, autoMerge, findMore, sync, index, speed]);

  useEffect(() => {
    if (!ready || !active) return;
    let live = true;
    let timer = 0;
    const poll = async () => {
      try {
        let next = await rpc<FaceScanStatus>("faceScanStatus");
        if (next.offByWipe) {
          // Off by the delete, not forgotten: the switch here follows, and the scan is not asked again.
          offElsewhere.current?.();
          next = await rpc<FaceScanStatus>("faceWipeSeen");
        } else if (next.state === "off") {
          // A sidecar that started over has forgotten it was asked.
          next = await rpc<FaceScanStatus>("faceScanSetEnabled", { on: enabled, autoMerge, findMore, sync, index, speed });
        }
        if (!live) return;
        // The same answer again keeps the old object, so the views reading it do not draw again.
        setStatus((before) => (sameStatus(before, next) ? before : next));
        if (enabled && next.version !== peopleVersion.current) {
          peopleVersion.current = next.version;
          await readPeople();
        }
        timer = window.setTimeout(poll, scanBusy(next) ? BUSY_POLL_MS : IDLE_POLL_MS);
      } catch {
        if (live) timer = window.setTimeout(poll, IDLE_POLL_MS);
      }
    };
    void poll();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [enabled, active, ready, autoMerge, findMore, sync, index, speed, readPeople]);

  /**
   * Runs one of the face calls, then reads the status and the people again. `then` sees the
   * answer before the people are read, so a page can follow a person whose id changed.
   */
  const act = useCallback(
    async <T,>(method: string, params?: Record<string, unknown>, then?: (out: T) => void): Promise<T> => {
      const out = await rpc<T>(method, params ?? {});
      then?.(out);
      try {
        const next = await rpc<FaceScanStatus>("faceScanStatus");
        // The same answer again keeps the old object, so the views reading it do not draw again.
        setStatus((before) => (sameStatus(before, next) ? before : next));
        peopleVersion.current = next.version;
      } catch {
        /* the next poll reads it */
      }
      if (enabled) await readPeople();
      return out;
    },
    [enabled, readPeople],
  );

  return { status, people, act };
}
