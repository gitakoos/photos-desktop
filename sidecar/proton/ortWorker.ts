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

// The thread the ONNX models live on. The runtime opens a model and runs it as one long native
// call on the thread that asks, so on the sidecar's own thread every answer to the window waited
// behind it. Here the sessions are opened, run and released on the main thread's word
// (`ortSession.ts`), and only plain tensors cross over.
//
// This file stands on its own, node's modules and the runtime only, with types that erase to
// plain JavaScript: it runs as TypeScript in the tests and in development, and bundled as
// `ortWorker.mjs` beside `server.mjs` in the app.

import { parentPort } from "node:worker_threads";

type Plain = { type: string; data: ArrayBufferView; dims: readonly number[] };
type Request =
  | { id: number; op: "retire" }
  | { id: number; op: "open"; path: string; options: Record<string, unknown> }
  | { id: number; op: "run"; handle: number; feeds: Record<string, Plain> }
  | { id: number; op: "release"; handle: number };

if (!parentPort) throw new Error("ortWorker runs only as a worker thread");
const port = parentPort;

// The sidecar's stdout carries only its answers to the window, and a thread's stdout is
// forwarded there: anything printed here goes to stderr, the log, instead.
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

let ortLoaded: Promise<any> | null = null;

/**
 * The runtime, loaded on first use. A worker's environment is a copy that native code does not
 * read: what keeps the runtime's usage reports off is the variable the main thread set in the
 * process before this thread started. This copy of it was taken from there, so a thread started
 * without it refuses to load the runtime at all.
 */
function ort(): Promise<any> {
  if (process.env.ORT_DISABLE_TELEMETRY !== "1") {
    return Promise.reject(new Error("ORT_DISABLE_TELEMETRY is not set; the runtime is not loaded"));
  }
  ortLoaded ??= import("onnxruntime-node");
  return ortLoaded;
}

const sessions = new Map<number, any>();
let nextHandle = 1;
/** Set once the thread is let go: nothing more is opened or run here. */
let retired = false;

/** What a thread let go answers: the main thread takes it as the thread lost, not the model failed. */
function refuseWhenRetired(): void {
  if (!retired) return;
  const e = new Error("the model thread was let go");
  e.name = "ModelWorkerGone";
  throw e;
}

function session(handle: number): any {
  const s = sessions.get(handle);
  if (!s) throw new Error("no such model session");
  return s;
}

async function perform(msg: Exclude<Request, { op: "retire" }>): Promise<{ value: unknown; transfer: ArrayBuffer[] }> {
  refuseWhenRetired();
  if (msg.op === "open") {
    const { InferenceSession } = await ort();
    refuseWhenRetired();
    const s = await InferenceSession.create(msg.path, msg.options);
    if (retired) {
      await s.release();
      refuseWhenRetired();
    }
    const handle = nextHandle++;
    sessions.set(handle, s);
    return {
      value: {
        handle,
        inputNames: [...s.inputNames],
        outputNames: [...s.outputNames],
        inputMetadata: s.inputMetadata ?? [],
        outputMetadata: s.outputMetadata ?? [],
      },
      transfer: [],
    };
  }
  if (msg.op === "run") {
    const s = session(msg.handle);
    const { Tensor } = await ort();
    refuseWhenRetired();
    const feeds: Record<string, unknown> = {};
    for (const [name, t] of Object.entries(msg.feeds)) feeds[name] = new Tensor(t.type, t.data, t.dims);
    const out = await s.run(feeds);
    const value: Record<string, Plain> = {};
    const transfer: ArrayBuffer[] = [];
    for (const name of Object.keys(out)) {
      const t = out[name];
      // A copy of its own, handed over whole: the runtime's buffer is not this thread's to give.
      const data = t.data.slice();
      if (ArrayBuffer.isView(data)) transfer.push(data.buffer as ArrayBuffer);
      value[name] = { type: t.type, data, dims: [...t.dims] };
    }
    return { value, transfer };
  }
  const s = sessions.get(msg.handle);
  sessions.delete(msg.handle);
  await s?.release?.();
  return { value: null, transfer: [] };
}

/**
 * Lets this thread go: it takes no more work, its models are released, and the main thread starts
 * a new one for what comes next. The thread itself stays, idle: one ended or terminated while the
 * runtime is in a native call brings the whole process down, so none is ever ended from here.
 * What the runtime has already queued on this thread runs first.
 */
function retire(): void {
  if (retired) return;
  retired = true;
  port.postMessage({ id: 0, retired: true });
  setImmediate(() => {
    const open = [...sessions.values()];
    sessions.clear();
    for (const s of open) void s.release().catch(() => {});
  });
}

// An error nothing caught lets the thread go the same way. Only the error's class is written:
// its text can carry a path.
function failed(e: unknown): void {
  process.stderr.write(`[inference] the model thread failed: ${(e as Error)?.name ?? "error"}\n`);
  retire();
}
process.on("uncaughtException", failed);
process.on("unhandledRejection", failed);

port.on("message", (msg: Request) => {
  if (msg.op === "retire") return retire();
  perform(msg).then(
    ({ value, transfer }) => port.postMessage({ id: msg.id, ok: true, value }, transfer),
    (e: unknown) => {
      const err = e as Error | undefined;
      port.postMessage({ id: msg.id, ok: false, error: { name: err?.name ?? "Error", message: String(err?.message ?? e) } });
    },
  );
});
