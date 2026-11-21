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

// The models on their own thread: the same answers as the runtime gives on the calling thread,
// the calling thread free while a model opens, a lost thread replaced, and a quit that does not
// wait on a model. The real models are checked too when PFP_BENCH_MODELS names their folder
// (yolov5face.onnx, ghostfacenet.onnx, clip_image.onnx), as for the scan's bench.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterAll, describe, expect, it } from "vitest";

import { BACKGROUND_THREADS, gpuUsable, openModel } from "./inference.ts";
import { testModel } from "./onnxTestModel.ts";
import { ModelWorkerGone, OrtSession, closeModelThread, modelThread, tensor } from "./ortSession.ts";

const dir = mkdtempSync(join(tmpdir(), "pfp-ort-"));
const WIDTH = 256;
const small = join(dir, "small.onnx");
writeFileSync(small, testModel(WIDTH, 8, 3));
/** About a hundred megabytes of weights: a model the runtime takes a noticeable while to open. */
const large = join(dir, "large.onnx");
writeFileSync(large, testModel(WIDTH, 400, 5));

const CPU = { executionProviders: ["cpu"], graphOptimizationLevel: "all", logSeverityLevel: 3 };
// As a face pass opens its models: a thread pool every core is not, so the sidecar keeps one.
const BACKGROUND = { ...CPU, intraOpNumThreads: BACKGROUND_THREADS, interOpNumThreads: 1 };

function input(seed: number, n = WIDTH): Float32Array {
  const x = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    x[i] = s / 2 ** 32;
  }
  return x;
}

const bytesOf = (data: ArrayBufferView) => Buffer.from(data.buffer, data.byteOffset, data.byteLength);

/** The answer of the runtime opened right here, on the calling thread, as the sidecar did before. */
async function hereAnswer(path: string, options: object, feeds: Record<string, { type: string; data: any; dims: readonly number[] }>) {
  const ort = await import("onnxruntime-node");
  const s = await ort.InferenceSession.create(path, options as any);
  const own: Record<string, unknown> = {};
  for (const [k, t] of Object.entries(feeds)) own[k] = new ort.Tensor(t.type as any, t.data, t.dims);
  const out = await s.run(own as any);
  const answer = Object.fromEntries(Object.entries(out).map(([k, t]: [string, any]) => [k, { data: t.data.slice(), dims: [...t.dims] }]));
  await s.release();
  return answer;
}

/** The longest the calling thread's timers ran late while `work` ran, and how long it took. */
async function lagDuring<T>(work: () => Promise<T>): Promise<{ lag: number; ms: number; value: T }> {
  await new Promise((r) => setTimeout(r, 30));
  let lag = 0;
  let last = performance.now();
  const tick = setInterval(() => {
    const now = performance.now();
    lag = Math.max(lag, now - last - 5);
    last = now;
  }, 5);
  const started = performance.now();
  try {
    const value = await work();
    const ms = performance.now() - started;
    await new Promise((r) => setTimeout(r, 20));
    return { lag, ms, value };
  } finally {
    clearInterval(tick);
  }
}

afterAll(async () => {
  await closeModelThread(10_000);
});

describe("a model on the model thread", () => {
  it("answers exactly as the runtime does on the calling thread", async () => {
    const x = tensor("float32", input(11), [1, WIDTH]);
    const s = await OrtSession.open(small, CPU);
    expect(s.inputNames).toEqual(["x"]);
    expect(s.outputNames).toEqual(["y"]);
    expect(s.inputMetadata[0]).toMatchObject({ name: "x", isTensor: true, type: "float32" });
    const out = await s.run({ x });
    const here = await hereAnswer(small, CPU, { x });
    expect(out.y.dims).toEqual([1, WIDTH]);
    expect(out.y.data).toBeInstanceOf(Float32Array);
    expect(bytesOf(out.y.data).equals(bytesOf(here.y.data))).toBe(true);
    expect(Array.from(out.y.data as Float32Array).some((v) => v !== 0)).toBe(true);
    await s.release();
  });

  it("leaves the values it was given as they were, for a caller that sends them again", async () => {
    const values = input(12);
    const kept = values.slice();
    const s = await OrtSession.open(small, CPU);
    const first = await s.run({ x: tensor("float32", values, [1, WIDTH]) });
    const again = await s.run({ x: tensor("float32", values, [1, WIDTH]) });
    expect(bytesOf(values).equals(bytesOf(kept))).toBe(true);
    expect(bytesOf(again.y.data).equals(bytesOf(first.y.data))).toBe(true);
    // A view into a larger buffer sends only its own values.
    const wide = new Float32Array(WIDTH * 3);
    wide.set(values, WIDTH);
    const view = await s.run({ x: tensor("float32", wide.subarray(WIDTH, 2 * WIDTH), [1, WIDTH]) });
    expect(bytesOf(view.y.data).equals(bytesOf(first.y.data))).toBe(true);
    await s.release();
  });

  it("keeps the calling thread answering while a large model opens and runs", { timeout: 60_000 }, async () => {
    const x = tensor("float32", input(13), [1, WIDTH]);
    // The thread already up, as in the app after its first model: only the open is measured.
    await (await OrtSession.open(small, CPU)).release();
    const opened = await lagDuring(() => OrtSession.open(large, BACKGROUND));
    const ran = await lagDuring(() => opened.value.run({ x }));
    // The same open on the calling thread, as before: it holds the thread for its whole length.
    const ort = await import("onnxruntime-node");
    const here = await lagDuring(() => ort.InferenceSession.create(large, BACKGROUND as any));
    await here.value.release();
    process.stderr.write(
      `[test] large model: open ${opened.ms.toFixed(0)} ms (calling thread late at most ${opened.lag.toFixed(0)} ms), ` +
        `run ${ran.ms.toFixed(0)} ms (late ${ran.lag.toFixed(0)} ms); opened on the calling thread: late ${here.lag.toFixed(0)} ms\n`,
    );
    expect(opened.lag).toBeLessThan(50);
    expect(ran.lag).toBeLessThan(50);
    expect(here.lag).toBeGreaterThan(opened.lag * 2);
    await opened.value.release();
  });

  it("opens the model again on a new thread when its thread is lost mid-run, with the same answer", { timeout: 30_000 }, async () => {
    const x = tensor("float32", input(14), [1, WIDTH]);
    const s = await OrtSession.open(large, CPU);
    const expected = await s.run({ x });
    const first = modelThread();
    expect(first).not.toBeNull();
    // Let go as after an error it did not catch: it answers the run, sent after, with a refusal.
    first!.postMessage({ id: 0, op: "retire" });
    const out = await s.run({ x });
    expect(bytesOf(out.y.data).equals(bytesOf(expected.y.data))).toBe(true);
    expect(modelThread()).not.toBeNull();
    expect(modelThread()).not.toBe(first);
    // A session opened before the loss, idle through it, opens again on its next run.
    const idle = await OrtSession.open(small, CPU);
    const before = await idle.run({ x: tensor("float32", input(15), [1, WIDTH]) });
    const second = modelThread()!;
    second.postMessage({ id: 0, op: "retire" });
    while (modelThread() === second) await new Promise((r) => setTimeout(r, 5));
    const after = await idle.run({ x: tensor("float32", input(15), [1, WIDTH]) });
    expect(bytesOf(after.y.data).equals(bytesOf(before.y.data))).toBe(true);
    await s.release();
    await idle.release();
  });

  it("tells a lost thread apart from a model's own failure", async () => {
    const missing = OrtSession.open(join(dir, "missing.onnx"), CPU);
    await expect(missing).rejects.toThrow();
    await expect(missing).rejects.not.toBeInstanceOf(ModelWorkerGone);
    const s = await OrtSession.open(small, CPU);
    await expect(s.run({ x: tensor("float32", input(16, 3), [1, 3]) })).rejects.not.toBeInstanceOf(ModelWorkerGone);
    await s.release();
    await expect(s.run({ x: tensor("float32", input(16), [1, WIDTH]) })).rejects.toThrow(/released/);
  });

  it("keeps the runtime's usage reports off: the thread refuses to load it without the setting", async () => {
    await OrtSession.open(small, CPU).then((s) => s.release());
    expect(process.env.ORT_DISABLE_TELEMETRY).toBe("1");
    const w = new Worker(new URL("./ortWorker.ts", import.meta.url), { env: { ...process.env, ORT_DISABLE_TELEMETRY: "0" } });
    const answer = await new Promise<any>((resolve) => {
      w.once("message", resolve);
      w.postMessage({ id: 1, op: "open", path: small, options: CPU });
    });
    await w.terminate();
    expect(answer.ok).toBe(false);
    expect(answer.error.message).toMatch(/ORT_DISABLE_TELEMETRY/);
  });

  it("lets the sidecar quit cleanly while a model opens or runs, and asks it nothing after", { timeout: 120_000 }, async () => {
    // As the sidecar quits: the model calls under way finish, or the wait runs out, then the
    // process ends itself at once (as `server.ts` does), with no teardown of the model threads. A
    // process torn down while a model thread is inside a native call aborts (0xC0000409 on Windows).
    const script = join(dir, "quit.mjs");
    const session = pathToFileURL(join(import.meta.dirname, "ortSession.ts")).href;
    writeFileSync(
      script,
      [
        `const { OrtSession, tensor, closeModelThread, ModelWorkerGone } = await import(${JSON.stringify(session)});`,
        `const options = { executionProviders: ["cpu"], graphOptimizationLevel: "all", logSeverityLevel: 3 };`,
        `const x = tensor("float32", new Float32Array(${WIDTH}).fill(0.5), [1, ${WIDTH}]);`,
        `const quit = async (s, wait) => { const idle = await closeModelThread(wait);`,
        `  const late = s ? await s.run({ x }).catch((e) => e) : null;`,
        `  if (s && !(late instanceof ModelWorkerGone)) process.exit(7);`,
        `  if (idle === (process.argv[2] === "late")) process.exit(8);`,
        `  process.stderr.write("", () => process.kill(process.pid, "SIGKILL")); };`,
        `if (process.argv[2] === "open") { void OrtSession.open(process.argv[3], options).catch(() => {}); setTimeout(() => void quit(null, 3000), 40); }`,
        `else { const s = await OrtSession.open(process.argv[3], options);`,
        `  for (let i = 0; i < 20; i++) void s.run({ x }).catch(() => {});`,
        `  setTimeout(() => void quit(s, process.argv[2] === "late" ? 1 : 3000), 2); }`,
      ].join("\n"),
    );
    for (const when of ["open", "run", "late"]) {
      for (let round = 0; round < 4; round++) {
        const started = performance.now();
        const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
          const child = spawn(process.execPath, [script, when, large], { stdio: "ignore" });
          child.on("exit", (c, sig) => resolve([c, sig]));
        });
        const ms = performance.now() - started;
        process.stderr.write(`[test] quit (${when}): exit ${code} ${signal ?? ""} after ${ms.toFixed(0)} ms\n`);
        // Ended by itself: on Windows with status 1, elsewhere by the signal. Never an abort.
        expect(process.platform === "win32" ? code : signal).toBe(process.platform === "win32" ? 1 : "SIGKILL");
        expect(ms).toBeLessThan(15_000);
      }
    }
  });

  it("stops starting model threads once five have failed", { timeout: 60_000 }, async () => {
    // In a process of its own: the count is the sidecar's, for as long as it runs.
    const script = join(dir, "cap.mjs");
    const session = pathToFileURL(join(import.meta.dirname, "ortSession.ts")).href;
    writeFileSync(
      script,
      [
        `const { OrtSession, tensor, closeModelThread, modelThread, ModelWorkerGone } = await import(${JSON.stringify(session)});`,
        `const options = { executionProviders: ["cpu"], logSeverityLevel: 3 };`,
        `const x = tensor("float32", new Float32Array(${WIDTH}).fill(0.5), [1, ${WIDTH}]);`,
        `const s = await OrtSession.open(process.argv[2], options); const answers = [];`,
        `for (let i = 0; i < 6; i++) {`,
        `  const w = modelThread(); if (w) { w.postMessage({ id: 0, op: "retire" }); while (modelThread() === w) await new Promise((r) => setTimeout(r, 5)); }`,
        `  answers.push(await s.run({ x }).then(() => "ran", (e) => (e instanceof ModelWorkerGone ? "gone" : "error")));`,
        `}`,
        `const idle = await closeModelThread(3000);`,
        `process.stdout.write(answers.join(",") + (idle ? " idle" : " busy"), () => process.kill(process.pid, "SIGKILL"));`,
      ].join("\n"),
    );
    const out = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [script, small], { stdio: ["ignore", "pipe", "ignore"] });
      let text = "";
      child.stdout.on("data", (d) => (text += d));
      child.on("exit", () => resolve(text));
    });
    // The model opened on the first thread runs on the next four; with the fifth lost, none is left.
    expect(out).toBe("ran,ran,ran,ran,gone,gone idle");
  });
});

const MODELS = process.env.PFP_BENCH_MODELS ?? "";

describe.skipIf(!MODELS || !existsSync(join(MODELS, "ghostfacenet.onnx")))("the real models on the model thread", () => {
  const cases = [
    { file: "yolov5face.onnx", dims: [1, 3, 640, 640], optimization: "all" as const },
    { file: "ghostfacenet.onnx", dims: [1, 112, 112, 3], optimization: "all" as const },
    { file: "clip_image.onnx", dims: [1, 3, 224, 224], optimization: "basic" as const },
  ];

  it("answer bit for bit as on the calling thread, on the processor and on the card", { timeout: 300_000 }, async () => {
    for (const c of cases) {
      const path = join(MODELS, c.file);
      const x = tensor("float32", input(21, c.dims.reduce((a, b) => a * b, 1)), c.dims);
      const kinds: { name: string; options: object }[] = [
        { name: "cpu", options: { executionProviders: ["cpu"], graphOptimizationLevel: c.optimization, intraOpNumThreads: 2, interOpNumThreads: 1, logSeverityLevel: 3 } },
      ];
      if (gpuUsable()) {
        kinds.push({
          name: "gpu",
          options: { executionProviders: [{ name: "dml" }], graphOptimizationLevel: c.optimization, enableMemPattern: false, executionMode: "sequential", logSeverityLevel: 3 },
        });
      }
      for (const k of kinds) {
        const s = await OrtSession.open(path, k.options as any);
        const out = await s.run({ [s.inputNames[0]]: x });
        await s.release();
        const here = await hereAnswer(path, k.options, { [s.inputNames[0]]: x });
        for (const name of s.outputNames) {
          expect(out[name].dims).toEqual(here[name].dims);
          expect(bytesOf(out[name].data).equals(bytesOf(here[name].data)), `${c.file} ${k.name} ${name}`).toBe(true);
        }
        process.stderr.write(`[test] ${c.file} on ${k.name}: the same ${s.outputNames.length} output(s), bit for bit\n`);
      }
    }
  });

  it("keep the calling thread answering while the scan's models open and run", { timeout: 300_000 }, async () => {
    for (const c of cases) {
      const opened = await lagDuring(() => openModel(join(MODELS, c.file), true, c.optimization));
      const x = tensor("float32", input(22, c.dims.reduce((a, b) => a * b, 1)), c.dims);
      const s = opened.value.session;
      const ran = await lagDuring(() => s.run({ [s.inputNames[0]]: x }));
      process.stderr.write(
        `[test] ${c.file} on ${opened.value.accel}: open ${opened.ms.toFixed(0)} ms (late ${opened.lag.toFixed(0)} ms), run ${ran.ms.toFixed(0)} ms (late ${ran.lag.toFixed(0)} ms)\n`,
      );
      expect(opened.lag).toBeLessThan(50);
      expect(ran.lag).toBeLessThan(50);
      await s.release();
    }
  });
});
