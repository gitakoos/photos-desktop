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

// The single-clip video editor's logic, apart from the window: the trim and split arithmetic,
// the crop rectangle through a turn or a flip, how the preview lays the frame out, the CSS
// that approximates the look, and the JSON the host turns into one ffmpeg pass (`video_edit.rs`).
// Positions are milliseconds; a crop is a box in pixels of the turned frame.

import { boxHeight, boxWidth, centeredCrop, type CropBox } from "./editorCrop";
import { GIF_MAX_SECONDS } from "./gifFrame";

// ---- Choices ----

export const SPEEDS = [0.5, 1, 1.5, 2] as const;
export type Speed = (typeof SPEEDS)[number];

export type Turn = 0 | 90 | 180 | 270;

export type VideoFilter = "none" | "vivid" | "warm" | "cool" | "mono" | "sepia" | "fade";

/** The presets, with the CSS filters that approximate each in the preview. */
export const FILTERS: { id: VideoFilter; label: string; css: string }[] = [
  { id: "none", label: "videoEditor.filter.none", css: "" },
  { id: "vivid", label: "videoEditor.filter.vivid", css: "saturate(1.4) contrast(1.1)" },
  { id: "warm", label: "videoEditor.filter.warm", css: "sepia(0.25) saturate(1.1) hue-rotate(-8deg)" },
  { id: "cool", label: "videoEditor.filter.cool", css: "hue-rotate(12deg) saturate(1.05) brightness(1.02)" },
  { id: "mono", label: "videoEditor.filter.mono", css: "grayscale(1) contrast(1.08)" },
  { id: "sepia", label: "videoEditor.filter.sepia", css: "sepia(1)" },
  { id: "fade", label: "videoEditor.filter.fade", css: "contrast(0.85) brightness(1.08) saturate(0.8)" },
];

export type VideoAspect = "free" | "1:1" | "4:5" | "16:9" | "9:16";
export const VIDEO_ASPECTS: VideoAspect[] = ["free", "1:1", "4:5", "16:9", "9:16"];

const ASPECT_RATIO: Record<VideoAspect, number | null> = {
  free: null,
  "1:1": 1,
  "4:5": 4 / 5,
  "16:9": 16 / 9,
  "9:16": 9 / 16,
};

/** The width over height the crop locks to, or null when it is free. */
export function aspectRatio(aspect: VideoAspect): number | null {
  return ASPECT_RATIO[aspect];
}

export const MIN_SPAN_MS = 100;
export const GIF_WIDTHS = [320, 480, 640] as const;
export const GIF_RATES = [8, 12, 15, 24] as const;

export type MusicMode = "replace" | "mix";

export type Music = {
  path: string;
  name: string;
  durationMs: number;
  /** Percent. */
  volume: number;
  mode: MusicMode;
  looped: boolean;
};

export type AudioState = {
  mute: boolean;
  /** Percent, 0 to 200. */
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
  music: Music | null;
};

export type SplitState = { atMs: number; both: boolean };

export type EditState = {
  startMs: number;
  endMs: number;
  split: SplitState | null;
  rotate: Turn;
  flipH: boolean;
  flipV: boolean;
  /** In pixels of the turned frame; null keeps the whole frame. */
  crop: CropBox | null;
  aspect: VideoAspect;
  filter: VideoFilter;
  brightness: number;
  contrast: number;
  saturation: number;
  speed: Speed;
  audio: AudioState;
  gifWidth: number;
  gifRate: number;
};

export const NEUTRAL_AUDIO: AudioState = { mute: false, volume: 100, fadeInMs: 0, fadeOutMs: 0, music: null };

export function freshEdit(durationMs: number): EditState {
  return {
    startMs: 0,
    endMs: Math.max(0, Math.round(durationMs)),
    split: null,
    rotate: 0,
    flipH: false,
    flipV: false,
    crop: null,
    aspect: "free",
    filter: "none",
    brightness: 0,
    contrast: 0,
    saturation: 0,
    speed: 1,
    audio: { ...NEUTRAL_AUDIO },
    gifWidth: 480,
    gifRate: 12,
  };
}

// ---- Trim and split ----

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** The position under a pointer on a track `width` wide that starts at `left`, in milliseconds. */
export function msAtX(clientX: number, left: number, width: number, durationMs: number): number {
  if (!(width > 0) || !(durationMs > 0)) return 0;
  return Math.round(clamp((clientX - left) / width, 0, 1) * durationMs);
}

/** Moves one handle to `ms`, keeping at least `MIN_SPAN_MS` between the two and both inside the video. */
export function moveHandle(
  state: Pick<EditState, "startMs" | "endMs">,
  handle: "start" | "end",
  ms: number,
  durationMs: number,
): { startMs: number; endMs: number } {
  const total = Math.max(0, durationMs);
  if (handle === "start") {
    return { startMs: Math.round(clamp(ms, 0, Math.max(0, state.endMs - MIN_SPAN_MS))), endMs: state.endMs };
  }
  return { startMs: state.startMs, endMs: Math.round(clamp(ms, Math.min(total, state.startMs + MIN_SPAN_MS), total)) };
}

/** The playhead kept inside the part that is kept. */
export function playheadIn(state: Pick<EditState, "startMs" | "endMs">, ms: number): number {
  return clamp(ms, state.startMs, state.endMs);
}

/** Whether the playhead can split the kept part: with a piece of at least `MIN_SPAN_MS` on each side. */
export function canSplitAt(state: Pick<EditState, "startMs" | "endMs">, ms: number): boolean {
  return ms >= state.startMs + MIN_SPAN_MS && ms <= state.endMs - MIN_SPAN_MS;
}

/** The trim after keeping one side of the split. */
export function keepSide(state: EditState, side: "first" | "second"): EditState {
  const at = state.split?.atMs;
  if (at == null) return state;
  return side === "first"
    ? { ...state, endMs: at, split: null }
    : { ...state, startMs: at, split: null };
}

/** The parts to write: the kept range, or its two halves when both sides of a split are saved. */
export function rangesToSave(state: EditState): { startMs: number; endMs: number }[] {
  const at = state.split?.atMs;
  if (state.split?.both && at != null && canSplitAt(state, at)) {
    return [
      { startMs: state.startMs, endMs: at },
      { startMs: at, endMs: state.endMs },
    ];
  }
  return [{ startMs: state.startMs, endMs: state.endMs }];
}

/** How long a part runs once the speed is applied. */
export function outputMs(range: { startMs: number; endMs: number }, speed: number): number {
  return Math.round(Math.max(0, range.endMs - range.startMs) / (speed > 0 ? speed : 1));
}

/** `m:ss.t` for a position or a length. */
export function formatClock(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

// ---- Turn, flip and crop ----

export function turnRight(turn: Turn): Turn {
  return ((turn + 90) % 360) as Turn;
}

export const sidewaysTurn = (turn: Turn): boolean => turn === 90 || turn === 270;

/** The frame after the turn, from the picture a player shows (already upright). */
export function turnedSize(width: number, height: number, turn: Turn): { w: number; h: number } {
  return sidewaysTurn(turn) ? { w: height, h: width } : { w: width, h: height };
}

/** A box after a quarter turn clockwise of a `w` by `h` frame: the frame is then `h` by `w`. */
export function turnBoxRight(box: CropBox, h: number): CropBox {
  return { left: h - box.bottom, top: box.left, right: h - box.top, bottom: box.right };
}

/** A box after the frame is mirrored across (`horizontal`) or down. */
export function flipBox(box: CropBox, w: number, h: number, horizontal: boolean): CropBox {
  return horizontal
    ? { left: w - box.right, top: box.top, right: w - box.left, bottom: box.bottom }
    : { left: box.left, top: h - box.bottom, right: box.right, bottom: h - box.top };
}

/** A crop that covers the whole frame is none at all. */
export function isFullBox(box: CropBox, w: number, h: number): boolean {
  return box.left <= 0 && box.top <= 0 && box.right >= w && box.bottom >= h;
}

/** The crop as the fractions of the turned frame the host takes, or null for the whole frame. */
export function cropFractions(
  box: CropBox | null,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } | null {
  if (!box || !(w > 0 && h > 0) || isFullBox(box, w, h)) return null;
  const f = (v: number, of: number) => Math.round(clamp(v / of, 0, 1) * 1e6) / 1e6;
  return { x: f(box.left, w), y: f(box.top, h), w: f(boxWidth(box), w), h: f(boxHeight(box), h) };
}

/** The crop's pixels as the host will cut them: even edges, inside the frame. */
export function cutSize(box: CropBox | null, w: number, h: number): { w: number; h: number } {
  const even = (v: number) => Math.max(2, Math.floor(v / 2) * 2);
  if (!box || isFullBox(box, w, h)) return { w: even(w), h: even(h) };
  return { w: even(boxWidth(box)), h: even(boxHeight(box)) };
}

/** The box a fixed shape starts at: the largest of that shape in the middle of the frame. */
export function startingCrop(aspect: VideoAspect, w: number, h: number): CropBox | null {
  const ratio = aspectRatio(aspect);
  if (ratio == null) return null;
  const box = centeredCrop(w, h, ratio);
  return isFullBox(box, w, h) ? null : box;
}

// ---- The preview's layout ----

export type PreviewLayout = {
  /** The visible window on the stage. */
  wrapW: number;
  wrapH: number;
  /** The whole turned frame, as big as it is drawn, and where it sits in the window. */
  frameW: number;
  frameH: number;
  offX: number;
  offY: number;
  scale: number;
};

/**
 * Where the turned frame sits on the stage: all of it while the crop is being drawn, only the
 * cropped part otherwise, either scaled to fill the stage as far as its shape allows.
 */
export function previewLayout(
  frame: { w: number; h: number },
  crop: CropBox | null,
  stage: { w: number; h: number },
  cropping: boolean,
): PreviewLayout {
  const region = crop && !cropping ? crop : { left: 0, top: 0, right: frame.w, bottom: frame.h };
  const rw = Math.max(1, boxWidth(region));
  const rh = Math.max(1, boxHeight(region));
  const scale = Math.max(0, Math.min(stage.w / rw, stage.h / rh));
  return {
    wrapW: rw * scale,
    wrapH: rh * scale,
    frameW: frame.w * scale,
    frameH: frame.h * scale,
    offX: -region.left * scale,
    offY: -region.top * scale,
    scale,
  };
}

// ---- The look ----

const pct = (v: number) => clamp(v, -100, 100) / 100;

/** The CSS filter that approximates the preset and the three sliders on the playing video. */
export function cssFilter(state: Pick<EditState, "filter" | "brightness" | "contrast" | "saturation">): string {
  const parts: string[] = [];
  const preset = FILTERS.find((f) => f.id === state.filter)?.css;
  if (preset) parts.push(preset);
  if (state.brightness !== 0) parts.push(`brightness(${(1 + pct(state.brightness) * 0.5).toFixed(3)})`);
  if (state.contrast !== 0) parts.push(`contrast(${(1 + pct(state.contrast)).toFixed(3)})`);
  if (state.saturation !== 0) parts.push(`saturate(${(1 + pct(state.saturation)).toFixed(3)})`);
  return parts.length ? parts.join(" ") : "none";
}

export function lookIsNeutral(state: Pick<EditState, "filter" | "brightness" | "contrast" | "saturation">): boolean {
  return state.filter === "none" && state.brightness === 0 && state.contrast === 0 && state.saturation === 0;
}

// ---- GIF ----

/** The size a GIF comes out at: the chosen width, never wider than the frame, the height following. */
export function gifFrameSize(cutW: number, cutH: number, width: number): { w: number; h: number } {
  const w = Math.max(16, Math.min(width, cutW));
  return { w, h: Math.max(2, Math.round((w * cutH) / Math.max(1, cutW) / 2) * 2) };
}

/**
 * A rough size for a GIF of that many pixels, frames and seconds. A frame of ordinary footage
 * comes to about a tenth of a byte a pixel after the palette and the compression.
 */
export function estimateGifBytes(w: number, h: number, fps: number, seconds: number): number {
  return Math.round(w * h * Math.max(1, fps) * Math.max(0, seconds) * 0.09);
}

/** Whether the part, at its speed, is short enough to be a GIF. */
export function gifFits(range: { startMs: number; endMs: number }, speed: number): boolean {
  const ms = outputMs(range, speed);
  return ms >= MIN_SPAN_MS && ms <= GIF_MAX_SECONDS * 1000;
}

// ---- What the host is asked to make ----

export type EditKind = "video" | "gif" | "frame";

/** What the host needs to know of the video besides the edit. */
export type EditContext = {
  /** The path the host reads: the user's file, or the staged download. */
  src: string;
  /** Unix milliseconds of the capture the copy keeps. */
  creationMs: number | null;
};

export type EditRequest = {
  kind: EditKind;
  src: string;
  startMs: number;
  endMs: number;
  frameMs: number;
  rotate: Turn;
  flipH: boolean;
  flipV: boolean;
  crop: { x: number; y: number; w: number; h: number } | null;
  filter: VideoFilter;
  brightness: number;
  contrast: number;
  saturation: number;
  speed: Speed;
  audio: {
    mute: boolean;
    volume: number;
    fadeInMs: number;
    fadeOutMs: number;
    music: { path: string; volume: number; mode: MusicMode; looped: boolean } | null;
  };
  gif: { width: number; fps: number };
  creationMs: number | null;
};

/**
 * The JSON for one pass of the host. `range` is the part to keep (one of `rangesToSave`), and for a
 * frame `frameMs` is the moment taken. `frame` is the size of the video as a player shows it.
 */
export function buildEdit(
  state: EditState,
  context: EditContext,
  frame: { w: number; h: number },
  kind: EditKind,
  range: { startMs: number; endMs: number },
  frameMs = 0,
): EditRequest {
  const turned = turnedSize(frame.w, frame.h, state.rotate);
  const music = state.audio.music;
  return {
    kind,
    src: context.src,
    startMs: Math.round(range.startMs),
    endMs: Math.round(range.endMs),
    frameMs: Math.round(frameMs),
    rotate: state.rotate,
    flipH: state.flipH,
    flipV: state.flipV,
    crop: cropFractions(state.crop, turned.w, turned.h),
    filter: state.filter,
    brightness: Math.round(state.brightness),
    contrast: Math.round(state.contrast),
    saturation: Math.round(state.saturation),
    speed: state.speed,
    audio: {
      mute: state.audio.mute,
      volume: Math.round(state.audio.volume),
      fadeInMs: Math.round(state.audio.fadeInMs),
      fadeOutMs: Math.round(state.audio.fadeOutMs),
      music: music ? { path: music.path, volume: Math.round(music.volume), mode: music.mode, looped: music.looped } : null,
    },
    gif: { width: state.gifWidth, fps: state.gifRate },
    creationMs: context.creationMs,
  };
}

/** Whether anything has been changed from the video as it is, for the discard prompt and the save button. */
export function isEdited(state: EditState, durationMs: number): boolean {
  const fresh = freshEdit(durationMs);
  const audio = state.audio;
  return (
    state.startMs !== fresh.startMs ||
    state.endMs !== fresh.endMs ||
    state.split !== null ||
    state.rotate !== 0 ||
    state.flipH ||
    state.flipV ||
    state.crop !== null ||
    !lookIsNeutral(state) ||
    state.speed !== 1 ||
    audio.mute ||
    audio.volume !== 100 ||
    audio.fadeInMs !== 0 ||
    audio.fadeOutMs !== 0 ||
    audio.music !== null
  );
}

/** The thumbnails a strip of this width and shape needs, so each frame keeps its proportions. */
export function stripCount(trackWidth: number, frameW: number, frameH: number, thumbHeight = 56): number {
  if (!(trackWidth > 0 && frameW > 0 && frameH > 0)) return 8;
  const thumbWidth = (thumbHeight * frameW) / frameH;
  return clamp(Math.ceil(trackWidth / thumbWidth), 4, 48);
}

/** The marks under the strip: whole seconds at a step that leaves at most `max` of them. */
export function rulerTicks(durationMs: number, max = 8): number[] {
  const total = durationMs / 1000;
  if (!(total > 0)) return [];
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800].find((s) => total / s <= max) ?? 3600;
  const out: number[] = [];
  for (let s = 0; s <= total; s += step) out.push(s);
  return out;
}
