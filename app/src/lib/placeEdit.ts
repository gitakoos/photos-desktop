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

import type { DateEditInfo } from "./dateEdit";

/** A place on the map. */
export type PlacePoint = { lat: number; lon: number };

export type NextPlace =
  | { kind: "change"; place: PlacePoint | null }
  | { kind: "pick" | "same" | "nothing" | "live" | "type" | "read" };

/** Two places count as the same within this many degrees, as the sidecar counts them. */
const SAME_DEGREES = 1e-6;

/**
 * What a photo's place becomes: `target` a point sets it, null takes it away, undefined is no
 * choice made yet. A photo already there, or one that cannot be changed, says why.
 */
export function placeChange(item: DateEditInfo, target: PlacePoint | null | undefined): NextPlace {
  if (target === undefined) return { kind: "pick" };
  if (item.blocked) return { kind: item.blocked };
  if (target === null) return item.place ? { kind: "change", place: null } : { kind: "nothing" };
  if (item.place && Math.abs(item.place[0] - target.lat) < SAME_DEGREES && Math.abs(item.place[1] - target.lon) < SAME_DEGREES) {
    return { kind: "same" };
  }
  return { kind: "change", place: target };
}
