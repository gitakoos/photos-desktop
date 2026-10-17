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
import { useT } from "../lib/i18n";
import "../styles/PhotoViewer.css";

const MIN_SCALE = 1; // scale 1 is "fit the whole photo on screen"
const MAX_SCALE = 8;
const STEP = 1.25;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

type View = { scale: number; x: number; y: number };
const FIT: View = { scale: 1, x: 0, y: 0 };

/**
 * Zoomable, pannable photo surface.
 *
 * At scale 1 the photo is fitted to the surface, never cropped and never larger
 * than the window, whatever its pixel dimensions. Zoom goes up from there:
 * wheel to zoom around the cursor, drag to pan, double click toggles fit and
 * one-to-one pixels.
 */
export function PhotoViewer({
  src,
  loading,
  photoKey,
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
}) {
  const t = useT();
  const [view, setView] = useState<View>(FIT);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const panRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  // A new photo always starts fitted. A sharper source for the SAME photo must not
  // reset it: the user may already have zoomed in, and that is exactly when the
  // upgrade matters most.
  useEffect(() => {
    setView(FIT);
    setNatural(null);
  }, [photoKey ?? src]);

  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    setView((v) => {
      const next = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      if (next === v.scale) return v;
      if (next === MIN_SCALE) return FIT; // snapping back to fit re-centres

      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return { ...v, scale: next };

      // Keep the point under the cursor pinned while the scale changes.
      const cx = clientX - rect.left - rect.width / 2;
      const cy = clientY - rect.top - rect.height / 2;
      const k = next / v.scale;
      return { scale: next, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  }, []);

  // React attaches wheel passively, so bind it natively to be able to preventDefault.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? STEP : 1 / STEP);
    }
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  function onMouseDown(e: React.MouseEvent) {
    if (view.scale === 1 || e.button !== 0) return;
    e.preventDefault();
    panRef.current = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y };
  }

  function onMouseMove(e: React.MouseEvent) {
    const pan = panRef.current;
    if (!pan) return;
    setView((v) => ({ ...v, x: pan.ox + (e.clientX - pan.x), y: pan.oy + (e.clientY - pan.y) }));
  }

  function endPan() {
    panRef.current = null;
  }

  /** The scale at which one image pixel covers one screen pixel. */
  function oneToOneScale(): number {
    const img = imgRef.current;
    if (!img || !natural || img.clientWidth === 0 || img.clientHeight === 0) return 2;
    // `object-fit: contain` letterboxes, so the drawn width is not the box width.
    const aspect = natural.w / natural.h;
    const drawnWidth = Math.min(img.clientWidth, img.clientHeight * aspect);
    return clamp(natural.w / drawnWidth, MIN_SCALE, MAX_SCALE);
  }

  function onDoubleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (view.scale > 1) setView(FIT);
    else zoomAt(e.clientX, e.clientY, oneToOneScale());
  }

  const zoomed = view.scale > 1;
  const percent = Math.round(view.scale * 100);

  return (
    <div
      className={`pv ${zoomed ? "zoomed" : ""} ${panRef.current ? "panning" : ""}`}
      ref={wrapRef}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endPan}
      onMouseLeave={endPan}
      onDoubleClick={onDoubleClick}
      onClick={(e) => e.stopPropagation()}
    >
      <img
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

      <div className="pv-zoom" onClick={(e) => e.stopPropagation()}>
        <button
          className="pv-zbtn"
          disabled={view.scale <= MIN_SCALE}
          onClick={() => setView((v) => (v.scale / STEP <= 1 ? FIT : { ...v, scale: v.scale / STEP }))}
          title={t("viewer.zoomOut")}
        >
          −
        </button>
        <button className="pv-zval" onClick={() => setView(FIT)} title={t("viewer.resetFit")}>
          {percent}%
        </button>
        <button
          className="pv-zbtn"
          disabled={view.scale >= MAX_SCALE}
          onClick={() => setView((v) => ({ ...v, scale: clamp(v.scale * STEP, MIN_SCALE, MAX_SCALE) }))}
          title={t("viewer.zoomIn")}
        >
          +
        </button>
        {natural && <span className="pv-dims">{`${natural.w} × ${natural.h}`}</span>}
      </div>
    </div>
  );
}
