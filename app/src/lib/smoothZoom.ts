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

import type L from "leaflet";

/*
 * The map's zoom, drawn a frame at a time.
 *
 * Leaflet zooms with a CSS transition on its panes and, once it ends, takes the transition
 * off and sets the new view. WebKitGTK runs that transition in its compositor, and at the
 * hand-over it drew one frame of the layers without either: the map as it was before the
 * zoom, small, with its pins where they were, between two frames of the new one. Here the
 * map moves to each step of the zoom itself, as Leaflet's own flyTo does, so no transition
 * is ever handed back.
 */

/** How long one zoom takes: Leaflet's own. */
export const ZOOM_MS = 250;

/** The least time between two steps of the wheel that each take the zoom further. */
const WHEEL_GAP_MS = 120;

type Xy = { x: number; y: number };

/** Fast at first, settling at the end, like Leaflet's own zoom. */
export function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * The centre at each scale of a zoom from centre `c0` to centre `c1`, both in pixels at the
 * starting zoom, that grows by `scale` in all. The point of the map that stays at one place
 * on the screen (under the pointer for the wheel, the middle for the buttons) stays there at
 * every step, not only at the end.
 */
export function zoomCentre(c0: Xy, c1: Xy, scale: number): (s: number) => Xy {
  const k = 1 - 1 / scale;
  const ax = (c1.x - c0.x / scale) / k;
  const ay = (c1.y - c0.y / scale) / k;
  return (s) => ({ x: ax + (c0.x - ax) / s, y: ay + (c0.y - ay) / s });
}

/** The parts of Leaflet 1.9.4's map this takes over or calls. */
type Inner = L.Map & {
  _zoom: number;
  /** Leaflet's own "a zoom is under way": its tile layers then wait for the zoom's end before
   * fetching for the view of the moment, and size their fetch for the zoom it goes to. */
  _animatingZoom?: boolean;
  _animateToZoom?: number;
  _animateToCenter?: L.LatLng;
  _move(center: L.LatLng, zoom: number, data?: object): unknown;
  _moveStart(zoomChanged: boolean, noMoveStart: boolean): unknown;
  _moveEnd(zoomChanged: boolean): unknown;
  _stop(): unknown;
  _getCenterOffset(latlng: L.LatLng): L.Point;
  _limitZoom(zoom: number): number;
  _tryAnimatedZoom(center: L.LatLng, zoom: number, options?: L.ZoomOptions & { noMoveStart?: boolean }): boolean;
};

/** The parts of a Leaflet 1.9.4 tile layer the zoom steers. */
type Tiles = {
  _setView(center: L.LatLng, zoom: number, noPrune?: boolean, noUpdate?: boolean): void;
  _setZoomTransforms(center: L.LatLng, zoom: number): void;
  _pruneTiles(): void;
  _retainChildren(x: number, y: number, z: number, maxZoom: number): void;
  _tileZoom?: number;
  _clampZoom(zoom: number): number;
  _updateLevels(): void;
};

const isTiles = (layer: unknown): layer is Tiles =>
  typeof (layer as Tiles | null)?._setView === "function" &&
  typeof (layer as Tiles)._setZoomTransforms === "function" &&
  typeof (layer as Tiles)._pruneTiles === "function";

type Wheel = {
  _delta: number;
  _startTime: number | null;
  _lastMousePos: L.Point;
  _performZoom(): void;
};

type Run = {
  z0: number;
  z1: number;
  center: L.LatLng;
  at: (s: number) => Xy;
  start: number;
  frame: number;
};

/**
 * Makes `map`, made with `zoomAnimation: false`, zoom a frame at a time. Every zoom that
 * Leaflet would have animated goes through here: the wheel, the buttons, the keys, a
 * double-click, a box, an animated setView or fitBounds.
 */
export function smoothZoom(map: L.Map): void {
  const m = map as Inner;
  /** The zoom under way. */
  let run: Run | null = null;
  /** A zoom stopped by `_stop` inside `setView`: the zoom that set it takes it up from there. */
  let cut: Run | null = null;
  /** Inside `setView`, whose `_stop` comes just before the next zoom. */
  let taking = false;
  /** The zoom each tile layer has fetched for. */
  const fetched = new WeakMap<Tiles, Run>();

  /** Tells the tile layers whether a zoom is under way, as Leaflet's own zoom did. */
  const zooming = (r: Run | null) => {
    m._animatingZoom = !!r;
    if (r) {
      m._animateToZoom = r.z1;
      m._animateToCenter = r.center;
    }
  };

  /**
   * A tile layer, steered through each zoom: at its start it fetches the tiles of the zoom it
   * is going to, for the view it will end on, as Leaflet's own zoom did; at each step they
   * are only scaled. Fetched one level at a time as the zoom passed each, a zoom out of three
   * or four levels showed the bare page round the old view, shrinking, for a second or more.
   * The old view's tiles stay under the new until the zoom has ended.
   */
  const steer = (layer: Tiles) => {
    if ((layer as { _smoothZoom?: boolean })._smoothZoom) return;
    (layer as { _smoothZoom?: boolean })._smoothZoom = true;
    const setView = layer._setView;
    const prune = layer._pruneTiles;
    layer._setView = function (this: Tiles, center, zoom, noPrune, noUpdate) {
      const r = run;
      if (!r) return setView.call(this, center, zoom, noPrune, noUpdate);
      if (fetched.get(this) !== r) {
        fetched.set(this, r);
        // The level for the zoom it goes to is made first, at the map's real zoom: a level
        // places itself from the map's zoom as it is made, and made at the zoom faked below it
        // sat millions of pixels off, off the pins by a pixel or two near the street level.
        this._tileZoom = this._clampZoom(Math.round(r.z1));
        this._updateLevels();
        // Sized as at the zoom's end: the layer reads the map's zoom for it.
        const at = m._zoom;
        m._zoom = r.z1;
        try {
          setView.call(this, r.center, r.z1, true, false);
        } finally {
          m._zoom = at;
        }
      }
      this._setZoomTransforms(center, zoom);
    };
    layer._pruneTiles = function (this: Tiles) {
      if (!run) prune.call(this);
    };
    // At a zoom's end the old tiles go once those that replace them are in. Leaflet keeps an
    // old tile for a new one still loading only two levels down, and a zoom out of three or
    // four left the whole view bare until the new tiles came; four levels, the most a zoom
    // animates, are kept now.
    const keep = layer._retainChildren;
    let deep = false;
    layer._retainChildren = function (this: Tiles, x, y, z, maxZoom) {
      if (deep) return keep.call(this, x, y, z, maxZoom);
      deep = true;
      try {
        keep.call(this, x, y, z, maxZoom + 2);
      } finally {
        deep = false;
      }
    };
  };
  map.eachLayer((layer) => {
    if (isTiles(layer)) steer(layer);
  });
  map.on("layeradd", (e) => {
    if (isTiles(e.layer)) steer(e.layer);
  });

  const finish = (r: Run) => {
    zooming(null);
    m._move(r.center, r.z1);
    // The tiles take the end of the zoom even when its last step landed on it exactly, which
    // fires no zoom event: the rest of the view is fetched and the old levels go.
    map.eachLayer((layer) => {
      if (isTiles(layer)) layer._setView(r.center, r.z1);
    });
    m._moveEnd(true);
  };

  const step = () => {
    const r = run;
    if (!r) return;
    const t = Math.min(1, (performance.now() - r.start) / ZOOM_MS);
    if (t >= 1) {
      run = null;
      finish(r);
      return;
    }
    const z = r.z0 + (r.z1 - r.z0) * easeOut(t);
    const c = r.at(m.getZoomScale(z, r.z0));
    // Each step only moves and scales: the tiles were asked for at the zoom's start.
    m._move(m.unproject([c.x, c.y], r.z0), z, { flyTo: true });
    r.frame = requestAnimationFrame(step);
  };

  const stop = m._stop.bind(m);
  m._stop = () => {
    const r = run;
    if (r) {
      cancelAnimationFrame(r.frame);
      run = null;
      // A new view takes the zoom up from where it has got to. Anything else that stops it (a
      // drag, a flight, a pinch, the map going) finds it ended where it was going, with its
      // zoomend, before it reads the view: a drag's bounds are those of the zoom it lands on.
      if (taking) {
        cut = r;
        zooming(null);
      } else finish(r);
    }
    return stop();
  };

  const setView = map.setView.bind(map);
  map.setView = (center, zoom, options) => {
    const was = taking;
    taking = true;
    try {
      return setView(center, zoom, options);
    } finally {
      // A view set at once rather than zoomed to leaves the cut zoom behind: its own
      // zoomstart and zoomend stand for it.
      taking = was;
      // Its zoomstart is answered even when the new view was no zoom at all.
      if (cut) {
        cut = null;
        m.fire("zoomend");
      }
    }
  };

  m._tryAnimatedZoom = (center, zoom, options = {}) => {
    const from = run ?? cut;
    if (run) cancelAnimationFrame(run.frame);
    run = null;
    cut = null;
    zooming(null);
    const far = Math.abs(zoom - m._zoom) > (map.options.zoomAnimationThreshold ?? 4);
    if (options.animate === false || far) return false;
    // As Leaflet: a zoom about a point more than a screen away is a jump, not a zoom.
    const scale = m.getZoomScale(zoom);
    if (scale === 1) {
      if (from) m.fire("zoomend");
      return false;
    }
    const offset = m._getCenterOffset(center).divideBy(1 - 1 / scale);
    if (options.animate !== true && !m.getSize().contains(offset)) return false;
    const z0 = m._zoom;
    const at = zoomCentre(m.project(m.getCenter(), z0), m.project(center, z0), scale);
    // A zoom taken up mid-way has already said it started.
    if (!from) m._moveStart(true, options.noMoveStart ?? false);
    run = { z0, z1: zoom, center, at, start: performance.now(), frame: 0 };
    zooming(run);
    // The tiles of the zoom it goes to are asked for now, not at its first step.
    const now = m.getCenter();
    map.eachLayer((layer) => {
      if (isTiles(layer)) layer._setView(now, z0, true, true);
    });
    run.frame = requestAnimationFrame(step);
    return true;
  };

  /** The zoom the map is at, or on its way to: the next step of the wheel or the buttons
   * starts from there, not from wherever the zoom has got to. */
  const aim = () => (run ? run.z1 : m._zoom);
  const delta = (d?: number) => d || (map.options.zoomDelta ?? 1);
  map.zoomIn = (d, options) => map.setZoom(aim() + delta(d), options);
  map.zoomOut = (d, options) => map.setZoom(aim() - delta(d), options);

  // Leaflet's own wheel step, from where the zoom is going rather than where it has got to:
  // otherwise a second turn of the wheel during a zoom rounds back to the same level.
  const wheel = map.scrollWheelZoom as unknown as Wheel | undefined;
  if (wheel) {
    wheel._performZoom = function (this: Wheel) {
      const snap = map.options.zoomSnap || 0;
      const base = aim();
      const d2 = this._delta / ((map.options.wheelPxPerZoomLevel ?? 60) * 4);
      const d3 = (4 * Math.log(2 / (1 + Math.exp(-Math.abs(d2))))) / Math.LN2;
      const d4 = snap ? Math.ceil(d3 / snap) * snap : d3;
      // A touchpad sends a step every few dozen milliseconds. Leaflet's own zoom took none
      // until the last one had ended; here a step may carry a zoom on, but the zoom stays at
      // most a level and a half ahead of the map, and goes no further ahead within
      // WHEEL_GAP_MS of the last step that did.
      const wanted = base + (this._delta > 0 ? d4 : -d4);
      const zoom = m._limitZoom(run ? Math.max(m._zoom - 1.5, Math.min(m._zoom + 1.5, wanted)) : wanted);
      this._delta = 0;
      this._startTime = null;
      if (zoom === base) return;
      if (run && performance.now() - run.start < WHEEL_GAP_MS && Math.abs(zoom - m._zoom) > Math.abs(run.z1 - m._zoom)) {
        return;
      }
      if (map.options.scrollWheelZoom === "center") map.setZoom(zoom);
      else map.setZoomAround(this._lastMousePos, zoom);
    };
  }

  map.on("unload", () => {
    if (run) cancelAnimationFrame(run.frame);
    run = null;
    cut = null;
    zooming(null);
  });
}
