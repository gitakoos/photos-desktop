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

// The scan's own steps timed on this computer with the real models, photo by photo and then
// several photos at once. Skipped unless asked for:
//
//   PFP_BENCH_MODELS=<folder with yolov5face.onnx, ghostfacenet.onnx, clip_image.onnx>
//   PFP_BENCH_PHOTOS=<folder of JPEGs>   (optional; made-up 12 MP pictures otherwise)
//   PFP_BENCH_FACES=<faces per made-up picture>   (default 3)
//   PFP_BENCH_CPU=1                       (the processor instead of the graphics card)
//   npx vitest run proton/scanBench.test.ts
//
// A made-up picture holds no real face, so the detector's answer is swapped for `PFP_BENCH_FACES`
// faces after it has run: the detector's time is its own, and each face goes through the real
// alignment and recognition model.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { describe, it } from "vitest";

import { analyzeImage } from "./faceScan.ts";
import { markGpuFailed, openModel } from "./inference.ts";
import { decodeLikePhone } from "./phoneDecode.ts";
import { newStageTimes, runInOrder, stageFields, timed, timedSync, type StageTimes } from "./scanPipeline.ts";
import { CLIP_SIDE, clipInputFrom, toHalves } from "./searchIndex.ts";

const MODELS = process.env.PFP_BENCH_MODELS ?? "";
const PHOTOS = process.env.PFP_BENCH_PHOTOS ?? "";
const FAKE_FACES = Number(process.env.PFP_BENCH_FACES ?? 3);
const COUNT = 24;

/** A 12 MP JPEG with smooth colour and grain, about the size a phone's photo is. */
async function madeUpPhoto(seed: number): Promise<Buffer> {
  const w = 4032;
  const h = 3024;
  const rgb = Buffer.alloc(w * h * 3);
  let state = seed * 2654435761;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const grain = (state >>> 24) - 128;
      const o = (y * w + x) * 3;
      rgb[o] = Math.max(0, Math.min(255, ((x * 255) / w + grain / 3) | 0));
      rgb[o + 1] = Math.max(0, Math.min(255, ((y * 255) / h + grain / 3) | 0));
      rgb[o + 2] = Math.max(0, Math.min(255, (((x + y + seed * 97) % 255) + grain / 2) | 0));
    }
  }
  return sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

/** The detector, run for its time, answering `faces` made-up faces spread over the square. */
function withFakeFaces(detector: any, faces: number): any {
  if (PHOTOS) return detector;
  return {
    inputNames: detector.inputNames,
    outputNames: detector.outputNames,
    run: async (feeds: any) => {
      await detector.run(feeds);
      const out = new Float32Array(faces * 16);
      for (let r = 0; r < faces; r++) {
        const cx = 120 + ((r * 170) % 400);
        const cy = 160 + Math.floor(r / 3) * 120;
        out.set([cx, cy, 90, 90, 0.95, cx - 20, cy - 15, cx + 20, cy - 15, cx, cy + 5, cx - 15, cy + 25, cx + 15, cy + 25, 1], r * 16);
      }
      return { [detector.outputNames[0]]: { data: out } };
    },
  };
}

const ms = (v: number) => v.toFixed(1).padStart(7);

describe.skipIf(!MODELS || !existsSync(join(MODELS, "ghostfacenet.onnx")))("the scan's steps on this computer", () => {
  it("are timed photo by photo, and several at once", { timeout: 600_000 }, async () => {
    if (process.env.PFP_BENCH_CPU) markGpuFailed("bench");
    const ort = await import("onnxruntime-node");
    const det = await openModel(join(MODELS, "yolov5face.onnx"), true);
    const emb = await openModel(join(MODELS, "ghostfacenet.onnx"), true);
    const clip = await openModel(join(MODELS, "clip_image.onnx"), true, "basic");
    const models = { detector: withFakeFaces(det.session, FAKE_FACES), embedder: emb.session, accel: det.accel };

    const photos: Buffer[] = [];
    if (PHOTOS) {
      for (const f of readdirSync(PHOTOS).filter((n) => /\.jpe?g$/i.test(n)).slice(0, COUNT)) photos.push(readFileSync(join(PHOTOS, f)));
    } else {
      for (let i = 0; i < COUNT; i++) photos.push(await madeUpPhoto(i + 1));
    }

    const onePhoto = async (bytes: Buffer, t: StageTimes) => {
      const img = await timed(t, "decode", () => decodeLikePhone(bytes));
      const faces = await analyzeImage(img, models as any, "bench", false, t);
      const input = timedSync(t, "clipPrep", () => new ort.Tensor("float32", clipInputFrom(img), [1, 3, CLIP_SIDE, CLIP_SIDE]));
      const out = await timed(t, "clip", () => clip.session.run({ [clip.session.inputNames[0]]: input }));
      timedSync(t, "clipPrep", () => toHalves(out[clip.session.outputNames[0]].data as Float32Array));
      t.photos++;
      t.faces += faces.length;
    };

    // Warm-up: the first runs on a card compile its kernels.
    for (const bytes of photos.slice(0, 3)) await onePhoto(bytes, newStageTimes());

    const t = newStageTimes();
    const started = performance.now();
    for (const bytes of photos) await onePhoto(bytes, t);
    const wall = performance.now() - started;
    const per = (v: number) => v / t.photos;
    const lines = [
      `accel=${det.accel} photos=${t.photos} faces=${t.faces} ${PHOTOS ? "real photos" : `made-up, ${FAKE_FACES} faces each`}`,
      `one at a time, ms per photo:`,
      `  decode     ${ms(per(t.decode))}`,
      `  detectPrep ${ms(per(t.detectPrep))}`,
      `  detect     ${ms(per(t.detect))}`,
      `  facePrep   ${ms(per(t.facePrep))}   (${ms(t.faces ? t.facePrep / t.faces : 0)} per face)`,
      `  embed      ${ms(per(t.embed))}   (${ms(t.faces ? t.embed / t.faces : 0)} per face)`,
      `  clipPrep   ${ms(per(t.clipPrep))}`,
      `  clip       ${ms(per(t.clip))}`,
      `  wall       ${ms(per(wall))}   => ${Math.round((60_000 * t.photos) / wall)} photos/min`,
    ];

    for (const width of [1, 2, 3, 4]) {
      const tw = newStageTimes();
      const s = performance.now();
      async function* each() {
        for (const b of photos) yield b;
      }
      await runInOrder(
        each(),
        () => width,
        (b) => onePhoto(b, tw),
        () => {},
        () => true,
        () => new Error("stopped"),
      );
      const w = performance.now() - s;
      lines.push(`  ${width} at once: ${ms(w / photos.length)} ms per photo => ${Math.round((60_000 * photos.length) / w)} photos/min ${JSON.stringify(stageFields(tw))}`);
    }
    process.stderr.write(`${lines.join("\n")}\n`);
    for (const s of [det.session, emb.session, clip.session]) await s.release?.();
  });
});
