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
 * The detect, straighten, classify and read ordering, the preprocessing and the asset descriptors
 * below are derived from mobile_ocr, which is MIT licensed:
 *
 *   Copyright (c) 2025 Laurens Priem
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, subject to the conditions of the MIT License.
 */

// Copy text: the words in a photo read on this computer with the phone's PP-OCRv5 models, the
// Latin reader that has every Hungarian letter. Detection says where the words are, each region
// is cut out as a level strip, the angle classifier says whether it is upside down, and the reader
// turns it into characters. The photo never leaves the computer.

import { readFileSync } from "node:fs";

import { cleanTextBlocks, looksReadable, type TextBlock } from "./ocrCleanup.ts";
import { detectQuads, detectionLimitSide, detectorInputSize, type DetectedQuad } from "./ocrGeometry.ts";
import {
  CLASSIFIER_WIDTH,
  READ_HEIGHT,
  READ_MAX_BATCH,
  buildCharacterDictionary,
  classifierTurnsCrop,
  cropSizeFor,
  cropTextQuad,
  decodeSlot,
  planReadBatches,
  readBatchWidth,
  writeCropInto,
  type DecodedText,
  type Rgb,
} from "./ocrRead.ts";
import { pinnedModel, type PinnedModelSpec, type PinnedModelStatus } from "./pinnedModel.ts";

const BASE = "https://github.com/gitakoos/ocr-models/releases/download/v1/";

/** The four files, pinned to the bytes of the models' own release, as on the phone. */
const SPECS: Record<"det" | "cls" | "rec" | "dict", PinnedModelSpec> = {
  det: { url: `${BASE}det.onnx`, file: "ocr-det.onnx", size: 4_748_769, sha256: "d7fe3ea74652890722c0f4d02458b7261d9f5ae6c92904d05707c9eb155c7924" },
  cls: { url: `${BASE}cls.onnx`, file: "ocr-cls.onnx", size: 582_663, sha256: "f4bb53707100c5f3d59ba834eb05bb400369f20aed35d4b26807b1bfadd2a70e" },
  rec: { url: `${BASE}rec_latin.onnx`, file: "ocr-rec-latin.onnx", size: 8_064_539, sha256: "995b0f5f28d2073896a78c03b5b863eae6af3744bafa0245b8522beea6994927" },
  dict: { url: `${BASE}ppocrv5_latin_dict.txt`, file: "ocr-latin-dict.txt", size: 2_616, sha256: "ccbcc45730b3fbbd9050c5bc74db6a99067141ef1035e3d14889a84a6b9b1aff" },
};
const models = Object.fromEntries(Object.entries(SPECS).map(([k, spec]) => [k, pinnedModel(spec, "ocr")])) as Record<
  keyof typeof SPECS,
  ReturnType<typeof pinnedModel>
>;

/** What the consent asks for, in bytes. */
export const OCR_DOWNLOAD_BYTES = Object.values(SPECS).reduce((n, s) => n + s.size, 0);

/** The four files as one: downloading while any is, ready when all are. */
export function ocrModelStatus(): PinnedModelStatus {
  const parts = Object.values(models).map((m) => m.status());
  if (parts.some((p) => p.state === "downloading")) {
    let done = 0;
    for (const [i, p] of parts.entries()) done += p.state === "downloading" ? p.done : p.state === "ready" ? Object.values(SPECS)[i].size : 0;
    return { state: "downloading", done, total: OCR_DOWNLOAD_BYTES };
  }
  if (parts.every((p) => p.state === "ready")) return { state: "ready" };
  const failed = parts.find((p) => p.state === "failed");
  if (failed) return failed;
  return { state: "absent" };
}

export function startOcrModelDownload(): PinnedModelStatus {
  for (const m of Object.values(models)) m.startDownload();
  return ocrModelStatus();
}

export function removeOcrModels(): PinnedModelStatus {
  closeSessions();
  for (const m of Object.values(models)) m.remove();
  return ocrModelStatus();
}

/** Mean and spread per channel the detector was trained on, in blue, green, red order. */
const MEAN = [0.485, 0.456, 0.406];
const DEVIATION = [0.229, 0.224, 0.225];
/** Most regions one photo is read from, the surest kept: above a dense page, below a wall of print. */
const MAX_READ_REGIONS = 256;
/** A photo is read at most this large; past it nothing more is legible, only more to hold. */
const MAX_FRAME_SIDE = 4096;
/** How long the loaded models are kept after the last read. */
const IDLE_MS = 2 * 60 * 1000;

type Sessions = { det: any; cls: any; rec: any; dictionary: string[] };
let sessions: Sessions | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;
/** One read at a time; a newer one makes the one running stop at its next group. */
let queue: Promise<unknown> = Promise.resolve();
let latest = 0;

function closeSessions(): void {
  if (idle) clearTimeout(idle);
  idle = null;
  const open = sessions;
  sessions = null;
  for (const s of [open?.det, open?.cls, open?.rec]) void s?.release?.().catch(() => {});
}

/**
 * On the processor, with every thread since the user is waiting: the three networks are small,
 * and the reader's input width changes with every run, which the graphics card path handles badly.
 */
async function openSessions(): Promise<Sessions> {
  if (sessions) return sessions;
  const ort = await import("onnxruntime-node");
  const open = (path: string) =>
    ort.InferenceSession.create(path, { executionProviders: ["cpu"], graphOptimizationLevel: "basic", logSeverityLevel: 3 });
  const [det, cls, rec] = await Promise.all([open(models.det.path()), open(models.cls.path()), open(models.rec.path())]);
  const dictionary = buildCharacterDictionary(readFileSync(models.dict.path(), "utf8").split(/\r?\n/).filter((l, i, all) => l.length || i < all.length - 1));
  sessions = { det, cls, rec, dictionary };
  return sessions;
}

export type OcrStage = "detecting" | "reading";
export type OcrResult = { width: number; height: number; blocks: TextBlock[] };

class Superseded extends Error {}

/**
 * The text in a photo, in the pixels of the photo as it is shown (turned upright by its EXIF
 * orientation). Null when the models are not on disk or not the pinned ones. A newer read makes
 * this one stop.
 */
export function readText(bytes: Buffer, onStage: (stage: OcrStage) => void = () => {}): Promise<OcrResult | null> {
  const id = ++latest;
  const run = queue.then(() => readNow(bytes, id, onStage));
  queue = run.catch(() => {});
  return run.catch((e) => {
    if (e instanceof Superseded) return null;
    throw e;
  });
}

async function readNow(bytes: Buffer, id: number, onStage: (stage: OcrStage) => void): Promise<OcrResult | null> {
  const check = () => {
    if (id !== latest) throw new Superseded();
  };
  check();
  for (const m of Object.values(models)) if (!(await m.intact())) return null;
  if (idle) clearTimeout(idle);
  idle = null;
  try {
    const s = await openSessions();
    const frame = await decodeFrame(bytes);
    check();
    onStage("detecting");
    const found = await detect(s.det, frame);
    check();
    if (found.length === 0) return { width: frame.width, height: frame.height, blocks: [] };
    onStage("reading");
    const blocks = await readBlocks(s, frame, capped(found), check);
    return { width: frame.width, height: frame.height, blocks: cleanTextBlocks(blocks) };
  } finally {
    idle = setTimeout(closeSessions, IDLE_MS);
  }
}

/** The photo upright, without alpha, at most MAX_FRAME_SIDE on its longer side. */
async function decodeFrame(bytes: Buffer): Promise<Rgb> {
  const sharp = (await import("sharp")).default;
  const { data, info } = await sharp(bytes, { failOn: "none", limitInputPixels: false })
    .rotate()
    .resize(MAX_FRAME_SIDE, MAX_FRAME_SIDE, { fit: "inside", withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}

async function detect(session: any, frame: Rgb): Promise<DetectedQuad[]> {
  const [w, h] = detectorInputSize(frame.width, frame.height, detectionLimitSide(frame.width, frame.height));
  const sharp = (await import("sharp")).default;
  const scaled = await sharp(Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.length), {
    raw: { width: frame.width, height: frame.height, channels: 3 },
  })
    .resize(w, h, { fit: "fill" })
    .raw()
    .toBuffer();
  const plane = w * h;
  const values = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    values[i] = (scaled[i * 3 + 2] / 255 - MEAN[0]) / DEVIATION[0];
    values[i + plane] = (scaled[i * 3 + 1] / 255 - MEAN[1]) / DEVIATION[1];
    values[i + 2 * plane] = (scaled[i * 3] / 255 - MEAN[2]) / DEVIATION[2];
  }
  const ort = await import("onnxruntime-node");
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", values, [1, 3, h, w]) });
  const map = (out[session.outputNames[0]].data as Float32Array).subarray(0, plane);
  return detectQuads({ width: w, height: h, values: map }, frame.width, frame.height);
}

/** At most MAX_READ_REGIONS regions, the surest, in the order the detector put them. */
function capped(found: DetectedQuad[]): DetectedQuad[] {
  if (found.length <= MAX_READ_REGIONS) return found;
  const kept = new Set(
    found
      .map((f, i) => [f.score, i] as const)
      .sort((a, b) => b[0] - a[0])
      .slice(0, MAX_READ_REGIONS)
      .map(([, i]) => i),
  );
  return found.filter((_, i) => kept.has(i));
}

/** The regions read a group at a time, so only one group's crops are held at once. */
async function readBlocks(s: Sessions, frame: Rgb, found: DetectedQuad[], check: () => void): Promise<TextBlock[]> {
  const blocks: TextBlock[] = [];
  for (let start = 0; start < found.length; start += READ_MAX_BATCH) {
    check();
    const crops: Rgb[] = [];
    const quads: DetectedQuad[] = [];
    for (const region of found.slice(start, start + READ_MAX_BATCH)) {
      const crop = cropTextQuad(frame, region.quad, cropSizeFor(region.quad));
      if (!crop) continue;
      crops.push(crop);
      quads.push(region);
    }
    if (crops.length === 0) continue;
    const upsideDown = await classify(s.cls, crops);
    const texts = await read(s, crops, upsideDown);
    texts.forEach((decoded, i) => {
      if (looksReadable(decoded.text, decoded.confidence)) blocks.push({ text: decoded.text, confidence: decoded.confidence, quad: quads[i].quad });
    });
  }
  return blocks;
}

async function classify(session: any, crops: Rgb[]): Promise<boolean[]> {
  const ort = await import("onnxruntime-node");
  const values = new Float32Array(crops.length * 3 * READ_HEIGHT * CLASSIFIER_WIDTH);
  crops.forEach((crop, slot) => writeCropInto(crop, false, values, slot, CLASSIFIER_WIDTH));
  const out = await session.run({
    [session.inputNames[0]]: new ort.Tensor("float32", values, [crops.length, 3, READ_HEIGHT, CLASSIFIER_WIDTH]),
  });
  const scores = out[session.outputNames[0]].data as Float32Array;
  return crops.map((_, i) => (i * 2 + 1 < scores.length ? classifierTurnsCrop(scores[i * 2], scores[i * 2 + 1]) : false));
}

/** The crops read in runs of like shapes; the answers come back in the crops' own order. */
async function read(s: Sessions, crops: Rgb[], upsideDown: boolean[]): Promise<DecodedText[]> {
  const ort = await import("onnxruntime-node");
  const ratio = (c: Rgb) => c.width / Math.max(c.height, 1);
  const order = crops.map((_, i) => i).sort((a, b) => ratio(crops[a]) - ratio(crops[b]));
  const ratios = order.map((i) => ratio(crops[i]));
  const answers: DecodedText[] = crops.map(() => ({ text: "", confidence: 0 }));
  let start = 0;
  for (const size of planReadBatches(ratios)) {
    const slots = order.slice(start, start + size);
    const batchWidth = readBatchWidth(ratios[start + size - 1]);
    const values = new Float32Array(size * 3 * READ_HEIGHT * batchWidth);
    const widths = slots.map((i, slot) => writeCropInto(crops[i], upsideDown[i], values, slot, batchWidth));
    const out = await s.rec.run({ [s.rec.inputNames[0]]: new ort.Tensor("float32", values, [size, 3, READ_HEIGHT, batchWidth]) });
    const tensor = out[s.rec.outputNames[0]];
    const [, columns, alphabet] = tensor.dims as number[];
    slots.forEach((i, slot) => {
      answers[i] = decodeSlot(tensor.data as Float32Array, slot, columns, alphabet, widths[slot], batchWidth, s.dictionary);
    });
    start += size;
  }
  return answers;
}
