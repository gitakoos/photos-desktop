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

// Face recognition on this computer, as the window sees it: what the scan is doing, and the
// people it made, turned into the cards and lists the library pages draw.

/** What `faceScanStatus` answers. */
export type FaceScanStatus = {
  state: "off" | "models" | "waiting" | "scanning" | "grouping" | "finding" | "paused" | "done" | "failed";
  done: number;
  total: number;
  faces: number;
  accel: "gpu" | "cpu" | null;
  download: { done: number; total: number } | null;
  error: string | null;
  /** Goes up whenever the people change. */
  version: number;
  /** This computer's copy on Drive: when it was last saved, and whether the last try failed. */
  drive: { savedAt: number | null; failed: boolean };
  /** The search index made here: photos with a vector, those that could not be read, and the library. */
  search: { indexed: number; unreadable: number; total: number } | null;
  /** Set when another device deleted the face data everywhere and face recognition went off here. */
  offByWipe?: number | null;
  /** The speed picked (null for this PC's own), this PC's own, and the one the scan runs at now. */
  speed?: { chosen: ScanSpeed | null; machine: ScanSpeed; running: ScanSpeed };
};

/** How fast the scan on this computer reads the library. */
export type ScanSpeed = "gentle" | "balanced" | "fast";

export const SCAN_SPEEDS: readonly ScanSpeed[] = ["gentle", "balanced", "fast"];

export function isScanSpeed(value: unknown): value is ScanSpeed {
  return typeof value === "string" && (SCAN_SPEEDS as readonly string[]).includes(value);
}

/** The speed Settings shows as picked: the one chosen, else the one this PC starts at, else Balanced. */
export function shownSpeed(chosen: ScanSpeed | null, status: FaceScanStatus | null): ScanSpeed {
  return chosen ?? status?.speed?.machine ?? "balanced";
}

/** Whether the scan runs Gentle for now, for the battery or a metered connection, instead of the speed shown. */
export function speedHeld(shown: ScanSpeed, status: FaceScanStatus | null): boolean {
  return shown !== "gentle" && status?.speed?.running === "gentle";
}

export type PersonView = {
  id: string;
  name: string | null;
  isOther: boolean;
  uids: string[];
  cover: { uid: string; box: [number, number, number, number] } | null;
};

/** "Might be the same person": an unnamed group and the named person it is close to. */
export type FaceSuggestion = { unnamed: string; named: string; similarity: number };

/** A face in no group worth naming. */
export type LooseFace = { faceId: string; uid: string; box: [number, number, number, number] };

/** A face on one photo, with who it is; `name` is null for an unnamed group or none. */
export type PhotoFace = {
  faceId: string;
  box: [number, number, number, number];
  personId: string | null;
  name: string | null;
};

/** One of a person's faces: the photo it is on and where on it. */
export type PersonFace = { uid: string; box: [number, number, number, number] };

/** What `facePeople` answers. */
export type LocalPeople = {
  named: PersonView[];
  unnamed: PersonView[];
  leftover: number;
  suggestions: FaceSuggestion[];
  loose: { faces: LooseFace[]; total: number };
};

/** Whether the scan is still working through the library, as against finished or waiting. */
export function scanBusy(status: FaceScanStatus | null): boolean {
  return !!status && ["models", "waiting", "scanning", "grouping", "finding"].includes(status.state);
}

/**
 * The scan as face recognition sees it. A pass that only builds the search index leaves the
 * faces' count full, so here it reads as finished.
 */
export function facesStatus(status: FaceScanStatus | null): FaceScanStatus | null {
  if (status?.state === "scanning" && status.total > 0 && status.done >= status.total) return { ...status, state: "done" };
  return status;
}

/** Whether the search index made here still has photos to read. */
export function searchIndexing(status: FaceScanStatus | null): boolean {
  const search = status?.search;
  return !!search && search.indexed + search.unreadable < search.total && scanBusy(status);
}

/**
 * A person's photos in the timeline's order, newest first, keeping only those still in it;
 * `order` maps a uid to its place.
 */
export function inTimelineOrder(uids: string[], order: Map<string, number>): string[] {
  return uids.filter((u) => order.has(u)).sort((a, b) => order.get(a)! - order.get(b)!);
}

/**
 * Where to centre each photo on a person's page, as a CSS object-position by uid: on the middle
 * of the first of their faces listed for that photo.
 */
export function focusFor(faces: { uid: string; box: number[] }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { uid, box } of faces) {
    if (out[uid]) continue;
    const [left, top, right, bottom] = box;
    out[uid] = `${(((left + right) / 2) * 100).toFixed(1)}% ${(((top + bottom) / 2) * 100).toFixed(1)}%`;
  }
  return out;
}

/** The status line under the switch, as a key and its values; null when there is nothing to say. */
export function statusLine(status: FaceScanStatus | null): { key: string; values?: Record<string, string | number> } | null {
  if (!status) return null;
  switch (status.state) {
    case "off":
      return null;
    case "models":
      return status.download
        ? {
            key: "faces.state.models",
            values: {
              done: Math.round(status.download.done / 1_000_000),
              total: Math.round(status.download.total / 1_000_000),
            },
          }
        : { key: "faces.state.preparing" };
    case "waiting":
      return { key: "faces.state.waiting" };
    case "scanning":
      return { key: "faces.state.scanning", values: { done: status.done, total: status.total, faces: status.faces } };
    case "grouping":
      return { key: "faces.state.grouping" };
    case "finding":
      return { key: "faces.state.finding", values: { done: status.done, total: status.total } };
    case "paused":
      return { key: "faces.state.paused", values: { done: status.done, total: status.total } };
    case "done":
      return { key: "faces.state.done", values: { total: status.total, faces: status.faces } };
    case "failed":
      return { key: "faces.state.failed" };
  }
}
