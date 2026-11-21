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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlbumAddPhotos } from "./AlbumAddPhotos";
import { Confirm } from "./Confirm";
import { RulerSlider } from "./PhotoEditor";
import {
  ArrowBackIcon,
  AspectRatioIcon,
  CheckIcon,
  CloudUploadIcon,
  ContentCopyIcon,
  GridOnIcon,
  ImageIcon,
  SpinnerIcon,
  SwapHorizIcon,
  TuneIcon,
} from "./icons";
import { saveCloudEdit } from "../lib/cloudEditor";
import {
  CORNER_MAX,
  COLLAGE_EXPORT_EDGE,
  COLLAGE_RATIO_IDS,
  COLLAGE_RATIOS,
  SPACING_MAX,
  cellAt,
  collageFileName,
  collageSize,
  collageTemplates,
  coverPlacement,
  freshCell,
  panAfterDrag,
  photoEdgeFor,
  replaceCell,
  swapCells,
  zoomAfterWheel,
  clampPan,
  clampZoom,
  type CollageCell,
  type CollageRatio,
} from "../lib/collageLayout";
import {
  cellRects,
  drawCollage,
  encodeCollage,
  loadCollagePhoto,
  type CollagePhoto,
  type CollageSpec,
} from "../lib/collageRender";
import { useT } from "../lib/i18n";
import "../styles/Editor.css";
import "../styles/Collage.css";

type Tab = "layout" | "ratio" | "border";

/** A timeline photo the replace picker offers. */
type Candidate = { uid: string; captureTime: number; tags?: number[] };

const BACKGROUNDS = ["#ffffff", "#f3eee5", "#c9ced6", "#8d939c", "#3a3f47", "#000000", "#1d2b44"];
const SAVE_EDGES = [COLLAGE_EXPORT_EDGE, 2048, 1024];
const SAVED_PAUSE_MS = 850;
const PAN_KEY_STEP = 0.1;
const ZOOM_KEY_STEP = 1.15;
const SWAP_DRAG_PX = 5;
const LOAD_PARALLEL = 2;

/**
 * The collage maker, built like the photo editor: round buttons on top, the picture, then
 * the open tab's panel over a pill of tabs. Each cell pans and zooms its own photo; two
 * photos trade places by dragging one onto the other. The picture is drawn by the same
 * `drawCollage` the export uses, so the saved file matches what is on screen.
 */
export function Collage({
  uids,
  candidates,
  cellSize,
  onClose,
  onSaved,
}: {
  uids: string[];
  /** The timeline photos the replace picker offers. */
  candidates: Candidate[];
  cellSize: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const count = uids.length;
  const templates = useMemo(() => collageTemplates(count), [count]);

  const [tab, setTab] = useState<Tab>("layout");
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [ratio, setRatio] = useState<CollageRatio>("1:1");
  const [spacing, setSpacing] = useState(10);
  const [corners, setCorners] = useState(0);
  const [background, setBackground] = useState(BACKGROUNDS[0]);
  const [cells, setCells] = useState<CollageCell[]>(() => uids.map(freshCell));
  const [selected, setSelected] = useState<number | null>(null);
  // The cell whose photo is to be swapped: the next cell picked takes its place.
  const [swapFrom, setSwapFrom] = useState<number | null>(null);
  const [dropOver, setDropOver] = useState<number | null>(null);
  const [replaceAt, setReplaceAt] = useState<number | null>(null);

  const [photos, setPhotos] = useState<Map<string, CollagePhoto>>(new Map());
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [saveOpen, setSaveOpen] = useState(false);
  const [edge, setEdge] = useState(COLLAGE_EXPORT_EDGE);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const [saveErr, setSaveErr] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const savedTimer = useRef<number | null>(null);
  const [avail, setAvail] = useState({ w: 0, h: 0 });

  const template = templates.find((x) => x.id === templateId) ?? templates[0];
  const spec: CollageSpec = { template, cells, spacing, corners, background };
  const specRef = useRef(spec);
  specRef.current = spec;
  const photosRef = useRef(photos);
  photosRef.current = photos;

  const touch = useCallback(() => setDirty(true), []);

  // ---- Loading ------------------------------------------------------------

  const requested = useRef(new Set<string>());
  const queue = useRef<string[]>([]);
  const running = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (savedTimer.current != null) window.clearTimeout(savedTimer.current);
    };
  }, []);

  const pump = useCallback(() => {
    while (running.current < LOAD_PARALLEL && queue.current.length > 0) {
      const uid = queue.current.shift() as string;
      running.current++;
      void loadCollagePhoto(uid, photoEdgeFor(count))
        .then((p) => {
          if (alive.current) setPhotos((m) => new Map(m).set(uid, p));
        })
        .catch(() => {
          if (alive.current) setFailed((f) => new Set(f).add(uid));
        })
        .finally(() => {
          running.current--;
          pump();
        });
    }
  }, [count]);

  useEffect(() => {
    for (const c of cells) {
      if (requested.current.has(c.uid)) continue;
      requested.current.add(c.uid);
      queue.current.push(c.uid);
    }
    pump();
  }, [cells, pump]);

  const ready = cells.every((c) => photos.has(c.uid));
  const anyFailed = cells.some((c) => failed.has(c.uid));

  // ---- Geometry -----------------------------------------------------------

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      setAvail({ w: Math.max(0, el.clientWidth - padX), h: Math.max(0, el.clientHeight - padY) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const aspect = COLLAGE_RATIOS[ratio];
  const dispW = Math.max(0, Math.floor(Math.min(avail.w, avail.h * aspect)));
  const dispH = dispW > 0 ? Math.max(1, Math.round(dispW / aspect)) : 0;
  const rects = useMemo(
    () => (dispW > 0 ? cellRects({ template, cells, spacing, corners, background }, dispW, dispH) : []),
    [template, cells, spacing, corners, background, dispW, dispH],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || dispW <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(dispW * dpr);
    canvas.height = Math.round(dispH * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawCollage(ctx, dispW, dispH, { template, cells, spacing, corners, background }, photos);
  }, [template, cells, spacing, corners, background, photos, dispW, dispH]);

  // ---- Editing the cells ----------------------------------------------------

  const patchCell = useCallback(
    (i: number, patch: Partial<CollageCell>) => {
      setCells((list) => list.map((c, k) => (k === i ? { ...c, ...patch } : c)));
      touch();
    },
    [touch],
  );

  function swap(a: number, b: number) {
    setCells((list) => swapCells(list, a, b));
    setSelected(b);
    touch();
  }

  function localPoint(e: { clientX: number; clientY: number }) {
    const box = overlayRef.current?.getBoundingClientRect();
    return box ? { x: e.clientX - box.left, y: e.clientY - box.top } : { x: -1, y: -1 };
  }

  // Dragging inside a cell moves its photo within the frame.
  const pan = useRef<{ i: number; x: number; y: number; panX: number; panY: number } | null>(null);

  function onOverlayDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || busy) return;
    if ((e.target as HTMLElement).closest(".cl-pill")) return;
    const p = localPoint(e);
    const i = cellAt(rects, p.x, p.y);
    if (swapFrom != null) {
      if (i >= 0 && i !== swapFrom) swap(swapFrom, i);
      setSwapFrom(null);
      return;
    }
    setSelected(i >= 0 ? i : null);
    if (i < 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pan.current = { i, x: e.clientX, y: e.clientY, panX: cells[i].panX, panY: cells[i].panY };
  }

  function onOverlayMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = pan.current;
    if (!d) return;
    const photo = photos.get(cells[d.i]?.uid ?? "");
    const r = rects[d.i];
    if (!photo || !r) return;
    const base = coverPlacement(photo.w, photo.h, r.w, r.h, cells[d.i].zoom, 0, 0);
    const panX = panAfterDrag(d.panX, e.clientX - d.x, base.w - r.w);
    const panY = panAfterDrag(d.panY, e.clientY - d.y, base.h - r.h);
    if (panX !== cells[d.i].panX || panY !== cells[d.i].panY) patchCell(d.i, { panX, panY });
  }

  function onOverlayUp() {
    pan.current = null;
  }

  function onOverlayWheel(e: React.WheelEvent<HTMLDivElement>) {
    if (busy) return;
    const p = localPoint(e);
    const i = cellAt(rects, p.x, p.y);
    if (i < 0) return;
    setSelected(i);
    patchCell(i, { zoom: zoomAfterWheel(cells[i].zoom, e.deltaY) });
  }

  function onCellKey(e: React.KeyboardEvent, i: number) {
    const c = cells[i];
    const step = PAN_KEY_STEP;
    let handled = true;
    if (e.key === "ArrowLeft") patchCell(i, { panX: clampPan(c.panX + step) });
    else if (e.key === "ArrowRight") patchCell(i, { panX: clampPan(c.panX - step) });
    else if (e.key === "ArrowUp") patchCell(i, { panY: clampPan(c.panY + step) });
    else if (e.key === "ArrowDown") patchCell(i, { panY: clampPan(c.panY - step) });
    else if (e.key === "+" || e.key === "=") patchCell(i, { zoom: clampZoom(c.zoom * ZOOM_KEY_STEP) });
    else if (e.key === "-") patchCell(i, { zoom: clampZoom(c.zoom / ZOOM_KEY_STEP) });
    else handled = false;
    if (handled) e.preventDefault();
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (swapFrom != null && swapFrom !== i) {
        swap(swapFrom, i);
        setSwapFrom(null);
      } else setSelected(i);
    }
  }

  // The swap button: a click starts "pick the other photo", a drag from it onto another
  // cell swaps at once.
  const swapDrag = useRef<{ from: number; x: number; y: number; moved: boolean } | null>(null);

  function onSwapDown(e: ReactPointerEvent<HTMLButtonElement>, i: number) {
    if (e.button !== 0 || busy) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    swapDrag.current = { from: i, x: e.clientX, y: e.clientY, moved: false };
  }

  function onSwapMove(e: ReactPointerEvent<HTMLButtonElement>) {
    const d = swapDrag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > SWAP_DRAG_PX) d.moved = true;
    if (!d.moved) return;
    const p = localPoint(e);
    const over = cellAt(rects, p.x, p.y);
    setDropOver(over >= 0 && over !== d.from ? over : null);
  }

  function onSwapUp(e: ReactPointerEvent<HTMLButtonElement>) {
    const d = swapDrag.current;
    swapDrag.current = null;
    if (!d) return;
    setDropOver(null);
    if (!d.moved) {
      setSwapFrom((cur) => (cur === d.from ? null : d.from));
      return;
    }
    const p = localPoint(e);
    const over = cellAt(rects, p.x, p.y);
    if (over >= 0 && over !== d.from) swap(d.from, over);
  }

  function replacePhoto(uid: string) {
    if (replaceAt == null) return;
    setCells((list) => replaceCell(list, replaceAt, uid));
    setFailed((f) => {
      const next = new Set(f);
      next.delete(uid);
      return next;
    });
    setReplaceAt(null);
    touch();
  }

  // ---- Saving ---------------------------------------------------------------

  const canSave = ready && !busy && !saved;

  function openSave() {
    if (!canSave) return;
    setSaveErr(false);
    setSwapFrom(null);
    setSaveOpen((o) => !o);
  }

  async function runSave(kind: "drive" | "computer") {
    if (!canSave) return;
    setBusy(true);
    setSaveErr(false);
    try {
      const size = collageSize(ratio, edge);
      const base64 = await encodeCollage(specRef.current, photosRef.current, size.w, size.h, "jpeg");
      if (kind === "drive") {
        await saveCloudEdit(base64, {
          name: "Collage",
          fileStem: "Collage",
          captureTime: Date.now(),
          camera: null,
          latitude: null,
          longitude: null,
        });
      } else {
        const path = await invoke<string | null>("save_image_as", {
          defaultName: collageFileName(new Date(), "jpg"),
          imageBase64: base64,
          format: "jpeg",
        });
        if (path == null) {
          setBusy(false);
          return;
        }
      }
      setSaved(t(kind === "drive" ? "collage.savedDrive" : "collage.savedComputer"));
      savedTimer.current = window.setTimeout(() => {
        // Drive has a new photo to show; a file on the computer changes nothing here.
        if (kind === "drive") onSaved();
        else onClose();
      }, SAVED_PAUSE_MS);
    } catch {
      setSaveErr(true);
      setBusy(false);
    }
  }

  const requestClose = useCallback(() => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  }, [busy, dirty, onClose]);

  // Registered in the capture phase and swallowed here, so the grid underneath never reacts to
  // Escape or Save. A picker or dialog on top owns its own keys, and a cell its arrows.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (confirmDiscard || replaceAt != null) return;
      const field = e.target instanceof HTMLElement && e.target.closest("input, textarea");
      if (field) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        if (swapFrom != null) setSwapFrom(null);
        else if (saveOpen) {
          if (!busy) setSaveOpen(false);
        } else requestClose();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.stopPropagation();
        e.preventDefault();
        openSave();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  // ---- Render -----------------------------------------------------------------

  const banner = saveErr ? (
    <div className="ed-banner error">{t("collage.saveFailed")}</div>
  ) : saved ? (
    <div className="ed-banner ok">{saved}</div>
  ) : anyFailed ? (
    <div className="ed-banner error">{t("collage.loadFailed")}</div>
  ) : swapFrom != null ? (
    <div className="ed-banner ok">{t("collage.swapHint")}</div>
  ) : null;

  let panel;
  if (tab === "layout") {
    panel = (
      <div className="cl-templates" role="listbox" aria-label={t("collage.tab.layout")}>
        {templates.map((tp, k) => (
          <button
            key={tp.id}
            role="option"
            aria-selected={tp.id === template.id}
            className={`cl-tpl ${tp.id === template.id ? "sel" : ""}`}
            title={t("collage.layoutN", { n: k + 1 })}
            aria-label={t("collage.layoutN", { n: k + 1 })}
            onClick={() => {
              setTemplateId(tp.id);
              touch();
            }}
          >
            {tp.cells.map((c, j) => (
              <i
                key={j}
                style={{
                  left: `${c.x0 * 100}%`,
                  top: `${c.y0 * 100}%`,
                  width: `${(c.x1 - c.x0) * 100}%`,
                  height: `${(c.y1 - c.y0) * 100}%`,
                }}
              />
            ))}
          </button>
        ))}
      </div>
    );
  } else if (tab === "ratio") {
    panel = (
      <div className="ed-ratios" role="radiogroup" aria-label={t("collage.tab.ratio")}>
        {COLLAGE_RATIO_IDS.map((id) => (
          <button
            key={id}
            role="radio"
            aria-checked={ratio === id}
            className={`ed-ratio ${ratio === id ? "sel" : ""}`}
            onClick={() => {
              setRatio(id);
              touch();
            }}
          >
            {id}
          </button>
        ))}
      </div>
    );
  } else {
    panel = (
      <div className="cl-border">
        <div className="ed-ruler-row">
          <span className="cl-label">{t("collage.spacing")}</span>
          <RulerSlider
            label={t("collage.spacing")}
            value={spacing}
            min={0}
            max={SPACING_MAX}
            compact
            onChange={(v) => {
              setSpacing(Math.round(v));
              touch();
            }}
          />
          <span className="ed-ruler-val">{spacing}</span>
        </div>
        <div className="ed-ruler-row">
          <span className="cl-label">{t("collage.corners")}</span>
          <RulerSlider
            label={t("collage.corners")}
            value={corners}
            min={0}
            max={CORNER_MAX}
            compact
            onChange={(v) => {
              setCorners(Math.round(v));
              touch();
            }}
          />
          <span className="ed-ruler-val">{corners}</span>
        </div>
        <div className="ed-ruler-row">
          <span className="cl-label">{t("collage.background")}</span>
          <div className="cl-swatches">
            {BACKGROUNDS.map((c) => (
              <button
                key={c}
                className={`cl-swatch ${background === c ? "sel" : ""}`}
                style={{ background: c }}
                title={c}
                aria-label={`${t("collage.background")} ${c}`}
                aria-pressed={background === c}
                onClick={() => {
                  setBackground(c);
                  touch();
                }}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const tabs: { id: Tab; label: string; Icon: typeof GridOnIcon }[] = [
    { id: "layout", label: "collage.tab.layout", Icon: GridOnIcon },
    { id: "ratio", label: "collage.tab.ratio", Icon: AspectRatioIcon },
    { id: "border", label: "collage.tab.border", Icon: TuneIcon },
  ];

  const savePanel = (
    <aside className="ed-side" aria-label={t("collage.saveTitle")}>
      <div className="ed-side-head">
        <span className="ed-side-title">{t("collage.saveTitle")}</span>
      </div>
      <div className="ed-side-body">
        <section className="ed-sec">
          <div className="ed-sec-head">
            <span className="ed-sec-title">{t("collage.size")}</span>
          </div>
          <div className="ed-chips">
            {SAVE_EDGES.map((px) => (
              <button
                key={px}
                className={`ed-chip ${edge === px ? "sel" : ""}`}
                onClick={() => setEdge(px)}
                disabled={busy}
              >
                {px}
              </button>
            ))}
          </div>
        </section>
        <button className="ed-save-option" onClick={() => void runSave("drive")} disabled={!canSave}>
          <span className="ed-save-option-icon">
            {busy && !saved ? (
              <span className="ed-spin">
                <SpinnerIcon size={18} />
              </span>
            ) : (
              <CloudUploadIcon size={20} />
            )}
          </span>
          <span className="ed-save-option-text">
            <span className="ed-save-option-title">{t("collage.saveDriveTitle")}</span>
            <span className="ed-save-option-sub">{t("collage.saveDriveSub")}</span>
          </span>
        </button>
        <button className="ed-save-option" onClick={() => void runSave("computer")} disabled={!canSave}>
          <span className="ed-save-option-icon">
            <ContentCopyIcon size={20} />
          </span>
          <span className="ed-save-option-text">
            <span className="ed-save-option-title">{t("collage.saveComputerTitle")}</span>
            <span className="ed-save-option-sub">{t("collage.saveComputerSub")}</span>
          </span>
        </button>
        <button className="ed-side-btn wide" onClick={() => setSaveOpen(false)} disabled={busy}>
          <span>{t("common.cancel")}</span>
        </button>
      </div>
    </aside>
  );

  return (
    <div className="ed-root" role="dialog" aria-label={t("collage.title")} onClick={(e) => e.stopPropagation()}>
      <div className="ed-topbar">
        <button
          className="ed-bubble"
          onClick={requestClose}
          disabled={busy}
          title={t("collage.back")}
          aria-label={t("collage.back")}
        >
          <ArrowBackIcon size={20} />
        </button>
        <span className="cl-title">{t("collage.title")}</span>
        <div className="ed-topbar-right">
          <button
            className={`ed-save ${saveOpen ? "open" : ""}`}
            onClick={openSave}
            disabled={!canSave}
            title={t("collage.save")}
            aria-label={t("collage.save")}
            aria-expanded={saveOpen}
          >
            {busy && !saved ? (
              <span className="ed-spin">
                <SpinnerIcon size={16} />
              </span>
            ) : (
              <CheckIcon size={20} />
            )}
          </button>
        </div>
      </div>

      <div className="ed-main">
        <div className="ed-stage" ref={stageRef}>
          {banner}
          {dispW > 0 && (
            <div className="cl-frame" style={{ width: dispW, height: dispH }}>
              <canvas ref={canvasRef} className="cl-canvas" style={{ width: dispW, height: dispH }} />
              <div
                ref={overlayRef}
                className={`cl-overlay ${swapFrom != null ? "picking" : ""}`}
                onPointerDown={onOverlayDown}
                onPointerMove={onOverlayMove}
                onPointerUp={onOverlayUp}
                onPointerCancel={onOverlayUp}
                onWheel={onOverlayWheel}
              >
                {rects.map((r, i) => {
                  const on = selected === i;
                  return (
                    <div
                      key={i}
                      role="button"
                      tabIndex={0}
                      aria-label={t("collage.cellN", { n: i + 1 })}
                      className={`cl-cell ${on ? "sel" : ""} ${swapFrom === i ? "swapsrc" : ""} ${dropOver === i ? "drop" : ""}`}
                      style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
                      onFocus={() => setSelected(i)}
                      onKeyDown={(e) => onCellKey(e, i)}
                    >
                      {on && swapFrom == null && !busy && (
                        <div className="cl-pill">
                          <button
                            className="cl-pill-btn"
                            title={t("collage.swap")}
                            aria-label={t("collage.swap")}
                            onPointerDown={(e) => onSwapDown(e, i)}
                            onPointerMove={onSwapMove}
                            onPointerUp={onSwapUp}
                            onPointerCancel={onSwapUp}
                            onClick={(e) => {
                              // A pointer press is handled on release; a click with no pointer
                              // (the keyboard) starts the pick here.
                              if (e.detail === 0) setSwapFrom(i);
                            }}
                          >
                            <SwapHorizIcon size={16} />
                          </button>
                          <button
                            className="cl-pill-btn"
                            title={t("collage.replace")}
                            aria-label={t("collage.replace")}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => setReplaceAt(i)}
                          >
                            <ImageIcon size={16} />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {!ready && !anyFailed && <div className="cl-loading">{t("collage.loading")}</div>}
            </div>
          )}
        </div>
        <div className="ed-side-slot">{saveOpen ? savePanel : null}</div>
      </div>

      <div className="ed-bottom">
        <div className="ed-panel" key={tab}>
          {panel}
        </div>
        <div className="ed-tabs" role="tablist">
          {tabs.map(({ id, label, Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`ed-tab ${tab === id ? "sel" : ""}`}
              onClick={() => setTab(id)}
              title={t(label)}
              aria-label={t(label)}
            >
              <span className="ed-tab-icon">
                <Icon size={24} />
              </span>
              <span className="ed-tab-label">{t(label)}</span>
            </button>
          ))}
        </div>
      </div>

      {replaceAt != null && (
        <AlbumAddPhotos
          albumName=""
          title={t("collage.replaceTitle")}
          confirmLabel={t("collage.replaceConfirm")}
          single
          candidates={candidates}
          cellSize={cellSize}
          busy={false}
          onConfirm={(picked) => picked[0] && replacePhoto(picked[0])}
          onClose={() => setReplaceAt(null)}
        />
      )}
      {confirmDiscard && (
        <Confirm
          title={t("collage.discardTitle")}
          message={t("collage.discardBody")}
          confirmLabel={t("collage.discardConfirm")}
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
