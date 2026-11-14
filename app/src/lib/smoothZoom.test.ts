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

import { afterAll, describe, expect, it, vi } from "vitest";
import type L from "leaflet";
import { easeOut, smoothZoom, zoomCentre } from "./smoothZoom";

describe("a zoom drawn a frame at a time", () => {
  it("starts at the old centre and ends at the new one", () => {
    const at = zoomCentre({ x: 100, y: 50 }, { x: 140, y: 90 }, 2);
    expect(at(1)).toEqual({ x: 100, y: 50 });
    const end = at(2);
    expect(end.x).toBeCloseTo(140);
    expect(end.y).toBeCloseTo(90);
  });

  it("keeps the point under the pointer in place at every step", () => {
    // The pointer 200 px right of the middle, zooming in one level: setZoomAround's centre.
    const c0 = { x: 1000, y: 500 };
    const pointer = { x: 1200, y: 500 };
    const c1 = { x: c0.x + (pointer.x - c0.x) * (1 - 1 / 2), y: 500 };
    const at = zoomCentre(c0, c1, 2);
    for (const s of [1, 1.2, 1.5, 1.9, 2]) {
      const c = at(s);
      // Where the pointer's spot is on the screen, from the middle, at this scale.
      expect((pointer.x - c.x) * s).toBeCloseTo(pointer.x - c0.x);
    }
  });

  it("zooms out about a point as well", () => {
    const at = zoomCentre({ x: 0, y: 0 }, { x: -30, y: 10 }, 0.5);
    const end = at(0.5);
    expect(end.x).toBeCloseTo(-30);
    expect(end.y).toBeCloseTo(10);
  });

  it("eases from 0 to 1", () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
  });
});

/** Just enough of a Leaflet map for the zoom's own bookkeeping: a flat world, one pixel a
 * unit at zoom 0, and the order its events come in. */
function fakeMap(tiles?: object) {
  const events: string[] = [];
  const pt = (x: number, y: number) => ({
    x,
    y,
    divideBy: (n: number) => pt(x / n, y / n),
  });
  const ll = (lat: number, lng: number) => ({ lat, lng, equals: (o: { lat: number; lng: number }) => o.lat === lat && o.lng === lng });
  const map = {
    _zoom: 3,
    centre: ll(0, 0),
    options: { zoomAnimationThreshold: 4, zoomDelta: 1 },
    events,
    getZoomScale: (to: number, from?: number) => 2 ** (to - (from ?? map._zoom)),
    getCenter: () => map.centre,
    getSize: () => ({ contains: () => true }),
    project: (c: { lat: number; lng: number }, z: number) => pt(c.lng * 2 ** z, c.lat * 2 ** z),
    unproject: ([x, y]: [number, number], z: number) => ll(y / 2 ** z, x / 2 ** z),
    _getCenterOffset: () => pt(0, 0),
    _limitZoom: (z: number) => Math.round(z),
    _moveStart: () => events.push("zoomstart"),
    _move: (c: ReturnType<typeof ll>, z: number) => {
      map._zoom = z;
      map.centre = c;
    },
    _moveEnd: () => events.push("zoomend"),
    _stop: () => undefined,
    _tryAnimatedZoom: (() => false) as (c: unknown, z: number, o?: object) => boolean,
    layers: [] as unknown[],
    eachLayer: (fn: (l: unknown) => void) => map.layers.forEach(fn),
    on: () => undefined,
    fire: (name: string) => events.push(name),
    setView(c: ReturnType<typeof ll>, z: number, o?: { animate?: boolean }) {
      map._stop();
      if (!map._tryAnimatedZoom(c, z, o)) {
        events.push("zoomstart");
        map._move(c, z);
        events.push("zoomend");
      }
      return map;
    },
    setZoom: (z: number, o?: object) => map.setView(map.centre, z, o),
    zoomIn: (_d?: number) => map,
    zoomOut: (_d?: number) => map,
  };
  if (tiles) map.layers.push(tiles);
  smoothZoom(map as unknown as L.Map);
  return map;
}

describe("the zoom's bookkeeping", () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  afterAll(() => vi.unstubAllGlobals());

  it("ends a zoom another move stops where it was going, there and then, with its zoomend", () => {
    const map = fakeMap();
    map.zoomIn();
    expect(map.events).toEqual(["zoomstart"]);
    map._stop(); // as a drag starting
    expect(map.events).toEqual(["zoomstart", "zoomend"]);
    expect(map._zoom).toBe(4);
  });

  it("takes a zoom up mid-way when the next one comes, with one zoomstart for both", () => {
    const map = fakeMap();
    map.zoomIn();
    map.zoomIn(); // from where the first was going: 5, not 4 again
    map._stop();
    expect(map.events).toEqual(["zoomstart", "zoomend"]);
    expect(map._zoom).toBe(5);
  });

  it("lets a view set at once replace a zoom under way", () => {
    const map = fakeMap();
    map.zoomIn();
    map.setZoom(1, { animate: false });
    expect(map._zoom).toBe(1);
    map._stop();
    expect(map._zoom).toBe(1);
  });

  it("has the tiles fetch for where the zoom ends, at its start, and keeps the old ones till then", () => {
    const calls: string[] = [];
    let mapZoom = 0;
    const tiles = {
      _setView(_c: unknown, zoom: number, _noPrune?: boolean, noUpdate?: boolean) {
        calls.push(`view ${zoom} ${noUpdate ? "scale" : `fetch at map zoom ${mapZoom}`}`);
      },
      _setZoomTransforms: (_c: unknown, zoom: number) => calls.push(`scale ${zoom}`),
      _pruneTiles: () => calls.push("prune"),
      _retainChildren: () => undefined,
      _tileZoom: undefined as number | undefined,
      _clampZoom: (z: number) => z,
      _updateLevels: () => calls.push("level"),
    };
    const map = fakeMap(tiles);
    const move = map._move;
    map._move = (c: Parameters<typeof move>[0], z: number, data?: object) => {
      move(c, z);
      // As the layer does on each zoom event: a step of a zoom only scales.
      tiles._setView(c, z, !!data, !!data);
    };
    Object.defineProperty(map, "_zoom", {
      get: () => mapZoom,
      set: (z: number) => {
        mapZoom = z;
      },
    });
    mapZoom = 3;
    map.zoomOut(); // to 2
    expect(calls).toEqual(["level", "view 2 fetch at map zoom 2", "scale 3"]);
    expect(tiles._tileZoom).toBe(2);
    tiles._pruneTiles();
    expect(calls).not.toContain("prune");
    frames.splice(0).forEach((f) => f(0));
    map._stop();
    expect(calls[calls.length - 1]).toBe("view 2 fetch at map zoom 2");
    tiles._pruneTiles();
    expect(calls[calls.length - 1]).toBe("prune");
  });
});
