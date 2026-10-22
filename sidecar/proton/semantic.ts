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

// Search by what a photo shows, from the index the phone saved to Drive. The phone runs the
// CLIP image encoder over the photos; this side needs only the matching text encoder, to put
// a typed phrase into the same space, and a ranking over the phone's vectors. The text model
// is the phone's own, fetched once on the reader's say-so and checked byte for byte.

import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { ClipTokenizer, CONTEXT_LENGTH } from "./clipTokenizer.ts";
import { storeDir } from "./store.ts";

/**
 * The embedding space the phone writes into every search copy: its indexer's generation and the
 * exact image encoder. Only vectors under this id compare with the text encoder below.
 */
export const SEARCH_MODEL_ID =
  "clip-vit-b16-datacomp:2:57bd1d3bc57e74d99a14a1ef0d1de717049dc2a14cb867a5927907a88c4eecaf";

/** The text encoder the phone's image encoder was paired with, pinned to the release's bytes. */
export const TEXT_MODEL = {
  url: "https://github.com/gitakoos/clip-models/releases/download/v1/clip_text.onnx",
  file: "clip_text.onnx",
  size: 127_267_139,
  sha256: "2ca4794ab703fdccf8bd903ae6fa52835ba657c8b68e1d569fb59400a859d282",
};

/** A match must score this much: the phone's threshold, calibrated on a real library. */
export const MIN_SCORE = 0.225;
/** The most matches one search returns, as on the phone. */
export const MAX_RESULTS = 200;
/** The width of every vector. */
export const EMBEDDING_DIM = 512;

/** How long the loaded text encoder is kept after the last search. */
const ENCODER_IDLE_MS = 3 * 60 * 1000;

// ---- The phone's vectors ----

/** One device's search copy: the photos (Drive link ids) and their vectors, at half precision. */
export type SearchCopy = { keys: string[]; vectors: Uint16Array };

let halfTable: Float32Array | null = null;

/** Every half-precision bit pattern as a float, so a vector is read with one lookup a value. */
export function halfToFloatTable(): Float32Array {
  if (halfTable) return halfTable;
  const table = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const sign = h & 0x8000 ? -1 : 1;
    const exp = (h >> 10) & 0x1f;
    const frac = h & 0x3ff;
    table[h] =
      exp === 0
        ? sign * 2 ** -14 * (frac / 1024)
        : exp === 31
          ? frac
            ? NaN
            : sign * Infinity
          : sign * 2 ** (exp - 15) * (1 + frac / 1024);
  }
  halfTable = table;
  return table;
}

/**
 * The photos closest to `query` (a unit vector), best first: at most `limit`, each scoring at
 * least `min`. A photo in several devices' copies counts once, at its best score.
 */
export function rank(
  copies: SearchCopy[],
  query: Float32Array,
  limit = MAX_RESULTS,
  min = MIN_SCORE,
): { key: string; score: number }[] {
  const table = halfToFloatTable();
  const best = new Map<string, number>();
  for (const copy of copies) {
    const dim = query.length;
    for (let i = 0; i < copy.keys.length; i++) {
      const base = i * dim;
      let dot = 0;
      let norm = 0;
      for (let d = 0; d < dim; d++) {
        const v = table[copy.vectors[base + d]];
        dot += v * query[d];
        norm += v * v;
      }
      // Stored at half precision, a vector is no longer exactly of unit length.
      const score = norm > 0 ? dot / Math.sqrt(norm) : 0;
      if (score < min) continue;
      const key = copy.keys[i];
      const had = best.get(key);
      if (had === undefined || score > had) best.set(key, score);
    }
  }
  return [...best]
    .map(([key, score]) => ({ key, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ---- The text model on disk ----

export type ModelStatus =
  | { state: "absent" }
  | { state: "downloading"; done: number; total: number }
  | { state: "ready" }
  | { state: "failed"; error: string };

let download: { done: number; total: number } | null = null;
let lastError: string | null = null;

function modelDir(): string {
  return join(storeDir(), "models");
}

function modelPath(): string {
  return join(modelDir(), TEXT_MODEL.file);
}

/** Whether the model on disk is the pinned one, by size: the digest was checked as it arrived. */
function modelReady(): boolean {
  try {
    return statSync(modelPath()).size === TEXT_MODEL.size;
  } catch {
    return false;
  }
}

export function modelStatus(): ModelStatus {
  if (download) return { state: "downloading", ...download };
  if (modelReady()) return { state: "ready" };
  if (lastError) return { state: "failed", error: lastError };
  return { state: "absent" };
}

/** Fetches the text model in the background; `modelStatus` follows it. Kept only if every byte
 *  matches the release's digest. */
export function startModelDownload(): ModelStatus {
  if (download || modelReady()) return modelStatus();
  download = { done: 0, total: TEXT_MODEL.size };
  lastError = null;
  void fetchModel()
    .catch((e) => {
      lastError = (e as Error).message || "download failed";
      process.stderr.write(`[semantic] the model download failed: ${(e as Error).name}\n`);
    })
    .finally(() => {
      download = null;
    });
  return modelStatus();
}

async function fetchModel(): Promise<void> {
  mkdirSync(modelDir(), { recursive: true });
  const part = `${modelPath()}.part`;
  const response = await fetch(TEXT_MODEL.url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const hash = createHash("sha256");
  const out = createWriteStream(part);
  let received = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      // The size is published with the digest: anything longer is not the model, and
      // is stopped here rather than allowed to fill the disk before the check.
      if (received > TEXT_MODEL.size) throw new Error("the model is larger than its published size");
      hash.update(value);
      if (!out.write(value)) await new Promise((r) => out.once("drain", r));
      if (download) download.done += value.length;
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    rmSync(part, { force: true });
    throw e;
  }
  if (hash.digest("hex") !== TEXT_MODEL.sha256 || statSync(part).size !== TEXT_MODEL.size) {
    rmSync(part, { force: true });
    throw new Error("the model did not match its published digest");
  }
  renameSync(part, modelPath());
  verified = true;
}

/** Deletes the model, and the encoder holding it. */
export function removeModel(): ModelStatus {
  closeEncoder();
  verified = false;
  rmSync(modelPath(), { force: true });
  rmSync(`${modelPath()}.part`, { force: true });
  lastError = null;
  return modelStatus();
}

// ---- The text encoder ----

let tokenizer: ClipTokenizer | null = null;
let session: any = null;
/** Whether the model on disk was checked against its digest in this run. The native runtime
 *  parses it, so a file changed on disk since the download is never handed to it. */
let verified = false;

async function modelIntact(): Promise<boolean> {
  if (verified) return true;
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(modelPath())
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve())
      .on("error", reject);
  });
  verified = hash.digest("hex") === TEXT_MODEL.sha256;
  if (!verified) {
    process.stderr.write("[semantic] the model on disk did not match its digest and was removed\n");
    rmSync(modelPath(), { force: true });
  }
  return verified;
}
let idle: ReturnType<typeof setTimeout> | null = null;

function tokenizerOnce(): ClipTokenizer {
  if (!tokenizer) {
    const gz = readFileSync(new URL("./assets/bpe_simple_vocab_16e6.txt.gz", import.meta.url));
    tokenizer = new ClipTokenizer(gunzipSync(gz).toString("utf8"));
  }
  return tokenizer;
}

function closeEncoder(): void {
  if (idle) clearTimeout(idle);
  idle = null;
  const open = session;
  session = null;
  void open?.release?.().catch(() => {});
}

/** `text` as a unit vector in the phone's image space, or null without the model. */
export async function encodeText(text: string): Promise<Float32Array | null> {
  if (!modelReady()) return null;
  if (!session) {
    if (!(await modelIntact())) return null;
    const ort = await import("onnxruntime-node");
    // Basic optimisation, as on the phone: the extended fusions are not what the model was
    // checked under.
    session = await ort.InferenceSession.create(modelPath(), {
      graphOptimizationLevel: "basic",
      executionProviders: ["cpu"],
      // Warnings only say which half-precision constants could not be folded ahead of time.
      logSeverityLevel: 3,
    });
  }
  if (idle) clearTimeout(idle);
  idle = setTimeout(closeEncoder, ENCODER_IDLE_MS);
  const ort = await import("onnxruntime-node");
  const ids = tokenizerOnce().encode(text);
  const input = session.inputNames[0];
  const meta = session.inputMetadata?.[0];
  const tensor =
    meta?.type === "int64"
      ? new ort.Tensor("int64", BigInt64Array.from(ids, (v) => BigInt(v)), [1, CONTEXT_LENGTH])
      : new ort.Tensor("int32", ids, [1, CONTEXT_LENGTH]);
  const output = await session.run({ [input]: tensor });
  const raw = output[session.outputNames[0]].data as Float32Array;
  let norm = 0;
  for (const v of raw) norm += v * v;
  norm = Math.sqrt(norm);
  if (!(norm > 0)) return null;
  return Float32Array.from(raw, (v) => v / norm);
}

/** Whether the vocabulary the tokenizer needs ships beside this module. */
export function vocabularyPresent(): boolean {
  return existsSync(new URL("./assets/bpe_simple_vocab_16e6.txt.gz", import.meta.url));
}
