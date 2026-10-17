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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { NEUTRAL_ADJUSTMENTS, type Adjustments, type FilterPreset } from "../lib/editorColor";
import {
  CROP_ASPECTS,
  MIN_CROP_PX,
  boxHeight,
  boxWidth,
  centeredCrop,
  lockRatio,
  pickHandle,
  resizeCrop,
  type CropAspect,
  type CropBox,
  type CropHandle,
} from "../lib/editorCrop";
import {
  encodeFull,
  outputSize,
  renderPreview,
  rotatedSize,
  type EditState,
  type RedactMode,
  type RedactStroke,
  type Rotation,
} from "../lib/editorRender";
import type { EditorSource } from "../lib/localFile";
import { Confirm } from "./Confirm";
import {
  BrushIcon,
  CheckIcon,
  CropIcon,
  FlipHorizontalIcon,
  FlipVerticalIcon,
  PaletteIcon,
  RedoIcon,
  RotateRightIcon,
  TuneIcon,
  UndoIcon,
} from "./icons";
import { useT } from "../lib/i18n";
import "../styles/Editor.css";

type Props = {
  /** Identifies the item being edited; the source reloads when it changes. */
  sourceKey: string;
  /** Loads the pixels and metadata to edit (a local file, or a cloud photo). */
  loadSource: () => Promise<EditorSource>;
  /**
   * Persists the edited JPEG (base64), carrying the source's metadata onto the copy.
   * Returns a value handed straight to `onSaved`: the new local path, or null in the
   * cloud, where the copy is a new node the caller reloads for rather than retargets to.
   */
  saveEdit: (jpegBase64: string, source: EditorSource) => Promise<string | null>;
  /** Close without saving. */
  onClose: () => void;
  /** A copy was written; the caller retargets (local) or reloads (cloud). */
  onSaved: (result: string | null) => void;
};

type Tool = "adjust" | "filters" | "crop" | "redact" | "rotate";

/** The undo model: parameter snapshots, never bitmaps, exactly as the Android editor keeps it. */
type History = { past: EditState[]; present: EditState; future: EditState[] };

/** The live canvas works on a downscaled copy, as the Android editor drives its sliders off a preview. */
const PREVIEW_MAX_EDGE = 1440;
const THUMB_EDGE = 96;
const HISTORY_DEPTH = 30;
/** The grab radius for a crop handle, in displayed pixels; mapped into bitmap space per image. */
const CROP_SLOP_PX = 24;
/** Brush diameter as a fraction of the longest edge, at the two ends of the size control. */
const BRUSH_MIN = 0.02;
const BRUSH_MAX = 0.2;

const ADJUSTMENTS: { key: keyof Omit<Adjustments, "filter">; label: string }[] = [
  { key: "brightness", label: "editor.adj.brightness" },
  { key: "contrast", label: "editor.adj.contrast" },
  { key: "saturation", label: "editor.adj.saturation" },
  { key: "exposure", label: "editor.adj.exposure" },
  { key: "highlights", label: "editor.adj.highlights" },
  { key: "shadows", label: "editor.adj.shadows" },
  { key: "temperature", label: "editor.adj.temperature" },
  { key: "tone", label: "editor.adj.tone" },
];

const FILTERS: { id: FilterPreset; label: string }[] = [
  { id: "none", label: "editor.filter.none" },
  { id: "bw", label: "editor.filter.bw" },
  { id: "sepia", label: "editor.filter.sepia" },
  { id: "vintage", label: "editor.filter.vintage" },
  { id: "vivid", label: "editor.filter.vivid" },
  { id: "cool", label: "editor.filter.cool" },
  { id: "warm", label: "editor.filter.warm" },
];

const TOOLS: { id: Tool; label: string; Icon: (p: { size?: number }) => ReactElement }[] = [
  { id: "adjust", label: "editor.tool.adjust", Icon: TuneIcon },
  { id: "filters", label: "editor.tool.filters", Icon: PaletteIcon },
  { id: "crop", label: "editor.tool.crop", Icon: CropIcon },
  { id: "redact", label: "editor.tool.redact", Icon: BrushIcon },
  { id: "rotate", label: "editor.tool.rotate", Icon: RotateRightIcon },
];

function freshState(): EditState {
  return {
    adjustments: { ...NEUTRAL_ADJUSTMENTS },
    rotation: 0,
    flipH: false,
    flipV: false,
    crop: null,
    redact: [],
  };
}

/** Small objects, so a stringify is the simplest faithful equality here. */
function sameState(a: EditState, b: EditState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** A box that covers the whole image is no crop at all. */
function isFullCrop(b: CropBox, w: number, h: number): boolean {
  return b.left <= 0 && b.top <= 0 && b.right >= w && b.bottom >= h;
}

/**
 * The local photo editor, matching the Android editor's tools and order one for one.
 *
 * The whole edit is held as parameters (an EditState), so the undo history is a stack of
 * cheap snapshots rather than bitmaps. Every change routes through `commit` (a new history
 * entry) or `setLive` (a live update during a drag, folded into one entry on release); the
 * render pipeline is the shared `renderPreview`/`encodeFull`, so the preview on screen and
 * the bytes saved can never diverge.
 */
export function PhotoEditor({ sourceKey, loadSource, saveEdit, onClose, onSaved }: Props) {
  const t = useT();

  const initialRef = useRef<EditState>(freshState());
  const [hist, setHist] = useState<History>(() => ({
    past: [],
    present: initialRef.current,
    future: [],
  }));
  const histRef = useRef(hist);
  histRef.current = hist;
  const present = hist.present;

  const [tool, setTool] = useState<Tool>("adjust");
  const [aspect, setAspect] = useState<CropAspect>("free");
  const [redactMode, setRedactMode] = useState<RedactMode>("black");
  const [brush, setBrush] = useState(0.06);

  const [source, setSource] = useState<EditorSource | null>(null);
  const [ready, setReady] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const imgRef = useRef<HTMLImageElement | null>(null);

  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const savedTimer = useRef<number | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [avail, setAvail] = useState({ w: 0, h: 0 });

  const srcW = source?.width ?? 0;
  const srcH = source?.height ?? 0;

  // ---- History primitives ------------------------------------------------

  const commit = useCallback((next: EditState) => {
    setHist((h) => {
      if (sameState(h.present, next)) return h;
      const past = [...h.past, h.present];
      if (past.length > HISTORY_DEPTH) past.shift();
      return { past, present: next, future: [] };
    });
  }, []);

  /** A live update during a drag: the picture follows, but no history entry is made yet. */
  const setLive = useCallback((next: EditState) => {
    setHist((h) => ({ ...h, present: next }));
  }, []);

  const undo = useCallback(() => {
    setHist((h) => {
      if (h.past.length === 0) return h;
      const past = h.past.slice();
      const prev = past.pop() as EditState;
      return { past, present: prev, future: [h.present, ...h.future] };
    });
  }, []);

  const redo = useCallback(() => {
    setHist((h) => {
      if (h.future.length === 0) return h;
      const [next, ...rest] = h.future;
      const past = [...h.past, h.present];
      if (past.length > HISTORY_DEPTH) past.shift();
      return { past, present: next, future: rest };
    });
  }, []);

  // A drag coalesces into ONE history entry: the state is snapshot at drag start, and
  // pushed on release only if something actually changed.
  const dragBase = useRef<EditState | null>(null);
  const beginDrag = useCallback(() => {
    if (!dragBase.current) dragBase.current = histRef.current.present;
  }, []);
  const endDrag = useCallback(() => {
    const base = dragBase.current;
    dragBase.current = null;
    if (!base) return;
    setHist((h) => {
      if (sameState(base, h.present)) return h;
      const past = [...h.past, base];
      if (past.length > HISTORY_DEPTH) past.shift();
      return { past, present: h.present, future: [] };
    });
  }, []);

  // A release anywhere ends an in-flight drag, so a pointer let go off the control still
  // closes its single history entry.
  useEffect(() => {
    const end = () => endDrag();
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [endDrag]);

  const canUndo = hist.past.length > 0;
  const canRedo = hist.future.length > 0;
  const dirty = !sameState(present, initialRef.current);

  // ---- Source load -------------------------------------------------------

  // The loader is often a fresh closure each render, so it is read through a ref and the
  // effect keys on the item id instead, or the image would reload on every render.
  const loadRef = useRef(loadSource);
  loadRef.current = loadSource;

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setSource(null);
    setLoadErr("");
    imgRef.current = null;
    (async () => {
      try {
        const s = await loadRef.current();
        if (cancelled) return;
        const img = new Image();
        img.onload = () => {
          if (cancelled) return;
          imgRef.current = img;
          setSource(s);
          setReady(true);
        };
        img.onerror = () => {
          if (!cancelled) setLoadErr(t("editor.loadFailed"));
        };
        img.src = s.dataUrl;
      } catch (e) {
        if (!cancelled) setLoadErr(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceKey, t]);

  useEffect(() => {
    return () => {
      if (savedTimer.current) window.clearTimeout(savedTimer.current);
    };
  }, []);

  // ---- Geometry + display fit -------------------------------------------

  // The rotated full-resolution size (crop-null space): the crop rectangle lives here.
  const bounds = useMemo(
    () => (ready ? rotatedSize(srcW, srcH, present.rotation) : { w: 0, h: 0 }),
    [ready, srcW, srcH, present.rotation],
  );

  // The post-geometry output size shown on the stage. The crop tool shows the whole
  // rotated image (crop drawn as an overlay), so it fits to the bounds instead.
  const outSize = useMemo(() => {
    if (!ready) return { w: 0, h: 0 };
    if (tool === "crop") return bounds;
    return outputSize(srcW, srcH, present.rotation, present.crop);
  }, [ready, srcW, srcH, present.rotation, present.crop, tool, bounds]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setAvail({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);

  // The image fitted into the stage, preserving aspect. A uniform scale, so a crop handle
  // stays square and bitmap coordinates map back with one factor.
  const disp = useMemo(() => {
    if (!outSize.w || !outSize.h || !avail.w || !avail.h) return { w: 0, h: 0 };
    const scale = Math.min(avail.w / outSize.w, avail.h / outSize.h);
    return { w: Math.max(1, Math.round(outSize.w * scale)), h: Math.max(1, Math.round(outSize.h * scale)) };
  }, [outSize, avail]);

  // ---- Live canvas render ------------------------------------------------

  useEffect(() => {
    if (!ready || !imgRef.current || !canvasRef.current) return;
    // The crop tool draws the whole rotated image without the crop, and lays the crop
    // rectangle over it; every other tool shows the final composition.
    const view = tool === "crop" ? { ...present, crop: null } : present;
    const out = renderPreview(imgRef.current, srcW, srcH, view, PREVIEW_MAX_EDGE);
    const cv = canvasRef.current;
    cv.width = out.width;
    cv.height = out.height;
    const g = cv.getContext("2d");
    if (g) g.drawImage(out, 0, 0);
  }, [ready, present, tool, srcW, srcH]);

  // Filter thumbnails: the current photo under each preset, neutral but for the filter,
  // rebuilt only when the geometry or the tool changes.
  const thumbs = useMemo(() => {
    if (!ready || !imgRef.current || tool !== "filters") return [];
    return FILTERS.map((f) => {
      const st: EditState = {
        rotation: present.rotation,
        flipH: present.flipH,
        flipV: present.flipV,
        crop: present.crop,
        redact: [],
        adjustments: { ...NEUTRAL_ADJUSTMENTS, filter: f.id },
      };
      const c = renderPreview(imgRef.current as HTMLImageElement, srcW, srcH, st, THUMB_EDGE);
      return { id: f.id, label: f.label, url: c.toDataURL("image/jpeg", 0.82) };
    });
  }, [ready, tool, srcW, srcH, present.rotation, present.flipH, present.flipV, present.crop]);

  // ---- Adjust ------------------------------------------------------------

  function onSlider(key: keyof Omit<Adjustments, "filter">, value: number) {
    setLive({ ...present, adjustments: { ...present.adjustments, [key]: value } });
  }

  // ---- Filters -----------------------------------------------------------

  function pickFilter(id: FilterPreset) {
    commit({ ...present, adjustments: { ...present.adjustments, filter: id } });
  }

  // ---- Crop --------------------------------------------------------------

  const cropDrag = useRef<{ handle: CropHandle; offX: number; offY: number } | null>(null);

  // The rectangle to draw and hit-test: the stored crop, or the full image when there is none.
  const displayCrop: CropBox = present.crop ?? { left: 0, top: 0, right: bounds.w, bottom: bounds.h };

  function pointerToBounds(e: ReactPointerEvent): { bx: number; by: number } {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const bx = ((e.clientX - rect.left) / rect.width) * bounds.w;
    const by = ((e.clientY - rect.top) / rect.height) * bounds.h;
    return { bx: clamp(bx, 0, bounds.w), by: clamp(by, 0, bounds.h) };
  }

  function applyCrop(next: CropBox) {
    const norm = isFullCrop(next, bounds.w, bounds.h) ? null : next;
    setHist((h) => ({ ...h, present: { ...h.present, crop: norm } }));
  }

  function onCropDown(e: ReactPointerEvent) {
    if (!bounds.w || !disp.w) return;
    const { bx, by } = pointerToBounds(e);
    const slop = CROP_SLOP_PX * (bounds.w / disp.w);
    const handle = pickHandle(displayCrop, bx, by, slop);
    if (!handle) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    cropDrag.current = { handle, offX: bx - displayCrop.left, offY: by - displayCrop.top };
    beginDrag();
  }

  function onCropMove(e: ReactPointerEvent) {
    const d = cropDrag.current;
    if (!d) return;
    const { bx, by } = pointerToBounds(e);
    const ratio = lockRatio(aspect, bounds.w, bounds.h);
    // Resize from the live box, so a burst of moves before a re-render still builds on
    // the latest rectangle rather than a stale closure.
    const cur = histRef.current.present.crop ?? { left: 0, top: 0, right: bounds.w, bottom: bounds.h };
    const next = resizeCrop(cur, d.handle, bx, by, ratio, bounds.w, bounds.h, MIN_CROP_PX, d.offX, d.offY);
    applyCrop(next);
  }

  function onCropUp() {
    if (!cropDrag.current) return;
    cropDrag.current = null;
    endDrag();
  }

  function pickAspect(a: CropAspect) {
    setAspect(a);
    // Free keeps whatever box is there and only changes the lock the next drag obeys.
    if (a === "free") return;
    const ratio = lockRatio(a, bounds.w, bounds.h);
    if (ratio == null) return;
    const box = centeredCrop(bounds.w, bounds.h, ratio);
    commit({ ...present, crop: isFullCrop(box, bounds.w, bounds.h) ? null : box });
  }

  // ---- Redact ------------------------------------------------------------

  const strokeIdx = useRef<number | null>(null);

  function onRedactDown(e: ReactPointerEvent) {
    if (!disp.w) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = clamp01((e.clientX - rect.left) / rect.width);
    const y = clamp01((e.clientY - rect.top) / rect.height);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    beginDrag();
    const stroke: RedactStroke = { mode: redactMode, points: [{ x, y }], brush };
    strokeIdx.current = present.redact.length;
    setLive({ ...present, redact: [...present.redact, stroke] });
  }

  function onRedactMove(e: ReactPointerEvent) {
    const idx = strokeIdx.current;
    if (idx == null) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = clamp01((e.clientX - rect.left) / rect.width);
    const y = clamp01((e.clientY - rect.top) / rect.height);
    setHist((h) => {
      const redact = h.present.redact.slice();
      const s = redact[idx];
      if (!s) return h;
      redact[idx] = { ...s, points: [...s.points, { x, y }] };
      return { ...h, present: { ...h.present, redact } };
    });
  }

  function onRedactUp() {
    if (strokeIdx.current == null) return;
    strokeIdx.current = null;
    endDrag();
  }

  function undoStroke() {
    if (present.redact.length === 0) return;
    commit({ ...present, redact: present.redact.slice(0, -1) });
  }
  function clearStrokes() {
    if (present.redact.length === 0) return;
    commit({ ...present, redact: [] });
  }

  // ---- Rotate / flip -----------------------------------------------------

  // A rotated or flipped crop is fiddly to remap, so it is dropped: the tool resets the
  // crop to null (and the aspect to free) on any turn or flip, which is safe and correct.
  function rotate() {
    commit({ ...present, rotation: ((present.rotation + 90) % 360) as Rotation, crop: null });
    setAspect("free");
  }
  function flipHorizontal() {
    commit({ ...present, flipH: !present.flipH, crop: null });
    setAspect("free");
  }
  function flipVertical() {
    commit({ ...present, flipV: !present.flipV, crop: null });
    setAspect("free");
  }

  // ---- Save / cancel -----------------------------------------------------

  const requestCancel = useCallback(() => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  }, [busy, dirty, onClose]);

  async function save() {
    if (busy || !ready || !imgRef.current || !source) return;
    setBusy(true);
    setSaveErr("");
    try {
      const base64 = await encodeFull(imgRef.current, srcW, srcH, present);
      const result = await saveEdit(base64, source);
      setSaved(true);
      // A beat of confirmation before the caller retargets or reloads, which unmounts this.
      savedTimer.current = window.setTimeout(() => onSaved(result), 850);
    } catch {
      setSaveErr(t("editor.saveFailed"));
      setBusy(false);
    }
  }

  // ---- Keyboard ----------------------------------------------------------
  // No dependency list: the handlers close over the current render, and re-binding each
  // render keeps them fresh. Registered in the capture phase and swallowed here so the
  // viewer underneath never steps its folder (which would swap the file mid-edit).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (confirmDiscard) return; // the discard dialog owns the keys while it is up
      e.stopPropagation();
      const meta = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") {
        e.preventDefault();
        requestCancel();
      } else if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (meta && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // ---- Render ------------------------------------------------------------

  const banner = saveErr ? (
    <div className="ed-banner error">{saveErr}</div>
  ) : saved ? (
    <div className="ed-banner ok">{t("editor.saved")}</div>
  ) : loadErr ? (
    <div className="ed-banner error">{loadErr}</div>
  ) : null;

  return (
    <div className="ed-root" onClick={(e) => e.stopPropagation()}>
      <div className="ed-topbar">
        <div className="ed-topbar-left">
          <button className="ed-text-btn" onClick={requestCancel} disabled={busy}>
            {t("editor.cancel")}
          </button>
        </div>
        <div className="ed-topbar-title">{t("editor.title")}</div>
        <div className="ed-topbar-right">
          <button
            className="ed-ibtn"
            onClick={undo}
            disabled={!canUndo || busy}
            title={t("editor.undo")}
            aria-label={t("editor.undo")}
          >
            <UndoIcon size={16} />
          </button>
          <button
            className="ed-ibtn"
            onClick={redo}
            disabled={!canRedo || busy}
            title={t("editor.redo")}
            aria-label={t("editor.redo")}
          >
            <RedoIcon size={16} />
          </button>
          <button className="ed-save" onClick={() => void save()} disabled={busy || !ready}>
            <CheckIcon size={14} />
            {busy && !saved ? t("editor.saving") : t("editor.save")}
          </button>
        </div>
      </div>

      <div className="ed-stage" ref={stageRef}>
        {banner}
        {ready ? (
          <div className="ed-canvas-wrap" style={{ width: disp.w, height: disp.h }}>
            <canvas className="ed-canvas" ref={canvasRef} />
            {tool === "crop" && bounds.w > 0 && (
              <div
                className="ed-overlay crop"
                onPointerDown={onCropDown}
                onPointerMove={onCropMove}
                onPointerUp={onCropUp}
              >
                <CropOverlay box={displayCrop} boundsW={bounds.w} boundsH={bounds.h} />
              </div>
            )}
            {tool === "redact" && (
              <div
                className="ed-overlay redact"
                onPointerDown={onRedactDown}
                onPointerMove={onRedactMove}
                onPointerUp={onRedactUp}
              />
            )}
          </div>
        ) : (
          <p className="ed-stage-msg">{loadErr || t("common.loading")}</p>
        )}
      </div>

      <div className="ed-controls">
        {tool === "adjust" && (
          <div className="ed-adjust">
            {ADJUSTMENTS.map(({ key, label }) => {
              const v = present.adjustments[key];
              const p = (v + 100) / 2;
              const lo = Math.min(50, p);
              const hi = Math.max(50, p);
              const fill = `linear-gradient(90deg, var(--surface-2) ${lo}%, var(--accent) ${lo}%, var(--accent) ${hi}%, var(--surface-2) ${hi}%)`;
              return (
                <div className="ed-slider-row" key={key}>
                  <span className="ed-slider-label">{t(label)}</span>
                  <input
                    className="ed-range"
                    type="range"
                    min={-100}
                    max={100}
                    step={1}
                    value={v}
                    style={{ background: fill }}
                    onPointerDown={beginDrag}
                    onChange={(e) => onSlider(key, Number(e.currentTarget.value))}
                  />
                  <span className="ed-slider-val">{v > 0 ? `+${v}` : v}</span>
                </div>
              );
            })}
          </div>
        )}

        {tool === "filters" && (
          <div className="ed-filters">
            {thumbs.map((f) => (
              <button
                key={f.id}
                className={`ed-filter ${present.adjustments.filter === f.id ? "sel" : ""}`}
                onClick={() => pickFilter(f.id)}
              >
                <img className="ed-filter-thumb" src={f.url} alt="" />
                <span>{t(f.label)}</span>
              </button>
            ))}
          </div>
        )}

        {tool === "crop" && (
          <div className="ed-chiprow">
            {CROP_ASPECTS.map((a) => (
              <button
                key={a}
                className={`ed-chip ${aspect === a ? "sel" : ""}`}
                onClick={() => pickAspect(a)}
              >
                {a === "free" ? t("editor.crop.free") : a === "original" ? t("editor.crop.original") : a}
              </button>
            ))}
          </div>
        )}

        {tool === "redact" && (
          <div className="ed-redact">
            <div className="ed-redact-row">
              <button
                className={`ed-chip ${redactMode === "black" ? "sel" : ""}`}
                onClick={() => setRedactMode("black")}
              >
                {t("editor.redact.black")}
              </button>
              <button
                className={`ed-chip ${redactMode === "pixelate" ? "sel" : ""}`}
                onClick={() => setRedactMode("pixelate")}
              >
                {t("editor.redact.pixelate")}
              </button>
              <div className="ed-brush">
                <span className="ed-brush-label">{t("editor.redact.brush")}</span>
                <input
                  className="ed-range"
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(((brush - BRUSH_MIN) / (BRUSH_MAX - BRUSH_MIN)) * 100)}
                  onChange={(e) =>
                    setBrush(BRUSH_MIN + (Number(e.currentTarget.value) / 100) * (BRUSH_MAX - BRUSH_MIN))
                  }
                />
              </div>
            </div>
            <div className="ed-redact-row">
              <button className="ed-mini-btn" onClick={undoStroke} disabled={present.redact.length === 0}>
                {t("editor.redact.undoStroke")}
              </button>
              <button className="ed-mini-btn" onClick={clearStrokes} disabled={present.redact.length === 0}>
                {t("editor.redact.clear")}
              </button>
            </div>
          </div>
        )}

        {tool === "rotate" && (
          <div className="ed-rotate">
            <button className="ed-action" onClick={rotate}>
              <RotateRightIcon size={18} />
              {t("editor.rotate")}
            </button>
            <button className="ed-action" onClick={flipHorizontal}>
              <FlipHorizontalIcon size={18} />
              {t("editor.flipH")}
            </button>
            <button className="ed-action" onClick={flipVertical}>
              <FlipVerticalIcon size={18} />
              {t("editor.flipV")}
            </button>
          </div>
        )}
      </div>

      <div className="ed-tabs">
        {TOOLS.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={`ed-tab ${tool === id ? "sel" : ""}`}
            onClick={() => setTool(id)}
          >
            <span className="ed-tab-icon">
              <Icon size={20} />
            </span>
            {t(label)}
          </button>
        ))}
      </div>

      {confirmDiscard && (
        <Confirm
          title={t("editor.discardTitle")}
          message={t("editor.discardBody")}
          confirmLabel={t("editor.discardConfirm")}
          danger
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            setConfirmDiscard(false);
            onClose();
          }}
        />
      )}
    </div>
  );
}

/**
 * The crop rectangle over the image: a dimming mask everywhere but the crop, a thin frame,
 * a thirds grid, and eight handles. Drawn in bitmap-bounds coordinates via the SVG viewBox,
 * which the uniform fit scales to the display, so the handles stay square without any math.
 */
function CropOverlay({ box, boundsW, boundsH }: { box: CropBox; boundsW: number; boundsH: number }) {
  const w = boxWidth(box);
  const h = boxHeight(box);
  // Constant on-screen weight: strokes and handles are drawn in bounds units, so they are
  // divided back by the scale the viewBox applies. The longer edge is the reference.
  const k = Math.max(boundsW, boundsH) / 320;
  const handle = 10 * k;
  const stroke = 1.5 * k;
  const corners: [number, number][] = [
    [box.left, box.top],
    [box.right, box.top],
    [box.left, box.bottom],
    [box.right, box.bottom],
  ];
  const edges: [number, number][] = [
    [(box.left + box.right) / 2, box.top],
    [(box.left + box.right) / 2, box.bottom],
    [box.left, (box.top + box.bottom) / 2],
    [box.right, (box.top + box.bottom) / 2],
  ];
  return (
    <svg className="ed-crop-svg" viewBox={`0 0 ${boundsW} ${boundsH}`} preserveAspectRatio="none">
      {/* Dim outside the crop: the whole frame, with the crop punched out (even-odd). */}
      <path
        d={`M0 0H${boundsW}V${boundsH}H0Z M${box.left} ${box.top}H${box.right}V${box.bottom}H${box.left}Z`}
        fill="rgba(0,0,0,0.5)"
        fillRule="evenodd"
      />
      {/* Thirds grid inside the crop. */}
      <g stroke="rgba(255,255,255,0.35)" strokeWidth={stroke * 0.6}>
        <line x1={box.left + w / 3} y1={box.top} x2={box.left + w / 3} y2={box.bottom} />
        <line x1={box.left + (2 * w) / 3} y1={box.top} x2={box.left + (2 * w) / 3} y2={box.bottom} />
        <line x1={box.left} y1={box.top + h / 3} x2={box.right} y2={box.top + h / 3} />
        <line x1={box.left} y1={box.top + (2 * h) / 3} x2={box.right} y2={box.top + (2 * h) / 3} />
      </g>
      <rect
        x={box.left}
        y={box.top}
        width={w}
        height={h}
        fill="none"
        stroke="#fff"
        strokeWidth={stroke}
      />
      {[...corners, ...edges].map(([x, y], i) => (
        <rect
          key={i}
          x={x - handle / 2}
          y={y - handle / 2}
          width={handle}
          height={handle}
          rx={handle * 0.25}
          fill="#fff"
        />
      ))}
    </svg>
  );
}
