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

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { useT } from "../lib/i18n";
import "../styles/PhotoViewer.css";

export const MIN_SCALE = 1; // scale 1 is "fit the whole photo on screen"
/** The least the zoom reaches over the fit, and the photo's own pixels it reaches at least. */
const MAX_OVER_FIT = 8;
const MAX_ACTUAL = 4;
/** One step of the bar's zoom buttons. */
export const ZOOM_STEP = 1.25;
/** How far one notch of a mouse wheel zooms, and the most one event may. */
const WHEEL_RATE = 0.0022;
const WHEEL_MAX = 1.6;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

type View = { scale: number; x: number; y: number };
const FIT: View = { scale: 1, x: 0, y: 0 };

/** Where the photo stands: its zoom over the fit, the photo's pixels, and how big the fit draws them. */
export type ZoomState = {
  scale: number;
  /** The furthest this photo zooms in: eight times the fit, or 400 % of its pixels if more. */
  maxScale: number;
  natural: { w: number; h: number } | null;
  /** Screen pixels per photo pixel at the fit, so the shown percent is the photo's own. */
  fitRatio: number;
};

/** The zoom controls the viewer's status bar drives. */
export type ZoomApi = {
  zoomBy: (factor: number) => void;
  setScale: (scale: number) => void;
  fit: () => void;
  /** One photo pixel to one screen pixel, or the fit when that is larger. */
  actual: () => void;
};

/**
 * Zoomable, pannable photo surface.
 *
 * At scale 1 the photo is fitted to the surface, never cropped and never larger
 * than the window, whatever its pixel dimensions. Zoom goes up from there:
 * wheel to zoom around the cursor, drag to pan, double click toggles fit and
 * one-to-one pixels. Every zoom eases into place; only a drag follows the pointer
 * as it is.
 */
export function PhotoViewer({
  src,
  loading,
  photoKey,
  apiRef,
  onZoom,
}: {
  src?: string;
  loading?: boolean;
  /**
   * Which photo `src` belongs to. One photo goes through several sources as it upgrades
   * to full resolution, and the fit must survive that, so the reset is keyed on the
   * photo rather than on the source. Callers without one fall back to the source, which
   * is the old behaviour of resetting on every change.
   */
  photoKey?: string;
  /** Filled with the controls the status bar drives. */
  apiRef?: MutableRefObject<ZoomApi | null>;
  /** Told whenever the zoom, the photo's size or the fit changes. */
  onZoom?: (z: ZoomState) => void;
}) {
  const t = useT();
  const [view, setView] = useState<View>(FIT);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const [fitRatio, setFitRatio] = useState(1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const panRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const maxScale = Math.max(MAX_OVER_FIT, fitRatio > 0 ? MAX_ACTUAL / fitRatio : MAX_OVER_FIT);
  const maxRef = useRef(maxScale);
  maxRef.current = maxScale;

  // A new photo always starts fitted. A sharper source for the SAME photo must not
  // reset it: the user may already have zoomed in, and that is exactly when the
  // upgrade matters most.
  useEffect(() => {
    setView(FIT);
    setNatural(null);
  }, [photoKey ?? src]);

  // The fit's size follows the window, so the percent shown stays the photo's own.
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const measure = () => {
      if (!natural || !img.clientWidth || !img.clientHeight) return;
      const drawnW = Math.min(img.clientWidth, img.clientHeight * (natural.w / natural.h));
      setFitRatio(drawnW / natural.w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(img);
    return () => ro.disconnect();
  }, [natural]);

  useEffect(() => {
    onZoom?.({ scale: view.scale, maxScale, natural, fitRatio });
  }, [view.scale, maxScale, natural, fitRatio, onZoom]);

  const zoomAt = useCallback((clientX: number | null, clientY: number | null, factor: number) => {
    setView((v) => {
      const next = clamp(v.scale * factor, MIN_SCALE, maxRef.current);
      if (next === v.scale) return v;
      if (next === MIN_SCALE) return FIT; // snapping back to fit re-centres

      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return { ...v, scale: next };

      // Keep the point under the cursor pinned while the scale changes; the bar's
      // controls zoom about the middle.
      const cx = clientX == null ? 0 : clientX - rect.left - rect.width / 2;
      const cy = clientY == null ? 0 : clientY - rect.top - rect.height / 2;
      const k = next / v.scale;
      return { scale: next, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  }, []);

  /** The scale at which one photo pixel covers one screen pixel. */
  const oneToOneScale = useCallback((): number => {
    if (!natural || fitRatio <= 0) return 2;
    return clamp(1 / fitRatio, MIN_SCALE, maxRef.current);
  }, [natural, fitRatio]);

  if (apiRef) {
    apiRef.current = {
      zoomBy: (f) => zoomAt(null, null, f),
      setScale: (s) => setView((v) => zoomFrom(v, s, maxRef.current)),
      fit: () => setView(FIT),
      actual: () => setView((v) => zoomFrom(v, oneToOneScale(), maxRef.current)),
    };
  }

  /** Whether a point on screen falls on the drawn photo, not on the ground around it. */
  const onPhoto = useCallback(
    (clientX: number, clientY: number): boolean => {
      const img = imgRef.current;
      if (!img || !natural) return false;
      const r = img.getBoundingClientRect();
      const scale = Math.min(r.width / natural.w, r.height / natural.h);
      const w = natural.w * scale;
      const h = natural.h * scale;
      const left = r.left + (r.width - w) / 2;
      const top = r.top + (r.height - h) / 2;
      return clientX >= left && clientX <= left + w && clientY >= top && clientY <= top + h;
    },
    [natural],
  );

  // React attaches wheel passively, so bind it natively to be able to preventDefault.
  // The factor follows how far the wheel turned, so a trackpad's small steps zoom
  // smoothly and a mouse notch still steps about a quarter.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      // The wheel zooms where the photo is; over the ground around it it does nothing.
      if (!onPhoto(e.clientX, e.clientY)) return;
      const factor = clamp(Math.exp(-e.deltaY * WHEEL_RATE), 1 / WHEEL_MAX, WHEEL_MAX);
      zoomAt(e.clientX, e.clientY, factor);
    }
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [zoomAt, onPhoto]);

  function onMouseDown(e: React.MouseEvent) {
    if (view.scale === 1 || e.button !== 0) return;
    e.preventDefault();
    panRef.current = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y };
    setPanning(true);
  }

  function onMouseMove(e: React.MouseEvent) {
    const pan = panRef.current;
    if (!pan) return;
    setView((v) => ({ ...v, x: pan.ox + (e.clientX - pan.x), y: pan.oy + (e.clientY - pan.y) }));
  }

  function endPan() {
    panRef.current = null;
    setPanning(false);
  }

  function onDoubleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (view.scale > 1) setView(FIT);
    else if (!onPhoto(e.clientX, e.clientY)) return;
    else zoomAt(e.clientX, e.clientY, oneToOneScale());
  }

  const zoomed = view.scale > 1;

  return (
    <div
      className={`pv ${zoomed ? "zoomed" : ""} ${panning ? "panning" : ""}`}
      ref={wrapRef}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endPan}
      onMouseLeave={endPan}
      onDoubleClick={onDoubleClick}
      onClick={(e) => e.stopPropagation()}
    >
      <img
        // A new photo is a new element, so it fades in rather than replacing the last one
        // in a single frame; a sharper source for the same photo swaps in place.
        key={photoKey ?? src}
        ref={imgRef}
        className="pv-img"
        src={src}
        alt=""
        draggable={false}
        onLoad={(e) =>
          setNatural({
            w: e.currentTarget.naturalWidth,
            h: e.currentTarget.naturalHeight,
          })
        }
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
      />

      {loading && (
        <div className="pv-loading" role="status" aria-live="polite">
          <span className="pv-spinner" aria-hidden="true" />
          <span>{t("common.loading")}</span>
        </div>
      )}
    </div>
  );
}

/** `v` zoomed to `scale` about the middle, the fit when that is all the way out. */
function zoomFrom(v: View, scale: number, max: number): View {
  const next = clamp(scale, MIN_SCALE, max);
  if (next === MIN_SCALE) return FIT;
  const k = next / v.scale;
  return { scale: next, x: v.x * k, y: v.y * k };
}
