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

// The ONNX models, run on a thread of their own. The runtime opens a model and runs it as one
// long native call on the thread that asks: opening the face detector on the graphics card held
// the sidecar for about a second, and every run on the processor for as long as it took, while
// the window's calls waited. An `OrtSession` here is the runtime's session as its callers use it
// (input and output names, `run`, `release`), opened and run on the one model thread
// (`ortWorker.ts`); the runtime itself is never loaded on the sidecar's own thread.
//
// The model thread is started on first use and kept. A thread that fails (an error it did not
// catch) is let go: it answers `ModelWorkerGone`, and the next use starts a new one, where a
// session opens its model again and runs once more, so a lost thread costs the time only. A
// fault inside the native runtime ends the whole process, as it did on the main thread.
//
// No model thread is ever ended or terminated: one cut off while the runtime is in a native
// call, or torn down by a normal exit, can abort the whole process. A thread let go stays, idle.
// The sidecar's quit waits for the model calls under way (`closeModelThread`), then ends the
// process at once, with no teardown.

import { Worker } from "node:worker_threads";

export type TensorType = "float32" | "int32" | "int64";
export type TensorData = Float32Array | Int32Array | BigInt64Array;
/** A tensor as it crosses to the model thread and back: its element type, values and shape. */
export type Tensor = { type: string; data: TensorData; dims: readonly number[] };
export type ValueMetadata = { name: string; isTensor: boolean; type?: string; shape?: (number | string)[] };
/** The runtime's own session options, passed on unchanged. */
export type SessionOptions = Record<string, unknown>;

export function tensor(type: TensorType, data: TensorData, dims: readonly number[]): Tensor {
  return { type, data, dims };
}

/** The model thread was lost while this waited on it. Not the model's fault, nor the card's. */
export class ModelWorkerGone extends Error {
  constructor() {
    super("the model thread stopped");
    this.name = "ModelWorkerGone";
  }
}

type Pending = { owner: Worker; at: number; resolve: (answer: { value: any; at: number }) => void; reject: (e: Error) => void };
type Answer = { id: number; ok?: boolean; value?: unknown; error?: { name: string; message: string }; retired?: boolean };

/** The thread new requests go to; null until one is needed, and after it was let go. */
let worker: Worker | null = null;
let generation = 0;
/**
 * The most model threads one sidecar starts. A thread let go stays, holding its share of memory,
 * so one that keeps failing does not get new ones without end: past this, the models stay off
 * until the next start.
 */
const MAX_THREADS = 5;
/** Set once the sidecar quits: no model thread is started or asked anything after it. */
let closing = false;
let nextId = 1;
const pending = new Map<number, Pending>();
/** Called once nothing waits on any model thread. */
let onIdle: (() => void)[] = [];

/** Bundled, the thread's code sits beside `server.mjs`; from the sources, beside this file. */
function workerUrl(): URL {
  const self = import.meta.url;
  return new URL(self.endsWith(".ts") ? "./ortWorker.ts" : "./ortWorker.mjs", self);
}

function settled(id: number): void {
  pending.delete(id);
  if (pending.size > 0) return;
  const waiting = onIdle;
  onIdle = [];
  for (const f of waiting) f();
}

/** Every request still waiting on `owner` fails, as that thread will never answer. */
function failWaiting(owner: Worker): void {
  for (const [id, p] of pending) {
    if (p.owner !== owner) continue;
    settled(id);
    p.reject(new ModelWorkerGone());
  }
}

function waitingOn(owner: Worker): boolean {
  for (const p of pending.values()) if (p.owner === owner) return true;
  return false;
}

/** New requests go to a new thread from here on; `w` finishes what it was already given. */
function letGo(w: Worker, why: string): void {
  if (worker !== w) return;
  worker = null;
  if (closing) return;
  process.stderr.write(`[inference] the model thread was let go: ${why}\n`);
  if (generation >= MAX_THREADS) process.stderr.write(`[inference] ${MAX_THREADS} model threads failed; the models stay off until the next start\n`);
}

function start(): Worker {
  // The runtime reads this from the process's environment, which a worker cannot write: set
  // here, on the main thread, before the thread that loads the runtime exists.
  process.env.ORT_DISABLE_TELEMETRY = "1";
  // What the thread prints reaches this thread's stdout and stderr; the thread sends its stdout
  // to stderr, as stdout carries only the window's answers.
  const w = new Worker(workerUrl());
  worker = w;
  generation++;
  w.on("message", (msg: Answer) => {
    if (msg.retired) return letGo(w, "it failed");
    const p = pending.get(msg.id);
    if (!p) return;
    settled(msg.id);
    if (!waitingOn(w)) w.unref();
    if (msg.ok) {
      p.resolve({ value: msg.value, at: p.at });
    } else if (msg.error?.name === "ModelWorkerGone") {
      letGo(w, "it failed");
      p.reject(new ModelWorkerGone());
    } else {
      const e = new Error(msg.error?.message ?? "the model failed");
      e.name = msg.error?.name ?? "Error";
      p.reject(e);
    }
  });
  // Only the error's class: its text can carry a path.
  w.on("error", (e) => {
    letGo(w, (e as Error)?.name ?? "error");
    failWaiting(w);
  });
  w.on("messageerror", () => {
    // An answer that cannot be read: whose it was is unknown, so the thread is let go whole.
    letGo(w, "messageerror");
    failWaiting(w);
    w.postMessage({ id: 0, op: "retire" });
  });
  w.on("exit", (code) => {
    letGo(w, `exit ${code}`);
    failWaiting(w);
  });
  // The sidecar lives on its own channel; an idle model thread is no reason to stay up, a busy
  // one is (`post`). Last, as a listener added after it takes the thread's hold back.
  w.unref();
  return w;
}

/** The generation of the model thread in use, or -1 while none is. */
function liveGeneration(): number {
  return worker ? generation : -1;
}

/**
 * Sends one request to the model thread and waits for its answer, and the generation of the
 * thread that gave it. With `onlyTo`, only to that generation: a session's handle means nothing
 * to any other.
 */
function post(op: string, body: Record<string, unknown>, onlyTo?: number): Promise<{ value: any; at: number }> {
  if (closing || (onlyTo !== undefined && onlyTo !== liveGeneration())) return Promise.reject(new ModelWorkerGone());
  if (!worker && generation >= MAX_THREADS) return Promise.reject(new ModelWorkerGone());
  const w = worker ?? start();
  const at = generation;
  const id = nextId++;
  w.ref();
  return new Promise((resolve, reject) => {
    pending.set(id, { owner: w, at, resolve, reject });
    w.postMessage({ id, op, ...body });
  });
}

/**
 * The values as their own buffer: a view into a larger one would carry all of it across.
 * Copied, never handed over, as a caller may send the same values once more.
 */
function whole(data: TensorData): TensorData {
  return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : (data.slice() as TensorData);
}

export class OrtSession {
  inputNames: string[] = [];
  outputNames: string[] = [];
  inputMetadata: ValueMetadata[] = [];
  outputMetadata: ValueMetadata[] = [];
  private readonly path: string;
  private readonly options: SessionOptions;
  private handle = 0;
  private generation = -1;
  private opening: Promise<void> | null = null;
  private released = false;

  private constructor(path: string, options: SessionOptions) {
    this.path = path;
    this.options = options;
  }

  /** Opens `path` on the model thread with the runtime's `options`. */
  static async open(path: string, options: SessionOptions): Promise<OrtSession> {
    const s = new OrtSession(path, options);
    await s.attach();
    return s;
  }

  /** Opens the model on the model thread in use, starting one when none is. */
  private attach(): Promise<void> {
    this.opening ??= (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const { value: info, at } = await post("open", { path: this.path, options: this.options });
          this.handle = info.handle;
          this.generation = at;
          this.inputNames = info.inputNames;
          this.outputNames = info.outputNames;
          this.inputMetadata = info.inputMetadata;
          this.outputMetadata = info.outputMetadata;
          if (this.released) await post("release", { handle: info.handle }, at).catch(() => {});
          return;
        } catch (e) {
          if (!(e instanceof ModelWorkerGone) || attempt > 0) throw e;
        }
      }
    })().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  /** The model's outputs for `feeds`, by output name. */
  async run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>> {
    if (this.released) throw new Error("the model session was released");
    const plain: Record<string, Tensor> = {};
    for (const [name, t] of Object.entries(feeds)) plain[name] = { type: t.type, data: whole(t.data), dims: [...t.dims] };
    for (let attempt = 0; ; attempt++) {
      try {
        if (this.generation !== liveGeneration()) await this.attach();
        return (await post("run", { handle: this.handle, feeds: plain }, this.generation)).value;
      } catch (e) {
        if (!(e instanceof ModelWorkerGone) || attempt > 0 || this.released) throw e;
      }
    }
  }

  /** Lets the model go on the model thread. Later runs fail. */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.opening?.catch(() => {});
    if (this.handle && this.generation === liveGeneration()) {
      await post("release", { handle: this.handle }, this.generation).catch(() => {});
    }
  }
}

/**
 * For the sidecar's quit: no model thread is asked anything more, and this waits, at most `maxMs`,
 * for the calls already under way to finish, so what they bring back is in before the end. True
 * once none runs, false when one still did at the end of the wait.
 */
export function closeModelThread(maxMs: number): Promise<boolean> {
  closing = true;
  if (pending.size === 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), maxMs);
    onIdle.push(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** The model thread in use, if any; for the tests, which let it go to see a lost thread handled. */
export function modelThread(): Worker | null {
  return worker;
}
