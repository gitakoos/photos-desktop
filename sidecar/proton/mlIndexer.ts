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

/*
 * The detector's RGB, 0-1 input, its letterbox and its (1, 25200, 16) output rows follow the
 * published YOLOv5-face detection format, which is GPL-3.0 licensed:
 *
 *   Copyright (c) 2021 the YOLOv5-face contributors
 */

// Looks at the photos the phone has not, on this PC, with the phone's own models and the
// phone's own preprocessing: the CLIP ViT-B/16 image encoder for search, then YOLOv5-face to
// find the faces, an alignment onto the ArcFace template and GhostFaceNet to tell them apart.
// Each photo is read from its HD preview, the picture the viewer shows, never the original.

import { availableParallelism } from "node:os";

import { faceDetectorModel } from "./faces.ts";
import { MIN_SHARPNESS, rgbSharpness } from "./faceCluster.ts";
import { toHalves } from "./mlSnapshot.ts";
import { pinnedModel } from "./pinnedModel.ts";
import { TEXT_MODEL, modelStatus as textModelStatus, startModelDownload as startTextModelDownload } from "./semantic.ts";

/** The image half of the phone's search model, pinned to the release's bytes. */
export const CLIP_IMAGE_MODEL = {
  url: "https://github.com/gitakoos/clip-models/releases/download/v1/clip_image.onnx",
  file: "clip_image.onnx",
  size: 172_680_414,
  sha256: "57bd1d3bc57e74d99a14a1ef0d1de717049dc2a14cb867a5927907a88c4eecaf",
};

/** The phone's face recognition model, pinned to the release's bytes. */
export const FACE_EMBED_MODEL = {
  url: "https://github.com/gitakoos/face-models/releases/download/v2/ghostfacenet.onnx",
  file: "ghostfacenet.onnx",
  size: 16_190_333,
  sha256: "ffd8203a0c9e93d90a4957e24d173a883a5a04d64d23c771742c66273518a0db",
};

const clipImage = pinnedModel(CLIP_IMAGE_MODEL, "semantic");
const embedder = pinnedModel(FACE_EMBED_MODEL, "faces");

export type ModelsStatus = {
  /** Bytes still to fetch across all four models; 0 when every one is on disk. */
  missing: number;
  downloading: { done: number; total: number } | null;
  failed: string | null;
};

const PARTS = () => [
  { status: textModelStatus(), size: TEXT_MODEL.size, start: startTextModelDownload },
  { status: clipImage.status(), size: CLIP_IMAGE_MODEL.size, start: clipImage.startDownload },
  { status: faceDetectorModel.status(), size: 32_370_314, start: faceDetectorModel.startDownload },
  { status: embedder.status(), size: FACE_EMBED_MODEL.size, start: embedder.startDownload },
];

/** Where the four models stand, together. */
export function indexModelsStatus(): ModelsStatus {
  let missing = 0;
  let done = 0;
  let total = 0;
  let failed: string | null = null;
  for (const p of PARTS()) {
    if (p.status.state === "ready") continue;
    missing += p.size;
    if (p.status.state === "downloading") {
      done += p.status.done;
      total += p.status.total;
    }
    if (p.status.state === "failed") failed = p.status.error;
  }
  return { missing, downloading: total > 0 ? { done, total } : null, failed };
}

/** Fetches whichever of the four models is missing, in the background. */
export function startIndexModelsDownload(): ModelsStatus {
  for (const p of PARTS()) if (p.status.state === "absent" || p.status.state === "failed") p.start();
  return indexModelsStatus();
}

// ---- Looking at one photo ----

const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711];
const DETECT_SIDE = 640;
const ROW = 16;
const SCORE_THRESHOLD = 0.6;
/** The Android app's sensitive setting, for its "find more photos" sweep, used by a thorough look. */
const SENSITIVE_THRESHOLD = 0.5;
/** A photo at least this wide or tall is also looked at in four overlapping quarters. */
const TILE_FROM_SIDE = 1000;
/** How far each quarter reaches past the middle, so a face on a seam is whole in one of them. */
const TILE_OVERLAP = 0.125;
const NMS_IOU = 0.4;
const MIN_FACE_PX = 40;
const MIN_FACE_FRACTION = 0.03;
const MIN_SIDE = 24;
/** The longest side a photo is decoded at: past the detector's and enough for a face crop. */
const DECODE_SIDE = 2048;
const ALIGN = 112;
const TEMPLATE_X = [38.2946, 73.5318, 56.0252, 41.5493, 70.7299];
const TEMPLATE_Y = [51.6963, 51.5014, 71.7366, 92.3655, 92.2041];

type Rgb = { data: Uint8Array; w: number; h: number };

export type FoundFace = {
  box: [number, number, number, number];
  score: number;
  blur: number;
  points: Float32Array;
  embedding: Float32Array;
};

export type Look = { vector: Uint16Array; faces: FoundFace[] };

function unit(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  return n > 0 ? Float32Array.from(v, (x) => x / n) : v;
}

/** The similarity that maps `pts` onto the ArcFace template, as FaceAlignment computes it. */
export function similarity(pts: ArrayLike<number>): { c: number; s: number; tx: number; ty: number } {
  let msx = 0, msy = 0, mdx = 0, mdy = 0;
  for (let i = 0; i < 5; i++) {
    msx += pts[2 * i]; msy += pts[2 * i + 1]; mdx += TEMPLATE_X[i]; mdy += TEMPLATE_Y[i];
  }
  msx /= 5; msy /= 5; mdx /= 5; mdy /= 5;
  let sxx = 0, a = 0, b = 0;
  for (let i = 0; i < 5; i++) {
    const px = pts[2 * i] - msx, py = pts[2 * i + 1] - msy, qx = TEMPLATE_X[i] - mdx, qy = TEMPLATE_Y[i] - mdy;
    sxx += px * px + py * py; a += px * qx + py * qy; b += px * qy - py * qx;
  }
  if (!(sxx > 0)) return { c: 1, s: 0, tx: mdx - msx, ty: mdy - msy };
  const c = a / sxx, s = b / sxx;
  return { c, s, tx: mdx - c * msx + s * msy, ty: mdy - s * msx - c * msy };
}

/** The 112-pixel aligned crop, sampled bilinearly through the inverse of the similarity. */
export function alignFace(img: Rgb, pts: ArrayLike<number>): Uint8Array {
  const { c, s, tx, ty } = similarity(pts);
  const det = c * c + s * s;
  const out = new Uint8Array(ALIGN * ALIGN * 3);
  const at = (x: number, y: number, ch: number) => (x < 0 || y < 0 || x >= img.w || y >= img.h ? 0 : img.data[(y * img.w + x) * 3 + ch]);
  for (let v = 0; v < ALIGN; v++) {
    for (let u = 0; u < ALIGN; u++) {
      const xu = u + 0.5 - tx, yv = v + 0.5 - ty;
      const sx = (c * xu + s * yv) / det - 0.5, sy = (-s * xu + c * yv) / det - 0.5;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      for (let ch = 0; ch < 3; ch++) {
        out[(v * ALIGN + u) * 3 + ch] = Math.round(
          at(x0, y0, ch) * (1 - fx) * (1 - fy) + at(x0 + 1, y0, ch) * fx * (1 - fy) +
            at(x0, y0 + 1, ch) * (1 - fx) * fy + at(x0 + 1, y0 + 1, ch) * fx * fy,
        );
      }
    }
  }
  return out;
}

type Hit = { score: number; box: number[]; pts: number[] };

/**
 * The detector's rows over `threshold`, in the source picture's pixels. `offX` and `offY` place
 * a region that was cut out of the picture back where it came from.
 */
export function detectionRows(
  o: Float32Array,
  scale: number,
  padX: number,
  padY: number,
  threshold = SCORE_THRESHOLD,
  offX = 0,
  offY = 0,
): Hit[] {
  const hits: Hit[] = [];
  for (let b = 0; b + ROW <= o.length; b += ROW) {
    const score = o[b + 4] * o[b + 15];
    if (!(score >= threshold)) continue;
    const bx = (v: number) => offX + (v - padX) / scale;
    const by = (v: number) => offY + (v - padY) / scale;
    const box = [bx(o[b] - o[b + 2] / 2), by(o[b + 1] - o[b + 3] / 2), bx(o[b] + o[b + 2] / 2), by(o[b + 1] + o[b + 3] / 2)];
    const pts: number[] = [];
    for (let k = 0; k < 5; k++) pts.push(bx(o[b + 5 + 2 * k]), by(o[b + 6 + 2 * k]));
    hits.push({ score, box, pts });
  }
  return hits;
}

/** The faces big enough to keep, each once: the surest of any overlapping pair wins. */
export function keepFaces(rows: Hit[], w: number, h: number): Hit[] {
  const minEdge = Math.max(MIN_FACE_PX, MIN_FACE_FRACTION * Math.min(w, h));
  const hits = rows.filter((r) => Math.min(r.box[2] - r.box[0], r.box[3] - r.box[1]) >= minEdge);
  hits.sort((a, b) => b.score - a.score);
  const iou = (a: number[], b: number[]) => {
    const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
    const ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - iw * ih;
    return u > 0 ? (iw * ih) / u : 0;
  };
  const kept: typeof hits = [];
  for (const h of hits) if (!kept.some((k) => iou(k.box, h.box) >= NMS_IOU)) kept.push(h);
  return kept;
}

/** The detector's rows that pass, in the source picture's pixels, after suppression. */
export function decodeDetections(o: Float32Array, scale: number, padX: number, padY: number, w: number, h: number) {
  return keepFaces(detectionRows(o, scale, padX, padY), w, h);
}

/**
 * The regions a thorough look runs the detector over: the whole picture, and for a large one
 * its four quarters reaching a little past the middle. The detector reads a 640 square, so in
 * a wide group photo a face of 40 pixels shrinks to about 12 in the whole and is missed; in a
 * quarter it is twice that, and found.
 */
export function detectRegions(w: number, h: number, thorough: boolean): { x: number; y: number; w: number; h: number }[] {
  const out = [{ x: 0, y: 0, w, h }];
  if (!thorough || Math.max(w, h) < TILE_FROM_SIDE) return out;
  const tw = Math.round(w * (0.5 + TILE_OVERLAP));
  const th = Math.round(h * (0.5 + TILE_OVERLAP));
  for (const y of [0, h - th]) for (const x of [0, w - tw]) out.push({ x, y, w: tw, h: th });
  return out;
}

/** The three image models, opened once for a run and released after it. */
export class Analyzer {
  private ort: any;
  private sharp: any;
  private clip: any;
  private det: any;
  private emb: any;

  /** Opens the sessions; false when a model is missing or not the pinned one. */
  async open(): Promise<boolean> {
    if (!(await clipImage.intact()) || !(await faceDetectorModel.intact()) || !(await embedder.intact())) return false;
    this.ort = await import("onnxruntime-node");
    this.sharp = (await import("sharp")).default;
    // Half the cores: a scan of the whole library runs for minutes, and taking every core
    // for it would leave the window, the thumbnails and the rest of the PC to stutter.
    const threads = Math.max(1, Math.floor(availableParallelism() / 2));
    const opts = (level: string) => ({
      graphOptimizationLevel: level,
      executionProviders: ["cpu"],
      logSeverityLevel: 3,
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
    });
    // Basic optimisation for CLIP, as on the phone: the extended fusions are not what it was checked under.
    this.clip = await this.ort.InferenceSession.create(clipImage.path(), opts("basic"));
    this.det = await this.ort.InferenceSession.create(faceDetectorModel.path(), opts("all"));
    this.emb = await this.ort.InferenceSession.create(embedder.path(), opts("all"));
    return true;
  }

  async close(): Promise<void> {
    for (const s of [this.clip, this.det, this.emb]) await s?.release?.().catch(() => {});
    this.clip = this.det = this.emb = null;
  }

  /**
   * What one picture shows: its search vector unless `vector` is false, and its faces unless
   * `faces` is false. A `thorough` look runs the detector at the sensitive setting over the
   * whole picture and its quarters, so the small faces of a group photo are found too.
   */
  async look(picture: Buffer, faces: boolean, thorough = false, vector = true): Promise<Look> {
    const { data, info } = await this.sharp(picture, { limitInputPixels: 100_000_000 })
      .rotate()
      .flatten({ background: "#ffffff" })
      .resize(DECODE_SIDE, DECODE_SIDE, { fit: "inside", withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const img: Rgb = { data: new Uint8Array(data), w: info.width, h: info.height };
    const v = vector ? toHalves(await this.encode(img)) : new Uint16Array(0);
    if (!faces || img.w < MIN_SIDE || img.h < MIN_SIDE) return { vector: v, faces: [] };
    return { vector: v, faces: await this.faces(img, thorough) };
  }

  private raw(img: Rgb) {
    return this.sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), { raw: { width: img.w, height: img.h, channels: 3 } });
  }

  /** Fills the 224 square and takes its centre, as ClipImageEncoder does. */
  private async encode(img: Rgb): Promise<Float32Array> {
    const data: Buffer = await this.raw(img).resize(224, 224, { fit: "cover" }).raw().toBuffer();
    const plane = 224 * 224;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) input[c * plane + i] = (data[i * 3 + c] / 255 - CLIP_MEAN[c]) / CLIP_STD[c];
    const out = await this.clip.run({ [this.clip.inputNames[0]]: new this.ort.Tensor("float32", input, [1, 3, 224, 224]) });
    return unit(out[this.clip.outputNames[0]].data as Float32Array);
  }

  /** The detector over one region of the picture, letterboxed into its 640 square. */
  private async detect(img: Rgb, region: { x: number; y: number; w: number; h: number }, threshold: number): Promise<Hit[]> {
    const scale = Math.min(DETECT_SIDE / region.w, DETECT_SIDE / region.h);
    const nw = Math.max(1, Math.round(region.w * scale));
    const nh = Math.max(1, Math.round(region.h * scale));
    let pipe = this.raw(img);
    if (region.w !== img.w || region.h !== img.h) pipe = pipe.extract({ left: region.x, top: region.y, width: region.w, height: region.h });
    const small: Buffer = await pipe.resize(nw, nh, { fit: "fill" }).raw().toBuffer();
    const padX = Math.floor((DETECT_SIDE - nw) / 2);
    const padY = Math.floor((DETECT_SIDE - nh) / 2);
    const plane = DETECT_SIDE * DETECT_SIDE;
    const input = new Float32Array(3 * plane).fill(114 / 255);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const i = (y + padY) * DETECT_SIDE + x + padX;
        const j = (y * nw + x) * 3;
        input[i] = small[j] / 255;
        input[plane + i] = small[j + 1] / 255;
        input[2 * plane + i] = small[j + 2] / 255;
      }
    }
    const out = await this.det.run({ [this.det.inputNames[0]]: new this.ort.Tensor("float32", input, [1, 3, DETECT_SIDE, DETECT_SIDE]) });
    return detectionRows(out[this.det.outputNames[0]].data as Float32Array, scale, padX, padY, threshold, region.x, region.y);
  }

  private async faces(img: Rgb, thorough: boolean): Promise<FoundFace[]> {
    const threshold = thorough ? SENSITIVE_THRESHOLD : SCORE_THRESHOLD;
    const rows: Hit[] = [];
    for (const region of detectRegions(img.w, img.h, thorough)) rows.push(...(await this.detect(img, region, threshold)));
    const found: FoundFace[] = [];
    for (const hit of keepFaces(rows, img.w, img.h)) {
      const crop = alignFace(img, hit.pts);
      const blur = rgbSharpness(crop, ALIGN, ALIGN);
      // An extremely blurred crop is neither stored nor grouped, as on the phone.
      if (blur < MIN_SHARPNESS) continue;
      const input2 = new Float32Array(ALIGN * ALIGN * 3);
      for (let i = 0; i < input2.length; i++) input2[i] = (crop[i] - 127.5) / 128;
      const e = await this.emb.run({ [this.emb.inputNames[0]]: new this.ort.Tensor("float32", input2, [1, ALIGN, ALIGN, 3]) });
      const clamp = (v: number) => Math.min(1, Math.max(0, v));
      found.push({
        box: [clamp(hit.box[0] / img.w), clamp(hit.box[1] / img.h), clamp(hit.box[2] / img.w), clamp(hit.box[3] / img.h)],
        score: hit.score,
        blur,
        points: Float32Array.from(hit.pts),
        embedding: unit(e[this.emb.outputNames[0]].data as Float32Array),
      });
    }
    return found;
  }
}
