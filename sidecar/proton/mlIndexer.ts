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

/** The detector's rows that pass, in the source picture's pixels, after suppression. */
export function decodeDetections(o: Float32Array, scale: number, padX: number, padY: number, w: number, h: number) {
  const minEdge = Math.max(MIN_FACE_PX, MIN_FACE_FRACTION * Math.min(w, h));
  const hits: { score: number; box: number[]; pts: number[] }[] = [];
  for (let b = 0; b + ROW <= o.length; b += ROW) {
    const score = o[b + 4] * o[b + 15];
    if (!(score >= SCORE_THRESHOLD)) continue;
    const bx = (v: number) => (v - padX) / scale;
    const by = (v: number) => (v - padY) / scale;
    const box = [bx(o[b] - o[b + 2] / 2), by(o[b + 1] - o[b + 3] / 2), bx(o[b] + o[b + 2] / 2), by(o[b + 1] + o[b + 3] / 2)];
    if (Math.min(box[2] - box[0], box[3] - box[1]) < minEdge) continue;
    const pts: number[] = [];
    for (let k = 0; k < 5; k++) pts.push(bx(o[b + 5 + 2 * k]), by(o[b + 6 + 2 * k]));
    hits.push({ score, box, pts });
  }
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
    const opts = (level: string) => ({ graphOptimizationLevel: level, executionProviders: ["cpu"], logSeverityLevel: 3 });
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

  /** What one picture shows: its search vector, and its faces unless `faces` is false. */
  async look(picture: Buffer, faces: boolean): Promise<Look> {
    const { data, info } = await this.sharp(picture, { limitInputPixels: 100_000_000 })
      .rotate()
      .flatten({ background: "#ffffff" })
      .resize(DECODE_SIDE, DECODE_SIDE, { fit: "inside", withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const img: Rgb = { data: new Uint8Array(data), w: info.width, h: info.height };
    const vector = toHalves(await this.encode(img));
    if (!faces || img.w < MIN_SIDE || img.h < MIN_SIDE) return { vector, faces: [] };
    return { vector, faces: await this.faces(img) };
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

  private async faces(img: Rgb): Promise<FoundFace[]> {
    const scale = Math.min(DETECT_SIDE / img.w, DETECT_SIDE / img.h);
    const nw = Math.max(1, Math.round(img.w * scale));
    const nh = Math.max(1, Math.round(img.h * scale));
    const small: Buffer = await this.raw(img).resize(nw, nh, { fit: "fill" }).raw().toBuffer();
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
    const found: FoundFace[] = [];
    for (const hit of decodeDetections(out[this.det.outputNames[0]].data as Float32Array, scale, padX, padY, img.w, img.h)) {
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
