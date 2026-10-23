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
 * The RGB, 0-1 normalised input and the single (1, 25200, 16) output row (a decoded box, an
 * objectness, five landmark pairs and a face-class score) follow the published YOLOv5-face
 * detection format, which is GPL-3.0 licensed:
 *
 *   Copyright (c) 2021 the YOLOv5-face contributors
 */

// Finds where the faces are in a photo, for the editor's Hide faces tool: the phone's own
// detector, run once per press of Detect. Only where faces are, never who they are.

import { pinnedModel } from "./pinnedModel.ts";

/** The YOLOv5-face detector the phone uses, pinned to the release's bytes. */
export const FACE_MODEL = {
  url: "https://github.com/gitakoos/face-models/releases/download/v2/yolov5face.onnx",
  file: "yolov5face.onnx",
  size: 32_370_314,
  sha256: "8ece145c7a956ed276250778bdb89e40c8ac9521c8669b14d79718cc83ccab32",
};

/** The square the network reads; the photo is letterboxed into it by the caller. */
export const FACE_INPUT = 640;

/** Values per output row: box (4), objectness (1), five landmark pairs (10), face class (1). */
const ROW = 16;
/** A face must score this much, objectness times class, as on the phone. */
export const FACE_SCORE_THRESHOLD = 0.6;
/** Boxes overlapping a surer one by this much or more are the same face. */
export const FACE_NMS_IOU = 0.4;

/** How long the loaded detector is kept after the last run. */
const DETECTOR_IDLE_MS = 2 * 60 * 1000;

/** One face, in the input square's pixels: its box, its two eyes, and how sure the network is. */
export type FaceHit = {
  box: [number, number, number, number];
  eyes: [number, number, number, number];
  score: number;
};

/** The rows of the network's output that pass the threshold, in the input square's pixels. */
export function decodeFaces(output: Float32Array, threshold = FACE_SCORE_THRESHOLD): FaceHit[] {
  const hits: FaceHit[] = [];
  const rows = Math.floor(output.length / ROW);
  for (let r = 0; r < rows; r++) {
    const b = r * ROW;
    const score = output[b + 4] * output[b + 15];
    if (!(score >= threshold)) continue;
    const cx = output[b];
    const cy = output[b + 1];
    const w = output[b + 2];
    const h = output[b + 3];
    hits.push({
      box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
      // The landmarks come in the ArcFace order: left eye, right eye, nose, mouth corners.
      eyes: [output[b + 5], output[b + 6], output[b + 7], output[b + 8]],
      score,
    });
  }
  return hits;
}

function iou(a: FaceHit["box"], b: FaceHit["box"]): number {
  const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = iw * ih;
  const area = (r: FaceHit["box"]) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
  const union = area(a) + area(b) - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Greedy suppression: keep the surest, drop what overlaps it by `limit` or more. */
export function suppressFaces(hits: FaceHit[], limit = FACE_NMS_IOU): FaceHit[] {
  const order = [...hits].sort((a, b) => b.score - a.score);
  const gone = new Array<boolean>(order.length).fill(false);
  const kept: FaceHit[] = [];
  for (let i = 0; i < order.length; i++) {
    if (gone[i]) continue;
    kept.push(order[i]);
    for (let j = i + 1; j < order.length; j++) {
      if (!gone[j] && iou(order[i].box, order[j].box) >= limit) gone[j] = true;
    }
  }
  return kept;
}

/** The `FACE_INPUT` square of RGB bytes as the network's (1, 3, H, W) input, 0 to 1. */
export function toPlanes(rgb: Uint8Array, side = FACE_INPUT): Float32Array {
  const plane = side * side;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    out[i] = rgb[i * 3] / 255;
    out[plane + i] = rgb[i * 3 + 1] / 255;
    out[2 * plane + i] = rgb[i * 3 + 2] / 255;
  }
  return out;
}

const model = pinnedModel(FACE_MODEL, "faces");

export const faceModelStatus = () => model.status();
export const startFaceModelDownload = () => model.startDownload();
export const removeFaceModel = () => {
  closeDetector();
  return model.remove();
};

let session: any = null;
let idle: ReturnType<typeof setTimeout> | null = null;

function closeDetector(): void {
  if (idle) clearTimeout(idle);
  idle = null;
  const open = session;
  session = null;
  void open?.release?.().catch(() => {});
}

/**
 * The faces in a letterboxed square of RGB bytes (base64), surest first, in the square's
 * pixels; null when the model is not on disk or is not the pinned one.
 */
export async function detectFaces(rgbBase64: string): Promise<FaceHit[] | null> {
  const rgb = Buffer.from(rgbBase64, "base64");
  if (rgb.length !== FACE_INPUT * FACE_INPUT * 3) throw new Error("the picture is not the detector's size");
  if (!(await model.intact())) return null;
  const ort = await import("onnxruntime-node");
  if (!session) {
    session = await ort.InferenceSession.create(model.path(), {
      graphOptimizationLevel: "all",
      executionProviders: ["cpu"],
      logSeverityLevel: 3,
    });
  }
  if (idle) clearTimeout(idle);
  idle = setTimeout(closeDetector, DETECTOR_IDLE_MS);
  const input = new ort.Tensor("float32", toPlanes(new Uint8Array(rgb)), [1, 3, FACE_INPUT, FACE_INPUT]);
  const result = await session.run({ [session.inputNames[0]]: input });
  const output = result[session.outputNames[0]].data as Float32Array;
  return suppressFaces(decodeFaces(output));
}
