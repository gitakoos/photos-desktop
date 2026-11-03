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
import { PersonAddIcon } from "./icons";
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
  faceTags,
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
  /** The faces found on the photo, tagged over it and kept on their faces through zoom and pan. */
  faceTags?: FaceTag[];
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

  // Where the image element sits in the stage, untouched by the zoom's transform: what the
  // face tags are placed from. Read again whenever the stage changes size.
  const [frame, setFrame] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
  useEffect(() => {
    const img = imgRef.current;
    const wrap = wrapRef.current;
    if (!img || !wrap) return;
    const read = () => setFrame({ l: img.offsetLeft, t: img.offsetTop, w: img.offsetWidth, h: img.offsetHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [natural]);

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

      {faceTags && faceTags.length > 0 && natural && frame && (
        <FaceTags tags={faceTags} natural={natural} frame={frame} view={view} moving={panning} />
      )}

      {loading && (
        <div className="pv-loading" role="status" aria-live="polite">
          <span className="pv-spinner" aria-hidden="true" />
          <span>{t("common.loading")}</span>
        </div>
      )}
    </div>
  );
}

/** One face to tag: its box in fractions of the photo, its name if it has one, and what a click does. */
export type FaceTag = {
  key: string;
  box: [number, number, number, number];
  name: string | null;
  /** Opens the person; for a face without a name, offers to name it. */
  onClick?: () => void;
};

const TAG_H = 26;
const TAG_GAP = 6;

/**
 * Name tags pinned over the faces, as the Android viewer draws them. Each box is mapped from
 * the photo to the screen through the same fit and transform the image rides, so a tag stays on
 * its face while the photo is zoomed and panned, yet keeps its own size. A label goes under its
 * face, or above it, or is nudged down off a label already placed, so a group photo reads as a
 * set of names rather than one pile.
 */
function FaceTags({
  tags,
  natural,
  frame,
  view,
  moving,
}: {
  tags: FaceTag[];
  natural: { w: number; h: number };
  frame: { l: number; t: number; w: number; h: number };
  view: View;
  moving: boolean;
}) {
  const t = useT();
  const ar = natural.w / natural.h;
  const dw = Math.min(frame.w, frame.h * ar);
  const dh = dw / ar;
  const dx = frame.l + (frame.w - dw) / 2;
  const dy = frame.t + (frame.h - dh) / 2;
  const cx = frame.l + frame.w / 2;
  const cy = frame.t + frame.h / 2;
  const toScreen = (fx: number, fy: number) => ({
    x: cx + (dx + fx * dw - cx) * view.scale + view.x,
    y: cy + (dy + fy * dh - cy) * view.scale + view.y,
  });
  const placed: { l: number; t: number; r: number; b: number }[] = [];
  const free = (l: number, top: number, w: number) =>
    !placed.some((p) => p.l < l + w && p.r > l && p.t < top + TAG_H && p.b > top);
  // The stage the tags are kept inside: the image element's box and the margin around it.
  const stageW = frame.l * 2 + frame.w;
  const stageH = frame.t * 2 + frame.h;
  const onStage = tags
    .map((tag) => ({ tag, a: toScreen(tag.box[0], tag.box[1]), b: toScreen(tag.box[2], tag.box[3]) }))
    // A face panned or zoomed out of sight takes its tag with it.
    .filter(({ a, b }) => b.x > 0 && b.y > 0 && a.x < stageW && a.y < stageH);
  const out = onStage.map(({ tag, a, b }) => {
    const w = Math.max(TAG_H, (tag.name?.length ?? 0) * 7.5 + (tag.name ? 22 : 0));
    const left = Math.min(Math.max(4, (a.x + b.x) / 2 - w / 2), stageW - w - 4);
    let top = b.y + TAG_GAP;
    if (!free(left, top, w)) {
      const above = a.y - TAG_GAP - TAG_H;
      if (free(left, above, w)) top = above;
      else for (let i = 0; i < 8 && !free(left, top, w); i++) top += TAG_H + TAG_GAP;
    }
    placed.push({ l: left, t: top, r: left + w, b: top + TAG_H });
    return { tag, box: { l: a.x, t: a.y, w: b.x - a.x, h: b.y - a.y }, pill: { l: left, t: top, w } };
  });
  return (
    <div className={`pv-tags${moving ? " moving" : ""}`}>
      {out.map(({ tag, box, pill }) => (
        <div key={tag.key}>
          <span className="pv-face" style={{ left: box.l, top: box.t, width: box.w, height: box.h }} />
          <button
            className={`pv-tag${tag.name ? "" : " add"}`}
            style={{ left: pill.l, top: pill.t, minWidth: pill.w }}
            title={tag.name ?? t("people.addName")}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              tag.onClick?.();
            }}
          >
            {tag.name ?? <PersonAddIcon size={14} />}
          </button>
        </div>
      ))}
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
