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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { NEUTRAL_ADJUSTMENTS, type Adjustments, type FilterPreset } from "../lib/editorColor";
import {
  CROP_ASPECTS,
  MIN_CROP_PX,
  centeredCrop,
  lockRatio,
  pickHandle,
  resizeCrop,
  type CropAspect,
  type CropBox,
  type CropHandle,
} from "../lib/editorCrop";
import {
  applyFrame,
  applyGeometry,
  applyPixels,
  base64FromBytes,
  facesInRender,
  warpCanvas,
  encodeFull,
  DEFAULT_SAVE,
  type SaveFormat,
  type SaveOptions,
  outputSize,
  rotatedSize,
  type EditState,
  type RedactMode,
  type RedactStroke,
  type Rotation,
} from "../lib/editorRender";
import { AUTO_FIX_SAMPLE, autoFix, rulerSpan, rulerValueAt } from "../lib/editorTone";
import {
  DRAW_COLORS,
  drawOverlays,
  hexToHsv,
  hsvToHex,
  inTurnedBox,
  newText,
  snapTextAngle,
  textBox,
  textFont,
  type DrawStroke,
  type TextItem,
} from "../lib/editorOverlay";
import type { EditorSource } from "../lib/localFile";
import { FACE_INPUT, FACE_PAD_GREY, NO_FACES, coversFromHits, letterbox, type FaceStyle } from "../lib/editorFaces";
import { rpc } from "../lib/rpc";
import {
  HSL_SWATCHES,
  IDENTITY_CURVE,
  curveValueAt,
  hslIsNeutral,
  isIdentityCurve,
  neutralColor,
  type CurveChannel,
  type CurvePoint,
  type HslBand,
} from "../lib/editorCurves";
import {
  FRAME_SHAPES,
  FRAME_SNAP_PX,
  FRAME_WHITE,
  afterGesture,
  borderRange,
  frameCanvas,
  frameFills,
  frameForShape,
  shapeOf,
  snappedToCentre,
  withBorder,
  type FrameFill,
  type FrameShape,
  type FrameSpec,
} from "../lib/editorFrame";
import { Confirm } from "./Confirm";
import {
  ArrowBackIcon,
  AspectRatioIcon,
  AutoFixIcon,
  BlockIcon,
  BrightnessIcon,
  BrushIcon,
  CheckIcon,
  CloudUploadIcon,
  ContentCopyIcon,
  ContrastIcon,
  CropRotateIcon,
  DrawIcon,
  FlipHorizontalIcon,
  FlipVerticalIcon,
  GridOnIcon,
  LightModeIcon,
  PaletteIcon,
  RedoIcon,
  RestoreIcon,
  RotateRightIcon,
  SpinnerIcon,
  SwapHorizIcon,
  TonalityIcon,
  TuneIcon,
  UndoIcon,
  DeblurIcon,
  GradientIcon,
  SortIcon,
  StraightenIcon,
  FormatColorFillIcon,
  LineWeightIcon,
  OpacityIcon,
  PencilIcon,
  PlusIcon,
  RoundedCornerIcon,
  TextIcon,
  TrashIcon,
  FaceIcon,
  AppsIcon,
  ColorizeIcon,
  FilterFramesIcon,
  GrainIcon,
  VignetteIcon,
  WaterDropIcon,
} from "./icons";
import { useT } from "../lib/i18n";
import "../styles/Editor.css";

type Props = {
  /** Identifies the item being edited; the source reloads when it changes. */
  sourceKey: string;
  /** Loads the pixels and metadata to edit (a local file, or a cloud photo). */
  loadSource: () => Promise<EditorSource>;
  /**
   * Persists the edited image (base64, encoded as `options` say), carrying the source's
   * metadata onto the copy. Returns a value handed straight to `onSaved`: the new local
   * path, or null in the cloud, where the copy is a new node the caller reloads for rather
   * than retargets to.
   */
  saveEdit: (imageBase64: string, source: EditorSource, options: SaveOptions) => Promise<string | null>;
  /** Where the copy lands, for the save panel's wording. */
  saveTo: "drive" | "computer";
  /**
   * The formats a copy may take. A Drive copy stays a JPEG, as on Android, so only its size
   * and quality are offered.
   */
  saveFormats?: SaveFormat[];
  /** The format the save panel starts on: the source's own, where it is offered. */
  defaultFormat?: SaveFormat;
  /** Close without saving. */
  onClose: () => void;
  /** A copy was written; the caller retargets (local) or reloads (cloud). */
  onSaved: (result: string | null) => void;
};

/** The tabs of the bottom bar, in the Android editor's order. */
type Tab = "transform" | "filters" | "tone" | "draw" | "more";

/** The tools of the More tab. */
type MoreTool = "frame" | "color";

/** A panel a tab opens over its row of buttons, with a back arrow: null is the row itself. */
type Panel = "ratio" | "straighten" | null;

/** The tools of the Draw tab, picked from its row of buttons. */
type MarkTool = "pen" | "text" | "redact" | "faces";

/** Where the Hide faces tool stands: the line under its Detect button reads it. */
type FaceRun =
  | { kind: "idle" }
  | { kind: "downloading"; done: number; total: number }
  | { kind: "detecting" }
  | { kind: "done"; found: number }
  | { kind: "failed" };

type ModelStatus =
  | { state: "absent" }
  | { state: "downloading"; done: number; total: number }
  | { state: "ready" }
  | { state: "failed"; error: string };

/** The three dials of the straighten panel. */
type GeoDial = "straighten" | "perspectiveV" | "perspectiveH";

type AdjustKey = keyof Omit<Adjustments, "filter">;

/** The undo model: parameter snapshots, never bitmaps, exactly as the Android editor keeps it. */
type History = { past: EditState[]; present: EditState; future: EditState[] };

type IconComponent = (p: { size?: number }) => ReactElement;

/** The live canvas works on a downscaled copy, as the Android editor drives its sliders off a preview. */
const PREVIEW_MAX_EDGE = 1440;
/** While a slider, a crop handle or a stroke is being dragged, a smaller copy keeps up with the pointer. */
const PREVIEW_DRAG_EDGE = 720;
/** Filter previews are drawn this large, for the side panel's big cards. */
const THUMB_EDGE = 320;
/** The small copy of the photo the filter thumbnails are drawn from. */
const THUMB_SOURCE_EDGE = 512;
const HISTORY_DEPTH = 30;
/** The grab radius for a crop handle, in displayed pixels; mapped into bitmap space per image. */
const CROP_SLOP_PX = 24;
/** Brush diameter as a fraction of the longest edge, at the two ends of the size control. */
const BRUSH_MIN = 0.02;
const BRUSH_MAX = 0.2;
/** The pen's width on screen, in pixels, as Android's ruler runs it. */
const PEN_MIN = 2;
const PEN_MAX = 40;
const PEN_DEFAULT = 8;
/** How near a text's corner handle a press has to land, in screen pixels. */
const TEXT_HANDLE_SLOP = 14;
/** The smallest and largest text, as a fraction of the picture's height. */
const TEXT_SIZE_MIN = 0.015;
const TEXT_SIZE_MAX = 0.5;
/** Ticks across a ruler; every fifth is a long one. */
const RULER_STEPS = 40;

/** The Tone rounds, in the Android editor's order and with its icons. */
const ADJUSTMENTS: { key: AdjustKey; label: string; Icon: IconComponent }[] = [
  { key: "brightness", label: "editor.adj.brightness", Icon: BrightnessIcon },
  { key: "exposure", label: "editor.adj.exposure", Icon: AutoFixIcon },
  { key: "contrast", label: "editor.adj.contrast", Icon: ContrastIcon },
  { key: "highlights", label: "editor.adj.highlights", Icon: TuneIcon },
  { key: "shadows", label: "editor.adj.shadows", Icon: BlockIcon },
  { key: "saturation", label: "editor.adj.saturation", Icon: PaletteIcon },
  { key: "vibrance", label: "editor.adj.vibrance", Icon: WaterDropIcon },
  { key: "tone", label: "editor.adj.tone", Icon: SwapHorizIcon },
  { key: "temperature", label: "editor.adj.temperature", Icon: BrushIcon },
  { key: "sharpen", label: "editor.adj.sharpen", Icon: DeblurIcon },
  { key: "grain", label: "editor.adj.grain", Icon: GrainIcon },
  { key: "vignette", label: "editor.adj.vignette", Icon: VignetteIcon },
  { key: "fade", label: "editor.adj.fade", Icon: GradientIcon },
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

const TABS: { id: Tab; label: string; short: string; Icon: IconComponent }[] = [
  { id: "transform", label: "editor.tab.transform", short: "editor.short.crop", Icon: CropRotateIcon },
  { id: "filters", label: "editor.tab.filters", short: "editor.short.filter", Icon: TonalityIcon },
  { id: "tone", label: "editor.tab.tone", short: "editor.short.adjust", Icon: LightModeIcon },
  { id: "draw", label: "editor.tab.draw", short: "editor.short.draw", Icon: DrawIcon },
  { id: "more", label: "editor.tab.more", short: "editor.short.more", Icon: AppsIcon },
];

function freshState(): EditState {
  return {
    adjustments: { ...NEUTRAL_ADJUSTMENTS },
    rotation: 0,
    flipH: false,
    flipV: false,
    straighten: 0,
    perspectiveV: 0,
    perspectiveH: 0,
    crop: null,
    redact: [],
    faces: { ...NO_FACES },
    color: neutralColor(),
    frame: null,
    draw: [],
    texts: [],
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

/** The room inside the stage's padding, which leaves the crop handles space past the photo. */
function roomIn(el: HTMLElement): { w: number; h: number } {
  const cs = getComputedStyle(el);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  return { w: Math.max(0, el.clientWidth - padX), h: Math.max(0, el.clientHeight - padY) };
}

/** `c` scaled down so its longest edge is at most `maxEdge`, or `c` itself when it already is. */
function shrink(c: HTMLCanvasElement, maxEdge: number): HTMLCanvasElement {
  const k = maxEdge / Math.max(c.width, c.height);
  if (k >= 1) return c;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(c.width * k));
  out.height = Math.max(1, Math.round(c.height * k));
  const g = out.getContext("2d");
  if (g) {
    g.imageSmoothingQuality = "high";
    g.drawImage(c, 0, 0, out.width, out.height);
  }
  return out;
}

/** Where the photo sits on screen: its centre and size, and the tab layout that put it there. */
type Place = { cx: number; cy: number; w: number; h: number; layout: string };

/** The place a fraction `p` of the way from `a` to `b`. */
function between(a: Place, b: Place, p: number): Place {
  const m = (x: number, y: number) => x + (y - x) * p;
  return { cx: m(a.cx, b.cx), cy: m(a.cy, b.cy), w: m(a.w, b.w), h: m(a.h, b.h), layout: b.layout };
}

function sameSize(a: { w: number; h: number }, b: { w: number; h: number }): boolean {
  return a.w === b.w && a.h === b.h;
}

function signed(v: number): string {
  return v > 0 ? `+${v}` : String(v);
}

/**
 * The photo editor, laid out as the Android editor is: a top bar of back, undo, redo,
 * reset and save, the photo, then the open tab's panel over a pill of icon-only tabs.
 *
 * The whole edit is held as parameters (an EditState), so the undo history is a stack of
 * cheap snapshots rather than bitmaps. Every change routes through `commit` (a new history
 * entry) or `setLive` (a live update during a drag, folded into one entry on release); the
 * render pipeline is the shared `renderPreview`/`encodeFull`, so the preview on screen and
 * the bytes saved can never diverge.
 */
export function PhotoEditor({
  sourceKey,
  loadSource,
  saveEdit,
  saveTo,
  saveFormats = ["jpeg"],
  defaultFormat = "jpeg",
  onClose,
  onSaved,
}: Props) {
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

  const [tab, setTab] = useState<Tab>("transform");
  const [panel, setPanel] = useState<Panel>(null);
  const [aspect, setAspect] = useState<CropAspect>("free");
  const [redactMode, setRedactMode] = useState<RedactMode>("black");
  const [brush, setBrush] = useState(0.06);
  const [comparing, setComparing] = useState(false);
  const [markTool, setMarkTool] = useState<MarkTool>("pen");
  const [penColor, setPenColor] = useState(DRAW_COLORS[0]);
  const [penWidth, setPenWidth] = useState(PEN_DEFAULT);
  const [selectedText, setSelectedText] = useState<number | null>(null);
  const [editingText, setEditingText] = useState<number | null>(null);
  const [textPick, setTextPick] = useState<"color" | "background">("color");
  const [faceRun, setFaceRun] = useState<FaceRun>({ kind: "idle" });
  const [moreTool, setMoreTool] = useState<MoreTool>("frame");
  const [colorMode, setColorMode] = useState<"curves" | "hsl">("curves");
  const [curveChannel, setCurveChannel] = useState<CurveChannel>("rgb");
  const [hslBand, setHslBand] = useState(0);
  const [framePicking, setFramePicking] = useState(false);
  const [frameSnap, setFrameSnap] = useState({ x: false, y: false });
  const [askFaceModel, setAskFaceModel] = useState(false);

  const [source, setSource] = useState<EditorSource | null>(null);
  const [ready, setReady] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const imgRef = useRef<HTMLImageElement | null>(null);

  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  // The save panel, in the side panel's place, and how the copy is to be written.
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveOpts, setSaveOpts] = useState<SaveOptions>(() => ({
    ...DEFAULT_SAVE,
    format: saveFormats.includes(defaultFormat) ? defaultFormat : "jpeg",
  }));
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
  const [dragging, setDragging] = useState(false);
  // `lowRes` drops the preview to the drag size while the drag lasts; a pen stroke or a
  // text move keeps the full preview, since only the marks are drawn again.
  const beginDrag = useCallback((lowRes: boolean = true) => {
    if (!dragBase.current) dragBase.current = histRef.current.present;
    if (lowRes) setDragging(true);
  }, []);
  const endDrag = useCallback(() => {
    const base = dragBase.current;
    dragBase.current = null;
    setDragging(false);
    if (!base) return;
    setHist((h) => {
      if (sameState(base, h.present)) return h;
      const past = [...h.past, base];
      if (past.length > HISTORY_DEPTH) past.shift();
      return { past, present: h.present, future: [] };
    });
  }, []);

  // A release anywhere ends an in-flight drag, so a pointer let go off the control still
  // closes its single history entry, and a held compare lets go of the original.
  useEffect(() => {
    const end = () => {
      endDrag();
      setComparing(false);
    };
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

  // ---- Tabs --------------------------------------------------------------

  const cropping = tab === "transform";

  function openTab(next: Tab) {
    finishTextEdit();
    setTab(next);
    setPanel(null);
    setComparing(false);
    if (!busy) setSaveOpen(false);
  }

  // ---- Geometry + display fit -------------------------------------------

  // The rotated full-resolution size (crop-null space): the crop rectangle lives here.
  const bounds = useMemo(
    () => (ready ? rotatedSize(srcW, srcH, present.rotation) : { w: 0, h: 0 }),
    [ready, srcW, srcH, present.rotation],
  );

  // The post-geometry output size shown on the stage. Transform shows the whole rotated
  // image (crop drawn as an overlay), so it fits to the bounds instead.
  const outSize = useMemo(() => {
    if (!ready) return { w: 0, h: 0 };
    if (cropping) return bounds;
    const photo = outputSize(srcW, srcH, present.rotation, present.crop);
    if (!present.frame) return photo;
    const layout = frameCanvas(photo.w, photo.h, present.frame);
    return { w: layout.width, h: layout.height };
  }, [ready, srcW, srcH, present.rotation, present.crop, present.frame, cropping, bounds]);

  // A resize of the window follows at once; a change of tab is measured below, before it
  // paints, so the photo can move there in one glide.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setAvail((a) => sameSize(a, roomIn(el)) ? a : roomIn(el));
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

  // The turned, flipped, cropped and downscaled photo, kept while only the colour or the
  // strokes change: rebuilding it means drawing the full-resolution source again, which is
  // what made a slider drag lag. Every frame then starts from this base.
  const baseRef = useRef<{ key: string; canvas: HTMLCanvasElement; small: HTMLCanvasElement | null } | null>(null);
  // The turned and flipped photo at preview size, which a straighten or keystone drag
  // warps on every frame without going back to the full-resolution source.
  const turnedRef = useRef<{ key: string; canvas: HTMLCanvasElement; small: HTMLCanvasElement | null } | null>(null);
  const pixelsRef = useRef<{ base: HTMLCanvasElement; key: string; canvas: HTMLCanvasElement; version: number } | null>(null);
  const framedRef = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!ready || !imgRef.current || !canvasRef.current) return;
    // Transform draws the whole rotated image without the crop, and lays the crop
    // rectangle over it; every other tab shows the final composition.
    // The marks belong to the cropped picture, so the uncropped view leaves them out, as the
    // Android crop view does.
    const view = cropping
      ? { ...present, crop: null, redact: [], faces: { ...present.faces, covers: [] }, frame: null, draw: [], texts: [] }
      : present;
    const img = imgRef.current;
    const cv = canvasRef.current;
    // One render per frame at most: a burst of pointer moves only draws its latest state.
    if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const warp = [view.straighten, view.perspectiveV, view.perspectiveH];
      const key = JSON.stringify([view.rotation, view.flipH, view.flipV, view.crop, warp, srcW, srcH]);
      let base: HTMLCanvasElement;
      if (!view.crop) {
        const turnKey = JSON.stringify([view.rotation, view.flipH, view.flipV, srcW, srcH]);
        if (turnedRef.current?.key !== turnKey) {
          const upright = { ...view, crop: null, straighten: 0, perspectiveV: 0, perspectiveH: 0 };
          turnedRef.current = {
            key: turnKey,
            canvas: applyGeometry(img, srcW, srcH, upright, PREVIEW_MAX_EDGE).canvas,
            small: null,
          };
        }
        const turned = turnedRef.current;
        if (dragging && !turned.small) turned.small = shrink(turned.canvas, PREVIEW_DRAG_EDGE);
        const from = dragging && turned.small ? turned.small : turned.canvas;
        const warpKey = `${key}:${from.width}`;
        if (baseRef.current?.key !== warpKey) {
          baseRef.current = { key: warpKey, canvas: warpCanvas(from, view), small: null };
        }
        base = baseRef.current.canvas;
      } else {
        if (baseRef.current?.key !== key) {
          baseRef.current = { key, canvas: applyGeometry(img, srcW, srcH, view, PREVIEW_MAX_EDGE).canvas, small: null };
        }
        const cached = baseRef.current;
        if (dragging && !cached.small) cached.small = shrink(cached.canvas, PREVIEW_DRAG_EDGE);
        base = dragging && cached.small ? cached.small : cached.canvas;
      }
      // The coloured, redacted picture is kept too, so a pen stroke or a text being moved
      // only draws the marks again over it.
      const pixelKey = JSON.stringify([view.adjustments, view.color, view.redact, view.faces, base.width]);
      const px = pixelsRef.current;
      if (!px || px.base !== base || px.key !== pixelKey) {
        const c = px && px.canvas.width === base.width && px.canvas.height === base.height ? px.canvas : null;
        const out = c ?? document.createElement("canvas");
        out.width = base.width;
        out.height = base.height;
        const pg = out.getContext("2d", { willReadFrequently: true });
        if (!pg) return;
        pg.drawImage(base, 0, 0);
        applyPixels(
          out,
          view.adjustments,
          view.redact,
          facesInRender(view, srcW, srcH, base.width, base.height),
          view.color,
        );
        pixelsRef.current = { base, key: pixelKey, canvas: out, version: (px?.version ?? 0) + 1 };
      }
      const done = pixelsRef.current as { canvas: HTMLCanvasElement; version: number };
      let shown = done.canvas;
      if (view.frame) {
        // Moving the photo in its frame only lays the frame out again over the same pixels.
        const frameKey = `${done.version}:${JSON.stringify(view.frame)}`;
        if (framedRef.current?.key !== frameKey) {
          framedRef.current = { key: frameKey, canvas: applyFrame(done.canvas, view.frame) };
        }
        shown = framedRef.current.canvas;
      }
      if (cv.width !== shown.width) cv.width = shown.width;
      if (cv.height !== shown.height) cv.height = shown.height;
      const g = cv.getContext("2d");
      if (!g) return;
      g.drawImage(shown, 0, 0);
      drawOverlays(g, cv.width, cv.height, view.draw, view.texts, editingText);
    });
  }, [ready, present, cropping, srcW, srcH, dragging, editingText]);

  useEffect(
    () => () => {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  // A tab that brings a side panel, or a taller or shorter panel below, gives the photo a
  // new place. The layout takes it at once and the photo moves there from where it was in
  // one glide (measure the old place, jump to the new one, play the difference back), so
  // it neither jumps nor swells and shrinks on the way. A new shape snaps instead, where a
  // glide would stretch the picture.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const placeRef = useRef<Place | null>(null);
  // Where the glide in flight started, so a tab changed again mid-glide starts the next
  // one from where the photo is, not from where it was heading.
  const flightRef = useRef<Place | null>(null);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const room = roomIn(stage);
    if (!sameSize(room, avail)) {
      // Runs again, before the paint, with the photo fitted to the new room.
      setAvail(room);
      return;
    }
    const el = wrapRef.current;
    if (!el || !disp.w || !disp.h) return;
    const sr = stage.getBoundingClientRect();
    const layout = `${tab}:${panel ?? ""}:${saveOpen ? "save" : ""}`;
    const next: Place = { cx: sr.left + sr.width / 2, cy: sr.top + sr.height / 2, w: disp.w, h: disp.h, layout };
    let prev = placeRef.current;
    placeRef.current = next;
    if (!prev || prev.layout === layout) return;
    const running = el.getAnimations().find((a) => a.playState === "running");
    const from = flightRef.current;
    if (running && from) {
      const p = running.effect?.getComputedTiming().progress ?? 1;
      prev = between(from, prev, p);
    }
    // A glide still running belongs to the old layout; it stops here either way.
    el.style.transition = "none";
    el.style.transform = "";
    flightRef.current = null;
    if (Math.abs(prev.w / prev.h - next.w / next.h) > 1e-3) return;
    const dx = prev.cx - next.cx;
    const dy = prev.cy - next.cy;
    const k = prev.w / next.w;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(k - 1) < 0.002) return;
    flightRef.current = { ...prev, layout };
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${k})`;
    el.getBoundingClientRect();
    el.style.transition = "transform 0.28s cubic-bezier(0.2, 0.8, 0.2, 1)";
    el.style.transform = "";
  });

  // Filter thumbnails: the current photo under each preset, neutral but for the filter,
  // rebuilt only when the geometry or the tab changes. They come from a small copy of the
  // photo, made once, so opening the tab never draws the full-resolution source.
  const smallSource = useMemo(() => {
    const img = imgRef.current;
    if (!ready || !img || !srcW || !srcH) return null;
    const f = Math.min(1, THUMB_SOURCE_EDGE / Math.max(srcW, srcH));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(srcW * f));
    c.height = Math.max(1, Math.round(srcH * f));
    const g = c.getContext("2d");
    if (!g) return null;
    g.imageSmoothingQuality = "high";
    g.drawImage(img, 0, 0, c.width, c.height);
    return { canvas: c, f };
  }, [ready, srcW, srcH]);

  // The blurred-fill swatch shows a soft copy of the photo, as on Android.
  const blurLook = useMemo(() => {
    if (!smallSource) return "";
    const c = document.createElement("canvas");
    c.width = 24;
    c.height = 24;
    const g = c.getContext("2d");
    if (!g) return "";
    g.imageSmoothingQuality = "high";
    g.drawImage(smallSource.canvas, 0, 0, 24, 24);
    return c.toDataURL();
  }, [smallSource]);

  const thumbs = useMemo(() => {
    if (!smallSource || tab !== "filters") return [];
    const { canvas, f } = smallSource;
    const crop = present.crop && {
      left: present.crop.left * f,
      top: present.crop.top * f,
      right: present.crop.right * f,
      bottom: present.crop.bottom * f,
    };
    const base = applyGeometry(
      canvas,
      canvas.width,
      canvas.height,
      {
        ...freshState(),
        rotation: present.rotation,
        flipH: present.flipH,
        flipV: present.flipV,
        straighten: present.straighten,
        perspectiveV: present.perspectiveV,
        perspectiveH: present.perspectiveH,
        crop,
      },
      THUMB_EDGE,
    ).canvas;
    return FILTERS.map((p) => {
      const c = document.createElement("canvas");
      c.width = base.width;
      c.height = base.height;
      c.getContext("2d")?.drawImage(base, 0, 0);
      applyPixels(c, { ...NEUTRAL_ADJUSTMENTS, filter: p.id }, []);
      return { id: p.id, label: p.label, url: c.toDataURL("image/jpeg", 0.82) };
    });
  }, [
    smallSource,
    tab,
    present.rotation,
    present.flipH,
    present.flipV,
    present.straighten,
    present.perspectiveV,
    present.perspectiveH,
    present.crop,
  ]);

  // ---- Tone --------------------------------------------------------------

  function onTone(key: AdjustKey, value: number) {
    // Built on the newest state, so moves that land before a render never undo each other.
    setHist((h) => ({ ...h, present: { ...h.present, adjustments: { ...h.present.adjustments, [key]: value } } }));
  }

  function resetTone(key: AdjustKey) {
    if (present.adjustments[key] === 0) return;
    commit({ ...present, adjustments: { ...present.adjustments, [key]: 0 } });
  }

  function resetAllTone() {
    commit({ ...present, adjustments: { ...NEUTRAL_ADJUSTMENTS, filter: present.adjustments.filter } });
  }

  function runAutoFix() {
    const img = imgRef.current;
    if (!img) return;
    const c = document.createElement("canvas");
    c.width = AUTO_FIX_SAMPLE;
    c.height = AUTO_FIX_SAMPLE;
    const g = c.getContext("2d", { willReadFrequently: true });
    if (!g) return;
    g.drawImage(img, 0, 0, AUTO_FIX_SAMPLE, AUTO_FIX_SAMPLE);
    const fix = autoFix(g.getImageData(0, 0, AUTO_FIX_SAMPLE, AUTO_FIX_SAMPLE).data);
    commit({ ...present, adjustments: { ...present.adjustments, ...fix } });
  }

  const toneEdited = ADJUSTMENTS.some(({ key }) => present.adjustments[key] !== 0);

  // ---- Filters -----------------------------------------------------------

  function pickFilter(id: FilterPreset) {
    commit({ ...present, adjustments: { ...present.adjustments, filter: id } });
  }

  // ---- Compare -----------------------------------------------------------

  // Holding the photo shows the untouched original, in the tabs whose photo is not a
  // drawing surface of its own.
  const canCompare = tab === "tone" || tab === "filters" || (tab === "more" && moreTool === "color");

  function onCompareDown(e: ReactPointerEvent) {
    if (!canCompare || e.button !== 0) return;
    setComparing(true);
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
    // Free releases the lock and takes the crop back to the whole photo, so it doubles as
    // the crop's reset, as it does on Android.
    if (a === "free") {
      commit({ ...present, crop: null });
      return;
    }
    const ratio = lockRatio(a, bounds.w, bounds.h);
    if (ratio == null) return;
    const box = centeredCrop(bounds.w, bounds.h, ratio);
    commit({ ...present, crop: isFullCrop(box, bounds.w, bounds.h) ? null : box });
  }

  // ---- Redact ------------------------------------------------------------

  const strokeIdx = useRef<number | null>(null);

  /**
   * A point on the shown picture as a fraction of the photo: the same with no frame, and
   * taken off the photo's box on the frame's canvas with one, since a redaction belongs to
   * the photo, not to the frame around it.
   */
  function onPhoto(e: ReactPointerEvent): { x: number; y: number } {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    const f = present.frame;
    if (!f) return { x: clamp01(fx), y: clamp01(fy) };
    const photo = outputSize(srcW, srcH, present.rotation, present.crop);
    const l = frameCanvas(photo.w, photo.h, f);
    const p = l.photo;
    return {
      x: clamp01((fx * l.width - p.left) / Math.max(1, p.right - p.left)),
      y: clamp01((fy * l.height - p.top) / Math.max(1, p.bottom - p.top)),
    };
  }

  function onRedactDown(e: ReactPointerEvent) {
    if (!disp.w || e.button !== 0) return;
    const { x, y } = onPhoto(e);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    beginDrag();
    const stroke: RedactStroke = { mode: redactMode, points: [{ x, y }], brush };
    strokeIdx.current = present.redact.length;
    setLive({ ...present, redact: [...present.redact, stroke] });
  }

  function onRedactMove(e: ReactPointerEvent) {
    const idx = strokeIdx.current;
    if (idx == null) return;
    const { x, y } = onPhoto(e);
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

  const brushValue = Math.round(((brush - BRUSH_MIN) / (BRUSH_MAX - BRUSH_MIN)) * 100);

  // ---- Pen ---------------------------------------------------------------

  const penIdx = useRef<number | null>(null);

  function pointIn(e: ReactPointerEvent): { x: number; y: number } {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: clamp01((e.clientX - rect.left) / rect.width), y: clamp01((e.clientY - rect.top) / rect.height) };
  }

  function onPenDown(e: ReactPointerEvent) {
    if (!disp.w || e.button !== 0) return;
    const p = pointIn(e);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    beginDrag(false);
    // The width is the pen's on screen, kept as a share of the picture's width.
    const stroke: DrawStroke = { points: [p], color: penColor, width: penWidth / disp.w };
    penIdx.current = histRef.current.present.draw.length;
    setHist((h) => ({ ...h, present: { ...h.present, draw: [...h.present.draw, stroke] } }));
  }

  function onPenMove(e: ReactPointerEvent) {
    const idx = penIdx.current;
    if (idx == null) return;
    const p = pointIn(e);
    setHist((h) => {
      const draw = h.present.draw.slice();
      const st = draw[idx];
      if (!st) return h;
      draw[idx] = { ...st, points: [...st.points, p] };
      return { ...h, present: { ...h.present, draw } };
    });
  }

  function onPenUp() {
    if (penIdx.current == null) return;
    penIdx.current = null;
    endDrag();
  }

  // ---- Text --------------------------------------------------------------

  // A text being typed is one history entry from the first key to the last, so it keeps
  // its own snapshot rather than the pointer's, which every click would close.
  const textEditBase = useRef<EditState | null>(null);
  const textDrag = useRef<{
    id: number;
    mode: "move" | "turn";
    offX: number;
    offY: number;
    startDist: number;
    startAngle: number;
    size: number;
    rotation: number;
  } | null>(null);
  const measureRef = useRef<CanvasRenderingContext2D | null>(null);
  function measure(): CanvasRenderingContext2D {
    if (!measureRef.current) measureRef.current = document.createElement("canvas").getContext("2d");
    return measureRef.current as CanvasRenderingContext2D;
  }

  const selected = present.texts.find((x) => x.id === selectedText) ?? null;

  function patchText(id: number, patch: Partial<TextItem>) {
    setHist((h) => ({
      ...h,
      present: { ...h.present, texts: h.present.texts.map((x) => (x.id === id ? { ...x, ...patch } : x)) },
    }));
  }

  function finishTextEdit() {
    const id = editingText;
    if (id == null) return;
    setEditingText(null);
    const base = textEditBase.current;
    textEditBase.current = null;
    const item = histRef.current.present.texts.find((x) => x.id === id);
    if (!item || item.text.trim() === "") setSelectedText(null);
    setHist((h) => {
      const it = h.present.texts.find((x) => x.id === id);
      const next =
        it && it.text.trim() === ""
          ? { ...h.present, texts: h.present.texts.filter((x) => x.id !== id) }
          : h.present;
      if (!base || sameState(base, next)) return { ...h, present: next };
      const past = [...h.past, base];
      if (past.length > HISTORY_DEPTH) past.shift();
      return { past, present: next, future: [] };
    });
  }

  function addText(at?: { x: number; y: number }) {
    const id = Math.max(0, ...histRef.current.present.texts.map((x) => x.id)) + 1;
    textEditBase.current = histRef.current.present;
    const item = { ...newText(id), ...(at ? { cx: at.x, cy: at.y } : {}) };
    setHist((h) => ({ ...h, present: { ...h.present, texts: [...h.present.texts, item] } }));
    setSelectedText(id);
    setEditingText(id);
  }

  function startTextEdit(id: number) {
    if (editingText === id) return;
    textEditBase.current = histRef.current.present;
    setSelectedText(id);
    setEditingText(id);
  }

  function deleteText(id: number) {
    if (editingText === id) {
      setEditingText(null);
      textEditBase.current = null;
    }
    commit({ ...histRef.current.present, texts: histRef.current.present.texts.filter((x) => x.id !== id) });
    setSelectedText(null);
  }

  /** Where a pointer is on the shown picture, in its own screen pixels. */
  function picturePoint(e: ReactPointerEvent | ReactMouseEvent): { px: number; py: number } {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return {
      px: ((e.clientX - rect.left) / rect.width) * disp.w,
      py: ((e.clientY - rect.top) / rect.height) * disp.h,
    };
  }

  function textAt(px: number, py: number): TextItem | null {
    const g = measure();
    const items = histRef.current.present.texts;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.text.trim() === "") continue;
      if (inTurnedBox(px, py, textBox(g, it, disp.w, disp.h), snapTextAngle(it.rotation))) return it;
    }
    return null;
  }

  /** The corner handle that sizes and turns a text: its box's lower right corner, turned with it. */
  function handleOf(it: TextItem): { x: number; y: number } {
    const box = textBox(measure(), it, disp.w, disp.h);
    const a = (snapTextAngle(it.rotation) * Math.PI) / 180;
    const hx = box.halfWidth;
    const hy = box.halfHeight;
    return { x: box.cx + hx * Math.cos(a) - hy * Math.sin(a), y: box.cy + hx * Math.sin(a) + hy * Math.cos(a) };
  }

  function onTextDown(e: ReactPointerEvent) {
    if (!disp.w || e.button !== 0) return;
    const { px, py } = picturePoint(e);
    const cur = selected;
    if (cur && editingText !== cur.id) {
      const hd = handleOf(cur);
      if (Math.hypot(px - hd.x, py - hd.y) <= TEXT_HANDLE_SLOP) {
        const cx = cur.cx * disp.w;
        const cy = cur.cy * disp.h;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        beginDrag(false);
        textDrag.current = {
          id: cur.id,
          mode: "turn",
          offX: 0,
          offY: 0,
          startDist: Math.max(1, Math.hypot(px - cx, py - cy)),
          startAngle: Math.atan2(py - cy, px - cx),
          size: cur.size,
          rotation: cur.rotation,
        };
        return;
      }
    }
    const hit = textAt(px, py);
    if (editingText != null && hit?.id !== editingText) finishTextEdit();
    if (!hit) {
      setSelectedText(null);
      return;
    }
    setSelectedText(hit.id);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    beginDrag(false);
    textDrag.current = {
      id: hit.id,
      mode: "move",
      offX: px - hit.cx * disp.w,
      offY: py - hit.cy * disp.h,
      startDist: 1,
      startAngle: 0,
      size: hit.size,
      rotation: hit.rotation,
    };
  }

  function onTextMove(e: ReactPointerEvent) {
    const d = textDrag.current;
    if (!d) return;
    const { px, py } = picturePoint(e);
    if (d.mode === "move") {
      patchText(d.id, { cx: clamp01((px - d.offX) / disp.w), cy: clamp01((py - d.offY) / disp.h) });
      return;
    }
    const it = histRef.current.present.texts.find((x) => x.id === d.id);
    if (!it) return;
    const cx = it.cx * disp.w;
    const cy = it.cy * disp.h;
    const dist = Math.hypot(px - cx, py - cy);
    const angle = Math.atan2(py - cy, px - cx);
    patchText(d.id, {
      size: clamp((d.size * dist) / d.startDist, TEXT_SIZE_MIN, TEXT_SIZE_MAX),
      rotation: d.rotation + ((angle - d.startAngle) * 180) / Math.PI,
    });
  }

  function onTextUp() {
    if (!textDrag.current) return;
    textDrag.current = null;
    endDrag();
  }

  function onTextDoubleClick(e: ReactMouseEvent) {
    if (!disp.w) return;
    const { px, py } = picturePoint(e);
    const hit = textAt(px, py);
    if (hit) startTextEdit(hit.id);
    else addText({ x: clamp01(px / disp.w), y: clamp01(py / disp.h) });
  }

  function pickMarkTool(next: MarkTool) {
    finishTextEdit();
    setMarkTool(next);
  }

  // ---- Frame ---------------------------------------------------------------

  const frameDrag = useRef<{ start: FrameSpec; x: number; y: number } | null>(null);
  const wheelTimer = useRef<number | null>(null);
  const fills = useMemo(() => frameFills(DRAW_COLORS), []);
  const customFill =
    present.frame?.fill.kind === "solid" &&
    !fills.some((f) => f.kind === "solid" && present.frame?.fill.kind === "solid" && f.color === present.frame.fill.color)
      ? present.frame.fill.color
      : null;

  /** The photo inside any frame, and canvas pixels of the frame per pixel on screen. */
  function frameMetrics() {
    const photo = outputSize(srcW, srcH, present.rotation, present.crop);
    const layout = present.frame ? frameCanvas(photo.w, photo.h, present.frame) : null;
    return { photo, perScreen: layout && disp.w ? layout.width / disp.w : 1 };
  }

  function pickFrameShape(shape: FrameShape) {
    const fill: FrameFill = present.frame?.fill ?? { kind: "solid", color: FRAME_WHITE };
    commit({ ...present, frame: frameForShape(shape, fill) });
    if (shape === "off") setFramePicking(false);
  }

  function pickFill(fill: FrameFill) {
    if (!present.frame) return;
    setFramePicking(false);
    commit({ ...present, frame: { ...present.frame, fill } });
  }

  function onFrameDown(e: ReactPointerEvent) {
    if (!present.frame || e.button !== 0) return;
    if (framePicking) {
      // The eyedropper takes the colour shown under the pointer.
      const cv = canvasRef.current;
      const g = cv?.getContext("2d", { willReadFrequently: true });
      if (!cv || !g) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = Math.min(cv.width - 1, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * cv.width)));
      const y = Math.min(cv.height - 1, Math.max(0, Math.floor(((e.clientY - rect.top) / rect.height) * cv.height)));
      const [r, gr, b] = g.getImageData(x, y, 1, 1).data;
      const hex = `#${[r, gr, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      pickFill({ kind: "solid", color: hex });
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    beginDrag(false);
    frameDrag.current = { start: present.frame, x: e.clientX, y: e.clientY };
  }

  function onFrameMove(e: ReactPointerEvent) {
    const d = frameDrag.current;
    if (!d) return;
    const { photo, perScreen } = frameMetrics();
    const moved = afterGesture(d.start, 1, (e.clientX - d.x) * perScreen, (e.clientY - d.y) * perScreen, photo.w, photo.h);
    const snap = snappedToCentre(moved, photo.w, photo.h, FRAME_SNAP_PX * perScreen);
    setFrameSnap({ x: snap.x, y: snap.y });
    setHist((h) => ({ ...h, present: { ...h.present, frame: snap.spec } }));
  }

  function onFrameUp() {
    if (!frameDrag.current) return;
    frameDrag.current = null;
    setFrameSnap({ x: false, y: false });
    endDrag();
  }

  /** The wheel zooms the photo in its frame, the turns of one spin folded into one undo entry. */
  function onFrameWheel(e: ReactWheelEvent) {
    const f = histRef.current.present.frame;
    if (!f) return;
    const { photo } = frameMetrics();
    beginDrag(false);
    const next = afterGesture(f, Math.exp(-e.deltaY * 0.0015), 0, 0, photo.w, photo.h);
    setHist((h) => ({ ...h, present: { ...h.present, frame: next } }));
    if (wheelTimer.current) window.clearTimeout(wheelTimer.current);
    wheelTimer.current = window.setTimeout(() => {
      wheelTimer.current = null;
      endDrag();
    }, 400);
  }

  // ---- Colour --------------------------------------------------------------

  function setCurveLive(channel: CurveChannel, points: CurvePoint[]) {
    setHist((h) => {
      const color = h.present.color;
      return { ...h, present: { ...h.present, color: { ...color, curves: { ...color.curves, [channel]: points } } } };
    });
  }

  function removeCurvePoint(channel: CurveChannel, index: number) {
    const pts = present.color.curves[channel];
    if (index <= 0 || index >= pts.length - 1) return;
    commit({
      ...present,
      color: { ...present.color, curves: { ...present.color.curves, [channel]: pts.filter((_, i) => i !== index) } },
    });
  }

  function resetCurve(channel: CurveChannel) {
    commit({ ...present, color: { ...present.color, curves: { ...present.color.curves, [channel]: [...IDENTITY_CURVE] } } });
  }

  function setHslLive(index: number, band: HslBand) {
    setHist((h) => {
      const hsl = h.present.color.hsl.slice();
      hsl[index] = band;
      return { ...h, present: { ...h.present, color: { ...h.present.color, hsl } } };
    });
  }

  function resetHsl() {
    commit({ ...present, color: { ...present.color, hsl: neutralColor().hsl } });
  }

  function pickMoreTool(next: MoreTool) {
    setFramePicking(false);
    setMoreTool(next);
  }

  // ---- Hide faces ----------------------------------------------------------

  const faceBusy = faceRun.kind === "detecting" || faceRun.kind === "downloading";

  /** Finds the faces with the phone's detector, fetching it first if the user agrees. */
  async function detectFaces() {
    if (faceBusy || !ready) return;
    try {
      const status = await rpc<ModelStatus>("faceModelStatus");
      if (status.state === "ready") await runFaceDetection();
      else if (status.state === "downloading") await followFaceDownload(status);
      else setAskFaceModel(true);
    } catch {
      setFaceRun({ kind: "failed" });
    }
  }

  async function downloadFaceModel() {
    setAskFaceModel(false);
    try {
      await followFaceDownload(await rpc<ModelStatus>("faceModelDownload"));
    } catch {
      setFaceRun({ kind: "failed" });
    }
  }

  async function followFaceDownload(first: ModelStatus) {
    let status = first;
    while (status.state === "downloading") {
      setFaceRun({ kind: "downloading", done: status.done, total: status.total });
      await new Promise((r) => setTimeout(r, 400));
      status = await rpc<ModelStatus>("faceModelStatus");
    }
    if (status.state === "ready") await runFaceDetection();
    else setFaceRun({ kind: "failed" });
  }

  async function runFaceDetection() {
    const img = imgRef.current;
    if (!img || !srcW || !srcH) return;
    setFaceRun({ kind: "detecting" });
    try {
      // The whole original photo, letterboxed into the detector's square on its grey.
      const fit = letterbox(srcW, srcH);
      const c = document.createElement("canvas");
      c.width = FACE_INPUT;
      c.height = FACE_INPUT;
      const g = c.getContext("2d", { willReadFrequently: true });
      if (!g) throw new Error("no canvas");
      g.fillStyle = `rgb(${FACE_PAD_GREY}, ${FACE_PAD_GREY}, ${FACE_PAD_GREY})`;
      g.fillRect(0, 0, FACE_INPUT, FACE_INPUT);
      g.imageSmoothingQuality = "high";
      g.drawImage(img, fit.padX, fit.padY, fit.fw, fit.fh);
      const rgba = g.getImageData(0, 0, FACE_INPUT, FACE_INPUT).data;
      const rgb = new Uint8Array(FACE_INPUT * FACE_INPUT * 3);
      for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
        rgb[j] = rgba[i];
        rgb[j + 1] = rgba[i + 1];
        rgb[j + 2] = rgba[i + 2];
      }
      const hits = await rpc<{ box: [number, number, number, number]; eyes: [number, number, number, number] }[] | null>(
        "detectFaces",
        { rgb: base64FromBytes(rgb) },
      );
      if (!hits) {
        setFaceRun({ kind: "failed" });
        return;
      }
      const covers = coversFromHits(hits, srcW, srcH);
      const cur = histRef.current.present;
      commit({ ...cur, faces: { ...cur.faces, covers } });
      setFaceRun({ kind: "done", found: covers.length });
    } catch {
      setFaceRun({ kind: "failed" });
    }
  }

  function setFaceStyle(style: FaceStyle) {
    commit({ ...present, faces: { ...present.faces, style } });
  }

  function clearFaces() {
    commit({ ...present, faces: { ...present.faces, covers: [] } });
    setFaceRun({ kind: "idle" });
  }

  // ---- Rotate / flip -----------------------------------------------------

  // A rotated or flipped crop is fiddly to remap, so it is dropped: any turn or flip
  // resets the crop to null (and the aspect to free), which is safe and correct.
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

  // ---- Straighten / keystone ----------------------------------------------

  const [dial, setDial] = useState<GeoDial>("straighten");
  const warped = present.straighten !== 0 || present.perspectiveV !== 0 || present.perspectiveH !== 0;

  function onDial(key: GeoDial, value: number) {
    setHist((h) => ({ ...h, present: { ...h.present, [key]: value } }));
  }

  function pickDial(key: GeoDial) {
    // A click on the dial already open takes it back to zero, as a tap does on Android.
    if (key === dial) {
      if (present[key] !== 0) commit({ ...present, [key]: 0 });
    } else {
      setDial(key);
    }
  }

  function resetGeometry() {
    commit({ ...present, straighten: 0, perspectiveV: 0, perspectiveH: 0 });
  }

  // ---- Reset / save / cancel --------------------------------------------

  function resetAll() {
    commit(freshState());
    setAspect("free");
  }

  const requestCancel = useCallback(() => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  }, [busy, dirty, onClose]);

  function openSave() {
    if (busy || !ready || faceBusy) return;
    finishTextEdit();
    setComparing(false);
    setSaveErr("");
    setSaveOpen((o) => !o);
  }

  async function save() {
    if (busy || !ready || faceBusy || !imgRef.current || !source) return;
    setBusy(true);
    setSaveErr("");
    try {
      const base64 = await encodeFull(imgRef.current, srcW, srcH, present, saveOpts);
      const result = await saveEdit(base64, source, saveOpts);
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
      if (confirmDiscard || askFaceModel) return; // a dialog owns the keys while it is up
      // While a text is typed its field owns the keys, and stops them from reaching the viewer.
      if (editingText != null) return;
      e.stopPropagation();
      const meta = e.ctrlKey || e.metaKey;
      if ((e.key === "Delete" || e.key === "Backspace") && tab === "draw" && markTool === "text" && selectedText != null) {
        e.preventDefault();
        deleteText(selectedText);
      } else if (e.key === "Escape") {
        e.preventDefault();
        // An open panel closes first, the way Back closes it on Android.
        if (saveOpen) {
          if (!busy) setSaveOpen(false);
        } else if (panel) setPanel(null);
        else requestCancel();
      } else if (e.key === "Enter" && saveOpen) {
        e.preventDefault();
        void save();
      } else if (meta && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (saveOpen) void save();
        else openSave();
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

  const lossy = saveOpts.format !== "png";
  const savePanel = (
    <aside className="ed-side" aria-label={t("editor.saveSheet.title")}>
      <div className="ed-side-head">
        <span className="ed-side-title">{t("editor.saveSheet.title")}</span>
      </div>
      <div className="ed-side-body">
        <p className="ed-side-desc">
          {t(saveTo === "drive" ? "editor.saveSheet.drive" : "editor.saveSheet.computer")}
        </p>
        {saveFormats.length > 1 && (
          <SideSection title={t("editor.saveSheet.format")}>
            <div className="ed-chips">
              {saveFormats.map((f) => (
                <button
                  key={f}
                  className={`ed-chip ${saveOpts.format === f ? "sel" : ""}`}
                  onClick={() => setSaveOpts((o) => ({ ...o, format: f }))}
                  disabled={busy}
                >
                  {FORMAT_LABEL[f]}
                </button>
              ))}
            </div>
          </SideSection>
        )}
        <SideSection title={t("editor.saveSheet.size")}>
          <div className="ed-chips">
            {SAVE_EDGES.map((edge) => (
              <button
                key={edge ?? "full"}
                className={`ed-chip ${saveOpts.maxEdge === edge ? "sel" : ""}`}
                onClick={() => setSaveOpts((o) => ({ ...o, maxEdge: edge }))}
                disabled={busy}
              >
                {edge == null ? t("editor.saveSheet.full") : edge}
              </button>
            ))}
          </div>
        </SideSection>
        {lossy && (
          <SideSection title={t("editor.saveSheet.quality")} value={String(saveOpts.quality)}>
            <RulerSlider
              label={t("editor.saveSheet.quality")}
              value={saveOpts.quality}
              min={50}
              max={100}
              compact
              onChange={(v) => setSaveOpts((o) => ({ ...o, quality: Math.round(v) }))}
            />
          </SideSection>
        )}
        <button className="ed-save-option" onClick={() => void save()} disabled={busy || !ready || faceBusy}>
          <span className="ed-save-option-icon">
            {busy && !saved ? (
              <span className="ed-spin">
                <SpinnerIcon size={18} />
              </span>
            ) : saveTo === "drive" ? (
              <CloudUploadIcon size={20} />
            ) : (
              <ContentCopyIcon size={20} />
            )}
          </span>
          <span className="ed-save-option-text">
            <span className="ed-save-option-title">
              {t(saveTo === "drive" ? "editor.saveSheet.copyDrive" : "editor.saveSheet.copyComputer")}
            </span>
            <span className="ed-save-option-sub">
              {t(saveTo === "drive" ? "editor.saveSheet.copyDriveSub" : "editor.saveSheet.copyComputerSub")}
            </span>
          </span>
        </button>
        <button className="ed-side-btn wide" onClick={() => setSaveOpen(false)} disabled={busy}>
          <span>{t("common.cancel")}</span>
        </button>
      </div>
    </aside>
  );

  // The side panel holds what needs room: every Tone slider at once, each on its own ruler.
  const sidePanel = saveOpen ? (
    savePanel
  ) : tab === "filters" ? (
    <aside className="ed-side" aria-label={t("editor.tab.filters")}>
      <div className="ed-side-head">
        <span className="ed-side-title">{t("editor.tab.filters")}</span>
      </div>
      <div className="ed-side-body">
        <div className="ed-filter-grid">
          {thumbs.map((f) => {
            const sel = present.adjustments.filter === f.id;
            return (
              <button key={f.id} className={`ed-filter ${sel ? "sel" : ""}`} onClick={() => pickFilter(f.id)}>
                <span className="ed-filter-thumb">
                  <img src={f.url} alt="" draggable={false} />
                  {sel && (
                    <span className="ed-filter-check">
                      <CheckIcon size={16} />
                    </span>
                  )}
                </span>
                <span className="ed-filter-name">{t(f.label)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  ) : tab === "tone" ? (
      <aside className="ed-side" aria-label={t("editor.tab.tone")}>
        <div className="ed-side-head">
          <span className="ed-side-title">{t("editor.tab.tone")}</span>
          {toneEdited && (
            <button className="ed-head-action" onClick={resetAllTone}>
              {t("editor.reset")}
            </button>
          )}
        </div>
        <button className="ed-side-btn" onClick={runAutoFix} title={t("editor.autoFix")}>
          <AutoFixIcon size={16} />
          <span>{t("editor.autoFix")}</span>
        </button>
        <div className="ed-side-list">
          {ADJUSTMENTS.map(({ key, label, Icon }) => {
            const v = present.adjustments[key];
            return (
              <div
                key={key}
                className={`ed-adj ${v !== 0 ? "on" : ""}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  resetTone(key);
                }}
              >
                <div className="ed-adj-head" onDoubleClick={() => resetTone(key)}>
                  <span className="ed-adj-icon">
                    <Icon size={18} />
                  </span>
                  <span className="ed-adj-name">{t(label)}</span>
                  <span className="ed-adj-val">{signed(v)}</span>
                  <button
                    className="ed-adj-reset"
                    onClick={() => resetTone(key)}
                    disabled={v === 0}
                    title={t("editor.reset")}
                    aria-label={`${t("editor.reset")}: ${t(label)}`}
                  >
                    <RestoreIcon size={14} />
                  </button>
                </div>
                <RulerSlider
                  label={t(label)}
                  value={v}
                  min={-100}
                  max={100}
                  compact
                  onStart={beginDrag}
                  onChange={(nv) => onTone(key, nv)}
                />
              </div>
            );
          })}
        </div>
      </aside>
    ) : tab === "draw" ? (
      <aside className="ed-side" aria-label={t("editor.tab.draw")}>
        <div className="ed-side-head">
          <span className="ed-side-title">
            {markTool === "pen"
              ? t("editor.tab.draw")
              : markTool === "text"
                ? t("editor.tool.text")
                : markTool === "faces"
                  ? t("editor.faces.title")
                  : t("editor.tool.redact")}
          </span>
        </div>
        <div className="ed-side-body">
          {markTool === "pen" && (
            <>
              <SideSection title={t("editor.text.color")}>
                <ColorPicker value={penColor} onChange={setPenColor} />
                <Swatches value={penColor} onPick={setPenColor} />
              </SideSection>
              <SideSection title={t("editor.draw.width")} value={String(penWidth)}>
              <div className="ed-ruler-row">
                <span className="ed-ruler-icon" title={t("editor.draw.width")}>
                  <LineWeightIcon size={20} />
                </span>
                <RulerSlider
                  label={t("editor.draw.width")}
                  value={penWidth}
                  min={PEN_MIN}
                  max={PEN_MAX}
                  compact
                  onChange={setPenWidth}
                />
              </div>
              </SideSection>
            </>
          )}
          {markTool === "text" && (
            <>
              <button className="ed-side-btn wide" onClick={() => addText()}>
                <PlusIcon size={16} />
                <span>{t("editor.text.add")}</span>
              </button>
              {selected && (
                <>
                  <div className="ed-side-row">
                    <button className="ed-side-btn" onClick={() => startTextEdit(selected.id)}>
                      <PencilIcon size={14} />
                      <span>{t("editor.text.edit")}</span>
                    </button>
                    <button className="ed-side-btn danger" onClick={() => deleteText(selected.id)}>
                      <TrashIcon size={15} />
                      <span>{t("editor.text.delete")}</span>
                    </button>
                  </div>
                  <div className="ed-seg" role="tablist">
                    <button
                      role="tab"
                      aria-selected={textPick === "color"}
                      className={textPick === "color" ? "sel" : ""}
                      onClick={() => setTextPick("color")}
                    >
                      <TextIcon size={15} />
                      <span>{t("editor.text.color")}</span>
                    </button>
                    <button
                      role="tab"
                      aria-selected={textPick === "background"}
                      className={textPick === "background" ? "sel" : ""}
                      onClick={() => setTextPick("background")}
                    >
                      <FormatColorFillIcon size={15} />
                      <span>{t("editor.text.background")}</span>
                    </button>
                  </div>
                  {textPick === "color" ? (
                    <>
                      <ColorPicker
                        value={selected.color}
                        onStart={() => beginDrag(false)}
                        onChange={(c) => patchText(selected.id, { color: c })}
                      />
                      <Swatches
                        value={selected.color}
                        onPick={(c) => commit({
                          ...present,
                          texts: present.texts.map((x) => (x.id === selected.id ? { ...x, color: c } : x)),
                        })}
                      />
                    </>
                  ) : (
                    <>
                      <ColorPicker
                        value={selected.background}
                        onStart={() => beginDrag(false)}
                        // A first colour makes the box show, so the pick is seen at once.
                        onChange={(c) =>
                          patchText(selected.id, {
                            background: c,
                            backgroundOpacity: selected.backgroundOpacity > 0.001 ? selected.backgroundOpacity : 1,
                          })
                        }
                      />
                      <div className="ed-ruler-row">
                        <span className="ed-ruler-icon" title={t("editor.text.opacity")}>
                          <OpacityIcon size={20} />
                        </span>
                        <RulerSlider
                          label={t("editor.text.opacity")}
                          value={Math.round(selected.backgroundOpacity * 100)}
                          min={0}
                          max={100}
                          compact
                          onStart={() => beginDrag(false)}
                          onChange={(v) => patchText(selected.id, { backgroundOpacity: v / 100 })}
                        />
                        <span className="ed-ruler-val">{Math.round(selected.backgroundOpacity * 100)}</span>
                      </div>
                      <div className="ed-ruler-row">
                        <span className="ed-ruler-icon" title={t("editor.text.corners")}>
                          <RoundedCornerIcon size={20} />
                        </span>
                        <RulerSlider
                          label={t("editor.text.corners")}
                          value={Math.round(selected.cornerRadius * 100)}
                          min={0}
                          max={100}
                          compact
                          onStart={() => beginDrag(false)}
                          onChange={(v) => patchText(selected.id, { cornerRadius: v / 100 })}
                        />
                        <span className="ed-ruler-val">{Math.round(selected.cornerRadius * 100)}</span>
                      </div>
                    </>
                  )}
                </>
              )}
            </>
          )}
          {markTool === "faces" && (
            <>
              <button className="ed-side-btn wide" onClick={() => void detectFaces()} disabled={faceBusy}>
                <FaceIcon size={16} />
                <span>{t("editor.faces.detect")}</span>
              </button>
              <p className={`ed-side-note ${faceRun.kind === "failed" ? "error" : ""}`} aria-live="polite">
                {faceRun.kind === "downloading"
                  ? t("editor.faces.downloading", {
                      done: Math.round(faceRun.done / 1e6),
                      total: Math.round(faceRun.total / 1e6),
                    })
                  : faceRun.kind === "detecting"
                    ? t("editor.faces.detecting")
                    : faceRun.kind === "failed"
                      ? t("editor.faces.failed")
                      : present.faces.covers.length > 0
                        ? t(present.faces.covers.length === 1 ? "editor.faces.count.one" : "editor.faces.count.other", {
                            count: present.faces.covers.length,
                          })
                        : faceRun.kind === "done"
                          ? t("editor.faces.none")
                          : ""}
              </p>
              {present.faces.covers.length > 0 && (
                <>
                  <div className="ed-rounds">
                    <ToolCircle
                      label={t("editor.faces.pixelate")}
                      selected={present.faces.style === "pixelate"}
                      onClick={() => setFaceStyle("pixelate")}
                    >
                      <GridOnIcon size={24} />
                    </ToolCircle>
                    <ToolCircle
                      label={t("editor.faces.blur")}
                      selected={present.faces.style === "blur"}
                      onClick={() => setFaceStyle("blur")}
                    >
                      <DeblurIcon size={24} />
                    </ToolCircle>
                  </div>
                  <div className="ed-ruler-row">
                    <span className="ed-ruler-icon" title={t("editor.faces.strength")}>
                      <TuneIcon size={20} />
                    </span>
                    <RulerSlider
                      label={t("editor.faces.strength")}
                      value={Math.round(present.faces.strength * 100)}
                      min={0}
                      max={100}
                      compact
                      onStart={beginDrag}
                      onChange={(v) =>
                        setHist((h) => ({
                          ...h,
                          present: { ...h.present, faces: { ...h.present.faces, strength: v / 100 } },
                        }))
                      }
                    />
                    <span className="ed-ruler-val">{Math.round(present.faces.strength * 100)}</span>
                  </div>
                  <button className="ed-side-btn danger" onClick={clearFaces}>
                    <TrashIcon size={15} />
                    <span>{t("editor.faces.clear")}</span>
                  </button>
                </>
              )}
            </>
          )}
          {markTool === "redact" && (
            <>
              <div className="ed-rounds">
                <ToolCircle
                  label={t("editor.redact.black")}
                  selected={redactMode === "black"}
                  onClick={() => setRedactMode("black")}
                >
                  <BlockIcon size={24} />
                </ToolCircle>
                <ToolCircle
                  label={t("editor.redact.pixelate")}
                  selected={redactMode === "pixelate"}
                  onClick={() => setRedactMode("pixelate")}
                >
                  <GridOnIcon size={24} />
                </ToolCircle>
              </div>
              <div className="ed-ruler-row">
                <span className="ed-ruler-icon" title={t("editor.redact.brush")}>
                  <BrushIcon size={20} />
                </span>
                <RulerSlider
                  label={t("editor.redact.brush")}
                  value={brushValue}
                  min={0}
                  max={100}
                  compact
                  onChange={(v) => setBrush(BRUSH_MIN + (v / 100) * (BRUSH_MAX - BRUSH_MIN))}
                />
                <span className="ed-ruler-val">{brushValue}</span>
              </div>
            </>
          )}
        </div>
      </aside>
    ) : tab === "more" ? (
      <aside className="ed-side" aria-label={t("editor.tab.more")}>
        <div className="ed-side-head">
          <span className="ed-side-title">{moreTool === "frame" ? t("editor.tool.frame") : t("editor.tool.color")}</span>
          {moreTool === "color" &&
            (colorMode === "curves" ? (
              !isIdentityCurve(present.color.curves[curveChannel]) && (
                <button className="ed-head-action" onClick={() => resetCurve(curveChannel)}>
                  {t("editor.reset")}
                </button>
              )
            ) : (
              !hslIsNeutral(present.color.hsl) && (
                <button className="ed-head-action" onClick={resetHsl}>
                  {t("editor.reset")}
                </button>
              )
            ))}
        </div>
        <div className="ed-side-body">
          {moreTool === "frame" && (
            <>
              <SideSection title={t("editor.sec.shape")}>
                <div className="ed-shapes">
                  {FRAME_SHAPES.map((sh) => (
                    <button
                      key={sh}
                      className={`ed-shape ${shapeOf(present.frame) === sh ? "sel" : ""}`}
                      onClick={() => pickFrameShape(sh)}
                    >
                      <span className="ed-shape-glyph">
                        <ShapeGlyph shape={sh} photo={bounds} />
                      </span>
                      <span className="ed-shape-name">
                        {sh === "off"
                          ? t("editor.frame.none")
                          : sh === "original"
                            ? t("editor.crop.original")
                            : sh === "polaroid"
                              ? t("editor.frame.polaroid")
                              : sh}
                      </span>
                    </button>
                  ))}
                </div>
              </SideSection>
              <SideSection
                title={t("editor.frame.border")}
                value={present.frame ? String(Math.round(present.frame.margin * 100)) : undefined}
                idle={!present.frame}
              >
              <div className={`ed-ruler-row ${present.frame ? "" : "idle"}`}>
                <span className="ed-ruler-icon" title={t("editor.frame.border")}>
                  <FilterFramesIcon size={20} />
                </span>
                {present.frame ? (
                  <RulerSlider
                    label={t("editor.frame.border")}
                    value={Math.round(present.frame.margin * 100)}
                    min={Math.round(borderRange(present.frame)[0] * 100)}
                    max={Math.round(borderRange(present.frame)[1] * 100)}
                    compact
                    onStart={() => beginDrag(false)}
                    onChange={(v) =>
                      setHist((h) =>
                        h.present.frame ? { ...h, present: { ...h.present, frame: withBorder(h.present.frame, v / 100) } } : h,
                      )
                    }
                  />
                ) : (
                  <RulerSlider label={t("editor.frame.border")} value={0} min={0} max={30} compact onChange={() => {}} />
                )}
              </div>
              </SideSection>
              <SideSection title={t("editor.sec.fill")} idle={!present.frame}>
              <div className={`ed-fills ${present.frame ? "" : "idle"}`}>
                <button
                  className={`ed-fill blur ${present.frame?.fill.kind === "blur" ? "sel" : ""}`}
                  onClick={() => pickFill({ kind: "blur" })}
                  title={t("editor.frame.blur")}
                  aria-label={t("editor.frame.blur")}
                  style={smallSource ? { backgroundImage: `url(${blurLook})` } : undefined}
                />
                <button
                  className={`ed-fill pick ${framePicking || customFill ? "sel" : ""}`}
                  onClick={() => present.frame && setFramePicking((v) => !v)}
                  title={t("editor.frame.pick")}
                  aria-label={t("editor.frame.pick")}
                  style={customFill ? { background: customFill } : undefined}
                >
                  <ColorizeIcon size={16} />
                </button>
                {fills.map((f) =>
                  f.kind === "solid" ? (
                    <button
                      key={f.color}
                      className={`ed-fill ${present.frame?.fill.kind === "solid" && present.frame.fill.color === f.color ? "sel" : ""}`}
                      style={{ background: f.color }}
                      onClick={() => pickFill(f)}
                      aria-label={f.color}
                    />
                  ) : null,
                )}
              </div>
              {framePicking && <p className="ed-side-note">{t("editor.frame.pick")}</p>}
              </SideSection>
            </>
          )}
          {moreTool === "color" && (
            <>
              <div className="ed-seg" role="tablist">
                <button
                  role="tab"
                  aria-selected={colorMode === "curves"}
                  className={colorMode === "curves" ? "sel" : ""}
                  onClick={() => setColorMode("curves")}
                >
                  <GradientIcon size={15} />
                  <span>{t("editor.color.curves")}</span>
                </button>
                <button
                  role="tab"
                  aria-selected={colorMode === "hsl"}
                  className={colorMode === "hsl" ? "sel" : ""}
                  onClick={() => setColorMode("hsl")}
                >
                  <PaletteIcon size={15} />
                  <span>{t("editor.color.hsl")}</span>
                </button>
              </div>
              {colorMode === "curves" ? (
                <>
                  <div className="ed-seg four" role="tablist">
                    {(["rgb", "r", "g", "b"] as const).map((ch) => (
                      <button
                        key={ch}
                        role="tab"
                        aria-selected={curveChannel === ch}
                        className={`${curveChannel === ch ? "sel" : ""} ch-${ch}`}
                        onClick={() => setCurveChannel(ch)}
                      >
                        <span>{ch.toUpperCase()}</span>
                      </button>
                    ))}
                  </div>
                  <CurveGraph
                    points={present.color.curves[curveChannel]}
                    channel={curveChannel}
                    onStart={beginDrag}
                    onChange={(pts) => setCurveLive(curveChannel, pts)}
                    onRemove={(i) => removeCurvePoint(curveChannel, i)}
                  />
                </>
              ) : (
                <>
                  <div className="ed-hsl-bands">
                    {HSL_SWATCHES.map((c, i) => {
                      const b = present.color.hsl[i];
                      const moved = b.hue !== 0 || b.sat !== 0 || b.light !== 0;
                      return (
                        <button
                          key={c}
                          className={`ed-hsl-band ${hslBand === i ? "sel" : ""}`}
                          style={{ background: c }}
                          onClick={() => setHslBand(i)}
                          aria-label={c}
                        >
                          {moved && <span className="ed-hsl-dot" />}
                        </button>
                      );
                    })}
                  </div>
                  {(["hue", "sat", "light"] as const).map((k) => {
                    const band = present.color.hsl[hslBand];
                    return (
                      <div key={k} className={`ed-adj ${band[k] !== 0 ? "on" : ""}`}>
                        <div className="ed-adj-head">
                          <span className="ed-adj-name">{t(`editor.hsl.${k}`)}</span>
                          <span className="ed-adj-val">{signed(band[k])}</span>
                        </div>
                        <RulerSlider
                          label={t(`editor.hsl.${k}`)}
                          value={band[k]}
                          min={-100}
                          max={100}
                          compact
                          onStart={beginDrag}
                          onChange={(v) => setHslLive(hslBand, { ...histRef.current.present.color.hsl[hslBand], [k]: v })}
                        />
                      </div>
                    );
                  })}
                </>
              )}
            </>
          )}
        </div>
      </aside>
    ) : null;

  let panelBody: ReactNode = null;
  if (tab === "transform" && panel === "ratio") {
    panelBody = (
      <PanelWithBack title={t("editor.ratio")} backLabel={t("editor.back")} onBack={() => setPanel(null)}>
        <div className="ed-ratios">
          {CROP_ASPECTS.map((a) => (
            <button key={a} className={`ed-ratio ${aspect === a ? "sel" : ""}`} onClick={() => pickAspect(a)}>
              {a === "free" ? t("editor.crop.free") : a === "original" ? t("editor.crop.original") : a}
            </button>
          ))}
        </div>
      </PanelWithBack>
    );
  } else if (tab === "transform" && panel === "straighten") {
    const dials: { key: GeoDial; label: string; Icon: IconComponent }[] = [
      { key: "straighten", label: "editor.straighten", Icon: StraightenIcon },
      { key: "perspectiveV", label: "editor.perspectiveV", Icon: SortIcon },
      { key: "perspectiveH", label: "editor.perspectiveH", Icon: SwapHorizIcon },
    ];
    const open = dials.find((d) => d.key === dial) ?? dials[0];
    panelBody = (
      <div className="ed-sub">
        <div className="ed-panel-head">
          <button
            className="ed-head-back"
            onClick={() => setPanel(null)}
            title={t("editor.back")}
            aria-label={t("editor.back")}
          >
            <ArrowBackIcon size={20} />
          </button>
          <span className="ed-panel-title">{t(open.label)}</span>
          {warped && (
            <button className="ed-head-action" onClick={resetGeometry}>
              {t("editor.reset")}
            </button>
          )}
        </div>
        <div className="ed-rounds">
          {dials.map(({ key, label, Icon }) => {
            const v = present[key];
            return (
              <ToolCircle
                key={key}
                label={t(label)}
                selected={dial === key}
                modified={v !== 0}
                valueText={v !== 0 ? String(v) : undefined}
                onClick={() => pickDial(key)}
              >
                <Icon size={24} />
              </ToolCircle>
            );
          })}
        </div>
        <RulerSlider
          label={t(open.label)}
          value={present[dial]}
          min={-100}
          max={100}
          onStart={beginDrag}
          onChange={(v) => onDial(dial, v)}
        />
      </div>
    );
  } else if (tab === "transform") {
    panelBody = (
      <OptionPill>
        <PillButton short={t("editor.short.flipH")} label={t("editor.flipH")} onClick={flipHorizontal}>
          <FlipHorizontalIcon size={22} />
        </PillButton>
        <PillButton short={t("editor.short.flipV")} label={t("editor.flipV")} onClick={flipVertical}>
          <FlipVerticalIcon size={22} />
        </PillButton>
        <PillButton short={t("editor.short.rotate")} label={t("editor.rotate")} onClick={rotate}>
          <RotateRightIcon size={22} />
        </PillButton>
        <PillButton short={t("editor.short.ratio")} label={t("editor.ratio")} active={aspect !== "free"} onClick={() => setPanel("ratio")}>
          <AspectRatioIcon size={22} />
        </PillButton>
        <PillButton short={t("editor.short.straighten")} label={t("editor.straighten")} active={warped} onClick={() => setPanel("straighten")}>
          <StraightenIcon size={22} />
        </PillButton>
      </OptionPill>
    );
  } else if (tab === "draw") {
    panelBody = (
      <OptionPill>
        <PillButton short={t("editor.short.pen")} label={t("editor.tab.draw")} active={markTool === "pen"} onClick={() => pickMarkTool("pen")}>
          <DrawIcon size={22} />
        </PillButton>
        <PillButton short={t("editor.short.text")} label={t("editor.tool.text")} active={markTool === "text"} onClick={() => pickMarkTool("text")}>
          <TextIcon size={22} />
        </PillButton>
        <PillButton
          short={t("editor.short.redact")} label={t("editor.tool.redact")}
          active={markTool === "redact"}
          onClick={() => pickMarkTool("redact")}
        >
          <BrushIcon size={22} />
        </PillButton>
        <PillButton short={t("editor.short.faces")} label={t("editor.faces.title")} active={markTool === "faces"} onClick={() => pickMarkTool("faces")}>
          <FaceIcon size={22} />
        </PillButton>
      </OptionPill>
    );
  } else if (tab === "more") {
    panelBody = (
      <OptionPill>
        <PillButton short={t("editor.short.frame")} label={t("editor.tool.frame")} active={moreTool === "frame"} onClick={() => pickMoreTool("frame")}>
          <FilterFramesIcon size={22} />
        </PillButton>
        <PillButton short={t("editor.short.color")} label={t("editor.tool.color")} active={moreTool === "color"} onClick={() => pickMoreTool("color")}>
          <TuneIcon size={22} />
        </PillButton>
      </OptionPill>
    );
  }

  const editing = editingText != null ? present.texts.find((x) => x.id === editingText) ?? null : null;
  const selBox = selected && tab === "draw" && markTool === "text" && disp.w ? textBox(measure(), selected, disp.w, disp.h) : null;
  const editBox = editing && disp.w ? textBox(measure(), editing, disp.w, disp.h) : null;

  return (
    <div className="ed-root" onClick={(e) => e.stopPropagation()}>
      <div className="ed-topbar">
        <IconBubble label={t("editor.back")} onClick={requestCancel} disabled={busy}>
          <ArrowBackIcon size={20} />
        </IconBubble>
        <div className="ed-topbar-right">
          <IconBubble label={t("editor.undo")} onClick={undo} disabled={!canUndo || busy}>
            <UndoIcon size={18} />
          </IconBubble>
          <IconBubble label={t("editor.redo")} onClick={redo} disabled={!canRedo || busy}>
            <RedoIcon size={18} />
          </IconBubble>
          <IconBubble label={t("editor.reset")} onClick={resetAll} disabled={busy} dim>
            <RestoreIcon size={18} />
          </IconBubble>
          <button
            className={`ed-save ${saveOpen ? "open" : ""}`}
            onClick={openSave}
            disabled={busy || !ready || faceBusy}
            title={t("editor.save")}
            aria-label={t("editor.save")}
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
        {ready ? (
          <div
            ref={wrapRef}
            className={`ed-canvas-wrap ${canCompare ? "compare" : ""}`}
            style={{ width: disp.w, height: disp.h }}
            onPointerDown={onCompareDown}
          >
            <canvas className="ed-canvas" ref={canvasRef} />
            {cropping && bounds.w > 0 && (
              <div
                className="ed-overlay crop"
                onPointerDown={onCropDown}
                onPointerMove={onCropMove}
                onPointerUp={onCropUp}
              >
                <CropOverlay box={displayCrop} boundsW={bounds.w} boundsH={bounds.h} dispW={disp.w} dispH={disp.h} />
              </div>
            )}
            {tab === "more" && moreTool === "frame" && present.frame && (
              <div
                className={`ed-overlay frame ${framePicking ? "picking" : ""}`}
                onPointerDown={onFrameDown}
                onPointerMove={onFrameMove}
                onPointerUp={onFrameUp}
                onWheel={onFrameWheel}
              >
                {frameSnap.x && <span className="ed-snap v" />}
                {frameSnap.y && <span className="ed-snap h" />}
              </div>
            )}
            {tab === "draw" && markTool === "redact" && (
              <div
                className="ed-overlay redact"
                onPointerDown={onRedactDown}
                onPointerMove={onRedactMove}
                onPointerUp={onRedactUp}
              />
            )}
            {tab === "draw" && markTool === "pen" && (
              <div
                className="ed-overlay pen"
                onPointerDown={onPenDown}
                onPointerMove={onPenMove}
                onPointerUp={onPenUp}
              />
            )}
            {tab === "draw" && markTool === "text" && (
              <div
                className="ed-overlay text"
                onPointerDown={onTextDown}
                onPointerMove={onTextMove}
                onPointerUp={onTextUp}
                onDoubleClick={onTextDoubleClick}
              >
                {selBox && selected && editingText !== selected.id && (
                  <div
                    className="ed-text-sel"
                    style={{
                      left: selBox.cx - selBox.halfWidth,
                      top: selBox.cy - selBox.halfHeight,
                      width: selBox.halfWidth * 2,
                      height: selBox.halfHeight * 2,
                      transform: `rotate(${snapTextAngle(selected.rotation)}deg)`,
                    }}
                  >
                    <span className="ed-text-handle" />
                  </div>
                )}
                {editing && editBox && (
                  <textarea
                    className="ed-text-field"
                    autoFocus
                    value={editing.text}
                    spellCheck={false}
                    rows={Math.max(1, editBox.lines.length)}
                    onChange={(e) => patchText(editing.id, { text: e.currentTarget.value })}
                    onPointerDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Escape") {
                        e.preventDefault();
                        finishTextEdit();
                      }
                    }}
                    onBlur={finishTextEdit}
                    style={{
                      left: editBox.cx - Math.max(editBox.halfWidth, editBox.px * 1.5),
                      top: editBox.cy - editBox.halfHeight,
                      width: Math.max(editBox.halfWidth, editBox.px * 1.5) * 2,
                      height: editBox.halfHeight * 2,
                      font: textFont(editBox.px),
                      lineHeight: `${editBox.px * 1.2}px`,
                      padding: `${editBox.px * 0.12}px 0`,
                      color: editing.color,
                      caretColor: editing.color,
                      borderRadius: editBox.radius,
                      background:
                        editing.backgroundOpacity > 0.001
                          ? hexWithAlpha(editing.background, editing.backgroundOpacity)
                          : "transparent",
                      transform: `rotate(${snapTextAngle(editing.rotation)}deg)`,
                    }}
                  />
                )}
              </div>
            )}
          </div>
        ) : (
          <p className="ed-stage-msg">{loadErr || t("common.loading")}</p>
        )}
        {comparing && source && (
          <>
            <img className="ed-compare" src={source.dataUrl} alt="" draggable={false} />
            <span className="ed-compare-label">{t("editor.original")}</span>
          </>
        )}
      </div>
      <div className="ed-side-slot">{sidePanel}</div>
      </div>

      <div className="ed-bottom">
        {panelBody && (
          <div className="ed-panel" key={`${tab}:${panel ?? ""}`}>
            {panelBody}
          </div>
        )}
        <div className="ed-tabs" role="tablist">
          {TABS.map(({ id, label, short, Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`ed-tab ${tab === id ? "sel" : ""}`}
              onClick={() => openTab(id)}
              title={t(label)}
              aria-label={t(label)}
            >
              <span className="ed-tab-icon">
                <Icon size={24} />
              </span>
              <span className="ed-tab-label">{t(short)}</span>
            </button>
          ))}
        </div>
      </div>

      {askFaceModel && (
        <Confirm
          title={t("editor.faces.modelTitle")}
          message={t("editor.faces.modelBody")}
          confirmLabel={t("editor.faces.download")}
          onCancel={() => setAskFaceModel(false)}
          onConfirm={() => void downloadFaceModel()}
        />
      )}
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

/** One part of a side panel: its name (and its value, if it has one) over its controls. */
function SideSection({
  title,
  value,
  idle,
  children,
}: {
  title: string;
  value?: string;
  /** Dimmed while it does not apply yet (a border before there is a frame). */
  idle?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`ed-sec ${idle ? "idle" : ""}`}>
      <div className="ed-sec-head">
        <span className="ed-sec-title">{title}</span>
        {value != null && <span className="ed-sec-val">{value}</span>}
      </div>
      {children}
    </section>
  );
}

/** A frame shape drawn as what it is: a small outline of that proportion. */
function ShapeGlyph({ shape, photo }: { shape: string; photo: { w: number; h: number } }) {
  if (shape === "off") return <BlockIcon size={20} />;
  let w = 1;
  let h = 1;
  if (shape === "original") {
    w = photo.w || 4;
    h = photo.h || 3;
  } else if (shape !== "polaroid") {
    const [a, b] = shape.split(":").map(Number);
    if (a > 0 && b > 0) {
      w = a;
      h = b;
    }
  }
  const k = 24 / Math.max(w, h);
  const bw = Math.max(8, Math.round(w * k));
  const bh = Math.max(8, Math.round(h * k));
  return (
    <span
      className={`ed-shape-box ${shape === "polaroid" ? "polaroid" : ""}`}
      style={{ width: shape === "polaroid" ? 22 : bw, height: shape === "polaroid" ? 26 : bh }}
    />
  );
}

/** The save panel's sizes: the edit's own, then the long sides Android offers. */
const SAVE_EDGES: (number | null)[] = [null, 2048, 1024];

const FORMAT_LABEL: Record<SaveFormat, string> = { jpeg: "JPEG", png: "PNG", webp: "WebP" };

/** A round button of the top bar: the pill background with a hairline border. */
function IconBubble({
  label,
  onClick,
  disabled,
  dim,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  dim?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      className={`ed-bubble ${dim ? "dim" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  );
}

/** A tab's row of buttons in one pill: each acts at once or opens its setting in a panel. */
function OptionPill({ children }: { children: ReactNode }) {
  return (
    <div className="ed-option-pill-wrap">
      <div className="ed-option-pill">{children}</div>
    </div>
  );
}

/** One button of an OptionPill; a lit one is a setting that is on. */
function PillButton({
  label,
  short,
  active,
  onClick,
  children,
}: {
  label: string;
  /** The word under the icon; the full name stays the tooltip. */
  short: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button className={`ed-pill-btn ${active ? "active" : ""}`} onClick={onClick} title={label} aria-label={label}>
      {children}
      <span className="ed-pill-label">{short}</span>
    </button>
  );
}

/** The panel a button opens: a back arrow and the setting's name over its content. */
function PanelWithBack({
  title,
  backLabel,
  onBack,
  children,
}: {
  title: string;
  backLabel: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <div className="ed-sub">
      <div className="ed-panel-head">
        <button className="ed-head-back" onClick={onBack} title={backLabel} aria-label={backLabel}>
          <ArrowBackIcon size={20} />
        </button>
        <span className="ed-panel-title">{title}</span>
      </div>
      {children}
    </div>
  );
}

/**
 * A round tool button: the pill background, or filled in the text colour while selected.
 * A selected round shows its value in the icon's place once there is one, an unselected
 * one a small accent dot while modified.
 */
function ToolCircle({
  label,
  selected,
  modified,
  valueText,
  onClick,
  children,
}: {
  label: string;
  selected?: boolean;
  modified?: boolean;
  valueText?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={`ed-round ${selected ? "sel" : ""}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={selected}
    >
      {selected && valueText ? <span className="ed-round-val">{valueText}</span> : children}
      {modified && !selected && <span className="ed-round-dot" />}
    </button>
  );
}

const CURVE_COLORS: Record<CurveChannel, string> = {
  rgb: "var(--fg-primary)",
  r: "#ff453a",
  g: "#32d74b",
  b: "#0a84ff",
};

/**
 * A tone curve to drag, the Android editor's: a press on a point moves it (the end points
 * only up and down), a press on empty space adds one there; a right click takes a middle
 * point away. The line is sampled through `curveValueAt`, as the render's table is.
 */
function CurveGraph({
  points,
  channel,
  onStart,
  onChange,
  onRemove,
}: {
  points: CurvePoint[];
  channel: CurveChannel;
  onStart: () => void;
  onChange: (pts: CurvePoint[]) => void;
  onRemove: (index: number) => void;
}) {
  const W = 300;
  const H = 200;
  const drag = useRef<number>(-1);
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const latest = useRef(sorted);
  latest.current = sorted;

  function local(e: ReactPointerEvent | ReactMouseEvent): { x: number; y: number; sx: number; sy: number } {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01(1 - (e.clientY - r.top) / r.height), sx: r.width, sy: r.height };
  }

  function nearest(x: number, y: number, sx: number, sy: number): number {
    let best = -1;
    let bestD = Infinity;
    latest.current.forEach((p, i) => {
      const d = Math.hypot((p.x - x) * sx, (p.y - y) * sy);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return bestD <= 14 ? best : -1;
  }

  const path = Array.from({ length: 73 }, (_, i) => {
    const x = i / 72;
    return `${i === 0 ? "M" : "L"}${x * W} ${(1 - curveValueAt(sorted, x)) * H}`;
  }).join(" ");

  return (
    <div
      className="ed-curve"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const { x, y, sx, sy } = local(e);
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        onStart();
        const hit = nearest(x, y, sx, sy);
        if (hit >= 0) {
          drag.current = hit;
          return;
        }
        const added = { x, y };
        const next = [...latest.current, added].sort((a, b) => a.x - b.x);
        drag.current = next.indexOf(added);
        // Held here at once, so a move that lands before the next render builds on it.
        latest.current = next;
        onChange(next);
      }}
      onPointerMove={(e) => {
        const i = drag.current;
        if (i < 0) return;
        const pts = latest.current.slice();
        if (i >= pts.length) return;
        const { x, y } = local(e);
        const nx = i === 0 ? 0 : i === pts.length - 1 ? 1 : Math.min(pts[i + 1].x - 0.02, Math.max(pts[i - 1].x + 0.02, x));
        pts[i] = { x: nx, y };
        latest.current = pts;
        onChange(pts);
      }}
      onPointerUp={() => (drag.current = -1)}
      onContextMenu={(e) => {
        e.preventDefault();
        const { x, y, sx, sy } = local(e);
        const hit = nearest(x, y, sx, sy);
        if (hit > 0 && hit < latest.current.length - 1) onRemove(hit);
      }}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <g className="ed-curve-grid">
          <line x1={W / 3} y1={0} x2={W / 3} y2={H} />
          <line x1={(2 * W) / 3} y1={0} x2={(2 * W) / 3} y2={H} />
          <line x1={0} y1={H / 3} x2={W} y2={H / 3} />
          <line x1={0} y1={(2 * H) / 3} x2={W} y2={(2 * H) / 3} />
          <line x1={0} y1={H} x2={W} y2={0} className="diag" />
        </g>
        <path d={path} fill="none" stroke={CURVE_COLORS[channel]} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
      </svg>
      {sorted.map((p, i) => (
        <span
          key={i}
          className="ed-curve-pt"
          style={{ left: `${p.x * 100}%`, top: `${(1 - p.y) * 100}%`, borderColor: CURVE_COLORS[channel] }}
        />
      ))}
    </div>
  );
}

/** `#rrggbb` with an opacity, as CSS. */
function hexWithAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * A colour picker, the Android editor's: a square of saturation across and brightness
 * down for the hue below it, and a rainbow bar to pick that hue. A grey keeps the hue it
 * had, so the bar does not jump to red as the square is dragged across the grey side.
 */
function ColorPicker({
  value,
  onChange,
  onStart,
}: {
  value: string;
  onChange: (hex: string) => void;
  onStart?: () => void;
}) {
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  // A colour from outside (an undo, another text) moves the pickers to it.
  useEffect(() => {
    setHsv((cur) => {
      if (hsvToHex(cur.h, cur.s, cur.v) === value) return cur;
      const next = hexToHsv(value);
      return next.s > 0.001 && next.v > 0.001 ? next : { ...next, h: cur.h };
    });
  }, [value]);
  const dragging = useRef<"square" | "hue" | null>(null);

  function apply(e: ReactPointerEvent, what: "square" | "hue") {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const fx = clamp01((e.clientX - r.left) / r.width);
    const fy = clamp01((e.clientY - r.top) / r.height);
    const next = what === "square" ? { ...hsv, s: fx, v: 1 - fy } : { ...hsv, h: fx * 360 };
    setHsv(next);
    onChange(hsvToHex(next.h, next.s, next.v));
  }

  function down(e: ReactPointerEvent, what: "square" | "hue") {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = what;
    onStart?.();
    apply(e, what);
  }

  return (
    <div className="ed-picker">
      <div
        className="ed-picker-square"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hsvToHex(hsv.h, 1, 1)})` }}
        onPointerDown={(e) => down(e, "square")}
        onPointerMove={(e) => dragging.current === "square" && apply(e, "square")}
        onPointerUp={() => (dragging.current = null)}
      >
        <span
          className="ed-picker-dot"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hsvToHex(hsv.h, hsv.s, hsv.v) }}
        />
      </div>
      <div
        className="ed-picker-hue"
        onPointerDown={(e) => down(e, "hue")}
        onPointerMove={(e) => dragging.current === "hue" && apply(e, "hue")}
        onPointerUp={() => (dragging.current = null)}
      >
        <span className="ed-picker-bar" />
        <span className="ed-picker-dot" style={{ left: `${(hsv.h / 360) * 100}%`, top: "50%", background: hsvToHex(hsv.h, 1, 1) }} />
      </div>
    </div>
  );
}

/** The pen's ten colours as swatches, the picked one ringed. */
function Swatches({ value, onPick }: { value: string; onPick: (hex: string) => void }) {
  return (
    <div className="ed-swatches">
      {DRAW_COLORS.map((c) => (
        <button
          key={c}
          className={`ed-swatch ${value.toLowerCase() === c ? "sel" : ""}`}
          style={{ background: c }}
          onClick={() => onPick(c)}
          aria-label={c}
        />
      ))}
    </div>
  );
}

/**
 * A ruler for a value: ticks across the width, every fifth longer, the span between zero
 * (or the low end) and the value in the accent and a marker at the value. A press or a
 * drag anywhere sets the value under the pointer; the editor's window-wide release folds
 * the whole drag into one undo entry.
 */
function RulerSlider({
  label,
  value,
  min,
  max,
  compact,
  onStart,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  /** A shorter ruler, for a list of them. */
  compact?: boolean;
  onStart?: () => void;
  onChange: (v: number) => void;
}) {
  const dragging = useRef(false);
  const { lo, hi, at } = rulerSpan(value, min, max);

  function valueFrom(e: ReactPointerEvent): number {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return rulerValueAt(e.clientX - rect.left, rect.width, min, max);
  }

  return (
    <div
      className={`ed-ruler ${compact ? "compact" : ""}`}
      role="slider"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        dragging.current = true;
        onStart?.();
        onChange(valueFrom(e));
      }}
      onPointerMove={(e) => {
        if (dragging.current) onChange(valueFrom(e));
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
    >
      {Array.from({ length: RULER_STEPS + 1 }, (_, i) => {
        const f = i / RULER_STEPS;
        const lit = hi > lo && f >= lo && f <= hi;
        return (
          <span
            key={i}
            className={`ed-tick ${i % 5 === 0 ? "major" : ""} ${lit ? "lit" : ""}`}
            style={{ left: `calc(var(--ruler-pad) + (100% - 2 * var(--ruler-pad)) * ${f})` }}
          />
        );
      })}
      <span
        className="ed-ruler-mark"
        style={{ left: `calc(var(--ruler-pad) + (100% - 2 * var(--ruler-pad)) * ${at})` }}
      />
    </div>
  );
}

/** The crop overlay's look, in screen pixels, as the Android editor draws it. */
const CROP_FRAME_STROKE = 2;
const CROP_MARKER_STROKE = 4;
const CROP_MARKER_ARM = 22;
const CROP_EDGE_MARKER = 28;
const CROP_MARKER_BACKING = 1;

/**
 * The crop rectangle over the image, drawn in screen pixels so its weight never follows
 * the photo's resolution: a dimming mask over the photo outside the crop, a thin accent
 * frame, a thirds grid, and corner brackets with a marker in the middle of each side. A
 * marker lies inside the rectangle with its outer edge on the frame, over a darker rim
 * that holds it against a bright photo.
 */
function CropOverlay({
  box,
  boundsW,
  boundsH,
  dispW,
  dispH,
}: {
  box: CropBox;
  boundsW: number;
  boundsH: number;
  dispW: number;
  dispH: number;
}) {
  const sx = dispW / boundsW;
  const sy = dispH / boundsH;
  const l = box.left * sx;
  const tp = box.top * sy;
  const r = box.right * sx;
  const b = box.bottom * sy;
  const w = r - l;
  const h = b - tp;
  if (w <= 0 || h <= 0) return null;

  const inset = CROP_MARKER_STROKE / 2;
  // Every marker gives way on a crop too small to hold it, so a corner and the side
  // marker beside it never merge into a solid edge.
  const arm = Math.min(CROP_MARKER_ARM, Math.min(w, h) / 4);
  const edgeX = Math.min(CROP_EDGE_MARKER, w / 4);
  const edgeY = Math.min(CROP_EDGE_MARKER, h / 4);
  const il = l + inset;
  const it = tp + inset;
  const ir = r - inset;
  const ib = b - inset;
  const mx = (l + r) / 2;
  const my = (tp + b) / 2;
  const segments: [number, number, number, number][] = [
    [l, it, l + arm, it],
    [il, tp, il, tp + arm],
    [r - arm, it, r, it],
    [ir, tp, ir, tp + arm],
    [l, ib, l + arm, ib],
    [il, b - arm, il, b],
    [r - arm, ib, r, ib],
    [ir, b - arm, ir, b],
    [mx - edgeX / 2, it, mx + edgeX / 2, it],
    [mx - edgeX / 2, ib, mx + edgeX / 2, ib],
    [il, my - edgeY / 2, il, my + edgeY / 2],
    [ir, my - edgeY / 2, ir, my + edgeY / 2],
  ];
  const half = CROP_FRAME_STROKE / 2;
  return (
    <svg className="ed-crop-svg" viewBox={`0 0 ${dispW} ${dispH}`} width={dispW} height={dispH}>
      {/* Dim the photo outside the crop: the whole frame, with the crop punched out (even-odd). */}
      <path
        d={`M0 0H${dispW}V${dispH}H0Z M${l} ${tp}H${r}V${b}H${l}Z`}
        fill="rgba(0,0,0,0.55)"
        fillRule="evenodd"
      />
      <g stroke="rgba(255,255,255,0.35)" strokeWidth={1} shapeRendering="crispEdges">
        <line x1={l + w / 3} y1={tp} x2={l + w / 3} y2={b} />
        <line x1={l + (2 * w) / 3} y1={tp} x2={l + (2 * w) / 3} y2={b} />
        <line x1={l} y1={tp + h / 3} x2={r} y2={tp + h / 3} />
        <line x1={l} y1={tp + (2 * h) / 3} x2={r} y2={tp + (2 * h) / 3} />
      </g>
      <rect
        x={l + half}
        y={tp + half}
        width={Math.max(0, w - CROP_FRAME_STROKE)}
        height={Math.max(0, h - CROP_FRAME_STROKE)}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={CROP_FRAME_STROKE}
      />
      <g stroke="rgba(0,0,0,0.45)" strokeWidth={CROP_MARKER_STROKE + 2 * CROP_MARKER_BACKING}>
        {segments.map(([x1, y1, x2, y2], i) => (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />
        ))}
      </g>
      <g stroke="#fff" strokeWidth={CROP_MARKER_STROKE}>
        {segments.map(([x1, y1, x2, y2], i) => (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />
        ))}
      </g>
    </svg>
  );
}
