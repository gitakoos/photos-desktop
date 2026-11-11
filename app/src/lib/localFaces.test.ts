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

import { describe, expect, it } from "vitest";
import {
  facesStatus,
  focusFor,
  inTimelineOrder,
  isScanSpeed,
  scanBusy,
  searchIndexing,
  shownSpeed,
  speedHeld,
  statusLine,
  type FaceScanStatus,
} from "./localFaces";

const status = (over: Partial<FaceScanStatus>): FaceScanStatus => ({
  state: "scanning",
  done: 10,
  total: 100,
  faces: 7,
  accel: "gpu",
  download: null,
  error: null,
  version: 1,
  drive: { savedAt: null, failed: false },
  search: null,
  ...over,
});

describe("face recognition status", () => {
  it("says how far the scan is", () => {
    expect(statusLine(status({}))).toEqual({ key: "faces.state.scanning", values: { done: 10, total: 100, faces: 7 } });
    expect(statusLine(status({ state: "off" }))).toBeNull();
    expect(statusLine(null)).toBeNull();
  });

  it("gives the download in megabytes", () => {
    const line = statusLine(status({ state: "models", download: { done: 12_400_000, total: 48_560_647 } }));
    expect(line).toEqual({ key: "faces.state.models", values: { done: 12, total: 49 } });
  });

  it("counts only the working states as busy", () => {
    expect(scanBusy(status({ state: "scanning" }))).toBe(true);
    expect(scanBusy(status({ state: "done" }))).toBe(false);
    expect(scanBusy(status({ state: "paused" }))).toBe(false);
  });

  it("reads a pass that only builds the search index as faces finished", () => {
    const searchOnly = status({ done: 100, total: 100, search: { indexed: 40, unreadable: 2, total: 100 } });
    expect(facesStatus(searchOnly)?.state).toBe("done");
    expect(scanBusy(facesStatus(searchOnly))).toBe(false);
    expect(searchIndexing(searchOnly)).toBe(true);
    expect(facesStatus(status({}))?.state).toBe("scanning");
  });

  it("reads the search index as indexing only while photos are left and the scan works", () => {
    const full = { indexed: 98, unreadable: 2, total: 100 };
    expect(searchIndexing(status({ search: full }))).toBe(false);
    expect(searchIndexing(status({ state: "paused", search: { ...full, indexed: 10 } }))).toBe(false);
    expect(searchIndexing(status({ search: null }))).toBe(false);
  });
});

describe("a person's photos", () => {
  it("follow the timeline's order and leave out what is gone", () => {
    const order = new Map([
      ["c", 0],
      ["a", 1],
      ["b", 2],
    ]);
    expect(inTimelineOrder(["a", "x", "b", "c"], order)).toEqual(["c", "a", "b"]);
  });
});

describe("the scan speed in Settings", () => {
  it("shows the one picked, else the one this PC starts at, else Balanced", () => {
    const fastPc = status({ speed: { chosen: null, machine: "fast", running: "fast" } });
    expect(shownSpeed("gentle", fastPc)).toBe("gentle");
    expect(shownSpeed(null, fastPc)).toBe("fast");
    expect(shownSpeed(null, status({}))).toBe("balanced");
    expect(shownSpeed(null, null)).toBe("balanced");
  });

  it("says when the battery or a metered connection holds it to Gentle", () => {
    const held = status({ speed: { chosen: "fast", machine: "fast", running: "gentle" } });
    expect(speedHeld("fast", held)).toBe(true);
    expect(speedHeld("gentle", held)).toBe(false);
    expect(speedHeld("fast", status({ speed: { chosen: "fast", machine: "fast", running: "fast" } }))).toBe(false);
    expect(speedHeld("fast", null)).toBe(false);
  });

  it("takes only the three speeds from saved settings", () => {
    expect(isScanSpeed("balanced")).toBe(true);
    expect(isScanSpeed("turbo")).toBe(false);
    expect(isScanSpeed(undefined)).toBe(false);
  });
});

describe("focusFor", () => {
  it("centres a photo on the middle of the face", () => {
    expect(focusFor([{ uid: "a", box: [0.2, 0.4, 0.4, 0.6] }])).toEqual({ a: "30.0% 50.0%" });
  });

  it("keeps the first face of a photo that has two", () => {
    expect(
      focusFor([
        { uid: "a", box: [0, 0, 0.2, 0.2] },
        { uid: "a", box: [0.8, 0.8, 1, 1] },
        { uid: "b", box: [0.8, 0.8, 1, 1] },
      ]),
    ).toEqual({ a: "10.0% 10.0%", b: "90.0% 90.0%" });
  });
});
